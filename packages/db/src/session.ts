import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { withCoordinationLock, withCoordinationRead } from "./coordination.ts";
import { createOnce } from "./creation.ts";
import { insertEvent, type SessionUpdateField } from "./event.ts";
import { creationFingerprint, sha256Hex } from "./fingerprint.ts";
import type { Db } from "./index.ts";
import {
  abandonedAt,
  type Conflict,
  claimedBy,
  conflict,
  effectiveSessionStatusSql,
  type Forbidden,
  leaseExpired,
  loadOwnedSession,
  materializeSessionStatus,
  type NotFound,
  notFound,
  releaseClaims,
  type SessionState,
  sessionState,
  terminalSessionConflict,
} from "./lifecycle.ts";
import { CLAIM_LEASE_MS, isSessionLive } from "./liveness.ts";
import { type Principal, sessionOwnerColumns } from "./principal.ts";
import {
  type AgentSession,
  agentSession,
  plan,
  type SessionStatus,
  type Task,
  task,
} from "./schema/coordination.ts";

// Session lifecycle (issue #12, "Lifecycle, leases and transitions";
// ADR-0014): start, update, attach, heartbeat and end under the Project's
// coordination lock, and reads that compute effective liveness from one
// database timestamp without writing.
//
// Callers (apps/web) authenticate the principal, check the Project is
// visible to it and validate input bounds before calling. These functions
// check ownership and state, and return plain outcomes the web layer maps to
// HTTP errors: `not_found` 404, `forbidden` (another principal's Session)
// 403 or 404, `conflict` 409.

export type SessionResult<T> = ({ status: "ok" } & T) | NotFound | Forbidden | Conflict;

/** Machine and git metadata. `null` means unknown; never guessed. */
export interface SessionMetadata {
  machine: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  worktreePath: string | null;
}

export interface StartSessionInput extends SessionMetadata {
  projectId: string;
  /** The caller's UUID for the Session, generated once by the client. */
  id: string;
  principal: Principal;
  agent: string;
  intent: string;
}

export type StartSessionOutcome =
  | { status: "ok"; session: SessionState; created: boolean }
  | NotFound
  | Conflict;

/**
 * Starts an `active` Session owned by `principal`, with its first heartbeat
 * now, or recognizes a retry of the same start (same id, input and principal)
 * and returns the Session as it is now with `created: false` and no Event.
 */
export async function startSession(db: Db, input: StartSessionInput): Promise<StartSessionOutcome> {
  const fingerprint = creationFingerprint({
    agent: input.agent,
    intent: input.intent,
    machine: input.machine,
    gitBranch: input.gitBranch,
    gitCommit: input.gitCommit,
    worktreePath: input.worktreePath,
  });
  return withCoordinationLock(db, input.projectId, async ({ tx, now }) => {
    const outcome = await createOnce(
      tx,
      {
        kind: "session",
        projectId: input.projectId,
        id: input.id,
        principal: input.principal,
        fingerprint,
      },
      async (savepoint) => {
        const [row] = await savepoint
          .insert(agentSession)
          .values({
            id: input.id,
            projectId: input.projectId,
            ...sessionOwnerColumns(input.principal),
            status: "active",
            agent: input.agent,
            intent: input.intent,
            machine: input.machine,
            gitBranch: input.gitBranch,
            gitCommit: input.gitCommit,
            worktreePath: input.worktreePath,
            lastHeartbeatAt: now,
            creationFingerprint: fingerprint,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error("agent_session insert returned no row");
        await insertEvent(savepoint, {
          projectId: input.projectId,
          type: "session.started",
          payload: { agent: row.agent, intent: row.intent },
          actor: { ...input.principal, sessionId: row.id },
          sessionId: row.id,
          now,
        });
        return row;
      },
    );
    switch (outcome.status) {
      case "created":
      case "replay":
        return {
          status: "ok",
          session: sessionState(outcome.row, now),
          created: outcome.status === "created",
        };
      case "conflict":
        return conflict(`Session id ${input.id} is already used by another request.`);
      case "not_found":
        return notFound;
    }
  });
}

/** Identifies a caller's Session in a Project. */
export interface OwnedSessionRef {
  projectId: string;
  sessionId: string;
  principal: Principal;
}

export interface UpdateSessionInput extends OwnedSessionRef {
  /** Only supplied fields change; `null` clears optional metadata. */
  changes: Partial<
    Omit<SessionMetadata, "worktreePath"> & {
      agent: string;
      intent: string;
      status: "active" | "idle";
    }
  >;
}

/**
 * Changes the supplied metadata or the active/idle status of the caller's
 * Session. Equal values are a no-op (`changed: false`, no Event). An ended or
 * effectively abandoned Session is a conflict. Changing the status does not
 * count as a heartbeat, so a stale Session stays effectively stale.
 */
export async function updateSession(
  db: Db,
  input: UpdateSessionInput,
): Promise<SessionResult<{ session: SessionState; changed: boolean }>> {
  return withCoordinationLock(db, input.projectId, async ({ tx, now }) => {
    const loaded = await loadOwnedSession(
      tx,
      input.projectId,
      input.sessionId,
      input.principal,
      now,
    );
    if (loaded.status !== "ok") return loaded;
    const { session } = loaded;
    const terminal = terminalSessionConflict(session);
    if (terminal) return terminal;

    const changes: Partial<Pick<AgentSession, keyof UpdateSessionInput["changes"]>> = {};
    const fields: SessionUpdateField[] = [];
    for (const key of SESSION_UPDATE_KEYS) {
      const value = input.changes[key];
      if (value !== undefined && value !== session[key]) {
        Object.assign(changes, { [key]: value });
        fields.push(key === "machine" ? "hostname" : key);
      }
    }
    if (Object.keys(changes).length === 0) return { status: "ok", session, changed: false };

    const [row] = await tx
      .update(agentSession)
      .set({ ...changes, updatedAt: now })
      .where(eq(agentSession.id, session.id))
      .returning();
    if (!row) throw new Error("agent_session update returned no row");
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "session.updated",
      payload: { fields },
      actor: { ...input.principal, sessionId: session.id },
      sessionId: session.id,
      now,
    });
    return { status: "ok", session: sessionState(row, now), changed: true };
  });
}

