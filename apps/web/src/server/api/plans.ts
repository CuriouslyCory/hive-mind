import {
  addTask as addTaskRecord,
  appendPlanLog as appendPlanLogRecord,
  createPlan as createPlanRecord,
  getPlan as getPlanRecord,
  listPlans as listPlanRecords,
  listPlanTasks as listPlanTaskRecords,
  recordPlanDecision as recordPlanDecisionRecord,
  resolvePlan,
  setPlanStatus as setPlanStatusRecord,
  updatePlan as updatePlanRecord,
} from "@hivemind/db";
import { authorizeProject, coordinationError, planNotFound } from "./coordination-auth";
import { toEventDto, toPlanDto, toPlanSummaryDto, toTaskDto } from "./coordination-dto";
import { listEventPage } from "./events";
import { api } from "./implementer";
import { decodeKeysetCursor, encodeKeysetCursor, INT4_POSITION, UUID_POSITION } from "./keyset";
import { pageLimit } from "./pagination";

// Plans, their Tasks (add and list), their log (issue #12 step 5) and their
// recorded decisions. Each handler authorizes the Project and the route's
// permissions first (`coordination-auth.ts`), then calls `@hivemind/db`, which
// resolves the Plan within that Project and maps nothing to HTTP itself.

/** `GET /projects/{id}/plans`: newest Plan first, optionally one status. */
export const listPlans = api.projects.plans.list.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["plan:read"]);
    const limit = pageLimit(input.limit);
    const scope = ["plans", input.id, input.status];
    const beforeNumber = input.cursor
      ? Number(decodeKeysetCursor(scope, input.cursor, [INT4_POSITION])[0])
      : undefined;
    const page = await listPlanRecords(db, {
      projectId: input.id,
      status: input.status,
      limit,
      beforeNumber,
    });
    const last = page.items.at(-1);
    return {
      items: page.items.map(toPlanSummaryDto),
      nextCursor:
        page.hasMore && last ? encodeKeysetCursor(scope, [String(last.plan.number)]) : null,
    };
  },
);

/** `POST /projects/{id}/plans`: create under the client's UUID, replay-safe. */
export const createPlan = api.projects.plans.create.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["plan:write"]);
    const outcome = await createPlanRecord(db, {
      projectId: input.id,
      principal: access.principal,
      sessionId: input.sessionId,
      id: input.planId,
      title: input.title,
      body: input.body,
      status: input.status,
    });
    if (outcome.status !== "created" && outcome.status !== "replay") {
      throw coordinationError(outcome);
    }
    return { plan: toPlanDto(outcome.plan), created: outcome.status === "created" };
  },
);

/** `GET /projects/{id}/plans/{planRef}`: the Plan and its progress, no Tasks or Events. */
export const getPlan = api.projects.plans.get.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["plan:read"]);
    const view = await getPlanRecord(db, input.id, input.planRef);
    if (!view) throw planNotFound();
    return toPlanDto(view);
  },
);

/** `PATCH /projects/{id}/plans/{planRef}`: title and/or body of an open Plan. */
export const updatePlan = api.projects.plans.update.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["plan:write"]);
    const outcome = await updatePlanRecord(db, {
      projectId: input.id,
      principal: access.principal,
      sessionId: input.sessionId,
      ref: input.planRef,
      title: input.title,
      body: input.body,
    });
    if (outcome.status !== "ok") throw coordinationError(outcome);
    return { plan: toPlanDto(outcome.plan), changed: outcome.changed };
  },
);

/** `POST /projects/{id}/plans/{planRef}/status`: one lifecycle transition. */
export const setPlanStatus = api.projects.plans.setStatus.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["plan:write"]);
    const outcome = await setPlanStatusRecord(db, {
      projectId: input.id,
      principal: access.principal,
      sessionId: input.sessionId,
      ref: input.planRef,
      status: input.status,
    });
    if (outcome.status !== "ok") throw coordinationError(outcome);
    return {
      plan: toPlanDto(outcome.plan),
      changed: outcome.changed,
      releasedClaimCount: outcome.releasedClaimCount,
    };
  },
);

/** `GET /projects/{id}/plans/{planRef}/log`: the Plan's Events, newest first. */
export const listPlanLog = api.projects.plans.log.list.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["plan:read", "event:read"]);
    const plan = await resolvePlan(db, input.id, input.planRef);
    if (!plan) throw planNotFound();
    return listEventPage(db, input.id, { kind: "plan", planId: plan.id }, input);
  },
);

/** `POST /projects/{id}/plans/{planRef}/log`: append an entry, replay-safe. */
export const appendPlanLog = api.projects.plans.log.append.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["plan:write"]);
    const outcome = await appendPlanLogRecord(db, {
      projectId: input.id,
      principal: access.principal,
      sessionId: input.sessionId,
      ref: input.planRef,
      eventId: input.eventId,
      message: input.message,
    });
    if (outcome.status !== "created" && outcome.status !== "replay") {
      throw coordinationError(outcome);
    }
    return { event: toEventDto(outcome.event), created: outcome.status === "created" };
  },
);

/**
 * `POST /projects/{id}/plans/{planRef}/decisions`: record a one-line decision,
 * replay-safe, with the Plan log's permission and replay rules.
 */
export const recordPlanDecision = api.projects.plans.decisions.record.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["plan:write"]);
    const outcome = await recordPlanDecisionRecord(db, {
      projectId: input.id,
      principal: access.principal,
      sessionId: input.sessionId,
      ref: input.planRef,
      eventId: input.eventId,
      text: input.text,
    });
    if (outcome.status !== "created" && outcome.status !== "replay") {
      throw coordinationError(outcome);
    }
    return { event: toEventDto(outcome.event), created: outcome.status === "created" };
  },
);

/** `GET /projects/{id}/plans/{planRef}/tasks`: by position, claims judged at read time. */
export const listPlanTasks = api.projects.plans.tasks.list.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["task:read"]);
    const limit = pageLimit(input.limit);
    // Bound to the Plan reference as given; PLAN-N and the UUID of the same
    // Plan are different lists as far as cursors go.
    const scope = ["plan-tasks", input.id, input.planRef, input.status];
    let after: { position: number; id: string } | undefined;
    if (input.cursor) {
      const [position = "", id = ""] = decodeKeysetCursor(scope, input.cursor, [
        INT4_POSITION,
        UUID_POSITION,
      ]);
      after = { position: Number(position), id };
    }
    const page = await listPlanTaskRecords(db, {
      projectId: input.id,
      ref: input.planRef,
      status: input.status,
      limit,
      after,
    });
    if (!page) throw planNotFound();
    const last = page.items.at(-1);
    return {
      items: page.items.map(toTaskDto),
      nextCursor:
        page.hasMore && last
          ? encodeKeysetCursor(scope, [String(last.task.position), last.task.id])
          : null,
    };
  },
);

/** `POST /projects/{id}/plans/{planRef}/tasks`: add a `todo` Task, replay-safe. */
export const addTask = api.projects.plans.tasks.add.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["task:write"]);
    const outcome = await addTaskRecord(db, {
      projectId: input.id,
      principal: access.principal,
      sessionId: input.sessionId,
      ref: input.planRef,
      taskId: input.taskId,
      title: input.title,
    });
    if (outcome.status !== "created" && outcome.status !== "replay") {
      throw coordinationError(outcome);
    }
    return { task: toTaskDto(outcome.task), created: outcome.status === "created" };
  },
);
