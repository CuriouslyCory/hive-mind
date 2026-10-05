import {
  type Actor,
  type ClaimedTaskIds,
  type CollectionState,
  type Event,
  MAX_PAGE_LIMIT,
  type Overlap,
  type Plan,
  type PlanSummary,
  type Scope,
  type Session,
  type Task,
} from "@hivemind/contract";
import {
  type CollectionState as CollectionRow,
  type Event as EventRow,
  isScopeComplete,
  type Plan as PlanRow,
  type PlanView,
  planKey,
  type ScopeOverlapItem,
  type Scope as ScopeRow,
  type SessionView,
  type TaskView,
} from "@hivemind/db";
import { projectEvent } from "../event-projection";

// Coordination records as the contract's JSON. Database rows never reach a
// response directly: these pick the public fields, turn Dates into ISO
// strings and keep 64-bit integers (Event seq, writer_xid) as decimal strings.

/** Who created a row with `created_by_*` columns (Plans, Tasks). */
export function creatorActor(row: {
  createdByKind: "user" | "project_key";
  createdByUserId: string | null;
  createdByKeyId: string | null;
}): Actor {
  if (row.createdByKind === "user" && row.createdByUserId) {
    return { kind: "user", userId: row.createdByUserId };
  }
  if (row.createdByKind === "project_key" && row.createdByKeyId) {
    return { kind: "project_key", keyId: row.createdByKeyId };
  }
  // The creator check constraints rule this out.
  throw new Error("Row has no creator.");
}

/** A Plan without its body, as lists show it. */
export function toPlanSummaryDto({ plan, progress }: PlanView): PlanSummary {
  return {
    id: plan.id,
    projectId: plan.projectId,
    key: planKey(plan.number),
    title: plan.title,
    status: plan.status,
    ownerUserId: plan.ownerUserId,
    createdBy: creatorActor(plan),
    progress: { ...progress },
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

/** A Plan with its body; an empty stored body reads as `null`. */
export function toPlanDto(view: PlanView): Plan {
  return { ...toPlanSummaryDto(view), body: bodyOf(view.plan) };
}

function bodyOf(plan: PlanRow): string | null {
  return plan.body === "" ? null : plan.body;
}

/** A Task with its claim only if usable at the read's database time (`TaskView`). */
export function toTaskDto({ task, planNumber, claim }: TaskView): Task {
  return {
    id: task.id,
    projectId: task.projectId,
    planId: task.planId,
    planKey: planKey(planNumber),
    title: task.title,
    status: task.status,
    position: task.position,
    claim: claim && {
      sessionId: claim.sessionId,
      claimedAt: claim.claimedAt.toISOString(),
      leaseExpiresAt: claim.leaseExpiresAt.toISOString(),
    },
    blockedReason: task.status === "blocked" ? task.blockReason : null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

/**
 * An Event row as the contract's Event, through the shared projection
 * (`server/event-projection.ts`, ADR-0015): a known Event as stored, or
 * `event.unavailable` when this build cannot read its details. A corrupt row
 * throws `EventProjectionError`. The encoded result is at most
 * `MAX_EVENT_BYTES` (64 KiB), which #11 sizes its frames from.
 */
export function toEventDto(row: EventRow): Event {
  return projectEvent(row);
}

/**
 * A Session as the contract's Session: `status` is the effective status at
 * the read's database time, `hostname` is the `machine` column and
 * `startedAt` its creation. The worktree path is stored but not exposed.
 */
export function toSessionDto({ session, attachedPlanNumber }: SessionView): Session {
  return {
    id: session.id,
    projectId: session.projectId,
    owner: sessionOwnerOf(session),
    agent: session.agent,
    intent: session.intent,
    status: session.effectiveStatus,
    hostname: session.machine,
    gitBranch: session.gitBranch,
    gitCommit: session.gitCommit,
    attachedPlanId: session.attachedPlanId,
    attachedPlanKey: attachedPlanNumber === null ? null : planKey(attachedPlanNumber),
    attachedTaskId: session.attachedTaskId,
    summary: session.summary,
    scopeComplete: isScopeComplete(session),
    startedAt: session.createdAt.toISOString(),
    lastHeartbeatAt: session.lastHeartbeatAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    updatedAt: session.updatedAt.toISOString(),
  };
}

function sessionOwnerOf(session: SessionView["session"]): Session["owner"] {
  if (session.ownerKind === "user" && session.userId) {
    return { kind: "user", userId: session.userId };
  }
  if (session.ownerKind === "key" && session.keyId) return { kind: "key", keyId: session.keyId };
  // agent_session's owner check constraint rules this out.
  throw new Error(`Session ${session.id} has no owner.`);
}

export function toScopeDto(row: ScopeRow): Scope {
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    source: row.source,
    value: row.value,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toOverlapDto(item: ScopeOverlapItem): Overlap {
  return {
    sessionId: item.sessionId,
    otherSessionId: item.otherSessionId,
    scope: { ...item.scope },
    otherScope: { ...item.otherScope },
    kind: item.kind,
    witness: item.witness,
  };
}

/**
 * Where a collection stands. `collectionComplete` additionally requires that
 * the manifest omitted no path; an omission also made the history incomplete,
 * so `scopeComplete` is the database's `isScopeComplete` either way.
 */
export function toCollectionDto(state: CollectionRow): CollectionState {
  const finalized = state.collectionComplete;
  const collectionComplete = finalized && state.omittedPathCount === 0;
  const historicalScopeComplete = !state.scopeHistoryIncomplete;
  return {
    collectionId: state.collectionId,
    sessionId: state.sessionId,
    pathCount: state.pathCount,
    batchCount: state.expectedBatches,
    omittedPathCount: state.omittedPathCount,
    receivedBatchCount: state.receivedBatchCount,
    finalized,
    collectionComplete,
    historicalScopeComplete,
    scopeComplete: collectionComplete && historicalScopeComplete,
  };
}

/** Task UUIDs, at most a page of them, and whether that was all. */
export function toClaimedTaskIds(taskIds: readonly string[]): ClaimedTaskIds {
  return { items: taskIds.slice(0, MAX_PAGE_LIMIT), complete: taskIds.length <= MAX_PAGE_LIMIT };
}
