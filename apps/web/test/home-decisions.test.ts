import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type HomeDecisionsInput,
  loadRecentDecisions,
} from "../src/server/dashboard/home-decisions";
import { type ApiHarness, createApiHarness, type SignedInUser } from "./support/api";
import { insertFutureEvent } from "./support/future-events";

// The home page's Decisions panel (src/server/dashboard/home-decisions.ts)
// against a real database, with decisions recorded through the real
// `/api/v1` handler: newest first across the Projects in scope, the `q`
// filter, the limit, and actor attribution by User and Project key.

describeDb("home dashboard decisions", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let projectA: string;
  let projectB: string;
  let projectC: string;
  let keyB: { id: string; secret: string };
  const ids = { queue: "", backoff: "", quota: "", hidden: "" };

  const uuid = () => crypto.randomUUID();

  async function ok<T>(token: string, path: string, body: unknown): Promise<T> {
    const response = await api.request(path, { token, body });
    if (response.status !== 200) {
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async function createPlan(token: string, projectId: string) {
    const { plan } = await ok<{ plan: { id: string; key: string } }>(
      token,
      `/projects/${projectId}/plans`,
      { planId: uuid(), title: "Plan", status: "active" },
    );
    return plan;
  }

  async function startSession(token: string, projectId: string, agent: string) {
    const { session } = await ok<{ session: { id: string } }>(
      token,
      `/projects/${projectId}/sessions`,
      { sessionId: uuid(), agent, intent: "Deciding" },
    );
    return session.id;
  }

  async function decide(
    token: string,
    projectId: string,
    planKey: string,
    text: string,
    sessionId?: string,
  ) {
    const eventId = uuid();
    await ok(token, `/projects/${projectId}/plans/${planKey}/decisions`, {
      eventId,
      text,
      sessionId,
    });
    return eventId;
  }

  function load(overrides: Partial<HomeDecisionsInput> = {}) {
    return api.testDb.db.transaction((tx) =>
      loadRecentDecisions(tx, {
        projects: [
          { id: projectA, name: "Alpha" },
          { id: projectB, name: "Beta" },
        ],
        q: "",
        limit: 10,
        ...overrides,
      }),
    );
  }

  const idsOf = async (overrides: Partial<HomeDecisionsInput> = {}) =>
    (await load(overrides)).map((decision) => decision.id);

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    projectA = await api.createProject(owner);
    projectB = await api.createProject(owner);
    projectC = await api.createProject(owner);
    keyB = await api.createKey(owner, projectB, { name: "deploy-bot" });

    const planA1 = await createPlan(owner.token, projectA);
    const planA2 = await createPlan(owner.token, projectA);
    const planB = await createPlan(owner.token, projectB);
    const planC = await createPlan(owner.token, projectC);
    const ownerSession = await startSession(owner.token, projectA, "claude-code");
    const keySession = await startSession(keyB.secret, projectB, "codex");

    // Oldest first. A Plan log entry is not a decision.
    ids.queue = await decide(
      owner.token,
      projectA,
      planA1.key,
      "Use one queue per Project.",
      ownerSession,
    );
    await ok(owner.token, `/projects/${projectA}/plans/${planA1.key}/log`, {
      eventId: uuid(),
      message: "Decided on jittered backoff, 100% sure.",
    });
    ids.backoff = await decide(
      keyB.secret,
      projectB,
      planB.key,
      "Retry with jittered backoff, capped at 30 seconds.",
      keySession,
    );
    ids.quota = await decide(owner.token, projectA, planA2.key, "Cap uploads at 100% of quota.");
    ids.hidden = await decide(owner.token, projectC, planC.key, "Jittered, but out of scope.");
    // The newest row: a decision written by a newer deployment, which this
    // build cannot read. It matches every filter below and is never shown.
    await insertFutureEvent(api.testDb.db, {
      projectId: projectA,
      type: "plan.decision_recorded",
      payloadVersion: 2,
      payload: { text: "jittered 100% codex", rationale: "newer" },
      planId: planA1.id,
    });
  });

  afterAll(async () => {
    await api?.drop();
  });

  it("lists decisions newest first across the Projects in scope only", async () => {
    expect(await idsOf()).toEqual([ids.quota, ids.backoff, ids.queue]);
    expect(await idsOf({ projects: [{ id: projectB, name: "Beta" }] })).toEqual([ids.backoff]);
  });

  it("attributes each decision to its User or Project key and the Session's agent", async () => {
    const [quota, backoff, queue] = await load();
    expect(queue).toEqual({
      id: ids.queue,
      projectId: projectA,
      projectName: "Alpha",
      planKey: "PLAN-1",
      text: "Use one queue per Project.",
      actor: { kind: "user", userId: owner.id, name: owner.name },
      actorAgent: "claude-code",
      at: expect.any(Date),
    });
    expect(backoff).toMatchObject({
      projectId: projectB,
      projectName: "Beta",
      planKey: "PLAN-1",
      actor: { kind: "project_key", keyId: keyB.id, name: "deploy-bot", revoked: false },
      actorAgent: "codex",
    });
    expect(quota).toMatchObject({ planKey: "PLAN-2", actorAgent: null });
    expect(quota && backoff && quota.at > backoff.at).toBe(true);
  });

  it("caps the list at the limit, skipping unreadable rows", async () => {
    expect(await idsOf({ limit: 1 })).toEqual([ids.quota]);
    expect(await idsOf({ limit: 2 })).toEqual([ids.quota, ids.backoff]);
    expect(await idsOf({ limit: 0 })).toEqual([]);
  });

  it("filters by text, Plan key, agent and Project name, case-insensitively", async () => {
    expect(await idsOf({ q: "JITTERED" })).toEqual([ids.backoff]);
    expect(await idsOf({ q: "plan-2" })).toEqual([ids.quota]);
    expect(await idsOf({ q: "Codex" })).toEqual([ids.backoff]);
    expect(await idsOf({ q: "alpha" })).toEqual([ids.quota, ids.queue]);
    expect(await idsOf({ q: "out of scope" })).toEqual([]);
  });

  it("matches LIKE wildcards literally", async () => {
    expect(await idsOf({ q: "100%" })).toEqual([ids.quota]);
    expect(await idsOf({ q: "%" })).toEqual([ids.quota]);
    expect(await idsOf({ q: "_" })).toEqual([]);
    expect(await idsOf({ q: "\\" })).toEqual([]);
  });

  it("shows a revoked key as revoked", async () => {
    const revoked = await api.request(`/projects/${projectB}/keys/${keyB.id}`, {
      token: owner.token,
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    const backoff = (await load()).find((decision) => decision.id === ids.backoff);
    expect(backoff?.actor).toEqual({
      kind: "project_key",
      keyId: keyB.id,
      name: null,
      revoked: true,
    });
  });
});
