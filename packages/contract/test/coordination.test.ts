import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AnyContractRouter, isContractProcedure } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ADR_SYNC_CHANGE_KINDS,
  addSessionScopeInputSchema,
  addTaskInputSchema,
  apiContract,
  appendPlanLogInputSchema,
  attachSessionInputSchema,
  blockTaskInputSchema,
  checkSessionOverlapsInputSchema,
  claimTaskInputSchema,
  cliEnvelopeSchema,
  cliErrorEnvelopeSchema,
  collectionStateSchema,
  compareTouchedPaths,
  createPlanInputSchema,
  decimalStringSchema,
  EVENT_TYPES,
  type Event,
  type EventType,
  endSessionInputSchema,
  eventMetadataSchema,
  eventPageSchema,
  eventSchema,
  getProjectStatusInputSchema,
  heartbeatSessionOutputSchema,
  isDeclaredScopePattern,
  isTouchedPath,
  knownEventSchema,
  listPlansInputSchema,
  listSessionsInputSchema,
  MAX_ADR_SYNC_EVENT_CHANGES,
  MAX_COLLECTION_BATCH_PATHS,
  MAX_CONFLICT_INTENT_LENGTH,
  MAX_DECISION_TEXT_LENGTH,
  MAX_EVENT_BYTES,
  MAX_MANAGEMENT_BODY_BYTES,
  MAX_MARKDOWN_BYTES,
  MAX_OVERLAP_WITNESS_LENGTH,
  MAX_PAGE_LIMIT,
  MAX_PLAN_TITLE_LENGTH,
  MAX_SCOPE_VALUE_BYTES,
  MAX_SESSION_INTENT_LENGTH,
  MAX_STATUS_SECTION_ITEMS,
  meOutputSchema,
  overlapPageSchema,
  type PlanSummary,
  PROJECT_KEY_PERMISSIONS,
  planRefSchema,
  projectStatusSchema,
  recordPlanDecisionInputSchema,
  registerCollectionManifestInputSchema,
  type Scope,
  type Session,
  sessionPageSchema,
  startSessionInputSchema,
  type Task,
  taskClaimConflictMessage,
  taskPageSchema,
  touchedPathsContentHash,
  touchedPathsManifestText,
  UNAVAILABLE_EVENT_TYPE,
  unavailableEventSchema,
  updatePlanInputSchema,
  updateSessionInputSchema,
  uploadCollectionBatchInputSchema,
  utf8ByteLength,
} from "../src/index.ts";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), "utf8"));
}

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

function jsonBytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

const PROJECT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SESSION_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const UUID = "6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b";

/** The installed CLI reads at most this much of a response (apps/cli/src/client.ts). */
const CLI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Worst cases for encoded size. "€" is 3 bytes of UTF-8 per UTF-16 code unit,
// the most a single-line field can take; `"` doubles when JSON escapes it,
// the most markdown can grow; a control character, allowed only in touched
// paths, becomes a 6-byte `\u0001` escape.
const WIDE = "€";
const QUOTE = '"';
const CONTROL = "\u0001";

describe("M1 fixtures", () => {
  // Released CLIs depend on these bytes (ADR-0009). New behavior gets a new
  // fixture file; these hashes never change.
  const M1_FIXTURES: Record<string, string> = {
    "cli.error.config-unsupported-version.json":
      "186a57637d6541d29e8aa7ffa1fef3f930dd6fc181276884d0f7d139018f1ee5",
    "cli.error.unauthorized.json":
      "4c10e9416176f70e537912a0eff42fa3591c61241c8fb50b51c56d6f215ada20",
    "cli.init.json": "b4cda19b953dfd7921461319fcaa6159f43ee8f56238e45b6436f5834710b324",
    "cli.key-create.json": "2cf9bc2b122897bf587be33e8c5a9ac386f9d4af08889df9bc07a117f3fa3a30",
    "cli.key-list.json": "9a4a353009fcb7d49e2ef8c0bd22990ce16b0aa7dcb1e41c6759c0c22748cb8f",
    "cli.key-revoke.json": "a4f430780e42a23e1e73b788d391b91c7cd1a8e9d34f2f913b0df5304e995b46",
    "cli.login.json": "35f556f99b0ca2c351c2abc9afce9580d8e09e7d2893e1ba4e04d374ccf5a977",
    "cli.logout.json": "6eafebe6364420c812fb3044d8ddec91841a8f89d08d1d559c9217faa7a388e6",
    "cli.whoami.project-key.json":
      "57a7cdbba800f91932459de78aab79e68341a29d7aacf9e22e406a83dcd23170",
    "cli.whoami.user.json": "bc4659f4a5b4d8126dde1498546e6c471a56a90f73283957c000e40a4b158938",
    "create-project-key.json": "b1ace241457e9199678f7dee5c2400c442ec874cb96f5d833b51ad43fa3367a2",
    "errors.json": "ab20055e7e9a0fcd3b4c0b6a151a005dd1dd9b7e07a6361b651463b87918432e",
    "hivemind.json": "09f3472212962751dcb2ebd44e7439c99bcdfa87d63ba5f0502f1f211e4d8d9f",
    "me.project-key.json": "8a7f20a41cc8f74168a2626b6f2ae9b6c7a2ff18d162dc4ab5a5582318035357",
    "me.user.json": "44e91ba499c54ceabcb3999aa2b3390b3b94993580d64ae6dc49e8310c79557b",
    "project-key-page.json": "fbc9e8277d15636e582150ce206ef8af05bec5c5ffac968fe442db51fe7b519c",
    "project.json": "7917ebd066a87f50ae50e4b9b26ef62ce0da23ed05bfe7fd060fc5ee016adea7",
    "routes.json": "8b7aa672734b2824d241f4687cfd22697f4534995a619310a5a50ceb4963f9c4",
  };

  it.each(Object.entries(M1_FIXTURES))("%s is byte-for-byte unchanged", (name, sha256) => {
    const bytes = readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  });
});