/** The fields `updateSession` can change, in the order its Event lists them. */
const SESSION_UPDATE_KEYS = [
  "agent",
  "intent",
  "machine",
  "gitBranch",
  "gitCommit",
  "status",
] as const satisfies readonly (keyof UpdateSessionInput["changes"])[];

/** A Plan by UUID or by its Project-local number (the N of PLAN-N). */
export type PlanRef = { id: string } | { number: number };

export interface AttachSessionInput extends OwnedSessionRef {
  /** The Plan to focus on, or null to clear the focus. */
  plan: PlanRef | null;
  /** A Task of that Plan, or null/omitted for the Plan alone. */
  taskId?: string | null;
}

/**
 * Sets the caller's Session focus to a Plan of this Project and optionally
 * one of that Plan's Tasks. A Plan of another Project, or a Task of another
 * Plan, is `not_found`. Attaching neither claims nor releases a Task.
 */
export async function attachSession(
  db: Db,
  input: AttachSessionInput,
): Promise<SessionResult<{ session: SessionState; changed: boolean }>> {
  return withCoordinationLock(db, input.projectId, async ({ tx, now }) => {
    const loaded = await loadOwnedSession(
      tx,
      input.projectId,
      input.sessionId,
      input.principal,
      now,
    );
    if (loaded.status !== "ok") return loaded;
    const { session } = loaded;
    const terminal = terminalSessionConflict(session);
    if (terminal) return terminal;

    let planId: string | null = null;
    let taskId: string | null = null;
    if (input.plan !== null) {
      const [found] = await tx
        .select({ id: plan.id })
        .from(plan)
        .where(
          and(
            eq(plan.projectId, input.projectId),
            "id" in input.plan ? eq(plan.id, input.plan.id) : eq(plan.number, input.plan.number),
          ),
        )
        .limit(1);
      if (!found) return notFound;
      planId = found.id;
      if (input.taskId) {
        const [foundTask] = await tx
          .select({ id: task.id })
          .from(task)
          .where(
            and(
              eq(task.id, input.taskId),
              eq(task.planId, planId),
              eq(task.projectId, input.projectId),
            ),
          )
          .limit(1);
        if (!foundTask) return notFound;
        taskId = foundTask.id;
      }
    } else if (input.taskId) {
      // The contract rejects this before it gets here; a Task needs its Plan.
      return notFound;
    }

    if (session.attachedPlanId === planId && session.attachedTaskId === taskId) {
      return { status: "ok", session, changed: false };
    }
    const [row] = await tx
      .update(agentSession)
      .set({ attachedPlanId: planId, attachedTaskId: taskId, updatedAt: now })
      .where(eq(agentSession.id, session.id))
      .returning();
    if (!row) throw new Error("agent_session update returned no row");
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "session.attached",
      payload: { previousPlanId: session.attachedPlanId, previousTaskId: session.attachedTaskId },
      actor: { ...input.principal, sessionId: session.id },
      planId,
      taskId,
      sessionId: session.id,
      now,
    });
    return { status: "ok", session: sessionState(row, now), changed: true };
  });
}

