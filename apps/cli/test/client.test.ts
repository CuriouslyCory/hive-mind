import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApiClient, createOriginFetch } from "../src/client.ts";
import { createFileStore } from "../src/credentials/file.ts";
import { CliError } from "../src/errors.ts";
import {
  type FakeServer,
  sendJson,
  sendOrpcError,
  startServer,
  USER_PRINCIPAL,
} from "./helpers/api-server.ts";
import { onlyJsonLine, runShell } from "./helpers/shell.ts";

const servers: FakeServer[] = [];
const root = mkdtempSync(join(tmpdir(), "hivemind-client-"));
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  rmSync(root, { recursive: true, force: true });
});
const serve = async (...args: Parameters<typeof startServer>) => {
  const server = await startServer(...args);
  servers.push(server);
  return server;
};

const PROJECT_ID = "3e0c4c38-8f3b-4c55-9d2f-0b9f6b1f3a21";
const credential = (
  origin: string,
  token = "hm_good_token_value",
  source: "env" | "file" = "file",
) => ({ origin, token, source });

async function caught(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("API client", () => {
  it("sends the bearer to its origin and accepts additive response fields", async () => {
    const server = await serve((_request, response) =>
      sendJson(response, 200, { ...USER_PRINCIPAL, addedLater: { x: 1 } }),
    );
    const api = createApiClient({ origin: server.origin, credential: credential(server.origin) });
    const me = await api.me();
    expect(me).toMatchObject({ kind: "user", user: { name: "Ada" } });
    expect(server.requests).toEqual([
      { method: "GET", url: "/api/v1/me", authorization: "Bearer hm_good_token_value", body: "" },
    ]);
  });

  it("maps API errors to contract codes and exit codes", async () => {
    const cases: [number, string, number][] = [
      [401, "UNAUTHORIZED", 3],
      [403, "FORBIDDEN", 3],
      [404, "NOT_FOUND", 4],
      [409, "CONFLICT", 2],
      [400, "BAD_REQUEST", 1],
      [500, "INTERNAL_SERVER_ERROR", 1],
    ];
    for (const [status, code, exit] of cases) {
      const server = await serve((_request, response) =>
        sendOrpcError(response, status, code, `server says ${code}`),
      );
      const error = await caught(
        createApiClient({
          origin: server.origin,
          credential: credential(server.origin),
        }).getProject(PROJECT_ID),
      );
      expect([error.code, error.exitCode]).toEqual([code, exit]);
      expect(error.message).toContain(`server says ${code}`);
    }
  });

  it("maps non-oRPC error pages by status and rejects unreadable success bodies", async () => {
    const html =
      (status: number) =>
      async (_request: unknown, response: import("node:http").ServerResponse) => {
        response.writeHead(status, { "content-type": "text/html" });
        response.end("<html>proxy</html>");
      };
    const unauthorized = await serve(html(401));
    expect(
      (await caught(createApiClient({ origin: unauthorized.origin, credential: null }).me()))
        .exitCode,
    ).toBe(3);
    const badGateway = await serve(html(502));
    const gatewayError = await caught(
      createApiClient({ origin: badGateway.origin, credential: null }).me(),
    );
    expect(gatewayError.exitCode).toBe(1);
    expect(gatewayError.code).toMatch(/^[A-Z_]+$/);
    const page = await serve(html(200));
    expect(
      (await caught(createApiClient({ origin: page.origin, credential: null }).me())).code,
    ).toBe("INVALID_RESPONSE");
    const missing = await serve((_request, response) =>
      sendJson(response, 200, { kind: "user", user: { id: "x" } }),
    );
    const shape = await caught(createApiClient({ origin: missing.origin, credential: null }).me());
    expect(shape.code).toBe("INVALID_RESPONSE");
    expect(shape.message).toContain("user.name");
  });

  it("never follows a redirect, so the bearer never reaches another origin", async () => {
    const elsewhere = await serve((_request, response) => sendJson(response, 200, USER_PRINCIPAL));
    for (const status of [301, 302, 303, 307, 308]) {
      const redirector = await serve((request, response) => {
        response.writeHead(status, { location: `${elsewhere.origin}${request.url}?token=leak` });
        response.end();
      });
      const error = await caught(
        createApiClient({
          origin: redirector.origin,
          credential: credential(redirector.origin),
        }).me(),
      );
      expect(error.code).toBe("UNEXPECTED_REDIRECT");
      expect(error.message).toContain(elsewhere.origin);
      expect(error.message).not.toContain("token=leak");
      expect(redirector.requests).toHaveLength(1);
    }
    // Same-origin redirects are not followed either (an API never redirects).
    const self = await serve((_request, response) => {
      response.writeHead(302, { location: "/sign-in" });
      response.end();
    });
    expect(
      (
        await caught(
          createApiClient({ origin: self.origin, credential: credential(self.origin) }).me(),
        )
      ).code,
    ).toBe("UNEXPECTED_REDIRECT");
    expect(self.requests).toHaveLength(1);
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("times out without retrying a non-idempotent request", async () => {
    const slow = await serve(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (!response.destroyed) sendJson(response, 201, {});
    });
    const api = createApiClient({
      origin: slow.origin,
      credential: credential(slow.origin),
      timeoutMs: 100,
    });
    const error = await caught(api.createProjectKey(PROJECT_ID, { name: "ci" }));
    expect(error.code).toBe("TIMEOUT");
    expect(error.hint).toContain("may still have completed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(slow.requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ["POST", `/api/v1/projects/${PROJECT_ID}/keys`, '{"name":"ci"}'],
    ]);

    const failing = await serve((_request, response) =>
      sendOrpcError(response, 500, "INTERNAL_SERVER_ERROR", "boom"),
    );
    await caught(
      createApiClient({
        origin: failing.origin,
        credential: credential(failing.origin),
      }).createProjectKey(PROJECT_ID, { name: "ci" }),
    );
    expect(failing.requests).toHaveLength(1);
  });

  it("reports an unreachable server and honors the abort signal", async () => {
    const closed = await serve(() => undefined);
    await closed.close();
    expect(
      (await caught(createApiClient({ origin: closed.origin, credential: null }).me())).code,
    ).toBe("NETWORK_ERROR");

    const hanging = await serve(() => undefined);
    const controller = new AbortController();
    const pending = caught(
      createApiClient({ origin: hanging.origin, credential: null, signal: controller.signal }).me(),
    );
    setTimeout(() => controller.abort(), 50);
    expect((await pending).code).toBe("CANCELLED");
  });

  // The timeout and the abort signal cover the whole exchange, so a server
  // that sends its headers and then stalls must fail the same way as one that
  // never answers: TIMEOUT or CANCELLED, never a raw DOMException turned into
  // INVALID_RESPONSE or INTERNAL_ERROR.
  const stallAfterHeaders = (status: number) =>
    serve((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.write('{"projectKey":');
    });

  it("times out while reading a body that stalls after the headers", async () => {
    const stalled = await stallAfterHeaders(201);
    const api = createApiClient({
      origin: stalled.origin,
      credential: credential(stalled.origin),
      timeoutMs: 200,
    });
    const write = await caught(api.createProjectKey(PROJECT_ID, { name: "ci" }));
    expect(write.code).toBe("TIMEOUT");
    expect(write.hint).toContain("may still have completed");
    const read = await caught(api.me());
    expect(read.code).toBe("TIMEOUT");
    expect(read.hint).toBeUndefined();
    expect(stalled.requests).toHaveLength(2);
  });

  it("is cancelled by the abort signal while reading a body", async () => {
    const stalled = await stallAfterHeaders(200);
    const controller = new AbortController();
    const pending = caught(
      createApiClient({
        origin: stalled.origin,
        credential: null,
        signal: controller.signal,
      }).createProjectKey(PROJECT_ID, { name: "ci" }),
    );
    setTimeout(() => controller.abort(), 100);
    const error = await pending;
    expect(error.code).toBe("CANCELLED");
    expect(error.hint).toContain("may still have completed");
  });

  it("refuses a body over the size cap without reading it all", async () => {
    const huge = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      // Never ends: the cap, not the end of the stream, must stop the read.
      const chunk = "x".repeat(64 * 1024);
      const pump = () => {
        while (!response.destroyed && response.write(chunk));
        if (!response.destroyed) response.once("drain", pump);
      };
      pump();
    });
    const error = await caught(
      createApiClient({ origin: huge.origin, credential: null, timeoutMs: 10_000 }).me(),
    );
    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.message).toContain("larger than");
  });
});

