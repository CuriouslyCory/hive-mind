import { randomUUID } from "node:crypto";
import {
  attachSession as attachSessionRecord,
  type Db,
  endSession as endSessionRecord,
  getSession as getSessionRecord,
  heartbeatSession as heartbeatSessionRecord,
  listSessionClaims as listSessionClaimRecords,
  listSessions as listSessionRecords,
  type PlanRef,
  planNumbers,
  projectHasSession,
  type SessionState,
  sessionViews,
  startSession as startSessionRecord,
  updateSession as updateSessionRecord,
} from "@hivemind/db";
import { apiError } from "./authorize";
import { authorizeProject, lifecycleError, sessionNotFound } from "./coordination-auth";
import { toClaimedTaskIds, toSessionDto, toTaskDto } from "./coordination-dto";
import { api } from "./implementer";
import { decodeKeysetCursor, encodeKeysetCursor, UUID_POSITION } from "./keyset";
import { pageLimit } from "./pagination";

// Sessions (issue #12 step 6): start, read, change, heartbeat and end. Reads
// cover every Session of the Project, whoever owns it; changes need the
// caller's own Session, and another principal's Session of the Project is 403
// (`coordination-auth.ts`). `@hivemind/db` applies the lifecycle rules under
// the Project lock and returns outcomes, which are mapped to HTTP here.

/** The contract DTO of one Session, with its attached Plan's key. */
export async function sessionDto(db: Db, projectId: string, session: SessionState) {
  const [view] = await sessionViews(db, projectId, [session]);
  if (!view) throw new Error("sessionViews returned nothing");
  return toSessionDto(view);
}

/**
 * The 404 for a `not_found` from a route that names a Session and one more
 * record: the Session if it is not in the Project, otherwise `other`.
 */
export async function missingRecord(db: Db, projectId: string, sessionId: string, other: string) {
  return (await projectHasSession(db, projectId, sessionId))
    ? apiError("NOT_FOUND", other)
    : sessionNotFound();
}

/** `GET /projects/{id}/sessions`: most recently started first, optionally filtered. */
export const listSessions = api.projects.sessions.list.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["session:read"]);
    const scope = ["sessions", input.id, input.status];
    const after = input.cursor
      ? decodeKeysetCursor(scope, input.cursor, [UUID_POSITION])[0]
      : undefined;
    const page = await listSessionRecords(db, {
      projectId: input.id,
      filter: input.status,
      limit: pageLimit(input.limit),
      after,
    });
    if (page.status !== "ok") throw lifecycleError(page, sessionNotFound);
    const views = await sessionViews(db, input.id, page.items);
    return {
      items: views.map(toSessionDto),
      nextCursor: page.next ? encodeKeysetCursor(scope, [page.next]) : null,
    };
  },
);

/** `POST /projects/{id}/sessions`: start a Session owned by the caller, replay-safe. */
export const startSession = api.projects.sessions.start.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["session:write"]);
    const outcome = await startSessionRecord(db, {
      projectId: input.id,
      id: input.sessionId,
      principal: access.principal,
      agent: input.agent,
      intent: input.intent,
      machine: input.hostname ?? null,
      gitBranch: input.gitBranch ?? null,
      gitCommit: input.gitCommit ?? null,
      // The contract has no worktree path; the CLI does not send one.
      worktreePath: null,
    });
    // `not_found`: the UUID is taken in another Project, answered like an
    // absent resource without saying which.
    if (outcome.status !== "ok") throw lifecycleError(outcome, () => apiError("NOT_FOUND"));
    return {
      session: await sessionDto(db, input.id, outcome.session),
      created: outcome.created,
    };
  },
);

/** `GET /projects/{id}/sessions/{sessionId}`: any Session of the Project. */
export const getSession = api.projects.sessions.get.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["session:read"]);
    const outcome = await getSessionRecord(db, { projectId: input.id, sessionId: input.sessionId });
    if (outcome.status !== "ok") throw sessionNotFound();
    return sessionDto(db, input.id, outcome.session);
  },
);

