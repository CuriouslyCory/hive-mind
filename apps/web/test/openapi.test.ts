import { readFile } from "node:fs/promises";
import { API_BASE_PATH, API_ERRORS } from "@hivemind/contract";
import { agentSession } from "@hivemind/db/schema";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED_MESSAGE } from "../src/server/api/not-implemented";
import { generateOpenAPIDocument, OPENAPI_DOCUMENT_PATH } from "../src/server/api/router";
import { type ApiHarness, createApiHarness, ORIGIN, type SignedInUser } from "./support/api";

// The OpenAPI document is generated from the contract the server implements.
// These tests pin it to the contract's golden route tables (the M1 routes and
// the coordination routes of #12) and check that the running handler answers
// each documented operation with its documented success status.

const ROUTE_FIXTURES = ["routes.json", "routes.coordination.json"];

/**
 * TEMPORARY: coordination operations whose handler is still a stub in
 * `src/server/api/not-implemented.ts`. They are checked for their 401 and
 * for the stub's 500 until implemented; whoever implements one removes it
 * here and adds a valid request to `bodies` below. Empty before #12 merges.
 */
const NOT_YET_SERVED = new Set([
  "claimTask",
  "releaseTask",
  "startTask",
  "blockTask",
  "completeTask",
  "listSessions",
  "startSession",
  "getSession",
  "updateSession",
  "heartbeatSession",
  "attachSession",
  "endSession",
  "listSessionClaims",
  "checkSessionOverlaps",
  "listSessionScopes",
  "addSessionScope",
  "removeSessionScope",
  "registerCollectionManifest",
  "uploadCollectionBatch",
  "finalizeCollection",
  "getProjectStatus",
]);

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface Operation {
  method: string;
  path: string;
  operationId: string;
  successStatus: number;
  errorStatuses: number[];
}

async function documentedOperations(): Promise<Operation[]> {
  const document = await generateOpenAPIDocument();
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post", "patch", "put", "delete"] as const) {
      const operation = item?.[method];
      if (!operation) continue;
      const statuses = Object.keys(operation.responses ?? {}).map(Number);
      const success = statuses.filter((status) => status < 300);
      expect(success).toHaveLength(1);
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: String(operation.operationId),
        successStatus: success[0] ?? 0,
        errorStatuses: statuses.filter((status) => status >= 400),
      });
    }
  }
  return operations;
}

describe("the OpenAPI document", () => {
  it("matches the contract's golden route tables", async () => {
    const fixture: { operationId: string; method: string; path: string; successStatus: number }[] =
      [];
    for (const name of ROUTE_FIXTURES) {
      fixture.push(
        ...JSON.parse(
          await readFile(
            new URL(`../../../packages/contract/test/fixtures/v1/${name}`, import.meta.url),
            "utf8",
          ),
        ),
      );
    }
    const operations = await documentedOperations();
    const key = (op: {
      operationId: string;
      method: string;
      path: string;
      successStatus: number;
    }) => `${op.operationId} ${op.method} ${op.path} ${op.successStatus}`;
    expect(operations.map(key).sort()).toEqual(fixture.map(key).sort());
  });

  it("documents every contract error status on every operation", async () => {
    const statuses = Object.values(API_ERRORS)
      .map((error) => error.status)
      .sort();
    for (const operation of await documentedOperations()) {
      expect(operation.errorStatuses.sort()).toEqual(statuses);
    }
  });

  it("names the base path and bearer authentication", async () => {
    const document = await generateOpenAPIDocument();
    expect(document.servers).toEqual([{ url: API_BASE_PATH }]);
    expect(document.security).toEqual([{ bearer: [] }]);
    expect(document.components?.securitySchemes).toEqual({
      bearer: { type: "http", scheme: "bearer" },
    });
  });
});