// Every coordination route's response is pinned by a fixture that its own
// output schema parses unchanged.
const RESPONSE_FIXTURES: Record<string, string> = {
  listPlans: "plan-page.json",
  createPlan: "create-plan.json",
  getPlan: "plan.json",
  updatePlan: "update-plan.json",
  setPlanStatus: "set-plan-status.json",
  listPlanLog: "event-page.json",
  appendPlanLog: "append-plan-log.json",
  recordPlanDecision: "record-plan-decision.json",
  listPlanTasks: "task-page.json",
  addTask: "add-task.json",
  claimTask: "claim-task.json",
  releaseTask: "task-action.json",
  startTask: "task-action.json",
  blockTask: "task-action.json",
  completeTask: "task-action.json",
  listSessions: "session-page.json",
  startSession: "start-session.json",
  getSession: "session.json",
  updateSession: "session-change.json",
  heartbeatSession: "heartbeat-session.json",
  attachSession: "session-change.json",
  endSession: "end-session.json",
  listSessionClaims: "task-page.json",
  listSessionEvents: "event-page.json",
  checkSessionOverlaps: "overlap-page.json",
  listSessionScopes: "scope-page.json",
  addSessionScope: "add-session-scope.json",
  removeSessionScope: "remove-session-scope.json",
  registerCollectionManifest: "collection.json",
  uploadCollectionBatch: "upload-collection-batch.json",
  finalizeCollection: "collection.json",
  listProjectEvents: "event-page.json",
  getProjectStatus: "project-status.json",
};

function outputSchemas(router: AnyContractRouter): Map<string, z.ZodType> {
  const schemas = new Map<string, z.ZodType>();
  for (const child of Object.values(router)) {
    if (isContractProcedure(child)) {
      const { route, outputSchema } = child["~orpc"];
      if (route.operationId) schemas.set(route.operationId, outputSchema as z.ZodType);
    } else {
      for (const [id, schema] of outputSchemas(child as AnyContractRouter)) schemas.set(id, schema);
    }
  }
  return schemas;
}

describe("coordination response fixtures", () => {
  const schemas = outputSchemas(apiContract);
  const coordination = (fixture("routes.coordination.json") as Array<{ operationId: string }>).map(
    (route) => route.operationId,
  );

  it("cover every coordination route", () => {
    expect(Object.keys(RESPONSE_FIXTURES).sort()).toEqual([...coordination].sort());
  });

  it.each(Object.entries(RESPONSE_FIXTURES))("%s parses %s unchanged", (operationId, name) => {
    const schema = schemas.get(operationId);
    const value = fixture(name);
    expect(schema?.parse(value)).toEqual(value);
  });

  it("keeps Event integers as decimal strings", () => {
    const page = fixture("event-page.json") as { items: Event[] };
    for (const event of page.items) {
      expect(typeof event.seq).toBe("string");
      expect(typeof event.writerXid).toBe("string");
    }
    // Above 2^53, where a JavaScript number would round.
    expect(page.items.some((event) => BigInt(event.writerXid) > 2n ** 53n)).toBe(true);
  });
});

describe("coordination CLI envelopes", () => {
  const data = (name: string) => (fixture(name) as { data: unknown }).data;

  it.each([
    ["cli.plan-create.json", "plan create", "create-plan.json"],
    ["cli.task-claim.json", "task claim", "claim-task.json"],
    ["cli.session-start.json", "session start", "start-session.json"],
    ["cli.status.json", "status", "project-status.json"],
    ["cli.plan-decide.json", "plan decide", "record-plan-decision.json"],
  ])("%s carries the API response as data", (name, command, response) => {
    expect(fixture(name)).toMatchObject({ schemaVersion: 1, command, ok: true });
    expect(data(name)).toEqual(fixture(response));
  });

  it("pins session heartbeat as the heartbeat plus its collection", () => {
    const envelope = cliEnvelopeSchema(
      z.strictObject({
        heartbeat: heartbeatSessionOutputSchema,
        collection: collectionStateSchema.nullable(),
        touchedPathsAvailable: z.boolean(),
      }),
    );
    const value = fixture("cli.session-heartbeat.json");
    expect(envelope.parse(value)).toEqual(value);
    expect(value).toMatchObject({ command: "session heartbeat" });
    expect((data("cli.session-heartbeat.json") as { heartbeat: unknown }).heartbeat).toEqual(
      fixture("heartbeat-session.json"),
    );
  });

  it("reports a claim conflict as code and message only, holder in the text", () => {
    const value = fixture("cli.error.task-claimed.json") as {
      error: { code: string; message: string };
    };
    expect(cliErrorEnvelopeSchema.parse(value)).toEqual(value);
    expect(value).toMatchObject({ command: "task claim", ok: false, error: { code: "CONFLICT" } });
    const holder = (fixture("session-page.json") as { items: Session[] }).items[0];
    expect(value.error.message).toContain(holder?.id);
    expect(value.error.message).toContain(holder?.intent);
  });
});