/** The collection columns of a Session that a heartbeat's generation rule reads and writes. */
export interface CollectionGenerationState {
  collectionId: string | null;
  collectionExpectedBatches: number | null;
  collectionPathCount: number | null;
  collectionContentHash: string | null;
  collectionOmittedPathCount: number | null;
  collectionComplete: boolean;
  scopeHistoryIncomplete: boolean;
}

/**
 * The touched-path collection generation rule a heartbeat applies (shared
 * with the Scope collection helpers). A `collectionId` different from the
 * stored one starts a new generation: if the previous generation exists and
 * is not complete, coverage was lost, so the sticky `scopeHistoryIncomplete`
 * is set; then the new id is stored with no manifest and not complete. The
 * same `collectionId` resumes the current generation and changes nothing.
 * Returns the columns to write (none on resume).
 */
export function nextCollectionGeneration(
  stored: CollectionGenerationState,
  collectionId: string,
):
  | { newGeneration: true; columns: CollectionGenerationState }
  | { newGeneration: false; columns: null } {
  if (stored.collectionId === collectionId) {
    return { newGeneration: false, columns: null };
  }
  const previousIncomplete = stored.collectionId !== null && !stored.collectionComplete;
  return {
    newGeneration: true,
    columns: {
      collectionId,
      collectionExpectedBatches: null,
      collectionPathCount: null,
      collectionContentHash: null,
      collectionOmittedPathCount: null,
      collectionComplete: false,
      scopeHistoryIncomplete: stored.scopeHistoryIncomplete || previousIncomplete,
    },
  };
}

export interface HeartbeatSessionInput extends OwnedSessionRef {
  /** The touched-path collection this heartbeat belongs to (see `nextCollectionGeneration`). */
  collectionId: string;
  /**
   * The status to set. Omitted: a live Session keeps its status (so an idle
   * Session stays idle) and a stale one becomes active.
   */
  sessionStatus?: "active" | "idle";
}

export interface HeartbeatResult {
  session: SessionState;
  /** The effective status before this heartbeat. */
  previousStatus: SessionStatus;
  /** Tasks whose claim this heartbeat renewed, all of them (the web layer bounds the list). */
  renewedTaskIds: string[];
  /** Tasks whose expired claim this heartbeat released instead (with Events). */
  releasedTaskIds: string[];
  /** The renewed leases' new expiry; null when nothing was renewed. */
  leaseExpiresAt: Date | null;
  /** The heartbeat's collection id (the input), now the Session's current one. */
  collectionId: string;
  /** Whether `collectionId` started a new collection generation. */
  newCollection: boolean;
}

/**
 * Records a heartbeat from the caller's Session. An ended or effectively
 * abandoned Session (30 minutes without a heartbeat, whatever its stored
 * status) cannot be revived: conflict. A stale Session first has its stale
 * status recorded and its expired claims released with Events. Then the
 * Session's unexpired claims are renewed to `now + CLAIM_LEASE_MS` (an
 * expired lease is never renewed, and claims another Session now holds are
 * untouched), the collection generation rule is applied, the status and
 * `last_heartbeat_at` are set and a `session.heartbeat` Event is written.
 */