describe("createOriginFetch", () => {
  it("requests paths on the origin, without a bearer when there is no credential", async () => {
    const server = await serve((_request, response) =>
      sendJson(response, 200, { device_code: "d" }),
    );
    const fetchOnOrigin = createOriginFetch({ origin: server.origin, credential: null });
    const response = await fetchOnOrigin("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "hivemind-cli" }),
    });
    expect(await response.json()).toEqual({ device_code: "d" });
    expect(server.requests).toEqual([
      {
        method: "POST",
        url: "/api/auth/device/code",
        authorization: undefined,
        body: '{"client_id":"hivemind-cli"}',
      },
    ]);
    const error = await caught(fetchOnOrigin("https://elsewhere.example/api/auth/device/code"));
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(server.requests).toHaveLength(1);
  });
});

describe("credentials over the wire", () => {
  it("an invalid HIVEMIND_TOKEN fails with exit 3 and never falls back to the stored login", async () => {
    const server = await serve((request, response) =>
      request.authorization === "Bearer hm_stored_login_token"
        ? sendJson(response, 200, USER_PRINCIPAL)
        : sendOrpcError(
            response,
            401,
            "UNAUTHORIZED",
            "Authentication is missing, invalid or expired.",
          ),
    );
    const file = createFileStore({ dir: join(root, "env-precedence", "hivemind") });
    expect(await file.set(server.origin, "hm_stored_login_token")).toEqual({ ok: true });
    const options = { credentialOptions: { file } };

    const stored = await runShell(["me", "--json", "--server", server.origin], options);
    expect(stored.code).toBe(0);

    const result = await runShell(["me", "--json", "--server", server.origin], {
      ...options,
      env: { HIVEMIND_TOKEN: "hm_revoked_env_token" },
    });
    expect(result.code).toBe(3);
    expect(onlyJsonLine(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED", message: expect.stringContaining("HIVEMIND_TOKEN") },
    });
    expect(result.stdout + result.stderr).not.toContain("hm_revoked_env_token");
    expect(server.requests.map((request) => request.authorization)).toEqual([
      "Bearer hm_stored_login_token",
      "Bearer hm_revoked_env_token",
    ]);
  });

  it("keeps logins for different origins apart", async () => {
    const a = await serve((request, response) =>
      sendJson(response, 200, { ...USER_PRINCIPAL, seen: request.authorization }),
    );
    const b = await serve((request, response) =>
      sendJson(response, 200, { ...USER_PRINCIPAL, seen: request.authorization }),
    );
    const file = createFileStore({ dir: join(root, "isolation", "hivemind") });
    await file.set(a.origin, "hm_token_for_a_only");
    const fromA = await runShell(["me", "--json", "--server", a.origin], {
      credentialOptions: { file },
    });
    expect(onlyJsonLine(fromA.stdout)).toMatchObject({
      data: { seen: "Bearer hm_token_for_a_only" },
    });
    const fromB = await runShell(["me", "--json", "--server", b.origin], {
      credentialOptions: { file },
    });
    expect(fromB.code).toBe(3);
    expect(onlyJsonLine(fromB.stdout)).toMatchObject({
      error: { code: "UNAUTHORIZED", message: expect.stringContaining("Not logged in") },
    });
    expect(b.requests).toHaveLength(0);
  });
});