describe("Project key permissions", () => {
  it("grants the coordination and ADR permissions and keeps project:read", () => {
    expect([...PROJECT_KEY_PERMISSIONS]).toEqual([
      "project:read",
      "plan:read",
      "plan:write",
      "task:read",
      "task:write",
      "session:read",
      "session:write",
      "scope:read",
      "scope:write",
      "event:read",
      "adr:read",
      "adr:write",
    ]);
  });

  it("is a valid /me principal, and clients still accept unknown permissions", () => {
    const key = fixture("me.project-key.json") as Record<string, unknown>;
    for (const permissions of [[...PROJECT_KEY_PERMISSIONS], ["project:read", "plan:admin"]]) {
      expect(accepts(meOutputSchema, { ...key, permissions })).toBe(true);
    }
  });
});

describe("Plan identifiers", () => {
  it.each([
    ["PLAN-1", true],
    ["PLAN-12", true],
    ["PLAN-999999999", true],
    [UUID, true],
    ["PLAN-0", false],
    ["PLAN-01", false],
    ["PLAN-1000000000", false],
    ["plan-1", false],
    ["PLAN-", false],
    ["PLAN-1a", false],
    ["12", false],
    ["../PLAN-1", false],
  ])("plan ref %j valid: %s", (value, expected) => {
    expect(accepts(planRefSchema, value)).toBe(expected);
  });
});

describe("text limits", () => {
  const plan = { id: PROJECT_ID, planId: UUID, title: "M2" };

  it("bounds markdown by UTF-8 bytes, not characters", () => {
    const fits = WIDE.repeat(Math.floor(MAX_MARKDOWN_BYTES / 3));
    expect(accepts(createPlanInputSchema, { ...plan, body: fits })).toBe(true);
    expect(accepts(createPlanInputSchema, { ...plan, body: `${fits}${WIDE}` })).toBe(false);
    expect(accepts(createPlanInputSchema, { ...plan, body: "a".repeat(MAX_MARKDOWN_BYTES) })).toBe(
      true,
    );
    expect(
      accepts(createPlanInputSchema, { ...plan, body: "a".repeat(MAX_MARKDOWN_BYTES + 1) }),
    ).toBe(false);
  });

  it("allows line breaks and tabs in markdown but no other control characters", () => {
    expect(accepts(createPlanInputSchema, { ...plan, body: "# A\n\n\t- b\r\n" })).toBe(true);
    for (const body of ["\u001b[2J", "a\u0000b", "C1\u009b", "   \n", "", "lone \ud800"]) {
      expect(accepts(createPlanInputSchema, { ...plan, body })).toBe(false);
    }
  });

  it("bounds titles at 120 characters and intent at 2048, single line", () => {
    const title = "t".repeat(MAX_PLAN_TITLE_LENGTH);
    expect(accepts(createPlanInputSchema, { ...plan, title })).toBe(true);
    expect(accepts(createPlanInputSchema, { ...plan, title: `${title}t` })).toBe(false);
    const session = { id: PROJECT_ID, sessionId: UUID, agent: "claude-code", intent: "x" };
    const intent = "i".repeat(MAX_SESSION_INTENT_LENGTH);
    expect(accepts(startSessionInputSchema, { ...session, intent })).toBe(true);
    expect(accepts(startSessionInputSchema, { ...session, intent: `${intent}i` })).toBe(false);
    expect(accepts(startSessionInputSchema, { ...session, intent: "two\nlines" })).toBe(false);
    expect(accepts(startSessionInputSchema, { ...session, agent: "lone \udc00" })).toBe(false);
  });

  it("trims decisions and bounds them at 500 characters on one line", () => {
    const decision = { id: PROJECT_ID, planRef: "PLAN-1", eventId: UUID };
    const parse = (text: string) => recordPlanDecisionInputSchema.parse({ ...decision, text }).text;
    expect(parse("  Retry with backoff.\n")).toBe("Retry with backoff.");
    const text = "d".repeat(MAX_DECISION_TEXT_LENGTH);
    expect(parse(` ${text} `)).toBe(text);
    expect(accepts(recordPlanDecisionInputSchema, { ...decision, text: `${text}d` })).toBe(false);
    for (const bad of [
      "",
      "   ",
      "two\nlines",
      "tab\there",
      "\u001b[2J",
      "C1\u009b",
      "lone \ud800",
    ]) {
      expect(accepts(recordPlanDecisionInputSchema, { ...decision, text: bad })).toBe(false);
    }
  });
});

