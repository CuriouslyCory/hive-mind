import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { withCoordinationRead } from "./coordination.ts";
import type { Db } from "./index.ts";
import {
  claimedBy,
  effectiveSessionStatusSql,
  type NotFound,
  notFound,
  type SessionState,
  sessionState,
} from "./lifecycle.ts";
import { isSessionLive, liveSessionCondition } from "./liveness.ts";
import {
  type PlanView,
  planNumbers,
  progressOf,
  selectTaskViews,
  type TaskView,
  toTaskView,
} from "./plan.ts";
import { agentSession, plan, task } from "./schema/coordination.ts";
import { type Scope, scope } from "./schema/scope.ts";
import { type ScopeOverlapItem, summarizeProjectOverlaps } from "./scope-store.ts";

// The Project status read (issue #12, "Project status"): every section is
// computed in one read transaction from one database `now`, so liveness,
// usable claims and overlaps agree with each other, and nothing is written.
// Each section holds at most `sectionLimit` records and says whether that was
// all of them.

/** A bounded section: `complete` is false when more records exist. */
export interface StatusSection<T> {
  items: T[];
  complete: boolean;
}

/** A Session with the PLAN-N number of its attached Plan, for the Session DTO. */
export interface SessionView {
  session: SessionState;
  attachedPlanNumber: number | null;
}

export interface LiveSessionView extends SessionView {
  /** All declared Scopes (at most 32), oldest first. */
  declaredScopes: Scope[];
  touchedScopeCount: number;
  /** Usable claims (unexpired leases; the Session is live). */
  claimCount: number;
}

export interface ProjectStatus {
  asOf: Date;
  selectedSessionId: string | null;
  /** `active` Plans with progress, newest first. */
  activePlans: StatusSection<PlanView>;
  /** Live Sessions, most recent heartbeat first. */
  liveSessions: StatusSection<LiveSessionView>;
  /** The selected Session's usable claims, oldest claim first; empty without one. */
  myClaims: StatusSection<TaskView>;
  /** Ended or abandoned Sessions, most recent heartbeat first. */
  recentTerminalSessions: StatusSection<SessionView>;
  /**
   * Overlaps among live Sessions (with a selected Session, only its own,
   * oriented with it as `sessionId`). `complete` is false whenever one could
   * be missing: a capped list, an exhausted budget or incomplete coverage.
   */
  overlaps: StatusSection<ScopeOverlapItem>;
}

export interface ProjectStatusInput {
  projectId: string;
  /** Any Session of the Project; another Project's or an absent one is `not_found`. */
  sessionId?: string;
  sectionLimit: number;
}

/** Live Sessions and overlap pairs the status overlap summary compares at most. */
const OVERLAP_SESSION_LIMIT = 100;
const OVERLAP_ITEM_LIMIT = 100;

