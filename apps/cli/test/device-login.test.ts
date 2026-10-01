import { Readable } from "node:stream";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createCredentialManager } from "../src/credentials/manager.ts";
import {
  CLI_CLIENT_ID,
  DEVICE_CODE_PATH,
  DEVICE_GRANT_TYPE,
  DEVICE_TOKEN_PATH,
  type DeviceAuthorization,
  type DeviceResponse,
  type DeviceTransport,
  MAX_BACKOFF_MS,
  pollForToken,
  requestDeviceCode,
} from "../src/device-login.ts";
import { CliError } from "../src/errors.ts";
import { sendJson, startServer, USER_PRINCIPAL } from "./helpers/api-server.ts";
import { commandHarness, fakeClock } from "./helpers/commands.ts";
import { onlyJsonLine } from "./helpers/shell.ts";

const ORIGIN = "https://hive.example";
const TOKEN = "login-session-token-0123456789abcdef";

const pending: DeviceResponse = { status: 400, body: { error: "authorization_pending" } };
const slowDown: DeviceResponse = { status: 400, body: { error: "slow_down" } };
const granted: DeviceResponse = {
  status: 200,
  body: { access_token: TOKEN, token_type: "Bearer", expires_in: 604800, scope: "" },
};
const timeout = () => new CliError("TIMEOUT", `${ORIGIN} did not answer within 15 s.`);

/** A transport that plays back `steps` (a response, or an error to throw) and records each call. */
function scripted(steps: (DeviceResponse | (() => Error))[]) {
  const calls: { path: string; body: unknown }[] = [];
  const transport: DeviceTransport = async (path, body) => {
    calls.push({ path, body });
    const step = steps.shift();
    if (step === undefined) throw new Error("transport called more often than scripted");
    if (typeof step === "function") throw step();
    return step;
  };
  return { transport, calls };
}

function authorization(overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization {
  return {
    deviceCode: "d".repeat(40),
    userCode: "ABCDEFGH",
    verificationUri: `${ORIGIN}/device`,
    verificationUriComplete: `${ORIGIN}/device?user_code=ABCDEFGH`,
    expiresInMs: 600_000,
    intervalMs: 5_000,
    ...overrides,
  };
}

async function poll(
  steps: (DeviceResponse | (() => Error))[],
  options: { auth?: Partial<DeviceAuthorization>; signal?: AbortSignal } = {},
) {
  const clock = fakeClock();
  const { transport, calls } = scripted(steps);
  const outcome = await pollForToken({
    transport,
    clock,
    signal: options.signal ?? new AbortController().signal,
    origin: ORIGIN,
    authorization: authorization(options.auth),
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as CliError }),
  );
  return { outcome, sleeps: clock.sleeps, calls };
}

describe("requestDeviceCode", () => {
  it("sends only the public client id as JSON and reads the RFC 8628 fields", async () => {
    const { transport, calls } = scripted([
      {
        status: 200,
        body: {
          device_code: "d".repeat(40),
          user_code: "ABCDEFGH",
          verification_uri: `${ORIGIN}/device`,
          verification_uri_complete: `${ORIGIN}/device?user_code=ABCDEFGH`,
          expires_in: 600,
          interval: 5,
        },
      },
    ]);
    expect(await requestDeviceCode(transport, ORIGIN)).toEqual(authorization());
    expect(calls).toEqual([{ path: DEVICE_CODE_PATH, body: { client_id: CLI_CLIENT_ID } }]);
  });

  it("never points the user at another origin, and defaults the interval to 5 s", async () => {
    const { transport } = scripted([
      {
        status: 200,
        body: {
          device_code: "d".repeat(40),
          user_code: "ABCDEFGH",
          verification_uri: "https://evil.example/device",
          verification_uri_complete: "https://evil.example/device?user_code=ABCDEFGH",
          expires_in: 600,
        },
      },
    ]);
    const result = await requestDeviceCode(transport, ORIGIN);
    expect(result.verificationUri).toBe(`${ORIGIN}/device`);
    expect(result.verificationUriComplete).toBeNull();
    expect(result.intervalMs).toBe(5_000);
  });

  it.each([
    [{ status: 400, body: { error: "invalid_client" } }, "LOGIN_FAILED"],
    [{ status: 503, body: null }, "INTERNAL_SERVER_ERROR"],
    [{ status: 200, body: { user_code: "ABCDEFGH", expires_in: 600 } }, "INVALID_RESPONSE"],
    [{ status: 404, body: null }, "INVALID_RESPONSE"],
  ])("fails clearly on %j", async (response, code) => {
    const { transport } = scripted([response]);
    await expect(requestDeviceCode(transport, ORIGIN)).rejects.toMatchObject({ code });
  });
});