describeDb("the served API", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let projectId: string;

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    projectId = await api.createProject(owner);
  });

  afterAll(async () => {
    await api?.drop();
  });

  it("serves the document without credentials", async () => {
    const response = await api.handle(new Request(`${ORIGIN}${OPENAPI_DOCUMENT_PATH}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      JSON.parse(JSON.stringify(await generateOpenAPIDocument())),
    );
  });

  it("answers each documented operation with its documented statuses", async () => {
    const key = await api.createKey(owner, projectId);
    // PLAN-1, which the Plan routes below address.
    const plan = await api.request(`/projects/${projectId}/plans`, {
      token: owner.token,
      body: { planId: crypto.randomUUID(), title: "Addressed" },
    });
    expect(plan.status).toBe(200);
    // A Session whose history the Session event route reads; the Session
    // routes still stubbed use their own id below.
    const [readSession] = await api.testDb.db
      .insert(agentSession)
      .values({
        projectId,
        ownerKind: "user",
        userId: owner.id,
        agent: "openapi",
        intent: "Read",
        creationFingerprint: "0".repeat(64),
      })
      .returning();
    if (!readSession) throw new Error("Session insert returned no row.");
    const nestedIdOverrides: Record<string, Record<string, string>> = {
      listSessionEvents: { "{sessionId}": readSession.id },
    };
    // A valid request for each operation, as the owner.
    const sessionId = crypto.randomUUID();
    const bodies: Record<string, unknown> = {
      createProject: { organizationId: owner.organizationId, slug: "openapi", name: "OpenAPI" },
      createProjectKey: { name: "openapi" },
      createPlan: { planId: crypto.randomUUID(), title: "OpenAPI" },
      updatePlan: { title: "OpenAPI" },
      setPlanStatus: { status: "active" },
      appendPlanLog: { eventId: crypto.randomUUID(), message: "Progress." },
      addTask: { taskId: crypto.randomUUID(), title: "OpenAPI" },
      claimTask: { sessionId },
      releaseTask: { sessionId },
      startTask: { sessionId },
      blockTask: { sessionId, reason: "Waiting for review." },
      completeTask: { sessionId },
      startSession: { sessionId, agent: "openapi", intent: "Check the OpenAPI document" },
      updateSession: { status: "idle" },
      heartbeatSession: {},
      attachSession: { planRef: null },
      endSession: { summary: "Checked." },
      addSessionScope: { pattern: "apps/web/**" },
      registerCollectionManifest: {
        pathCount: 0,
        batchCount: 0,
        omittedPathCount: 0,
        contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      uploadCollectionBatch: { batchIndex: 0, paths: ["README.md"] },
      finalizeCollection: {},
    };
    const nestedIds: Record<string, string> = {
      "{planRef}": "PLAN-1",
      "{taskId}": crypto.randomUUID(),
      "{sessionId}": sessionId,
      "{scopeId}": crypto.randomUUID(),
      "{collectionId}": crypto.randomUUID(),
    };
    for (const operation of await documentedOperations()) {
      let path = operation.path.replace("{id}", projectId).replace("{keyId}", key.id);
      const ids = { ...nestedIds, ...nestedIdOverrides[operation.operationId] };
      for (const [parameter, value] of Object.entries(ids)) {
        path = path.replace(parameter, value);
      }
      const response = await api.request(path, {
        method: operation.method as Method,
        token: owner.token,
        body: bodies[operation.operationId],
      });
      if (NOT_YET_SERVED.has(operation.operationId)) {
        // The request passed input validation and reached the stub.
        expect([operation.operationId, response.status]).toEqual([operation.operationId, 500]);
        expect(await response.json()).toMatchObject({ message: NOT_IMPLEMENTED_MESSAGE });
      } else {
        expect([operation.operationId, response.status]).toEqual([
          operation.operationId,
          operation.successStatus,
        ]);
      }

      const anonymous = await api.request(path, {
        method: operation.method as Method,
        body: bodies[operation.operationId],
      });
      expect(anonymous.status).toBe(401);
      expect(operation.errorStatuses).toContain(anonymous.status);
    }
  });
});
