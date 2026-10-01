import { and, eq, gt, inArray, ne, type SQL, sql } from "drizzle-orm";
import { type CoordinationContext, withCoordinationLock } from "./coordination.ts";
import { insertEvent } from "./event.ts";
import type { Db } from "./index.ts";
import {
  abandonedAt,
  type Conflict,
  claimableCondition,
  claimConflictMessage,
  claimedBy,
  conflict,
  type Forbidden,
  loadOwnedSession,
  type NotFound,
  notFound,
  notLiveSessionConflict,
  releaseClaims,
  type SessionState,
  sessionState,
  staleAt,
} from "./lifecycle.ts";
import { CLAIM_LEASE_MS, isClaimUsable } from "./liveness.ts";
import type { Principal } from "./principal.ts";
import {
  type AgentSession,
  agentSession,
  type PlanStatus,
  plan,
  type Task,
  task,
} from "./schema/coordination.ts";

// Task work actions (issue #12, "Lifecycle, leases and transitions";
// ADR-0014): claim, steal, release, start, block and done, each under the
// Project's coordination lock with its Event in the same transaction.
//
// Every action needs the caller's own Session. Each state change is a
// conditional UPDATE whose WHERE clause repeats the rule it enforces (for a
// claim: the Task is unclaimed, its lease expired or its holder is not live),
// so the decision is made by the row the database changes, never by a read
// followed by an unconditional write. Reads before it only choose the answer
// and the Events. A non-ok outcome writes nothing; a no-op (`changed: false`)
// writes no Event.

export interface TaskActionInput {
  projectId: string;
  taskId: string;
  /** The caller's Session the action is made through. */
  sessionId: string;
  principal: Principal;
}

/** A live competing claim: its holder, for the conflict message. */
export type ClaimConflict = Conflict & { holder?: { sessionId: string; intent: string } };

export type TaskActionOutcome<T = object> =
  | ({ status: "ok"; task: Task; changed: boolean } & T)
  | NotFound
  | Forbidden
  | ClaimConflict;

interface LoadedAction {
  session: SessionState;
  task: Task;
  planStatus: PlanStatus;
  /** The Session holding `task`'s claim, if any. */
  holder: AgentSession | null;
}

/**
 * Loads the caller's Session and the Task with its Plan's status. The
 * Session must be the caller's (else `not_found`/`forbidden`), and the Task
 * must belong to the Project (else `not_found`).
 */
async function loadAction(
  { tx, now }: CoordinationContext,
  input: TaskActionInput,
): Promise<NotFound | Forbidden | ({ status: "ok" } & LoadedAction)> {
  const loaded = await loadOwnedSession(tx, input.projectId, input.sessionId, input.principal, now);
  if (loaded.status !== "ok") return loaded;
  const [found] = await tx
    .select({ task, planStatus: plan.status })
    .from(task)
    .innerJoin(plan, and(eq(plan.id, task.planId), eq(plan.projectId, task.projectId)))
    .where(and(eq(task.id, input.taskId), eq(task.projectId, input.projectId)))
    .limit(1);
  if (!found) return notFound;
  let holder: AgentSession | null = null;
  if (found.task.claimedBySessionId !== null) {
    if (found.task.claimedBySessionId === loaded.session.id) {
      holder = loaded.session;
    } else {
      const [row] = await tx
        .select()
        .from(agentSession)
        .where(eq(agentSession.id, found.task.claimedBySessionId))
        .limit(1);
      holder = row ?? null;
    }
  }
  return {
    status: "ok",
    session: loaded.session,
    task: found.task,
    planStatus: found.planStatus,
    holder,
  };
}

/** The conflict for a Task whose claim the caller does not currently hold. */
function notHolderConflict(loaded: LoadedAction, now: Date): ClaimConflict {
  const { holder, task: row, session } = loaded;
  if (holder && holder.id !== session.id && isClaimUsable(row, holder, now)) {
    const conflictHolder = { sessionId: holder.id, intent: holder.intent };
    return { ...conflict(claimConflictMessage(conflictHolder)), holder: conflictHolder };
  }
  return conflict(
    `Session ${session.id} does not hold a current claim on this Task. Claim it first.`,
  );
}

/** Condition on `task`: the caller holds a current (unexpired) claim. */
function heldBy(sessionId: string, now: Date): SQL {
  return and(claimedBy(sessionId), gt(task.leaseExpiresAt, now)) as SQL;
}

/**
 * Claims a Task for the caller's live Session. The Plan must be active and
 * the Task not done. Succeeds when the Task is unclaimed, its lease has
 * expired or its holder is not live (stale, ended or abandoned); the old
 * claim is released with a `system` Event effective when it lapsed. A live
 * competing claim is a conflict naming the holder, unless `steal` is set,
 * which takes the claim over; its `task.claimed` Event names the former
 * holder in `stolenFromSessionId`. The holder repeating its valid claim is a no-op: no lease
 * extension, no Event.
 */
