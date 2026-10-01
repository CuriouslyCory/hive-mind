import { and, eq, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { Transaction } from "./coordination.ts";
import { type EventPayloads, insertEvent } from "./event.ts";
import {
  effectiveSessionStatus,
  liveSessionCondition,
  SESSION_ABANDONED_AFTER_MS,
  SESSION_STALE_AFTER_MS,
} from "./liveness.ts";
import { type Actor, type Principal, samePrincipal, sessionOwner } from "./principal.ts";
import {
  type AgentSession,
  agentSession,
  type SessionStatus,
  task,
} from "./schema/coordination.ts";

// Building blocks shared by the Session, Task-claim and sweep operations
// (src/session.ts, src/task-claims.ts, src/sweep.ts). Every function here runs
// inside `withCoordinationLock` or `tryWithCoordinationLock` and takes that
// transaction's database `now` (ADR-0014, "Lifecycle and leases").

/** The Session row with the status it effectively has at the read's `now`. */
export type SessionState = AgentSession & { effectiveStatus: SessionStatus };

export function sessionState(row: AgentSession, now: Date): SessionState {
  return { ...row, effectiveStatus: effectiveSessionStatus(row, now) };
}

/** The absent resource answer: no such record in this Project (or it is in another). */
export type NotFound = { status: "not_found" };
/** A Session of this Project that the caller does not own. */
export type Forbidden = { status: "forbidden" };
/** The request conflicts with current state. `message` is safe to show the caller. */
export type Conflict = { status: "conflict"; message: string };

export const notFound: NotFound = { status: "not_found" };
export const forbidden: Forbidden = { status: "forbidden" };
export function conflict(message: string): Conflict {
  return { status: "conflict", message };
}

/** Longest part of a holder's intent quoted in a claim conflict message. */
export const MAX_CONFLICT_INTENT_LENGTH = 200;

/**
 * The conflict message for a Task another live Session holds: the holder's
 * UUID and a bounded part of its intent (issue #12, "Ownership and
 * authorization"). Matches `taskClaimConflictMessage` in packages/contract,
 * which this package cannot import.
 */
export function claimConflictMessage(holder: { sessionId: string; intent: string }): string {
  const codePoints = [...holder.intent];
  const intent =
    codePoints.length > MAX_CONFLICT_INTENT_LENGTH
      ? `${codePoints.slice(0, MAX_CONFLICT_INTENT_LENGTH - 1).join("")}…`
      : holder.intent;
  return `The Task is claimed by Session ${holder.sessionId} (intent: ${JSON.stringify(intent)}).`;
}

/** The conflict for a Session that can no longer act: ended or effectively abandoned. */
export function terminalSessionConflict(session: SessionState): Conflict | undefined {
  if (session.effectiveStatus === "ended") {
    return conflict(`Session ${session.id} has ended. Start a new Session.`);
  }
  if (session.effectiveStatus === "abandoned") {
    return conflict(
      `Session ${session.id} is abandoned: it sent no heartbeat for 30 minutes. Start a new Session.`,
    );
  }
  return undefined;
}

/** The conflict for a Session that must be live (claims and Task work), if it is not. */
export function notLiveSessionConflict(session: SessionState): Conflict | undefined {
  const terminal = terminalSessionConflict(session);
  if (terminal) return terminal;
  if (session.effectiveStatus === "stale") {
    return conflict(
      `Session ${session.id} is stale: it sent no heartbeat for 5 minutes. Heartbeat it, then claim the Task again.`,
    );
  }
  return undefined;
}

/**
 * Loads a Session of `projectId` that `principal` owns. A Session that does
 * not exist or belongs to another Project is `not_found`; one in this Project
 * owned by someone else is `forbidden` (the web layer chooses its status code).
 */
export async function loadOwnedSession(
  tx: Transaction,
  projectId: string,
  sessionId: string,
  principal: Principal,
  now: Date,
): Promise<NotFound | Forbidden | { status: "ok"; session: SessionState }> {
  const [row] = await tx
    .select()
    .from(agentSession)
    .where(and(eq(agentSession.id, sessionId), eq(agentSession.projectId, projectId)))
    .limit(1);
  if (!row) return notFound;
  if (!samePrincipal(sessionOwner(row), principal)) return forbidden;
  return { status: "ok", session: sessionState(row, now) };
}

/** When a Session crossed the stale threshold. */
export function staleAt(session: { lastHeartbeatAt: Date }): Date {
  return new Date(session.lastHeartbeatAt.getTime() + SESSION_STALE_AFTER_MS);
}

/** When a Session crossed the abandoned threshold. */
export function abandonedAt(session: { lastHeartbeatAt: Date }): Date {
  return new Date(session.lastHeartbeatAt.getTime() + SESSION_ABANDONED_AFTER_MS);
}

/**
 * SQL for a Session's effective status at `now`, the same rule as
 * `effectiveSessionStatus` (src/liveness.ts), for filtering in queries.
 */
export function effectiveSessionStatusSql(now: Date): SQL<SessionStatus> {
  const staleBefore = new Date(now.getTime() - SESSION_STALE_AFTER_MS);
  const abandonedBefore = new Date(now.getTime() - SESSION_ABANDONED_AFTER_MS);
  return sql<SessionStatus>`case
    when ${agentSession.status} in ('ended', 'abandoned') then ${agentSession.status}
    when ${agentSession.lastHeartbeatAt} <= ${abandonedBefore} then 'abandoned'
    when ${agentSession.lastHeartbeatAt} <= ${staleBefore} then 'stale'
    else ${agentSession.status} end`;
}

/**
 * Stores the status a non-terminal Session has effectively reached (stale or
 * abandoned) and writes a `system` Event per threshold crossed, each with
 * `effectiveAt` at the threshold. `session` must have been read under the
 * Project lock held by `tx`; the update is also conditional on the status
 * read, so a Session another transaction already moved writes nothing. Abandoning a
 * Session also sets `ended_at` to the threshold. Returns the statuses written.
 */
export async function materializeSessionStatus(
  tx: Transaction,
  now: Date,
  session: AgentSession,
): Promise<SessionStatus[]> {
  const target = effectiveSessionStatus(session, now);
  if (target === session.status || (target !== "stale" && target !== "abandoned")) return [];
  const [updated] = await tx
    .update(agentSession)
    .set({
      status: target,
      endedAt: target === "abandoned" ? abandonedAt(session) : null,
      updatedAt: now,
    })
    .where(and(eq(agentSession.id, session.id), eq(agentSession.status, session.status)))
    .returning({ id: agentSession.id });
  if (!updated) return [];

  // A Session that skipped the stale step records both crossings, so its
  // history reads the same whether or not a sweep ran in between.
  const steps: { from: SessionStatus; to: "stale" | "abandoned"; at: Date }[] = [];
  if (session.status !== "stale") {
    steps.push({ from: session.status, to: "stale", at: staleAt(session) });
  }
  if (target === "abandoned") {
    steps.push({ from: "stale", to: "abandoned", at: abandonedAt(session) });
  }
  for (const step of steps) {
    await insertEvent(tx, {
      projectId: session.projectId,
      type: "session.status_changed",
      payload: { from: step.from, to: step.to },
      actor: { kind: "system" },
      sessionId: session.id,
      now,
      effectiveAt: step.at,
    });
  }
  return steps.map((step): SessionStatus => step.to);
}

export interface ReleasedClaim {
  taskId: string;
  planId: string;
  sessionId: string;
}

/**
 * Clears the claims matching `where` (a condition on `task`, always scoped to
 * `projectId`) and writes one `task.released` Event for each. A claim whose
 * lease has expired at `now` is recorded as `lease_expired` by `system`,
 * effective when the lease ran out, whatever the caller asked; every other
 * claim gets `reason` and `actor`, effective now. Task progress (status,
 * block reason) is kept. Returns the released claims, at most `limit`.
 */
export async function releaseClaims(
  tx: Transaction,
  input: {
    projectId: string;
    now: Date;
    where: SQL;
    reason: EventPayloads["task.released"]["reason"];
    actor: Actor;
    /** When a non-expired claim's release took effect. Defaults to `now`. */
    effectiveAt?: Date;
    limit?: number;
  },
): Promise<ReleasedClaim[]> {
  const { projectId, now } = input;
  // Read the claims first to record each one's holder and lease; the lock
  // keeps them unchanged until the update below.
  const query = tx
    .select({
      id: task.id,
      planId: task.planId,
      sessionId: task.claimedBySessionId,
      leaseExpiresAt: task.leaseExpiresAt,
    })
    .from(task)
    .where(and(eq(task.projectId, projectId), input.where))
    .orderBy(task.leaseExpiresAt, task.id);
  const claims = await (input.limit === undefined ? query : query.limit(input.limit));
  if (claims.length === 0) return [];

  await tx
    .update(task)
    .set({ claimedBySessionId: null, claimedAt: null, leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(task.projectId, projectId),
        inArray(
          task.id,
          claims.map((claim) => claim.id),
        ),
      ),
    );

  const released: ReleasedClaim[] = [];
  for (const claim of claims) {
    // The select's condition only returns claimed rows; the check narrows types.
    if (claim.sessionId === null || claim.leaseExpiresAt === null) continue;
    const expired = claim.leaseExpiresAt.getTime() <= now.getTime();
    await insertEvent(tx, {
      projectId,
      type: "task.released",
      payload: { reason: expired ? "lease_expired" : input.reason },
      actor: expired ? { kind: "system" } : input.actor,
      planId: claim.planId,
      taskId: claim.id,
      sessionId: claim.sessionId,
      now,
      effectiveAt: expired ? claim.leaseExpiresAt : (input.effectiveAt ?? now),
    });
    released.push({ taskId: claim.id, planId: claim.planId, sessionId: claim.sessionId });
  }
  return released;
}

/**
 * Condition on `task`: a claim may be taken at `now` without stealing. The
 * Task is unclaimed, its lease has expired (inclusive), or its holder is not
 * effectively live. `claimTask`'s conditional UPDATE uses it, so this
 * predicate, not a prior read, decides a contested claim.
 */
export function claimableCondition(now: Date): SQL {
  return or(
    isNull(task.claimedBySessionId),
    lte(task.leaseExpiresAt, now),
    sql`not exists (select 1 from ${agentSession} where ${agentSession.id} = ${task.claimedBySessionId} and ${liveSessionCondition(now)})`,
  ) as SQL;
}

/** Condition on `task`: claimed by this Session. */
export function claimedBy(sessionId: string): SQL {
  return eq(task.claimedBySessionId, sessionId);
}

/** Condition on `task`: the lease has expired at `now` (inclusive). */
export function leaseExpired(now: Date): SQL {
  return lte(task.leaseExpiresAt, now);
}