describe("pollForToken", () => {
  it("waits the interval before every poll and sends the device grant", async () => {
    const { outcome, sleeps, calls } = await poll([pending, pending, granted]);
    expect(outcome).toEqual({ ok: true, value: { accessToken: TOKEN, requests: 3 } });
    expect(sleeps).toEqual([5_000, 5_000, 5_000]);
    expect(calls[0]).toEqual({
      path: DEVICE_TOKEN_PATH,
      body: {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: "d".repeat(40),
        client_id: CLI_CLIENT_ID,
      },
    });
  });

  it("adds 5 s to the interval for every slow_down, for all later polls", async () => {
    const { outcome, sleeps } = await poll([pending, slowDown, pending, slowDown, granted]);
    expect(outcome.ok).toBe(true);
    expect(sleeps).toEqual([5_000, 5_000, 10_000, 10_000, 15_000]);
  });

  it("backs off exponentially on transport timeouts and resets after an answer", async () => {
    const { outcome, sleeps } = await poll([timeout, timeout, pending, timeout, granted]);
    expect(outcome.ok).toBe(true);
    expect(sleeps).toEqual([5_000, 10_000, 20_000, 5_000, 10_000]);
  });

  it("treats 5xx and 429 as transient, with the backoff capped", async () => {
    const errors = Array.from({ length: 6 }, () => ({ status: 503, body: null }));
    const { outcome, sleeps } = await poll([...errors, { status: 429, body: null }, granted]);
    expect(outcome.ok).toBe(true);
    expect(sleeps.slice(0, 3)).toEqual([5_000, 10_000, 20_000]);
    expect(Math.max(...sleeps)).toBe(MAX_BACKOFF_MS);
  });

  it("stops on denial with FORBIDDEN (exit 3)", async () => {
    const { outcome, calls } = await poll([
      pending,
      { status: 400, body: { error: "access_denied" } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("FORBIDDEN");
    expect(outcome.error.exitCode).toBe(3);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["expired_token", "LOGIN_EXPIRED"],
    ["invalid_grant", "LOGIN_FAILED"],
    ["something_new", "LOGIN_FAILED"],
  ])("stops on %s", async (error, code) => {
    const { outcome, calls } = await poll([{ status: 400, body: { error } }]);
    expect(outcome).toMatchObject({ ok: false, error: { code } });
    expect(calls).toHaveLength(1);
  });

  it("bounds the number of polls by expires_in when the user never answers", async () => {
    const steps = Array.from({ length: 100 }, () => pending);
    const { outcome, sleeps, calls } = await poll(steps, { auth: { expiresInMs: 30_000 } });
    expect(outcome).toMatchObject({ ok: false, error: { code: "LOGIN_EXPIRED" } });
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(30_000);
  });

  it("also stops at expires_in while the server keeps failing", async () => {
    const steps = Array.from({ length: 100 }, () => timeout);
    const { outcome, sleeps } = await poll(steps, { auth: { expiresInMs: 120_000 } });
    expect(outcome).toMatchObject({ ok: false, error: { code: "LOGIN_EXPIRED" } });
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(120_000);
  });

  it("stops at once when interrupted while waiting", async () => {
    const controller = new AbortController();
    const clock = fakeClock();
    clock.onSleep = (index) => {
      if (index === 2) controller.abort();
    };
    const { transport, calls } = scripted([pending, pending, granted]);
    await expect(
      pollForToken({
        transport,
        clock,
        signal: controller.signal,
        origin: ORIGIN,
        authorization: authorization(),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a request cancelled in flight", async () => {
    const controller = new AbortController();
    const { outcome, calls } = await poll(
      [
        () => {
          controller.abort();
          return new CliError("CANCELLED", "Cancelled.");
        },
        granted,
      ],
      { signal: controller.signal },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(calls).toHaveLength(1);
  });

  it("rejects a 200 without a usable token", async () => {
    const { outcome } = await poll([{ status: 200, body: { access_token: "has space" } }]);
    expect(outcome).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
});

describe("hivemind login", () => {
  const harness = commandHarness();
  afterAll(() => harness.cleanup());
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  /** A fake backend: device code, then `tokenSteps` for the polls, then /me. */
  async function backend(tokenSteps: DeviceResponse[]) {
    server = await startServer((request, response) => {
      const origin = server?.origin ?? "";
      if (request.url === DEVICE_CODE_PATH) {
        sendJson(response, 200, {
          device_code: "d".repeat(40),
          user_code: "ABCDEFGH",
          verification_uri: `${origin}/device`,
          verification_uri_complete: `${origin}/device?user_code=ABCDEFGH`,
          expires_in: 600,
          interval: 5,
        });
      } else if (request.url === DEVICE_TOKEN_PATH) {
        const step = tokenSteps.shift() ?? pending;
        sendJson(response, step.status, step.body);
      } else if (request.url === "/api/v1/me") {
        sendJson(response, 200, USER_PRINCIPAL);
      } else if (request.url === "/api/auth/sign-out") {
        sendJson(response, 200, { success: true });
      } else sendJson(response, 404, {});
    });
    return server;
  }

  function stored(origin: string) {
    return createCredentialManager({
      env: {},
      interactive: false,
      file: harness.file,
    }).readStored(origin);
  }

  it("without a TTY prints the URL and code to stderr, polls, never opens a browser or reads stdin", async () => {
    const api = await backend([pending, granted]);
    let stdinRead = false;
    const stdin = new Readable({
      read() {
        stdinRead = true;
        this.push(null);
      },
    });
    const opened: string[] = [];
    const result = await harness.run(["login", "--server", api.origin, "--json"], {
      stdin,
      openUrl: async (url) => {
        opened.push(url);
        return true;
      },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`${api.origin}/device`);
    expect(result.stderr).toContain("ABCD-EFGH");
    expect(opened).toEqual([]);
    expect(stdinRead).toBe(false);
    expect(onlyJsonLine(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "login",
      ok: true,
      data: {
        origin: api.origin,
        credentialStore: "file",
        user: USER_PRINCIPAL.user,
        hivemindTokenSet: false,
      },
    });
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect((await stored(api.origin))?.token).toBe(TOKEN);
    const me = api.requests.find((request) => request.url === "/api/v1/me");
    expect(me?.authorization).toBe(`Bearer ${TOKEN}`);
    await harness.run(["logout", "--server", api.origin]);
  });

  it("in a TTY opens the browser and keeps going when that fails", async () => {
    const api = await backend([granted]);
    const opened: string[] = [];
    const result = await harness.run(["login", "--server", api.origin], {
      interactive: true,
      openUrl: async (url) => {
        opened.push(url);
        return false;
      },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(opened).toEqual([`${api.origin}/device?user_code=ABCDEFGH`]);
    expect(result.stderr).toContain("Could not open a browser");
    expect(result.stdout).toContain("Logged in");
    expect(result.stdout).not.toContain(TOKEN);
    // Interactive runs prefer the OS store.
    expect(harness.os.items.get(api.origin)).toBe(TOKEN);
    harness.os.items.clear();
    await harness.run(["logout", "--server", api.origin], { interactive: true });
  });

  it("stores nothing when the request is denied (exit 3)", async () => {
    const api = await backend([pending, { status: 400, body: { error: "access_denied" } }]);
    const result = await harness.run(["login", "--server", api.origin, "--json"]);
    expect(result.code).toBe(3);
    expect(onlyJsonLine(result.stdout)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await stored(api.origin)).toBeNull();
  });

  it("stores nothing when interrupted (SIGINT)", async () => {
    const api = await backend([pending, pending, granted]);
    const controller = new AbortController();
    const clock = fakeClock();
    clock.onSleep = (index) => {
      if (index === 1) controller.abort();
    };
    const result = await harness.run(["login", "--server", api.origin, "--json"], {
      signal: controller.signal,
      clock,
    });
    expect(result.code).toBe(1);
    expect(onlyJsonLine(result.stdout)).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(await stored(api.origin)).toBeNull();
    expect(api.requests.filter((request) => request.url === DEVICE_TOKEN_PATH)).toHaveLength(1);
  });

  it("with HIVEMIND_TOKEN set, warns that it takes precedence and still stores the login", async () => {
    const api = await backend([granted]);
    const result = await harness.run(["login", "--server", api.origin, "--json"], {
      env: { HIVEMIND_TOKEN: "hm_env_token_value_123" },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("HIVEMIND_TOKEN is set");
    expect(onlyJsonLine(result.stdout)).toMatchObject({ data: { hivemindTokenSet: true } });
    expect((await stored(api.origin))?.token).toBe(TOKEN);
    // /me was asked with the new login, not with HIVEMIND_TOKEN.
    const me = api.requests.find((request) => request.url === "/api/v1/me");
    expect(me?.authorization).toBe(`Bearer ${TOKEN}`);
    await harness.run(["logout", "--server", api.origin]);
  });
});
