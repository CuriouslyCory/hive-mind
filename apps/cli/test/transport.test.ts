import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../scripts/build.ts";
import { json, PROBE_BINARY, runAsync } from "./helpers/binaries.ts";

// Spike (a): a compiled binary reaches an HTTP API with a bearer token and
// parses JSON, and @orpc/client 1.x bundles into a binary and makes a call.

const TOKEN = "hm_test_token";
const requests: { url?: string; method?: string; authorization?: string; body: string }[] = [];
let redirected = 0;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

const other = createServer((_request, response) => {
  redirected += 1;
  response.end();
});
const api = createServer(async (request, response) => {
  const body = await readBody(request);
  requests.push({
    url: request.url,
    method: request.method,
    authorization: request.headers.authorization,
    body,
  });
  response.setHeader("content-type", "application/json");
  if (request.url === "/redirect") {
    response.writeHead(302, { location: `${otherOrigin}/steal` });
    response.end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    response.writeHead(401);
    response.end(JSON.stringify({ code: "UNAUTHORIZED", message: "missing or invalid token" }));
    return;
  }
  if (request.url === "/api/v1/me") {
    response.end(JSON.stringify({ principal: { type: "user", userId: "u_1" } }));
    return;
  }
  if (request.url === "/rpc/me" && request.method === "POST") {
    // oRPC's RPC protocol wraps the output as { json }.
    response.end(JSON.stringify({ json: { principal: { type: "user", userId: "u_1" } } }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ code: "NOT_FOUND" }));
});

let origin = "";
let otherOrigin = "";
const dir = mkdtempSync(join(tmpdir(), "hivemind-transport-"));

beforeAll(async () => {
  origin = await listen(api);
  otherOrigin = await listen(other);
});
afterAll(() => {
  api.close();
  other.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("compiled fetch transport", () => {
  it("sends the bearer token and parses the JSON response", async () => {
    const result = await runAsync(PROBE_BINARY, ["http", `${origin}/api/v1/me`], {
      env: { HIVEMIND_PROBE_TOKEN: TOKEN },
    });
    expect(json(result)).toEqual({
      status: 200,
      location: null,
      body: { principal: { type: "user", userId: "u_1" } },
    });
    expect(requests.at(-1)).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}` });
  });

  it("surfaces a JSON 401 for a wrong token", async () => {
    const result = await runAsync(PROBE_BINARY, ["http", `${origin}/api/v1/me`], {
      env: { HIVEMIND_PROBE_TOKEN: "wrong" },
    });
    expect(json(result)).toMatchObject({ status: 401, body: { code: "UNAUTHORIZED" } });
  });

  it("does not follow a cross-origin redirect with the token", async () => {
    const result = await runAsync(PROBE_BINARY, ["http", `${origin}/redirect`], {
      env: { HIVEMIND_PROBE_TOKEN: TOKEN },
    });
    expect(json(result)).toMatchObject({ status: 302, location: `${otherOrigin}/steal` });
    expect(redirected).toBe(0);
  });
});

describe("@orpc/client in a compiled binary", () => {
  it("bundles and calls an RPC procedure with the bearer header", async () => {
    const binary = build({ entry: "test/fixtures/orpc-entry.ts", outfile: join(dir, "orpc") });
    const result = await runAsync(binary, [`${origin}/rpc`], {
      env: { HIVEMIND_PROBE_TOKEN: TOKEN },
    });
    expect(result.stderr).toBe("");
    expect(json(result)).toEqual({ principal: { type: "user", userId: "u_1" } });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "/rpc/me",
      authorization: `Bearer ${TOKEN}`,
    });
  });
});