export async function claimTask(
  db: Db,
  input: TaskActionInput & { steal?: boolean },
): Promise<TaskActionOutcome<{ stolenFromSessionId: string | null }>> {
  return withCoordinationLock(db, input.projectId, async (context) => {
    const { tx, now } = context;
    const loaded = await loadAction(context, input);
    if (loaded.status !== "ok") return loaded;
    const { session, task: before, holder } = loaded;
    const notLive = notLiveSessionConflict(session);
    if (notLive) return notLive;
    if (loaded.planStatus !== "active") {
      return conflict(
        `The Plan is ${loaded.planStatus}; Tasks can be claimed only in an active Plan.`,
      );
    }
    if (before.status === "done") return conflict("The Task is done.");
    if (holder?.id === session.id && isClaimUsable(before, holder, now)) {
      return { status: "ok", task: before, changed: false, stolenFromSessionId: null };
    }

    const eligible = input.steal ? sql`true` : claimableCondition(now);
    const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    const [claimed] = await tx
      .update(task)
      .set({ claimedBySessionId: session.id, claimedAt: now, leaseExpiresAt, updatedAt: now })
      .where(
        and(
          eq(task.id, before.id),
          eq(task.projectId, input.projectId),
          ne(task.status, "done"),
          sql`exists (select 1 from ${plan} where ${plan.id} = ${task.planId} and ${plan.status} = 'active')`,
          eligible,
        ),
      )
      .returning();
    if (!claimed) return notHolderConflict(loaded, now);

    let stolenFromSessionId: string | null = null;
    const actor = { ...input.principal, sessionId: session.id };
    if (holder && before.leaseExpiresAt) {
      if (holder.id !== session.id && isClaimUsable(before, holder, now)) {
        stolenFromSessionId = holder.id;
      } else {
        // The old claim had lapsed: record when, attributed to the system.
        const holderState = sessionState(holder, now);
        const leaseLapsed = before.leaseExpiresAt.getTime() <= now.getTime();
        const reason = leaseLapsed
          ? "lease_expired"
          : holderState.effectiveStatus === "stale"
            ? "session_stale"
            : "session_abandoned";
        await insertEvent(tx, {
          projectId: input.projectId,
          type: "task.released",
          payload: { reason },
          actor: { kind: "system" },
          planId: before.planId,
          taskId: before.id,
          sessionId: holder.id,
          now,
          effectiveAt: leaseLapsed
            ? before.leaseExpiresAt
            : reason === "session_stale"
              ? staleAt(holder)
              : abandonedAt(holder),
        });
      }
    }
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "task.claimed",
      payload: { stolenFromSessionId, leaseExpiresAt: leaseExpiresAt.toISOString() },
      actor,
      planId: claimed.planId,
      taskId: claimed.id,
      sessionId: session.id,
      now,
    });
    return { status: "ok", task: claimed, changed: true, stolenFromSessionId };
  });
}

/**
 * Releases the caller's claim on a Task, keeping its progress status. An
 * unclaimed Task, or one whose only claim has lapsed and belongs to another
 * Session, is a no-op, recognized before the liveness check so a retried
 * release succeeds. A live claim of another Session is a conflict. A claim
 * of the caller whose lease expired is released as `lease_expired`.
 */
export async function releaseTask(db: Db, input: TaskActionInput): Promise<TaskActionOutcome> {
  return withCoordinationLock(db, input.projectId, async (context) => {
    const { tx, now } = context;
    const loaded = await loadAction(context, input);
    if (loaded.status !== "ok") return loaded;
    const { session, task: before, holder } = loaded;
    if (!holder) return { status: "ok", task: before, changed: false };
    if (holder.id !== session.id) {
      return isClaimUsable(before, holder, now)
        ? notHolderConflict(loaded, now)
        : { status: "ok", task: before, changed: false };
    }
    const notLive = notLiveSessionConflict(session);
    if (notLive) return notLive;

    await releaseClaims(tx, {
      projectId: input.projectId,
      now,
      where: and(eq(task.id, before.id), claimedBy(session.id)) as SQL,
      reason: "released",
      actor: { ...input.principal, sessionId: session.id },
    });
    const [after] = await tx.select().from(task).where(eq(task.id, before.id));
    if (!after) throw new Error("task disappeared under the coordination lock");
    return { status: "ok", task: after, changed: true };
  });
}

/**
 * Starts work on a Task: `todo` or `blocked` to `in_progress`, clearing the
 * block reason. Needs the caller's current claim and an active Plan (a paused
 * Plan allows no start). Already `in_progress` is a no-op.
 */
