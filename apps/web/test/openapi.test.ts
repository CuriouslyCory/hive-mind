import { readFile } from "node:fs/promises";
import {
  API_BASE_PATH,
  API_ERRORS,
  feedOriginCursor,
  MAX_CURSOR_LENGTH,
  touchedPathsContentHash,
} from "@hivemind/contract";
import { agentSession } from "@hivemind/db/schema";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateOpenAPIDocument, OPENAPI_DOCUMENT_PATH } from "../src/server/api/router";
import {
  type ApiHarness,
  createApiHarness,
  errorCode,
  ORIGIN,
  type SignedInUser,
} from "./support/api";

// The OpenAPI document is generated from the contract the server implements.
// These tests pin it to the contract's golden route tables (the M1 routes, the
// coordination routes of #12 and the Event stream of #11) and check that the
// running handler answers each documented operation with its documented
// success status.

const ROUTE_FIXTURES = ["routes.json", "routes.coordination.json", "routes.realtime.json"];

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

  it("describes the Event stream as Server-Sent Events of stream frames", async () => {
    const document = await generateOpenAPIDocument();
    const operation = document.paths?.["/projects/{id}/events/stream"]?.get;
    expect(operation?.operationId).toBe("streamProjectEvents");
    const content = (operation?.responses?.["200"] as { content?: Record<string, unknown> })
      ?.content;
    expect(Object.keys(content ?? {})).toEqual(["text/event-stream"]);
    // The message data is the frame union, discriminated by `type`.
    const text = JSON.stringify(content);
    for (const type of ["event", "heartbeat", "access_lost"]) {
      expect(text).toContain(JSON.stringify(type));
    }
    const parameters = (operation?.parameters ?? []) as { name?: string; in?: string }[];
    expect(parameters.map(({ name, in: location }) => `${location} ${name}`).sort()).toEqual([
      "path id",
      "query cursor",
    ]);
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

  it("checks the Event stream's access and cursor before it opens", async () => {
    const path = `/projects/${projectId}/events/stream`;
    const stream = (query = "", headers: Record<string, string> = {}) =>
      api.request(`${path}${query}`, { token: owner.token, headers });
    const valid = feedOriginCursor(projectId);
    const foreign = feedOriginCursor(crypto.randomUUID());

    for (const response of [
      await stream(),
      await stream(`?cursor=${valid}`),
      await stream("", { "last-event-id": valid }),
      // Last-Event-ID wins over the query cursor.
      await stream(`?cursor=${foreign}`, { "last-event-id": valid }),
    ]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      await response.body?.cancel();
    }

    for (const response of [
      await stream(`?cursor=${foreign}`),
      await stream("?cursor=not-a-cursor"),
      await stream(`?cursor=${"A".repeat(MAX_CURSOR_LENGTH + 1)}`),
      await stream("", { "last-event-id": foreign }),
      await stream(`?cursor=${valid}`, { "last-event-id": "not-a-cursor" }),
    ]) {
      expect([response.status, await errorCode(response)]).toEqual([400, "BAD_REQUEST"]);
    }

    const stranger = await api.signUp();
    const hidden = await api.request(path, { token: stranger.token });
    expect([hidden.status, await errorCode(hidden)]).toEqual([404, "NOT_FOUND"]);
    const anonymous = await api.request(path);
    expect(anonymous.status).toBe(401);
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
    const call = async (path: string, body?: unknown) => {
      const response = await api.request(`/projects/${projectId}${path}`, {
        token: owner.token,
        body,
      });
      expect([path, response.status]).toEqual([path, 200]);
      return (await response.json()) as Record<string, unknown>;
    };
    // PLAN-1, which the Plan routes below address; active, so its Tasks can be claimed.
    await call("/plans", { planId: crypto.randomUUID(), title: "Addressed", status: "active" });
    // A Session whose history the Session event route reads.
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

    const startBody = { agent: "openapi", intent: "Check the OpenAPI document" };
    const newSession = async () => {
      const sessionId = crypto.randomUUID();
      await call("/sessions", { sessionId, ...startBody });
      return sessionId;
    };
    const newTask = async () => {
      const taskId = crypto.randomUUID();
      await call("/plans/PLAN-1/tasks", { taskId, title: "OpenAPI" });
      return taskId;
    };
    // A Task claimed by a new Session, for the actions that need a claim.
    const claimed = async () => {
      const sessionId = await newSession();
      const taskId = await newTask();
      await call(`/tasks/${taskId}/claim`, { sessionId });
      return { ids: { "{taskId}": taskId }, body: { sessionId } };
    };
    // A new Session's current collection, optionally with a registered manifest.
    const collection = async (paths?: string[]) => {
      const sessionId = await newSession();
      const { collectionId } = await call(`/sessions/${sessionId}/heartbeat`, {});
      if (paths) {
        await call(`/sessions/${sessionId}/collections/${collectionId}/manifest`, {
          pathCount: paths.length,
          batchCount: Math.ceil(paths.length / 16),
          omittedPathCount: 0,
          contentHash: await touchedPathsContentHash(paths),
        });
      }
      return { "{sessionId}": sessionId, "{collectionId}": String(collectionId) };
    };

    // The shared Session most Session routes address; the startSession
    // operation below replays its start (`created: false`).
    const sessionId = crypto.randomUUID();
    await call("/sessions", { sessionId, ...startBody });

    // A valid request for each operation, as the owner.
    const bodies: Record<string, unknown> = {
      createProject: { organizationId: owner.organizationId, slug: "openapi", name: "OpenAPI" },
      createProjectKey: { name: "openapi" },
      createPlan: { planId: crypto.randomUUID(), title: "OpenAPI" },
      updatePlan: { title: "OpenAPI" },
      setPlanStatus: { status: "active" },
      appendPlanLog: { eventId: crypto.randomUUID(), message: "Progress." },
      addTask: { taskId: crypto.randomUUID(), title: "OpenAPI" },
      startSession: { sessionId, ...startBody },
      updateSession: { status: "idle" },
      heartbeatSession: {},
      attachSession: { planRef: "PLAN-1" },
      addSessionScope: { pattern: "apps/web/**" },
      registerCollectionManifest: {
        pathCount: 0,
        batchCount: 0,
        omittedPathCount: 0,
        contentHash: await touchedPathsContentHash([]),
      },
      uploadCollectionBatch: { batchIndex: 0, paths: ["README.md"] },
      finalizeCollection: {},
    };
    // Operations that change what they address get records of their own, so
    // the document's operation order does not matter.
    const prepare: Record<string, () => Promise<{ ids?: Record<string, string>; body?: unknown }>> =
      {
        listSessionEvents: async () => ({ ids: { "{sessionId}": readSession.id } }),
        claimTask: async () => ({
          ids: { "{taskId}": await newTask() },
          body: { sessionId: await newSession() },
        }),
        releaseTask: claimed,
        startTask: claimed,
        blockTask: async () => {
          const prepared = await claimed();
          return { ...prepared, body: { ...prepared.body, reason: "Waiting for review." } };
        },
        completeTask: claimed,
        endSession: async () => ({
          ids: { "{sessionId}": await newSession() },
          body: { summary: "Checked." },
        }),
        registerCollectionManifest: async () => ({ ids: await collection() }),
        uploadCollectionBatch: async () => ({ ids: await collection(["README.md"]) }),
        finalizeCollection: async () => ({ ids: await collection([]) }),
      };
    const nestedIds: Record<string, string> = {
      "{planRef}": "PLAN-1",
      "{sessionId}": sessionId,
      "{scopeId}": crypto.randomUUID(),
    };
    for (const operation of await documentedOperations()) {
      const prepared = await prepare[operation.operationId]?.();
      const body = prepared?.body ?? bodies[operation.operationId];
      let path = operation.path.replace("{id}", projectId).replace("{keyId}", key.id);
      const ids = { ...nestedIds, ...prepared?.ids };
      for (const [parameter, value] of Object.entries(ids)) {
        path = path.replace(parameter, value);
      }
      expect(path).not.toContain("{");
      const response = await api.request(path, {
        method: operation.method as Method,
        token: owner.token,
        body,
      });
      expect([operation.operationId, response.status]).toEqual([
        operation.operationId,
        operation.successStatus,
      ]);

      const anonymous = await api.request(path, {
        method: operation.method as Method,
        body,
      });
      expect(anonymous.status).toBe(401);
      expect(operation.errorStatuses).toContain(anonymous.status);
    }
  });
});
