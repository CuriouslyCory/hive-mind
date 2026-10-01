import { readFileSync } from "node:fs";
import {
  type AnyContractProcedure,
  type AnyContractRouter,
  isContractProcedure,
} from "@orpc/contract";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  API_BASE_PATH,
  API_ERROR_CODES,
  API_ERRORS,
  anyCliEnvelopeSchema,
  apiContract,
  CONFIG_ERROR_CODES,
  cliEnvelopeSchema,
  createProjectInputSchema,
  createProjectKeyInputSchema,
  createProjectKeyOutputSchema,
  EXIT_CODES,
  errorEnvelope,
  exitCodeForEnvelope,
  exitCodeForErrorCode,
  getProjectInputSchema,
  hivemindConfigSchema,
  httpStatusForErrorCode,
  listProjectKeysInputSchema,
  listProjectsInputSchema,
  MAX_CONFIG_BYTES,
  MAX_KEY_NAME_LENGTH,
  MAX_MANAGEMENT_BODY_BYTES,
  MAX_PAGE_LIMIT,
  MAX_PROJECT_NAME_LENGTH,
  MAX_PROJECT_SLUG_LENGTH,
  MAX_REPO_URL_LENGTH,
  meOutputSchema,
  OUTPUT_SCHEMA_VERSION,
  parseHivemindConfig,
  principalSchema,
  projectKeyPageSchema,
  projectKeySchema,
  projectSchema,
  revokeProjectKeyInputSchema,
  revokeProjectKeyOutputSchema,
  serializeHivemindConfig,
  successEnvelope,
} from "../src/index.ts";

// Golden v1 fixtures. They are what an installed M1 CLI and the scripts that
// call it rely on. If one of these tests fails, the change breaks installed
// clients: make the change additive instead (a new optional field, a new
// route), or ship it under a new API or output version. Never edit an existing
// v1 fixture to make the test pass; add a new fixture for new behavior.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), "utf8"));
}

const ORG_ID = "2c9e8b71-5d4a-4f3e-8a1b-6c7d8e9f0a1b";
const PROJECT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const KEY_ID = "4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8";

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

interface RouteEntry {
  procedure: string;
  operationId: string | undefined;
  method: string | undefined;
  path: string | undefined;
  successStatus: number | undefined;
}

function flattenProcedures(
  router: AnyContractRouter,
  prefix: string[] = [],
): Array<{ procedure: string; contract: AnyContractProcedure }> {
  return Object.entries(router).flatMap(([name, child]) => {
    const path = [...prefix, name];
    if (isContractProcedure(child)) return [{ procedure: path.join("."), contract: child }];
    return flattenProcedures(child as AnyContractRouter, path);
  });
}

function flattenRoutes(router: AnyContractRouter): RouteEntry[] {
  return flattenProcedures(router).map(({ procedure, contract }) => {
    const route = contract["~orpc"].route;
    return {
      procedure,
      operationId: route.operationId,
      method: route.method,
      path: route.path,
      successStatus: route.successStatus,
    };
  });
}

// The route table is the union of two golden fixtures: `routes.json`, the M1
// routes released CLIs call (never edited), and `routes.coordination.json`,
// the routes #12 added. A new route is added to a fixture; a changed or
// missing M1 route fails here.
const ROUTE_FIXTURES = ["routes.json", "routes.coordination.json"];

function fixtureRoutes(): RouteEntry[] {
  return ROUTE_FIXTURES.flatMap((name) => fixture(name) as RouteEntry[]);
}