export async function heartbeatSession(
  db: Db,
  input: HeartbeatSessionInput,
): Promise<SessionResult<HeartbeatResult>> {
  return withCoordinationLock(db, input.projectId, async ({ tx, now }) => {
    const loaded = await loadOwnedSession(
      tx,
      input.projectId,
      input.sessionId,
      input.principal,
      now,
    );
    if (loaded.status !== "ok") return loaded;
    const { session } = loaded;
    const terminal = terminalSessionConflict(session);
    if (terminal) return terminal;
    const previousStatus = session.effectiveStatus;
    const actor = { ...input.principal, sessionId: session.id };

    if (previousStatus === "stale") await materializeSessionStatus(tx, now, session);
    // Expired leases are released whether or not the Session went stale: a
    // claim taken shortly before a missed renewal can expire while its Session
    // is still live.
    const released = await releaseClaims(tx, {
      projectId: input.projectId,
      now,
      where: and(claimedBy(session.id), leaseExpired(now)) as SQL,
      reason: "lease_expired",
      actor,
    });

    const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    const renewed = await tx
      .update(task)
      .set({ leaseExpiresAt, updatedAt: now })
      .where(
        and(
          eq(task.projectId, input.projectId),
          claimedBy(session.id),
          gt(task.leaseExpiresAt, now),
        ),
      )
      .returning({ id: task.id });

    const generation = nextCollectionGeneration(session, input.collectionId);
    // Not terminal here, so the previous status is active, idle or stale.
    const status = input.sessionStatus ?? (previousStatus === "idle" ? "idle" : "active");
    const [row] = await tx
      .update(agentSession)
      .set({ ...generation.columns, status, lastHeartbeatAt: now, updatedAt: now })
      .where(eq(agentSession.id, session.id))
      .returning();
    if (!row) throw new Error("agent_session update returned no row");
    if (row.scopeHistoryIncomplete && !session.scopeHistoryIncomplete) {
      // The new generation replaced an unfinished collection: the same sticky
      // loss, recorded once, that src/scope-store.ts records for its causes.
      await insertEvent(tx, {
        projectId: input.projectId,
        type: "scope.coverage_lost",
        payload: {
          collectionId: session.collectionId,
          reason: "collection_superseded",
          pathCount: session.collectionPathCount,
        },
        actor,
        sessionId: session.id,
        now,
      });
    }
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "session.heartbeat",
      payload: {
        from: previousStatus,
        to: status,
        renewedClaimCount: renewed.length,
        releasedClaimCount: released.length,
        collectionId: input.collectionId,
      },
      actor,
      sessionId: session.id,
      now,
    });
    return {
      status: "ok",
      session: sessionState(row, now),
      previousStatus,
      renewedTaskIds: renewed.map((claim) => claim.id).sort(),
      releasedTaskIds: released.map((claim) => claim.taskId),
      leaseExpiresAt: renewed.length > 0 ? leaseExpiresAt : null,
      collectionId: input.collectionId,
      newCollection: generation.newGeneration,
    };
  });
}

export interface EndSessionInput extends OwnedSessionRef {
  /** The final summary (bounded markdown, validated by the caller). */
  summary: string;
}

/**
 * Ends the caller's Session with a final summary and releases all its claims,
 * keeping Task progress. The first accepted summary's fingerprint is kept: the
 * same summary again is a no-op (`changed: false`, no Event), recognized
 * before any liveness check; a different one is a conflict, also after
 * abandonment. A Session that is abandoned (stored or effectively) accepts
 * its first summary and stays abandoned.
 */
export async function endSession(
  db: Db,
  input: EndSessionInput,
): Promise<SessionResult<{ session: SessionState; changed: boolean; releasedTaskIds: string[] }>> {
  const fingerprint = sha256Hex(input.summary);
  return withCoordinationLock(db, input.projectId, async ({ tx, now }) => {
    const loaded = await loadOwnedSession(
      tx,
      input.projectId,
      input.sessionId,
      input.principal,
      now,
    );
    if (loaded.status !== "ok") return loaded;
    const { session } = loaded;

    if (session.summaryFingerprint !== null) {
      return session.summaryFingerprint === fingerprint
        ? { status: "ok", session, changed: false, releasedTaskIds: [] }
        : conflict(`Session ${session.id} already ended with a different summary.`);
    }
    // Only endSession sets a summary, and it always ends the Session; an
    // ended row without one predates nothing and cannot be ended twice.
    if (session.status === "ended") {
      return conflict(`Session ${session.id} has ended.`);
    }

    const actor = { ...input.principal, sessionId: session.id };
    const abandoned = session.effectiveStatus === "abandoned";
    if (abandoned) await materializeSessionStatus(tx, now, session);
    const released = await releaseClaims(tx, {
      projectId: input.projectId,
      now,
      where: claimedBy(session.id),
      reason: abandoned ? "session_abandoned" : "session_ended",
      actor: abandoned ? { kind: "system" } : actor,
      effectiveAt: abandoned ? abandonedAt(session) : now,
    });

    const [row] = await tx
      .update(agentSession)
      .set({
        summary: input.summary,
        summaryFingerprint: fingerprint,
        updatedAt: now,
        ...(abandoned ? {} : { status: "ended" as const, endedAt: now }),
      })
      .where(eq(agentSession.id, session.id))
      .returning();
    if (!row) throw new Error("agent_session update returned no row");
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "session.ended",
      payload: { from: session.effectiveStatus, summary: input.summary },
      actor,
      sessionId: session.id,
      now,
    });
    return {
      status: "ok",
      session: sessionState(row, now),
      changed: true,
      releasedTaskIds: released.map((claim) => claim.taskId),
    };
  });
}

/** Page size bounds for list reads (issue #12: default 50, max 100). */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export function pageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(limit, MAX_PAGE_LIMIT);
}