describe("coordination inputs", () => {
  it("require the client-generated UUID on every create", () => {
    expect(accepts(createPlanInputSchema, { id: PROJECT_ID, title: "x" })).toBe(false);
    expect(accepts(addTaskInputSchema, { id: PROJECT_ID, planRef: "PLAN-1", title: "x" })).toBe(
      false,
    );
    expect(accepts(startSessionInputSchema, { id: PROJECT_ID, agent: "a", intent: "i" })).toBe(
      false,
    );
    expect(
      accepts(appendPlanLogInputSchema, { id: PROJECT_ID, planRef: "PLAN-1", message: "m" }),
    ).toBe(false);
    expect(
      accepts(recordPlanDecisionInputSchema, { id: PROJECT_ID, planRef: "PLAN-1", text: "d" }),
    ).toBe(false);
  });

  it("never take attribution, ownership or fingerprints from the caller", () => {
    const plan = { id: PROJECT_ID, planId: UUID, title: "x" };
    for (const field of ["actor", "createdBy", "ownerUserId", "fingerprint", "keyId", "userId"]) {
      expect(accepts(createPlanInputSchema, { ...plan, [field]: UUID })).toBe(false);
    }
    const session = { id: PROJECT_ID, sessionId: UUID, agent: "a", intent: "i" };
    for (const field of ["owner", "ownerKind", "status", "lastHeartbeatAt"]) {
      expect(accepts(startSessionInputSchema, { ...session, [field]: "user" })).toBe(false);
    }
  });

  it("require a Session for Task work and a bounded reason to block", () => {
    const action = { id: PROJECT_ID, taskId: UUID, sessionId: SESSION_ID };
    expect(accepts(claimTaskInputSchema, action)).toBe(true);
    expect(accepts(claimTaskInputSchema, { ...action, steal: true })).toBe(true);
    expect(accepts(claimTaskInputSchema, { ...action, steal: "yes" })).toBe(false);
    expect(accepts(claimTaskInputSchema, { id: PROJECT_ID, taskId: UUID })).toBe(false);
    expect(accepts(blockTaskInputSchema, action)).toBe(false);
    expect(accepts(blockTaskInputSchema, { ...action, reason: "Waiting on review." })).toBe(true);
  });

  it("need at least one change in PATCH bodies", () => {
    const plan = { id: PROJECT_ID, planRef: "PLAN-1" };
    expect(accepts(updatePlanInputSchema, plan)).toBe(false);
    expect(accepts(updatePlanInputSchema, { ...plan, body: null })).toBe(true);
    const session = { id: PROJECT_ID, sessionId: UUID };
    expect(accepts(updateSessionInputSchema, session)).toBe(false);
    expect(accepts(updateSessionInputSchema, { ...session, gitBranch: null })).toBe(true);
    expect(accepts(updateSessionInputSchema, { ...session, status: "stale" })).toBe(false);
  });

  it("attach a Task only with its Plan", () => {
    const session = { id: PROJECT_ID, sessionId: UUID };
    expect(accepts(attachSessionInputSchema, { ...session, planRef: null })).toBe(true);
    expect(accepts(attachSessionInputSchema, { ...session, planRef: "PLAN-3", taskId: UUID })).toBe(
      true,
    );
    expect(accepts(attachSessionInputSchema, { ...session, planRef: null, taskId: UUID })).toBe(
      false,
    );
  });

  it("use the pagination idiom and documented filters on list routes", () => {
    expect(listPlansInputSchema.parse({ id: PROJECT_ID, limit: "100" }).limit).toBe(100);
    expect(accepts(listPlansInputSchema, { id: PROJECT_ID, limit: "101" })).toBe(false);
    expect(accepts(listPlansInputSchema, { id: PROJECT_ID, status: "draft" })).toBe(true);
    for (const status of ["live", "terminal", "stale"]) {
      expect(accepts(listSessionsInputSchema, { id: PROJECT_ID, status })).toBe(true);
    }
    expect(accepts(listSessionsInputSchema, { id: PROJECT_ID, status: "running" })).toBe(false);
    expect(accepts(checkSessionOverlapsInputSchema, { id: PROJECT_ID, sessionId: UUID })).toBe(
      true,
    );
  });

  it("select a status Session only explicitly", () => {
    expect(accepts(getProjectStatusInputSchema, { id: PROJECT_ID })).toBe(true);
    expect(accepts(getProjectStatusInputSchema, { id: PROJECT_ID, sessionId: UUID })).toBe(true);
    expect(accepts(getProjectStatusInputSchema, { id: PROJECT_ID, sessionId: "latest" })).toBe(
      false,
    );
  });

  it("fit the largest field-valid bodies without JSON escapes in 16 KiB", () => {
    const bodies = [
      {
        planId: UUID,
        title: WIDE.repeat(MAX_PLAN_TITLE_LENGTH),
        body: WIDE.repeat(Math.floor(MAX_MARKDOWN_BYTES / 3)),
        status: "active",
        sessionId: SESSION_ID,
      },
      {
        sessionId: UUID,
        agent: WIDE.repeat(120),
        intent: WIDE.repeat(MAX_SESSION_INTENT_LENGTH),
        hostname: WIDE.repeat(255),
        gitBranch: WIDE.repeat(255),
        gitCommit: "a".repeat(64),
      },
      {
        batchIndex: 1023,
        paths: Array.from(
          { length: MAX_COLLECTION_BATCH_PATHS },
          (_, i) => `${"p".repeat(MAX_SCOPE_VALUE_BYTES - 2)}${i.toString(16).padStart(2, "0")}`,
        ),
      },
    ];
    for (const body of bodies) {
      expect(jsonBytes(body)).toBeLessThan(MAX_MANAGEMENT_BODY_BYTES);
    }
    expect(
      accepts(uploadCollectionBatchInputSchema, {
        id: PROJECT_ID,
        sessionId: UUID,
        collectionId: UUID,
        ...bodies[2],
      }),
    ).toBe(true);
  });

  it("bound the end summary", () => {
    const end = { id: PROJECT_ID, sessionId: UUID };
    expect(accepts(endSessionInputSchema, end)).toBe(false);
    expect(accepts(endSessionInputSchema, { ...end, summary: "Done." })).toBe(true);
  });
});