/** Reads the Project status at one database time. Never writes. */
export async function projectStatus(
  db: Db,
  input: ProjectStatusInput,
): Promise<({ status: "ok" } & ProjectStatus) | NotFound> {
  const limit = input.sectionLimit;
  return withCoordinationRead(db, async (context) => {
    const { tx, now } = context;
    let selected: SessionState | null = null;
    if (input.sessionId !== undefined) {
      const [row] = await tx
        .select()
        .from(agentSession)
        .where(
          and(eq(agentSession.id, input.sessionId), eq(agentSession.projectId, input.projectId)),
        )
        .limit(1);
      if (!row) return notFound;
      selected = sessionState(row, now);
    }

    const planRows = await tx
      .select()
      .from(plan)
      .where(and(eq(plan.projectId, input.projectId), eq(plan.status, "active")))
      .orderBy(desc(plan.number))
      .limit(limit + 1);
    const shownPlans = planRows.slice(0, limit);
    const progress = await progressOf(
      tx,
      shownPlans.map((row) => row.id),
    );
    const activePlans = section(
      planRows.map((row) => ({ plan: row, progress: progress.get(row.id) ?? emptyProgress() })),
      limit,
    );

    const liveRows = await tx
      .select()
      .from(agentSession)
      .where(and(eq(agentSession.projectId, input.projectId), liveSessionCondition(now)))
      .orderBy(desc(agentSession.lastHeartbeatAt), desc(agentSession.id))
      .limit(limit + 1);
    const terminalRows = await tx
      .select()
      .from(agentSession)
      .where(
        and(
          eq(agentSession.projectId, input.projectId),
          inArray(effectiveSessionStatusSql(now), ["ended", "abandoned"]) as SQL,
        ),
      )
      .orderBy(desc(agentSession.lastHeartbeatAt), desc(agentSession.id))
      .limit(limit + 1);
    const live = liveRows.slice(0, limit);
    const terminal = terminalRows.slice(0, limit);
    const numbers = await planNumbers(tx, input.projectId, [
      ...live.map((row) => row.attachedPlanId),
      ...terminal.map((row) => row.attachedPlanId),
    ]);
    const view = (row: typeof agentSession.$inferSelect): SessionView => ({
      session: sessionState(row, now),
      attachedPlanNumber: row.attachedPlanId ? (numbers.get(row.attachedPlanId) ?? null) : null,
    });

    const liveIds = live.map((row) => row.id);
    const declared =
      liveIds.length === 0
        ? []
        : await tx
            .select()
            .from(scope)
            .where(and(inArray(scope.sessionId, liveIds), eq(scope.source, "declared")))
            .orderBy(asc(scope.createdAt), asc(scope.id));
    const touchedCounts =
      liveIds.length === 0
        ? []
        : await tx
            .select({ sessionId: scope.sessionId, count: sql<number>`count(*)::int` })
            .from(scope)
            .where(and(inArray(scope.sessionId, liveIds), eq(scope.source, "touched")))
            .groupBy(scope.sessionId);
    const claimCounts =
      liveIds.length === 0
        ? []
        : await tx
            .select({ sessionId: task.claimedBySessionId, count: sql<number>`count(*)::int` })
            .from(task)
            .where(
              and(
                eq(task.projectId, input.projectId),
                inArray(task.claimedBySessionId, liveIds),
                gt(task.leaseExpiresAt, now),
              ),
            )
            .groupBy(task.claimedBySessionId);
    const declaredBySession = Map.groupBy(declared, (row) => row.sessionId);
    const touchedBySession = new Map(touchedCounts.map((row) => [row.sessionId, row.count]));
    const claimsBySession = new Map(claimCounts.map((row) => [row.sessionId, row.count]));
    const liveSessions = {
      items: live.map((row) => ({
        ...view(row),
        declaredScopes: declaredBySession.get(row.id) ?? [],
        touchedScopeCount: touchedBySession.get(row.id) ?? 0,
        claimCount: claimsBySession.get(row.id) ?? 0,
      })),
      complete: liveRows.length <= limit,
    };

    let myClaims: StatusSection<TaskView> = { items: [], complete: true };
    if (selected && isSessionLive(selected, now)) {
      const rows = await selectTaskViews(tx)
        .where(
          and(
            eq(task.projectId, input.projectId),
            claimedBy(selected.id),
            gt(task.leaseExpiresAt, now),
          ),
        )
        .orderBy(asc(task.claimedAt), asc(task.id))
        .limit(limit + 1);
      myClaims = section(
        rows.map((row) => toTaskView(row, now)),
        limit,
      );
    }

    const summary = await summarizeProjectOverlaps(context, {
      projectId: input.projectId,
      sessionLimit: OVERLAP_SESSION_LIMIT,
      overlapLimit: OVERLAP_ITEM_LIMIT,
    });
    const overlapItems = selected
      ? summary.overlaps.flatMap((item) => orientTo(item, selected.id))
      : summary.overlaps;
    const overlaps = {
      items: overlapItems.slice(0, limit),
      complete: summary.complete && overlapItems.length <= limit,
    };

    return {
      status: "ok",
      asOf: now,
      selectedSessionId: selected?.id ?? null,
      activePlans,
      liveSessions,
      myClaims,
      recentTerminalSessions: section(terminalRows.map(view), limit),
      overlaps,
    };
  });
}

function section<T>(rows: T[], limit: number): StatusSection<T> {
  return { items: rows.slice(0, limit), complete: rows.length <= limit };
}

function emptyProgress() {
  return { total: 0, todo: 0, inProgress: 0, blocked: 0, done: 0 };
}

/** The overlap seen from `sessionId`'s side, or nothing if it is not one of the pair. */
function orientTo(item: ScopeOverlapItem, sessionId: string): ScopeOverlapItem[] {
  if (item.sessionId === sessionId) return [item];
  if (item.otherSessionId !== sessionId) return [];
  return [
    {
      ...item,
      sessionId: item.otherSessionId,
      otherSessionId: item.sessionId,
      scope: item.otherScope,
      otherScope: item.scope,
    },
  ];
}

/**
 * Sessions as `SessionView`s: each with its attached Plan's number, read
 * after the Session (a Plan's number never changes, so a separate read
 * cannot disagree with the Session it decorates).
 */
export async function sessionViews(
  db: Db,
  projectId: string,
  sessions: readonly SessionState[],
): Promise<SessionView[]> {
  const numbers = await planNumbers(
    db,
    projectId,
    sessions.map((session) => session.attachedPlanId),
  );
  return sessions.map((session) => ({
    session,
    attachedPlanNumber: session.attachedPlanId
      ? (numbers.get(session.attachedPlanId) ?? null)
      : null,
  }));
}
