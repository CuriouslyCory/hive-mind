import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { type Transaction, tryWithCoordinationLock, withCoordinationRead } from "./coordination.ts";
import type { Db } from "./index.ts";
import {
  abandonedAt,
  claimedBy,
  leaseExpired,
  materializeSessionStatus,
  releaseClaims,
} from "./lifecycle.ts";
import { SESSION_ABANDONED_AFTER_MS, SESSION_STALE_AFTER_MS } from "./liveness.ts";
import { agentSession } from "./schema/coordination.ts";

// The coordination sweep (issue #12, "Sweep and deployment"; ADR-0014,
// "Sweep"), run by the Cron route apps/web/src/app/api/cron/coordination.
//
// Eligibility never waits for the sweep: request paths compute liveness and
// lease expiry from database time. The sweep only stores what time has
// already decided (stale and abandoned statuses, released expired claims) and
// writes their `system` Events, each with `effectiveAt` at the threshold
// rather than the time the sweep ran.
//
// One invocation takes at most `projectBatch` candidate Projects, oldest
// `coordination_swept_at` first (never-swept first, then by id), and visits
// them one at a time, each in its own transaction holding only that Project's
// lock. A Project whose lock is held is skipped and keeps its place for the
// next invocation. Under the lock everything is re-read and every change is
// conditional on current state, so overlapping, repeated or late sweeps find
// nothing left to do and write no duplicate Event. Each visited Project's
// `coordination_swept_at` advances in the same transaction, even when its
// batch left work behind, so later invocations rotate through Projects; the
// timestamp is the only progress record, kept in the database.

export interface SweepOptions {
  /** Most candidate Projects one invocation visits (swept or skipped as busy). */
  projectBatch: number;
  /**
   * Most Sessions one Project transaction transitions, and most expired
   * claims it releases. Remaining work waits for a later invocation.
   */
  sessionBatch: number;
  /** No further Project is started after this time (application clock). */
  deadline: Date;
  /**
   * The application clock compared with `deadline`; defaults to the system
   * clock. Eligibility always uses database time, never this.
   */
  now?: () => Date;
}

export interface SweepResult {
  /** Projects whose lock was acquired and whose sweep committed. */
  projectsSwept: number;
  /** Projects skipped because another transaction held their lock. */
  projectsSkipped: number;
  /** Sessions stored as stale (including those that went on to abandoned). */
  sessionsStale: number;
  /** Sessions stored as abandoned. */
  sessionsAbandoned: number;
  /** Claims released, each with a `task.released` Event. */
  claimsReleased: number;
  /**
   * Whether work may remain for a later invocation: more candidates than the
   * batch, a skipped Project, a Project that hit `sessionBatch`, or the
   * deadline.
   */
  moreWork: boolean;
}

/** The candidate scan's SQL condition: a Project with a transition or expired claim due at `now`. */
function dueWork(now: Date) {
  const staleBefore = new Date(now.getTime() - SESSION_STALE_AFTER_MS);
  const abandonedBefore = new Date(now.getTime() - SESSION_ABANDONED_AFTER_MS);
  return sql`(
    exists (
      select 1 from agent_session s
      where s.project_id = p.id and (
        (s.status in ('active', 'idle') and s.last_heartbeat_at <= ${staleBefore})
        or (s.status = 'stale' and s.last_heartbeat_at <= ${abandonedBefore})
      )
    )
    or exists (select 1 from task t where t.project_id = p.id and t.lease_expires_at <= ${now})
  )`;
}

async function sweepProject(
  tx: Transaction,
  now: Date,
  projectId: string,
  limit: number,
): Promise<Omit<SweepResult, "projectsSwept" | "projectsSkipped">> {
  const staleBefore = new Date(now.getTime() - SESSION_STALE_AFTER_MS);
  const abandonedBefore = new Date(now.getTime() - SESSION_ABANDONED_AFTER_MS);
  const due = await tx
    .select()
    .from(agentSession)
    .where(
      and(
        eq(agentSession.projectId, projectId),
        or(
          and(
            inArray(agentSession.status, ["active", "idle"]),
            lte(agentSession.lastHeartbeatAt, staleBefore),
          ),
          and(eq(agentSession.status, "stale"), lte(agentSession.lastHeartbeatAt, abandonedBefore)),
        ),
      ),
    )
    .orderBy(asc(agentSession.lastHeartbeatAt), asc(agentSession.id))
    .limit(limit + 1);

  let sessionsStale = 0;
  let sessionsAbandoned = 0;
  let claimsReleased = 0;
  for (const session of due.slice(0, limit)) {
    const steps = await materializeSessionStatus(tx, now, session);
    if (steps.includes("stale")) sessionsStale++;
    if (steps.includes("abandoned")) {
      sessionsAbandoned++;
      // An abandoned Session's leases have normally expired already (they
      // last 5 minutes past a heartbeat or claim), and are then recorded as
      // lease_expired; this also clears any that have not.
      const released = await releaseClaims(tx, {
        projectId,
        now,
        where: claimedBy(session.id),
        reason: "session_abandoned",
        actor: { kind: "system" },
        effectiveAt: abandonedAt(session),
        limit,
      });
      claimsReleased += released.length;
    }
  }

  const expired = await releaseClaims(tx, {
    projectId,
    now,
    where: leaseExpired(now),
    reason: "lease_expired",
    actor: { kind: "system" },
    limit,
  });
  claimsReleased += expired.length;

  // Raw SQL, so project.updated_at (shown in the Project DTO) stays as is.
  await tx.execute(sql`update project set coordination_swept_at = ${now} where id = ${projectId}`);
  return {
    sessionsStale,
    sessionsAbandoned,
    claimsReleased,
    moreWork: due.length > limit || expired.length === limit,
  };
}

/**
 * Runs one bounded sweep invocation. See the module comment for the rules.
 * Safe to run concurrently with itself and with any coordination request.
 */
export async function sweepCoordination(db: Db, options: SweepOptions): Promise<SweepResult> {
  const clock = options.now ?? (() => new Date());
  const result: SweepResult = {
    projectsSwept: 0,
    projectsSkipped: 0,
    sessionsStale: 0,
    sessionsAbandoned: 0,
    claimsReleased: 0,
    moreWork: false,
  };
  const scanNow = await withCoordinationRead(db, async ({ now }) => now);
  const candidates = await db.execute<{ id: string }>(sql`
    select p.id from project p
    where ${dueWork(scanNow)}
    order by p.coordination_swept_at asc nulls first, p.id asc
    limit ${options.projectBatch + 1}
  `);
  const projectIds = candidates.rows.map((row) => row.id);
  if (projectIds.length > options.projectBatch) result.moreWork = true;

  for (const projectId of projectIds.slice(0, options.projectBatch)) {
    if (clock().getTime() >= options.deadline.getTime()) {
      result.moreWork = true;
      break;
    }
    const attempt = await tryWithCoordinationLock(db, projectId, ({ tx, now }) =>
      sweepProject(tx, now, projectId, options.sessionBatch),
    );
    if (!attempt.acquired) {
      result.projectsSkipped++;
      result.moreWork = true;
      continue;
    }
    result.projectsSwept++;
    result.sessionsStale += attempt.result.sessionsStale;
    result.sessionsAbandoned += attempt.result.sessionsAbandoned;
    result.claimsReleased += attempt.result.claimsReleased;
    if (attempt.result.moreWork) result.moreWork = true;
  }
  return result;
}