describe("Scopes", () => {
  it.each([
    ["src/**", true],
    ["**", true],
    ["**/*.ts", true],
    ["packages/*/src/?.ts", true],
    [".github/workflows/ci.yml", true],
    ["café/ü.md", true],
    ["/etc/passwd", false],
    ["a//b", false],
    ["a/", false],
    ["./a", false],
    ["a/../b", false],
    ["a\\b", false],
    ["!src/**", false],
    ["src/{a,b}", false],
    ["src/[ab].ts", false],
    ["src/@(a|b)", false],
    ["src/a**", false],
    ["src/**b/c", false],
    ["a\nb", false],
    ["", false],
    ["a".repeat(MAX_SCOPE_VALUE_BYTES), true],
    ["a".repeat(MAX_SCOPE_VALUE_BYTES + 1), false],
    [WIDE.repeat(86), false],
  ])("declared pattern %j valid: %s", (pattern, expected) => {
    expect(isDeclaredScopePattern(pattern)).toBe(expected);
    expect(accepts(addSessionScopeInputSchema, { id: PROJECT_ID, sessionId: UUID, pattern })).toBe(
      expected,
    );
  });

  it.each([
    ["src/a.ts", true],
    ["src/*?.ts", true],
    ["dir/new\nline", true],
    ["back\\slash", true],
    [".env", true],
    ["/abs", false],
    ["a/../b", false],
    ["a/./b", false],
    ["a//b", false],
    ["nul\u0000", false],
    ["lone\ud800", false],
    ["a".repeat(MAX_SCOPE_VALUE_BYTES + 1), false],
  ])("touched path %j valid: %s", (path, expected) => {
    expect(isTouchedPath(path)).toBe(expected);
  });

  it("orders paths by code point, the UTF-8 byte order", () => {
    // U+FF5E sorts before U+1F600 by code point, after it by UTF-16 code unit.
    const paths = ["b", "\u{1F600}", "a/b", "～", "a"];
    expect([...paths].sort(compareTouchedPaths)).toEqual(["a", "a/b", "b", "～", "\u{1F600}"]);
    expect(compareTouchedPaths("a", "a")).toBe(0);
  });

  it("hashes a canonical, deduplicated manifest", async () => {
    expect(touchedPathsManifestText(["b", "a", "b"])).toBe("a\0b\0");
    expect(await touchedPathsContentHash([])).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await touchedPathsContentHash(["b", "a"])).toBe(
      createHash("sha256").update("a\0b\0").digest("hex"),
    );
  });

  it("checks manifest counts and batch order", () => {
    const path = { id: PROJECT_ID, sessionId: UUID, collectionId: UUID };
    const manifest = { ...path, omittedPathCount: 0, contentHash: "0".repeat(64) };
    for (const [pathCount, batchCount, expected] of [
      [0, 0, true],
      [16, 1, true],
      [17, 1, false],
      [17, 2, true],
      [2, 3, false],
      [0, 1, false],
    ] as const) {
      expect(
        accepts(registerCollectionManifestInputSchema, { ...manifest, pathCount, batchCount }),
      ).toBe(expected);
    }
    const batch = { ...path, batchIndex: 0 };
    expect(accepts(uploadCollectionBatchInputSchema, { ...batch, paths: ["a", "b"] })).toBe(true);
    expect(accepts(uploadCollectionBatchInputSchema, { ...batch, paths: ["b", "a"] })).toBe(false);
    expect(accepts(uploadCollectionBatchInputSchema, { ...batch, paths: ["a", "a"] })).toBe(false);
    expect(accepts(uploadCollectionBatchInputSchema, { ...batch, paths: [] })).toBe(false);
    const seventeen = Array.from({ length: 17 }, (_, i) => `p${i.toString().padStart(2, "0")}`);
    expect(accepts(uploadCollectionBatchInputSchema, { ...batch, paths: seventeen })).toBe(false);
  });
});

describe("claim conflict message", () => {
  it("names the holder and quotes a bounded intent", () => {
    const message = taskClaimConflictMessage({ sessionId: SESSION_ID, intent: "Fix the parser" });
    expect(message).toContain(SESSION_ID);
    expect(message).toContain('"Fix the parser"');
    const long = taskClaimConflictMessage({ sessionId: SESSION_ID, intent: "€".repeat(2048) });
    expect(long).toContain(`${"€".repeat(MAX_CONFLICT_INTENT_LENGTH - 1)}…`);
    expect(long).not.toContain("€".repeat(MAX_CONFLICT_INTENT_LENGTH));
    expect(accepts(cliErrorEnvelopeSchema.shape.error, { code: "CONFLICT", message: long })).toBe(
      true,
    );
  });
});