export async function startTask(db: Db, input: TaskActionInput): Promise<TaskActionOutcome> {
  return withCoordinationLock(db, input.projectId, async (context) => {
    const { tx, now } = context;
    const loaded = await loadAction(context, input);
    if (loaded.status !== "ok") return loaded;
    const { session, task: before } = loaded;
    const notLive = notLiveSessionConflict(session);
    if (notLive) return notLive;
    if (loaded.planStatus !== "active") {
      return conflict(
        `The Plan is ${loaded.planStatus}; Tasks can be started only in an active Plan.`,
      );
    }
    if (before.status === "done") return conflict("The Task is done.");
    const holds = loaded.holder?.id === session.id && isClaimUsable(before, loaded.holder, now);
    if (holds && before.status === "in_progress") {
      return { status: "ok", task: before, changed: false };
    }

    const [started] = await tx
      .update(task)
      .set({ status: "in_progress", blockReason: null, updatedAt: now })
      .where(
        and(
          eq(task.id, before.id),
          heldBy(session.id, now),
          inArray(task.status, ["todo", "blocked"]),
        ),
      )
      .returning();
    if (started) {
      await insertEvent(tx, {
        projectId: input.projectId,
        type: "task.started",
        payload: { from: before.status },
        actor: { ...input.principal, sessionId: session.id },
        planId: started.planId,
        taskId: started.id,
        sessionId: session.id,
        now,
      });
      return { status: "ok", task: started, changed: true };
    }
    return notHolderConflict(loaded, now);
  });
}

/**
 * Marks a Task blocked with a reason, keeping the caller's claim and lease.
 * Needs the caller's current claim; allowed in an active or paused Plan. The
 * same reason again is a no-op; a new reason replaces it.
 */
export async function blockTask(
  db: Db,
  input: TaskActionInput & { reason: string },
): Promise<TaskActionOutcome> {
  return withCoordinationLock(db, input.projectId, async (context) => {
    const { tx, now } = context;
    const loaded = await loadAction(context, input);
    if (loaded.status !== "ok") return loaded;
    const { session, task: before } = loaded;
    const notLive = notLiveSessionConflict(session);
    if (notLive) return notLive;
    const closed = closedPlanConflict(loaded.planStatus);
    if (closed) return closed;
    if (before.status === "done") return conflict("The Task is done.");
    const holds = loaded.holder?.id === session.id && isClaimUsable(before, loaded.holder, now);
    if (holds && before.status === "blocked" && before.blockReason === input.reason) {
      return { status: "ok", task: before, changed: false };
    }

    const [blocked] = await tx
      .update(task)
      .set({ status: "blocked", blockReason: input.reason, updatedAt: now })
      .where(and(eq(task.id, before.id), heldBy(session.id, now), ne(task.status, "done")))
      .returning();
    if (!blocked) return notHolderConflict(loaded, now);
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "task.blocked",
      payload: { from: before.status, reason: input.reason },
      actor: { ...input.principal, sessionId: session.id },
      planId: blocked.planId,
      taskId: blocked.id,
      sessionId: session.id,
      now,
    });
    return { status: "ok", task: blocked, changed: true };
  });
}

/**
 * Marks a Task done and clears its claim. Needs the caller's current claim;
 * allowed in an active or paused Plan. A Task that is already done is a
 * no-op, so a retried `done` succeeds.
 */
export async function doneTask(db: Db, input: TaskActionInput): Promise<TaskActionOutcome> {
  return withCoordinationLock(db, input.projectId, async (context) => {
    const { tx, now } = context;
    const loaded = await loadAction(context, input);
    if (loaded.status !== "ok") return loaded;
    const { session, task: before } = loaded;
    const notLive = notLiveSessionConflict(session);
    if (notLive) return notLive;
    if (before.status === "done") return { status: "ok", task: before, changed: false };
    const closed = closedPlanConflict(loaded.planStatus);
    if (closed) return closed;

    const [done] = await tx
      .update(task)
      .set({
        status: "done",
        blockReason: null,
        claimedBySessionId: null,
        claimedAt: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(task.id, before.id), heldBy(session.id, now)))
      .returning();
    if (!done) return notHolderConflict(loaded, now);
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "task.done",
      payload: { from: before.status },
      actor: { ...input.principal, sessionId: session.id },
      planId: done.planId,
      taskId: done.id,
      sessionId: session.id,
      now,
    });
    return { status: "ok", task: done, changed: true };
  });
}

/** Block and done work in active and paused Plans only. */
function closedPlanConflict(status: PlanStatus): Conflict | undefined {
  if (status === "active" || status === "paused") return undefined;
  return conflict(`The Plan is ${status}; its Tasks cannot change.`);
}
