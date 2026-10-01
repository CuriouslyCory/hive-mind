import { and, gt, inArray, type SQL } from "drizzle-orm";
import { agentSession, type SessionStatus } from "./schema/coordination.ts";

// Effective Session liveness and claim usability (ADR-0014, issue #12
// "Lifecycle, leases and transitions"). Eligibility always comes from the
// database time of the current transaction (`CoordinationContext.now`), never
// from a stored status alone: the sweep may run late or not at all, so a row
// that still says `active` can be effectively stale or abandoned.
//
// Boundaries are inclusive: at exactly `last_heartbeat_at + 5 minutes` a
// Session is stale, and at exactly `lease_expires_at` a claim has expired.

/** How often agents are told to heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** A Session with no heartbeat for this long is effectively stale. */
export const SESSION_STALE_AFTER_MS = 5 * 60_000;
/** A Session with no heartbeat for this long is effectively abandoned. */
export const SESSION_ABANDONED_AFTER_MS = 30 * 60_000;
/** A claim expires this long after it was taken or last renewed. */
export const CLAIM_LEASE_MS = 5 * 60_000;

/** Stored statuses that can hold claims and count for overlap checks. */
export const LIVE_SESSION_STATUSES = ["active", "idle"] as const satisfies readonly SessionStatus[];

export interface SessionLiveness {
  status: SessionStatus;
  lastHeartbeatAt: Date;
}

/**
 * The status a Session effectively has at `now`. Terminal statuses are kept;
 * otherwise the heartbeat age decides stale and abandoned.
 */
export function effectiveSessionStatus(session: SessionLiveness, now: Date): SessionStatus {
  if (session.status === "ended" || session.status === "abandoned") return session.status;
  const age = now.getTime() - session.lastHeartbeatAt.getTime();
  if (age >= SESSION_ABANDONED_AFTER_MS) return "abandoned";
  if (age >= SESSION_STALE_AFTER_MS) return "stale";
  return session.status;
}

/** True when the Session is effectively active or idle at `now`. */
export function isSessionLive(session: SessionLiveness, now: Date): boolean {
  const status = effectiveSessionStatus(session, now);
  return status === "active" || status === "idle";
}

/**
 * True when a claim is usable at `now`: its lease has not expired and its
 * holder is effectively live. An unusable claim may be taken by another
 * Session even if no sweep has cleared it yet.
 */
export function isClaimUsable(
  claim: { leaseExpiresAt: Date | null },
  holder: SessionLiveness | null,
  now: Date,
): boolean {
  if (claim.leaseExpiresAt === null || holder === null) return false;
  return now.getTime() < claim.leaseExpiresAt.getTime() && isSessionLive(holder, now);
}

/** SQL condition on `agent_session` matching Sessions effectively live at `now`. */
export function liveSessionCondition(now: Date): SQL {
  const staleBefore = new Date(now.getTime() - SESSION_STALE_AFTER_MS);
  // Live iff now < last_heartbeat_at + 5 min, i.e. last_heartbeat_at > now - 5 min.
  return and(
    inArray(agentSession.status, [...LIVE_SESSION_STATUSES]),
    gt(agentSession.lastHeartbeatAt, staleBefore),
  ) as SQL;
}