// Maximal Events: the largest value each field allows, encoded the most
// expensive way. Keyed by type so a new Event type needs an entry here.
const MAX_DECIMAL = "18446744073709551615";
const LONG_TIME = "2026-10-01T12:00:00.000000+05:30";
const markdown = QUOTE.repeat(MAX_MARKDOWN_BYTES);
const wideTitle = WIDE.repeat(MAX_PLAN_TITLE_LENGTH);
const widePath = (i: number) =>
  `${CONTROL.repeat(MAX_SCOPE_VALUE_BYTES - 2)}${i.toString(16).padStart(2, "0")}`;

const MAXIMAL_PAYLOADS: Record<EventType, unknown> = {
  "plan.created": { key: "PLAN-999999999", title: wideTitle, status: "abandoned" },
  "plan.updated": { title: wideTitle, bodyChanged: true },
  "plan.status_changed": { from: "active", to: "abandoned" },
  "plan.log_appended": { message: markdown },
  "plan.decision_recorded": { text: WIDE.repeat(MAX_DECISION_TEXT_LENGTH) },
  "task.added": { title: wideTitle, position: Number.MAX_SAFE_INTEGER },
  "task.claimed": { stolenFromSessionId: UUID, leaseExpiresAt: LONG_TIME },
  "task.released": { reason: "session_abandoned" },
  "task.started": { from: "in_progress" },
  "task.blocked": { from: "in_progress", reason: markdown },
  "task.done": { from: "in_progress" },
  "session.started": { agent: WIDE.repeat(120), intent: WIDE.repeat(MAX_SESSION_INTENT_LENGTH) },
  "session.updated": {
    fields: ["agent", "intent", "hostname", "gitBranch", "gitCommit", "status"],
  },
  "session.attached": { previousPlanId: UUID, previousTaskId: UUID },
  "session.heartbeat": {
    from: "abandoned",
    to: "active",
    renewedClaimCount: Number.MAX_SAFE_INTEGER,
    releasedClaimCount: Number.MAX_SAFE_INTEGER,
    collectionId: UUID,
  },
  "session.status_changed": { from: "active", to: "abandoned" },
  "session.ended": { from: "abandoned", summary: markdown },
  "scope.added": { scopeId: UUID, pattern: widePath(0) },
  "scope.removed": { scopeId: UUID, pattern: widePath(0) },
  "scope.touched": {
    collectionId: UUID,
    paths: Array.from({ length: MAX_COLLECTION_BATCH_PATHS }, (_, i) => widePath(i)),
  },
  "scope.collection_finalized": { collectionId: UUID, pathCount: Number.MAX_SAFE_INTEGER },
  "scope.coverage_lost": {
    collectionId: UUID,
    reason: "unrepresentable_paths",
    pathCount: Number.MAX_SAFE_INTEGER,
  },
  "adr.reserved": {
    adrId: UUID,
    number: 9999,
    title: WIDE.repeat(200),
    slug: "a".repeat(100),
    floor: 9999,
  },
  "adr.synced": {
    commitSha: "f".repeat(64),
    previousCommitSha: "f".repeat(64),
    forced: true,
    added: Number.MAX_SAFE_INTEGER,
    updated: Number.MAX_SAFE_INTEGER,
    removed: Number.MAX_SAFE_INTEGER,
    changes: Array.from({ length: MAX_ADR_SYNC_EVENT_CHANGES }, (_, i) => ({
      number: 9999 - i,
      change: "updated",
      statusFrom: "deprecated",
      statusTo: "superseded",
    })),
    truncated: true,
  },
};

function maximalEvent(type: EventType): unknown {
  return {
    id: UUID,
    projectId: PROJECT_ID,
    seq: MAX_DECIMAL,
    writerXid: MAX_DECIMAL,
    type,
    payloadVersion: 1,
    actor: { kind: "project_key", keyId: UUID },
    actorSessionId: UUID,
    planId: UUID,
    taskId: UUID,
    sessionId: UUID,
    effectiveAt: LONG_TIME,
    createdAt: LONG_TIME,
    payload: MAXIMAL_PAYLOADS[type],
  };
}