/**
 * A keyset page. `next` is the id of the last item to pass back as `after`,
 * or null on the last page. The web layer encodes it as an opaque cursor.
 */
export interface Page<T> {
  items: T[];
  next: string | null;
}

/** A cursor that names no row of the list; the web layer answers 400. */
export type InvalidCursor = { status: "invalid_cursor" };

/** Reads one Session with its effective status. Never writes. */
export async function getSession(
  db: Db,
  input: { projectId: string; sessionId: string },
): Promise<{ status: "ok"; session: SessionState } | NotFound> {
  return withCoordinationRead(db, async ({ tx, now }) => {
    const [row] = await tx
      .select()
      .from(agentSession)
      .where(and(eq(agentSession.id, input.sessionId), eq(agentSession.projectId, input.projectId)))
      .limit(1);
    return row ? { status: "ok", session: sessionState(row, now) } : notFound;
  });
}

/** `live` is active or idle; `terminal` is ended or abandoned; otherwise one effective status. */
export type SessionListFilter = "live" | "terminal" | SessionStatus;

const FILTER_STATUSES: Record<SessionListFilter, SessionStatus[]> = {
  live: ["active", "idle"],
  terminal: ["ended", "abandoned"],
  active: ["active"],
  idle: ["idle"],
  stale: ["stale"],
  ended: ["ended"],
  abandoned: ["abandoned"],
};

/**
 * Lists a Project's Sessions, most recently started first, optionally
 * filtered by effective status at one database time. Keyset-paged by
 * `(created_at, id)`; `after` is a previous page's `next`.
 */
export async function listSessions(
  db: Db,
  input: { projectId: string; filter?: SessionListFilter; limit?: number; after?: string },
): Promise<({ status: "ok" } & Page<SessionState>) | InvalidCursor> {
  const limit = pageLimit(input.limit);
  return withCoordinationRead(db, async ({ tx, now }) => {
    const conditions: SQL[] = [eq(agentSession.projectId, input.projectId)];
    if (input.filter) {
      conditions.push(
        inArray(effectiveSessionStatusSql(now), FILTER_STATUSES[input.filter]) as SQL,
      );
    }
    if (input.after !== undefined) {
      const [cursor] = await tx
        .select({ createdAt: agentSession.createdAt, id: agentSession.id })
        .from(agentSession)
        .where(and(eq(agentSession.id, input.after), eq(agentSession.projectId, input.projectId)))
        .limit(1);
      if (!cursor) return { status: "invalid_cursor" };
      // Compared in SQL against the stored row so microsecond timestamps
      // written by database defaults page correctly.
      conditions.push(
        sql`(${agentSession.createdAt}, ${agentSession.id}) < (select created_at, id from agent_session where id = ${cursor.id})`,
      );
    }
    const rows = await tx
      .select()
      .from(agentSession)
      .where(and(...conditions))
      .orderBy(desc(agentSession.createdAt), desc(agentSession.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map((row) => sessionState(row, now));
    return {
      status: "ok",
      items,
      next: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  });
}

/**
 * Lists the Tasks a Session holds a usable claim on (unexpired lease, live
 * holder) at one database time, oldest claim first. A Session that is not
 * live has none, whatever the stored claims say.
 */
export async function listSessionClaims(
  db: Db,
  input: { projectId: string; sessionId: string; limit?: number; after?: string },
): Promise<({ status: "ok" } & Page<Task>) | NotFound | InvalidCursor> {
  const limit = pageLimit(input.limit);
  return withCoordinationRead(db, async ({ tx, now }) => {
    const [session] = await tx
      .select()
      .from(agentSession)
      .where(and(eq(agentSession.id, input.sessionId), eq(agentSession.projectId, input.projectId)))
      .limit(1);
    if (!session) return notFound;
    if (!isSessionLive(session, now)) return { status: "ok", items: [], next: null };

    const conditions: SQL[] = [
      eq(task.projectId, input.projectId),
      claimedBy(session.id),
      gt(task.leaseExpiresAt, now),
    ];
    if (input.after !== undefined) {
      const [cursor] = await tx
        .select({ id: task.id })
        .from(task)
        .where(and(eq(task.id, input.after), ...conditions))
        .limit(1);
      if (!cursor) return { status: "invalid_cursor" };
      conditions.push(
        sql`(${task.claimedAt}, ${task.id}) > (select claimed_at, id from task where id = ${cursor.id})`,
      );
    }
    const rows = await tx
      .select()
      .from(task)
      .where(and(...conditions))
      .orderBy(asc(task.claimedAt), asc(task.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    return { status: "ok", items, next: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  });
}