/** `PATCH /projects/{id}/sessions/{sessionId}`: metadata or active/idle of the caller's Session. */
export const updateSession = api.projects.sessions.update.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["session:write"]);
    const outcome = await updateSessionRecord(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      changes: {
        agent: input.agent,
        intent: input.intent,
        machine: input.hostname,
        gitBranch: input.gitBranch,
        gitCommit: input.gitCommit,
        status: input.status,
      },
    });
    if (outcome.status !== "ok") throw lifecycleError(outcome, sessionNotFound);
    return { session: await sessionDto(db, input.id, outcome.session), changed: outcome.changed };
  },
);

const PLAN_KEY = /^PLAN-([1-9][0-9]{0,8})$/;

function toPlanRef(ref: string): PlanRef {
  const key = PLAN_KEY.exec(ref);
  return key ? { number: Number(key[1]) } : { id: ref.toLowerCase() };
}

/** `POST /projects/{id}/sessions/{sessionId}/attach`: set or clear the caller's Session focus. */
export const attachSession = api.projects.sessions.attach.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["session:write"]);
    const outcome = await attachSessionRecord(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      plan: input.planRef === null ? null : toPlanRef(input.planRef),
      taskId: input.taskId ?? null,
    });
    if (outcome.status !== "ok") {
      throw outcome.status === "not_found"
        ? await missingRecord(db, input.id, input.sessionId, "Plan or Task not found.")
        : lifecycleError(outcome, sessionNotFound);
    }
    return { session: await sessionDto(db, input.id, outcome.session), changed: outcome.changed };
  },
);

/**
 * `POST /projects/{id}/sessions/{sessionId}/heartbeat`. Every call opens a
 * new touched-path collection under a UUID generated here, so a delayed or
 * repeated heartbeat can never resume an older collection; resuming one is
 * done by calling the collection routes with its UUID instead.
 */
export const heartbeatSession = api.projects.sessions.heartbeat.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["session:write"]);
    const outcome = await heartbeatSessionRecord(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      collectionId: randomUUID(),
      sessionStatus: input.status,
    });
    if (outcome.status !== "ok") throw lifecycleError(outcome, sessionNotFound);
    return {
      session: await sessionDto(db, input.id, outcome.session),
      previousStatus: outcome.previousStatus,
      renewedClaims: toClaimedTaskIds(outcome.renewedTaskIds),
      releasedClaims: toClaimedTaskIds(outcome.releasedTaskIds),
      leaseExpiresAt: outcome.leaseExpiresAt?.toISOString() ?? null,
      collectionId: outcome.collectionId,
      historicalScopeComplete: !outcome.session.scopeHistoryIncomplete,
    };
  },
);

/** `POST /projects/{id}/sessions/{sessionId}/end`: final summary; releases the claims. */
export const endSession = api.projects.sessions.end.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["session:write"]);
    const outcome = await endSessionRecord(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      principal: access.principal,
      summary: input.summary,
    });
    if (outcome.status !== "ok") throw lifecycleError(outcome, sessionNotFound);
    return {
      session: await sessionDto(db, input.id, outcome.session),
      changed: outcome.changed,
      releasedClaims: toClaimedTaskIds(outcome.releasedTaskIds),
    };
  },
);

/** `GET /projects/{id}/sessions/{sessionId}/claims`: the Session's usable claims, oldest first. */
export const listSessionClaims = api.projects.sessions.claims.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["session:read", "task:read"]);
    const scope = ["session-claims", input.id, input.sessionId];
    const after = input.cursor
      ? decodeKeysetCursor(scope, input.cursor, [UUID_POSITION])[0]
      : undefined;
    const page = await listSessionClaimRecords(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      limit: pageLimit(input.limit),
      after,
    });
    if (page.status !== "ok") throw lifecycleError(page, sessionNotFound);
    const numbers = await planNumbers(
      db,
      input.id,
      page.items.map((task) => task.planId),
    );
    return {
      items: page.items.map((task) => {
        const planNumber = numbers.get(task.planId);
        // Every listed claim is usable at the read's time, so all are set.
        if (planNumber === undefined || !task.claimedAt || !task.leaseExpiresAt) {
          throw new Error(`Claimed task ${task.id} is missing its Plan or claim.`);
        }
        return toTaskDto({
          task,
          planNumber,
          claim: {
            sessionId: input.sessionId,
            claimedAt: task.claimedAt,
            leaseExpiresAt: task.leaseExpiresAt,
          },
        });
      }),
      nextCursor: page.next ? encodeKeysetCursor(scope, [page.next]) : null,
    };
  },
);