describe("Events", () => {
  it("has a schema variant and a maximal case for every type", () => {
    expect(Object.keys(MAXIMAL_PAYLOADS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(EVENT_TYPES)("a maximal %s Event is valid and at most 64 KiB encoded", (type) => {
    const event = maximalEvent(type);
    expect(knownEventSchema.parse(event)).toEqual(event);
    expect(eventSchema.parse(event)).toEqual(event);
    expect(jsonBytes(event)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  });

  // The writers' vocabulary and the readable union are both strict: the
  // tolerance for newer Events lives in the server's projection, not here.
  it.each([
    ["known", knownEventSchema],
    ["readable", eventSchema],
  ] as const)("the %s schema rejects unknown types, payload fields and versions", (_, schema) => {
    const event = maximalEvent("task.done") as Record<string, unknown>;
    expect(accepts(schema, { ...event, type: "task.deleted" })).toBe(false);
    expect(accepts(schema, { ...event, payload: { from: "todo", extra: 1 } })).toBe(false);
    expect(accepts(schema, { ...event, payloadVersion: 2 })).toBe(false);
    expect(accepts(schema, { ...event, payload: MAXIMAL_PAYLOADS["task.claimed"] })).toBe(false);
    expect(accepts(schema, { ...event, extra: "x" })).toBe(false);
  });

  it("bounds ADR Events: numbers, the change list and statuses that match each change", () => {
    const reserved = maximalEvent("adr.reserved") as { payload: Record<string, unknown> };
    const reserve = (payload: Record<string, unknown>) =>
      accepts(knownEventSchema, { ...reserved, payload: { ...reserved.payload, ...payload } });
    expect(reserve({ number: 1, floor: 0 })).toBe(true);
    expect(reserve({ number: 0 })).toBe(false);
    expect(reserve({ number: 10000 })).toBe(false);
    expect(reserve({ floor: -1 })).toBe(false);
    expect(reserve({ floor: null })).toBe(false);
    expect(reserve({ title: WIDE.repeat(201) })).toBe(false);
    expect(reserve({ slug: "Not-A-Slug" })).toBe(false);
    expect(reserve({ slug: "a".repeat(101) })).toBe(false);

    const synced = maximalEvent("adr.synced") as { payload: Record<string, unknown> };
    const sync = (payload: Record<string, unknown>) =>
      accepts(knownEventSchema, { ...synced, payload: { ...synced.payload, ...payload } });
    const one = (change: Record<string, unknown>) => sync({ changes: [change] });
    expect(sync({ changes: [], truncated: false, previousCommitSha: null })).toBe(true);
    expect(sync({ commitSha: "f".repeat(39) })).toBe(false);
    expect(sync({ commitSha: "F".repeat(40) })).toBe(false);
    const tooMany = Array.from({ length: MAX_ADR_SYNC_EVENT_CHANGES + 1 }, (_, i) => ({
      number: i + 1,
      change: "removed",
      statusFrom: "accepted",
      statusTo: null,
    }));
    expect(sync({ changes: tooMany })).toBe(false);
    for (const change of ["added", "restored"]) {
      expect(one({ number: 1, change, statusFrom: null, statusTo: "proposed" })).toBe(true);
      expect(one({ number: 1, change, statusFrom: "proposed", statusTo: "proposed" })).toBe(false);
    }
    expect(one({ number: 1, change: "updated", statusFrom: "proposed", statusTo: null })).toBe(
      false,
    );
    expect(one({ number: 1, change: "removed", statusFrom: "accepted", statusTo: null })).toBe(
      true,
    );
    expect(one({ number: 1, change: "renamed", statusFrom: null, statusTo: null })).toBe(false);
    // Every listed kind has a variant.
    for (const change of ADR_SYNC_CHANGE_KINDS) {
      const statusFrom = change === "added" || change === "restored" ? null : "accepted";
      const statusTo = change === "removed" ? null : "accepted";
      expect(one({ number: 1, change, statusFrom, statusTo })).toBe(true);
    }
    expect(one({ number: 1, change: "added", statusFrom: null, statusTo: "draft" })).toBe(false);
    // No titles or content in a sync Event.
    expect(
      one({ number: 1, change: "added", statusFrom: null, statusTo: "accepted", title: "x" }),
    ).toBe(false);
  });

  it("types the actor as a User, a Project key or the system", () => {
    const event = maximalEvent("task.done") as Record<string, unknown>;
    for (const actor of [{ kind: "user", userId: UUID }, { kind: "system" }]) {
      expect(accepts(eventSchema, { ...event, actor })).toBe(true);
    }
    for (const actor of [
      { kind: "projectKey", keyId: UUID },
      { kind: "user", keyId: UUID },
      { kind: "system", userId: UUID },
      { kind: "session", sessionId: UUID },
    ]) {
      expect(accepts(eventSchema, { ...event, actor })).toBe(false);
    }
  });

  describe("event.unavailable", () => {
    const metadata = (({ type: _t, payloadVersion: _v, payload: _p, ...rest }) => rest)(
      maximalEvent("task.done") as Record<string, unknown>,
    );
    const unavailable = {
      ...metadata,
      type: UNAVAILABLE_EVENT_TYPE,
      payloadVersion: 1,
      payload: {},
    };

    it("is readable with the stable metadata and an empty payload, at most 64 KiB", () => {
      expect(eventMetadataSchema.parse(metadata)).toEqual(metadata);
      expect(unavailableEventSchema.parse(unavailable)).toEqual(unavailable);
      expect(eventSchema.parse(unavailable)).toEqual(unavailable);
      expect(jsonBytes(unavailable)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    });

    it("is response-only: not a writable type, and the event. prefix is reserved", () => {
      expect(accepts(knownEventSchema, unavailable)).toBe(false);
      expect(EVENT_TYPES).not.toContain(UNAVAILABLE_EVENT_TYPE);
      expect(EVENT_TYPES.filter((type) => type.startsWith("event."))).toEqual([]);
    });

    it.each([
      ["a payload field", { payload: { secret: "canary" } }],
      ["the stored payload", { payload: MAXIMAL_PAYLOADS["task.done"] }],
      ["another version", { payloadVersion: 2 }],
      ["the stored type", { originalType: "task.done" }],
      ["an undeclared field", { creationFingerprint: "0".repeat(64) }],
    ])("rejects %s", (_, change) => {
      expect(accepts(eventSchema, { ...unavailable, ...change })).toBe(false);
    });

    it.each([
      ["id", "not-a-uuid"],
      ["seq", "-1"],
      ["writerXid", 42],
      ["actor", { kind: "system", userId: UUID }],
      ["effectiveAt", "yesterday"],
    ])("rejects invalid metadata (%s)", (field, value) => {
      expect(accepts(eventMetadataSchema, { ...metadata, [field]: value })).toBe(false);
      expect(accepts(eventSchema, { ...unavailable, [field]: value })).toBe(false);
    });

    it("parses a pinned mixed page unchanged", () => {
      const page = fixture("event-page.unavailable.json");
      expect(eventPageSchema.parse(page)).toEqual(page);
      const types = (page as { items: Event[] }).items.map((event) => event.type);
      expect(types).toEqual(["task.started", UNAVAILABLE_EVENT_TYPE, "session.status_changed"]);
    });
  });

  it.each([
    ["0", true],
    ["42", true],
    [MAX_DECIMAL, true],
    ["9".repeat(21), false],
    ["042", false],
    ["-1", false],
    ["1e3", false],
    [42, false],
  ])("decimal string %j valid: %s", (value, expected) => {
    expect(accepts(decimalStringSchema, value)).toBe(expected);
  });
});

// The CLI rejects a response over 4 MiB, so the largest valid page or status
// must fit with room to spare.
describe("response sizes", () => {
  const plan: PlanSummary = {
    ...((fixture("plan-page.json") as { items: PlanSummary[] }).items[0] as PlanSummary),
    title: wideTitle,
  };
  const task: Task = {
    ...((fixture("task-page.json") as { items: Task[] }).items[0] as Task),
    title: wideTitle,
    status: "blocked",
    blockedReason: markdown,
  };
  const session: Session = {
    ...(fixture("session.json") as Session),
    agent: WIDE.repeat(120),
    intent: WIDE.repeat(MAX_SESSION_INTENT_LENGTH),
    hostname: WIDE.repeat(255),
    gitBranch: WIDE.repeat(255),
    summary: markdown,
  };
  const declared: Scope = {
    ...((fixture("scope-page.json") as { items: Scope[] }).items[0] as Scope),
    value: QUOTE.repeat(MAX_SCOPE_VALUE_BYTES),
  };
  const overlap = {
    ...((fixture("overlap-page.json") as { items: unknown[] }).items[0] as object),
    scope: { id: UUID, source: "touched", value: widePath(0) },
    otherScope: { id: UUID, source: "touched", value: widePath(1) },
    witness: CONTROL.repeat(MAX_OVERLAP_WITNESS_LENGTH),
  };
  const full = <T>(item: T, count = MAX_PAGE_LIMIT) => Array.from({ length: count }, () => item);

  it.each([
    [
      "Event page",
      eventPageSchema,
      { items: full(maximalEvent("scope.touched")), nextCursor: null },
    ],
    ["Task page", taskPageSchema, { items: full(task), nextCursor: null }],
    ["Session page", sessionPageSchema, { items: full(session), nextCursor: null }],
    [
      "overlap page",
      overlapPageSchema,
      {
        items: full(overlap),
        nextCursor: null,
        complete: false,
        incompleteSessionIds: full(UUID, MAX_PAGE_LIMIT + 1),
      },
    ],
  ] as const)("a maximal %s fits the CLI's 4 MiB limit", (_name, schema, page) => {
    expect(accepts(schema, page)).toBe(true);
    expect(jsonBytes(page)).toBeLessThan(CLI_MAX_RESPONSE_BYTES);
  });

  it("a maximal Project status fits the CLI's 4 MiB limit and myClaims can be empty", () => {
    const status = {
      ...(fixture("project-status.json") as object),
      activePlans: full(plan, MAX_STATUS_SECTION_ITEMS),
      liveSessions: full(
        {
          session: { ...session, summary: null },
          declaredScopes: full(declared, 32),
          touchedScopeCount: 96,
          claimCount: 1000,
        },
        MAX_STATUS_SECTION_ITEMS,
      ),
      myClaims: full(task, MAX_STATUS_SECTION_ITEMS),
      recentTerminalSessions: full(session, MAX_STATUS_SECTION_ITEMS),
      overlaps: full(overlap, MAX_STATUS_SECTION_ITEMS),
    };
    expect(projectStatusSchema.parse(status)).toEqual(status);
    expect(jsonBytes(status)).toBeLessThan(CLI_MAX_RESPONSE_BYTES);
    expect(accepts(projectStatusSchema, { ...status, selectedSessionId: null, myClaims: [] })).toBe(
      true,
    );
    expect(
      accepts(projectStatusSchema, {
        ...status,
        myClaims: full(task, MAX_STATUS_SECTION_ITEMS + 1),
      }),
    ).toBe(false);
  });
});