describe("route table", () => {
  it("is exactly the union of the M1 and coordination route fixtures", () => {
    const byProcedure = (a: RouteEntry, b: RouteEntry) => a.procedure.localeCompare(b.procedure);
    expect(flattenRoutes(apiContract).sort(byProcedure)).toEqual(fixtureRoutes().sort(byProcedure));
  });

  it("keeps the M1 routes first and unchanged", () => {
    const m1 = fixture("routes.json") as RouteEntry[];
    expect(flattenRoutes(apiContract).slice(0, m1.length)).toEqual(m1);
  });

  it("has unique procedures, operation IDs and method-path pairs", () => {
    const routes = fixtureRoutes();
    for (const key of [
      (route: RouteEntry) => route.procedure,
      (route: RouteEntry) => route.operationId,
      (route: RouteEntry) => `${route.method} ${route.path}`,
    ]) {
      const values = routes.map(key);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("keeps the /api/v1 prefix out of route paths", () => {
    expect(API_BASE_PATH).toBe("/api/v1");
    for (const route of flattenRoutes(apiContract)) {
      expect(route.path).not.toMatch(/^\/api\//);
    }
  });

  it("declares every stable error code with its status on every procedure", () => {
    const procedures = flattenProcedures(apiContract).map(({ contract }) => contract);
    expect(procedures).toHaveLength(fixtureRoutes().length);
    for (const procedure of procedures) {
      const errorMap = procedure["~orpc"].errorMap;
      expect(Object.keys(errorMap).sort()).toEqual([...API_ERROR_CODES].sort());
      for (const code of API_ERROR_CODES) {
        expect(errorMap[code]?.status).toBe(API_ERRORS[code].status);
      }
    }
  });
});

describe("error codes", () => {
  it("map to the v1 HTTP statuses and CLI exit codes", () => {
    const table = Object.fromEntries(
      API_ERROR_CODES.map((code) => [
        code,
        { status: httpStatusForErrorCode(code), exitCode: exitCodeForErrorCode(code) },
      ]),
    );
    expect(table).toEqual(fixture("errors.json"));
  });

  it("treat unknown and CLI-local codes as generic errors", () => {
    expect(exitCodeForErrorCode("SOMETHING_NEW")).toBe(EXIT_CODES.error);
    expect(httpStatusForErrorCode("SOMETHING_NEW")).toBe(500);
    for (const code of CONFIG_ERROR_CODES) {
      expect(exitCodeForErrorCode(code)).toBe(EXIT_CODES.error);
    }
    // Inherited object keys are not error codes.
    expect(exitCodeForErrorCode("toString")).toBe(EXIT_CODES.error);
  });
});

describe("principal and /me", () => {
  it("parses the v1 user and Project-key fixtures unchanged", () => {
    for (const name of ["me.user.json", "me.project-key.json"]) {
      const value = fixture(name);
      expect(meOutputSchema.parse(value)).toEqual(value);
    }
  });

  it("allows a user principal without organizations", () => {
    const { organizations: _, ...withoutOrganizations } = fixture("me.user.json") as Record<
      string,
      unknown
    >;
    expect(accepts(principalSchema, withoutOrganizations)).toBe(true);
  });

  it("never lets a Project key carry a user, or a user carry key fields", () => {
    const user = fixture("me.user.json") as Record<string, unknown>;
    const key = fixture("me.project-key.json") as Record<string, unknown>;
    expect(accepts(principalSchema, { ...key, user: user.user })).toBe(false);
    expect(accepts(principalSchema, { ...user, projectId: PROJECT_ID })).toBe(false);
    expect(accepts(principalSchema, { ...key, kind: "user" })).toBe(false);
    expect(accepts(principalSchema, { ...user, kind: "projectKey" })).toBe(false);
    expect(accepts(principalSchema, { ...key, kind: "agent" })).toBe(false);
  });

  it("accepts permission strings added later but not malformed ones", () => {
    const key = fixture("me.project-key.json") as Record<string, unknown>;
    expect(accepts(principalSchema, { ...key, permissions: ["project:read", "plan:write"] })).toBe(
      true,
    );
    expect(accepts(principalSchema, { ...key, permissions: ["*"] })).toBe(false);
    expect(accepts(principalSchema, { ...key, permissions: ["Project Read"] })).toBe(false);
  });
});

describe("Project schemas", () => {
  const valid = { organizationId: ORG_ID, name: "hive-mind", slug: "hive-mind" };

  it("parses the v1 Project fixture unchanged", () => {
    const value = fixture("project.json");
    expect(projectSchema.parse(value)).toEqual(value);
  });

  it("bounds the name", () => {
    expect(accepts(createProjectInputSchema, valid)).toBe(true);
    const longest = "a".repeat(MAX_PROJECT_NAME_LENGTH);
    expect(accepts(createProjectInputSchema, { ...valid, name: longest })).toBe(true);
    expect(accepts(createProjectInputSchema, { ...valid, name: `${longest}a` })).toBe(false);
    expect(accepts(createProjectInputSchema, { ...valid, name: "" })).toBe(false);
    expect(accepts(createProjectInputSchema, { ...valid, name: "   " })).toBe(false);
    expect(accepts(createProjectInputSchema, { ...valid, name: "evil\u001b[2Jname" })).toBe(false);
    expect(accepts(createProjectInputSchema, { ...valid, name: "tab\there" })).toBe(false);
    expect(accepts(createProjectInputSchema, { ...valid, name: "C1\u009bcontrol" })).toBe(false);
  });

  it.each([
    ["a", true],
    ["hive-mind", true],
    ["a1-b2", true],
    ["a".repeat(MAX_PROJECT_SLUG_LENGTH), true],
    ["a".repeat(MAX_PROJECT_SLUG_LENGTH + 1), false],
    ["", false],
    ["-leading", false],
    ["trailing-", false],
    ["Upper", false],
    ["under_score", false],
    ["dot.ted", false],
    ["sp ace", false],
    ["émoji", false],
  ])("slug %j valid: %s", (slug, expected) => {
    expect(accepts(createProjectInputSchema, { ...valid, slug })).toBe(expected);
  });

  it.each([
    ["https://github.com/CuriouslyCory/hive-mind.git", true],
    ["http://git.internal.example/team/repo", true],
    ["ssh://git@github.com/CuriouslyCory/hive-mind.git", true],
    ["ssh://github.com:2222/owner/repo.git", true],
    ["git://example.com/repo.git", true],
    ["git@github.com:CuriouslyCory/hive-mind.git", true],
    ["https://x-access-token:ghp_secret@github.com/o/r.git", false],
    ["https://ghp_secret@github.com/o/r.git", false],
    ["ssh://git:password@github.com/o/r.git", false],
    ["file:///etc/passwd", false],
    ["javascript:alert(1)", false],
    ["ftp://example.com/repo", false],
    ["github.com/owner/repo", false],
    ["C:/repos/thing", false],
    ["https://github.com/o/r\n.git", false],
    ["https://github.com/o/r .git", false],
    ["", false],
  ])("repo URL %j valid: %s", (repoUrl, expected) => {
    expect(accepts(createProjectInputSchema, { ...valid, repoUrl })).toBe(expected);
  });

  it("bounds the repo URL at 2048 characters", () => {
    const head = "https://github.com/o/";
    const longest = head + "r".repeat(MAX_REPO_URL_LENGTH - head.length);
    expect(accepts(createProjectInputSchema, { ...valid, repoUrl: longest })).toBe(true);
    expect(accepts(createProjectInputSchema, { ...valid, repoUrl: `${longest}r` })).toBe(false);
  });

  it("rejects unknown fields and malformed IDs", () => {
    expect(accepts(createProjectInputSchema, { ...valid, ownerId: ORG_ID })).toBe(false);
    expect(accepts(createProjectInputSchema, { ...valid, organizationId: "not-a-uuid" })).toBe(
      false,
    );
    expect(accepts(createProjectInputSchema, { name: "x", slug: "x" })).toBe(false);
    expect(accepts(getProjectInputSchema, { id: "1" })).toBe(false);
    expect(accepts(getProjectInputSchema, { id: PROJECT_ID, extra: true })).toBe(false);
  });
});

describe("pagination", () => {
  it.each([
    [1, 1],
    ["1", 1],
    [MAX_PAGE_LIMIT, MAX_PAGE_LIMIT],
    [String(MAX_PAGE_LIMIT), MAX_PAGE_LIMIT],
  ])("accepts limit %j", (limit, parsed) => {
    expect(listProjectsInputSchema.parse({ limit }).limit).toBe(parsed);
  });

  it.each([0, -1, MAX_PAGE_LIMIT + 1, 1.5, "0", "101", "1e2", "0x10", " 5", "", "05", null])(
    "rejects limit %j",
    (limit) => {
      expect(accepts(listProjectsInputSchema, { limit })).toBe(false);
    },
  );

  it("accepts opaque cursors and rejects anything else", () => {
    expect(accepts(listProjectsInputSchema, { cursor: "eyJpZCI6MX0" })).toBe(true);
    expect(accepts(listProjectsInputSchema, { cursor: "a".repeat(512) })).toBe(true);
    expect(accepts(listProjectsInputSchema, { cursor: "a".repeat(513) })).toBe(false);
    expect(accepts(listProjectsInputSchema, { cursor: "" })).toBe(false);
    expect(accepts(listProjectsInputSchema, { cursor: "a/b+c=" })).toBe(false);
  });

  it("caps page size in responses", () => {
    const item = (fixture("project-key-page.json") as { items: unknown[] }).items[0];
    const page = { items: Array(MAX_PAGE_LIMIT + 1).fill(item), nextCursor: null };
    expect(accepts(projectKeyPageSchema, page)).toBe(false);
  });
});

describe("Project keys", () => {
  it("parses the v1 key list and create fixtures unchanged", () => {
    for (const [name, schema] of [
      ["project-key-page.json", projectKeyPageSchema],
      ["create-project-key.json", createProjectKeyOutputSchema],
    ] as const) {
      const value = fixture(name);
      expect(schema.parse(value)).toEqual(value);
    }
  });

  it("rejects secret material in key metadata and list output", () => {
    const page = fixture("project-key-page.json") as { items: Array<Record<string, unknown>> };
    const item = page.items[0] as Record<string, unknown>;
    for (const field of ["key", "secret", "hash", "keyHash", "start", "prefix"]) {
      const leaked = { ...item, [field]: "hm_leaked0123456789" };
      expect(accepts(projectKeySchema, leaked)).toBe(false);
      expect(accepts(projectKeyPageSchema, { ...page, items: [leaked] })).toBe(false);
    }
  });

  it("returns the raw key only beside the metadata, never inside it", () => {
    const created = fixture("create-project-key.json") as {
      projectKey: Record<string, unknown>;
      secret: string;
    };
    expect(
      accepts(createProjectKeyOutputSchema, {
        ...created,
        projectKey: { ...created.projectKey, secret: created.secret },
      }),
    ).toBe(false);
    expect(accepts(createProjectKeyOutputSchema, { projectKey: created.projectKey })).toBe(false);
    expect(accepts(createProjectKeyOutputSchema, { ...created, secret: "short" })).toBe(false);
    expect(
      accepts(createProjectKeyOutputSchema, { ...created, secret: "has space 0123456789" }),
    ).toBe(false);
  });

  it("bounds key names and expiry", () => {
    const valid = { id: PROJECT_ID, name: "ci" };
    expect(accepts(createProjectKeyInputSchema, valid)).toBe(true);
    expect(accepts(createProjectKeyInputSchema, { ...valid, expiresInDays: 1 })).toBe(true);
    expect(accepts(createProjectKeyInputSchema, { ...valid, expiresInDays: 365 })).toBe(true);
    for (const expiresInDays of [0, 366, 1.5, "30", -1]) {
      expect(accepts(createProjectKeyInputSchema, { ...valid, expiresInDays })).toBe(false);
    }
    const longest = "k".repeat(MAX_KEY_NAME_LENGTH);
    expect(accepts(createProjectKeyInputSchema, { ...valid, name: longest })).toBe(true);
    expect(accepts(createProjectKeyInputSchema, { ...valid, name: `${longest}k` })).toBe(false);
    expect(accepts(createProjectKeyInputSchema, { ...valid, name: "" })).toBe(false);
    // Callers cannot choose permissions or bind the key elsewhere.
    expect(accepts(createProjectKeyInputSchema, { ...valid, permissions: ["*"] })).toBe(false);
    expect(accepts(createProjectKeyInputSchema, { ...valid, projectId: PROJECT_ID })).toBe(false);
  });

  it("requires UUIDs in key paths", () => {
    expect(accepts(listProjectKeysInputSchema, { id: PROJECT_ID })).toBe(true);
    expect(accepts(revokeProjectKeyInputSchema, { id: PROJECT_ID, keyId: KEY_ID })).toBe(true);
    expect(accepts(revokeProjectKeyInputSchema, { id: PROJECT_ID, keyId: "../x" })).toBe(false);
  });
});

describe("management body limit", () => {
  // The body limit must never reject a request the schemas accept. The worst
  // case per UTF-16 code unit is 3 bytes of UTF-8 (a BMP character such as €);
  // control characters, which JSON would escape to 6 bytes, are rejected.
  it("fits the largest valid create bodies", () => {
    const project = {
      organizationId: ORG_ID,
      name: "€".repeat(MAX_PROJECT_NAME_LENGTH),
      slug: "a".repeat(MAX_PROJECT_SLUG_LENGTH),
      repoUrl: `https://example.com/${"€".repeat(MAX_REPO_URL_LENGTH - 20)}`,
    };
    const key = { id: PROJECT_ID, name: "€".repeat(MAX_KEY_NAME_LENGTH), expiresInDays: 365 };
    expect(accepts(createProjectInputSchema, project)).toBe(true);
    expect(accepts(createProjectKeyInputSchema, key)).toBe(true);
    for (const body of [project, key]) {
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(MAX_MANAGEMENT_BODY_BYTES);
    }
    expect(MAX_MANAGEMENT_BODY_BYTES).toBe(16 * 1024);
  });
});

describe(".hivemind.json", () => {
  it("parses the v1 fixture and serializes it canonically", () => {
    const text = readFileSync(new URL("./fixtures/v1/hivemind.json", import.meta.url), "utf8");
    const result = parseHivemindConfig(text);
    expect(result).toEqual({ ok: true, config: { version: 1, projectId: PROJECT_ID } });
    expect(result.ok && serializeHivemindConfig(result.config)).toBe(text);
    expect(parseHivemindConfig(new TextEncoder().encode(text)).ok).toBe(true);
  });

  it.each([2, 99, 0, -1])("rejects version %j as unsupported", (version) => {
    const result = parseHivemindConfig(JSON.stringify({ version, projectId: PROJECT_ID }));
    expect(result.ok || result.error.code).toBe("CONFIG_UNSUPPORTED_VERSION");
  });

  it.each([
    ["string version", { version: "1", projectId: PROJECT_ID }],
    ["fractional version", { version: 1.5, projectId: PROJECT_ID }],
    ["missing version", { projectId: PROJECT_ID }],
    ["missing projectId", { version: 1 }],
    ["malformed projectId", { version: 1, projectId: "abc" }],
    ["server origin", { version: 1, projectId: PROJECT_ID, server: "https://evil.example" }],
    ["credential", { version: 1, projectId: PROJECT_ID, token: "hm_x" }],
    ["array", [1]],
    ["null", null],
  ])("rejects %s as invalid", (_label, value) => {
    const result = parseHivemindConfig(JSON.stringify(value));
    expect(result.ok || result.error.code).toBe("CONFIG_INVALID");
  });

  it("rejects malformed JSON and invalid UTF-8", () => {
    for (const contents of ["{", "", new Uint8Array([0x7b, 0xff, 0x7d])]) {
      const result = parseHivemindConfig(contents);
      expect(result.ok || result.error.code).toBe("CONFIG_INVALID_JSON");
    }
  });

  it("enforces the 16 KiB limit on encoded bytes", () => {
    const body = JSON.stringify({ version: 1, projectId: PROJECT_ID });
    const atLimit = body + " ".repeat(MAX_CONFIG_BYTES - body.length);
    expect(parseHivemindConfig(atLimit).ok).toBe(true);
    const over = parseHivemindConfig(`${atLimit} `);
    expect(over.ok || over.error.code).toBe("CONFIG_TOO_LARGE");
    // Multi-byte characters count by their UTF-8 size, not by string length.
    // "€" is 3 bytes, so this is about 5.5k characters but over 16 KiB.
    const wide = `${body}${"€".repeat(Math.ceil(MAX_CONFIG_BYTES / 3))}`;
    expect(wide.length).toBeLessThan(MAX_CONFIG_BYTES);
    const result = parseHivemindConfig(wide);
    expect(result.ok || result.error.code).toBe("CONFIG_TOO_LARGE");
  });

  it("refuses to serialize anything but a valid v1 config", () => {
    expect(() => serializeHivemindConfig({ version: 1, projectId: "nope" } as never)).toThrow();
    expect(accepts(hivemindConfigSchema, { version: 1, projectId: PROJECT_ID })).toBe(true);
  });
});

describe("CLI --json envelope", () => {
  it("parses the v1 envelope fixtures unchanged", () => {
    const whoami = cliEnvelopeSchema(meOutputSchema);
    for (const name of ["cli.whoami.user.json", "cli.whoami.project-key.json"]) {
      const value = fixture(name);
      expect(whoami.parse(value)).toEqual(value);
    }
    for (const name of [
      "cli.error.unauthorized.json",
      "cli.error.config-unsupported-version.json",
    ]) {
      const value = fixture(name);
      expect(anyCliEnvelopeSchema.parse(value)).toEqual(value);
    }
  });

  // The `data` of these commands is documented in docs/cli.md and scripts
  // read it; the CLI test json-output.test.ts compares real output with these
  // fixtures (field names, nesting and types).
  const commandFixtures = {
    "cli.login.json": "login",
    "cli.logout.json": "logout",
    "cli.init.json": "init",
    "cli.key-create.json": "key create",
    "cli.key-list.json": "key list",
    "cli.key-revoke.json": "key revoke",
  } as const;

  it("parses the per-command v1 fixtures unchanged", () => {
    for (const [name, command] of Object.entries(commandFixtures)) {
      const value = fixture(name);
      expect(anyCliEnvelopeSchema.parse(value)).toEqual(value);
      expect(value).toMatchObject({ schemaVersion: 1, command, ok: true });
    }
  });

  it("pins the documented data fields of login, logout and init", () => {
    const data = (name: string) => (fixture(name) as { data: Record<string, unknown> }).data;
    expect(data("cli.login.json")).toEqual({
      origin: expect.any(String),
      credentialStore: "file",
      user: (fixture("me.user.json") as { user: unknown }).user,
      hivemindTokenSet: false,
    });
    expect(data("cli.logout.json")).toEqual({
      origin: expect.any(String),
      removed: true,
      revoked: true,
      hivemindTokenSet: false,
    });
    expect(data("cli.init.json")).toEqual({
      project: fixture("project.json"),
      created: true,
      config: { path: expect.any(String), status: "created" },
    });
  });

  it("carries API shapes unchanged in the key command fixtures", () => {
    expect(successEnvelope("key create", fixture("create-project-key.json"))).toEqual(
      fixture("cli.key-create.json"),
    );
    const list = fixture("cli.key-list.json") as {
      data: { projectId: string; items: unknown[]; nextCursor: null };
    };
    expect(list.data.projectId).toBe(PROJECT_ID);
    expect(projectKeyPageSchema.parse({ items: list.data.items, nextCursor: null })).toEqual(
      fixture("project-key-page.json"),
    );
    const revoke = fixture("cli.key-revoke.json") as { data: unknown };
    expect(revokeProjectKeyOutputSchema.parse(revoke.data)).toEqual({
      id: KEY_ID,
      projectId: PROJECT_ID,
      revoked: true,
    });
  });

  it("builds envelopes identical to the fixtures", () => {
    expect(successEnvelope("whoami", fixture("me.user.json"))).toEqual(
      fixture("cli.whoami.user.json"),
    );
    expect(
      errorEnvelope("whoami", {
        code: "UNAUTHORIZED",
        message: API_ERRORS.UNAUTHORIZED.message,
      }),
    ).toEqual(fixture("cli.error.unauthorized.json"));
    expect(OUTPUT_SCHEMA_VERSION).toBe(1);
  });

  it("maps envelopes to exit codes", () => {
    expect(exitCodeForEnvelope(successEnvelope("whoami", {}))).toBe(0);
    const cases = [
      ["UNAUTHORIZED", 3],
      ["FORBIDDEN", 3],
      ["NOT_FOUND", 4],
      ["CONFLICT", 2],
      ["BAD_REQUEST", 1],
      ["INTERNAL_SERVER_ERROR", 1],
      ["CONFIG_UNSUPPORTED_VERSION", 1],
      ["NETWORK_ERROR", 1],
    ] as const;
    for (const [code, exitCode] of cases) {
      expect(exitCodeForEnvelope(errorEnvelope("whoami", { code, message: "m" }))).toBe(exitCode);
    }
  });

  it("rejects envelopes that break the documented shape", () => {
    const ok = fixture("cli.whoami.user.json") as Record<string, unknown>;
    const err = fixture("cli.error.unauthorized.json") as Record<string, unknown>;
    expect(accepts(anyCliEnvelopeSchema, { ...ok, schemaVersion: 2 })).toBe(false);
    expect(accepts(anyCliEnvelopeSchema, { ...ok, token: "secret" })).toBe(false);
    expect(accepts(anyCliEnvelopeSchema, { ...err, data: {} })).toBe(false);
    expect(accepts(anyCliEnvelopeSchema, { ...err, error: { code: "lower", message: "m" } })).toBe(
      false,
    );
    expect(accepts(anyCliEnvelopeSchema, { ...ok, command: "Who Am I" })).toBe(false);
    expect(accepts(anyCliEnvelopeSchema, { ...ok, ok: "true" })).toBe(false);
  });
});
