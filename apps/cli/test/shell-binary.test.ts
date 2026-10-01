import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyCliEnvelopeSchema } from "@hivemind/contract";
import { afterAll, describe, expect, it } from "vitest";
import {
  type FakeServer,
  sendJson,
  sendOrpcError,
  startServer,
  USER_PRINCIPAL,
} from "./helpers/api-server.ts";
import { run, runAsync, SHELL_BINARY, shippedBinary } from "./helpers/binaries.ts";
import { workingSecretTool } from "./helpers/fake-secret-tool.ts";
import { onlyJsonLine } from "./helpers/shell.ts";

// The shell as a real compiled process: stdout/stderr separation, exit codes,
// escaping, credential precedence and redirect handling over a real socket.

const root = mkdtempSync(join(tmpdir(), "hivemind-shell-bin-"));
const servers: FakeServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  rmSync(root, { recursive: true, force: true });
});
let counter = 0;
const isolatedEnv = () => ({ HOME: root, XDG_CONFIG_HOME: join(root, `config-${counter++}`) });
const envelope = (stdout: string) => anyCliEnvelopeSchema.parse(onlyJsonLine(stdout));

describe("compiled shell output", () => {
  it("prints exactly one JSON object on stdout and progress on stderr", () => {
    const result = run(SHELL_BINARY, ["echo", "hi", "--json"], { env: isolatedEnv() });
    expect(result.status).toBe(0);
    expect(envelope(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "echo",
      ok: true,
      data: { text: "hi" },
    });
    expect(result.stderr).toBe("working...\n");
  });

  it("exits 0/1/2/3/4 by error category, with an error envelope", () => {
    for (const [code, exit] of [
      ["BAD_REQUEST", 1],
      ["CONFLICT", 2],
      ["UNAUTHORIZED", 3],
      ["NOT_FOUND", 4],
      ["CONFIG_INVALID", 1],
    ] as const) {
      const result = run(SHELL_BINARY, ["fail", code, "--json"], { env: isolatedEnv() });
      expect(result.status).toBe(exit);
      expect(result.stderr).toBe("");
      expect(envelope(result.stdout)).toMatchObject({
        ok: false,
        command: "fail",
        error: { code },
      });
    }
    const usage = run(SHELL_BINARY, ["--json", "nope"], { env: isolatedEnv() });
    expect([usage.status, envelope(usage.stdout).ok]).toEqual([1, false]);
  });

  it("escapes control characters in human output", () => {
    const result = run(SHELL_BINARY, ["hostile"], { env: isolatedEnv() });
    expect(result.status).toBe(0);
    for (const raw of ["\u001b", "\u0007", "\r", "\u202e"])
      expect(result.stdout + result.stderr).not.toContain(raw);
    expect(result.stdout).toBe("Project name\\x1b]0;pwned\\x07\\x1b[2J\\r\\nforged line\\u202e\n");
  });

  it("does not wait for input without a terminal", () => {
    const result = run(SHELL_BINARY, ["ask", "--json"], { env: isolatedEnv(), timeout: 5_000 });
    expect(result.status).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ error: { code: "USAGE_ERROR" } });
  });

  it("the shipped binary reports a missing command as a JSON error", () => {
    const result = run(shippedBinary(), ["--json"], { env: { PATH: "" } });
    expect(result.status).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({
      command: "hivemind",
      ok: false,
      error: { code: "USAGE_ERROR" },
    });
  });
});

describe("compiled shell against a server", () => {
  const serve = async (...args: Parameters<typeof startServer>) => {
    const server = await startServer(...args);
    servers.push(server);
    return server;
  };

  it("does not forward the bearer through a cross-origin redirect", async () => {
    const elsewhere = await serve((_request, response) => sendJson(response, 200, USER_PRINCIPAL));
    const redirector = await serve((request, response) => {
      response.writeHead(307, { location: `${elsewhere.origin}${request.url}` });
      response.end();
    });
    const token = "hm_env_token_redirect";
    const result = await runAsync(SHELL_BINARY, ["me", "--json", "--server", redirector.origin], {
      env: { ...isolatedEnv(), HIVEMIND_TOKEN: token },
    });
    expect(result.status).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ error: { code: "UNEXPECTED_REDIRECT" } });
    expect(redirector.requests.map((request) => request.authorization)).toEqual([
      `Bearer ${token}`,
    ]);
    expect(elsewhere.requests).toHaveLength(0);
    expect(result.stdout + result.stderr).not.toContain(token);
  });

  it("an invalid HIVEMIND_TOKEN exits 3 and does not fall back to the stored login", async () => {
    const server = await serve((request, response) =>
      request.authorization === "Bearer hm_stored_good_token"
        ? sendJson(response, 200, USER_PRINCIPAL)
        : sendOrpcError(
            response,
            401,
            "UNAUTHORIZED",
            "Authentication is missing, invalid or expired.",
          ),
    );
    const env = isolatedEnv();
    const saved = await runAsync(SHELL_BINARY, ["cred", "save", "--server", server.origin], {
      env,
      input: "hm_stored_good_token",
    });
    expect(saved.status, saved.stderr).toBe(0);
    expect((await runAsync(SHELL_BINARY, ["me", "--server", server.origin], { env })).status).toBe(
      0,
    );
    const result = await runAsync(SHELL_BINARY, ["me", "--json", "--server", server.origin], {
      env: { ...env, HIVEMIND_TOKEN: "hm_bad_env_token" },
    });
    expect(result.status).toBe(3);
    expect(server.requests.at(-1)?.authorization).toBe("Bearer hm_bad_env_token");
    expect(server.requests).toHaveLength(2);
    expect(result.stdout).not.toContain("hm_bad_env_token");
  });
});

describe.skipIf(process.platform !== "linux")("secrets never reach subprocess argv", () => {
  it("passes the token to secret-tool on stdin only", () => {
    const tool = join(root, "fake-tool");
    const state = join(root, "fake-state");
    workingSecretTool(tool, state);
    const env = {
      ...isolatedEnv(),
      PATH: `${tool}:/usr/bin:/bin`,
      TERM: "dumb",
      TEST_TOKEN: "hm_pty_secret_token",
    };
    // `script` provides a PTY, so the shell treats the run as interactive and uses libsecret.
    const result = spawnSync(
      "script",
      ["-qec", `${SHELL_BINARY} cred save --json --server https://hive.example`, "/dev/null"],
      {
        encoding: "utf8",
        env,
        timeout: 20_000,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"store":"libsecret"');
    expect(readFileSync(join(state, "argv.log"), "utf8")).not.toContain("hm_pty_secret_token");
    expect(readFileSync(join(state, "stdin.log"), "utf8")).toContain("hm_pty_secret_token");
    const index = readFileSync(join(env.XDG_CONFIG_HOME, "hivemind", "credentials.json"), "utf8");
    expect(JSON.parse(index)).toEqual({
      version: 1,
      credentials: { "https://hive.example": { store: "libsecret" } },
    });
  });
});
