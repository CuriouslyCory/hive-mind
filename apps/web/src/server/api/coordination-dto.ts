import {
  type Actor,
  type Event,
  eventSchema,
  MAX_EVENT_BYTES,
  type Plan,
  type PlanSummary,
  type Task,
} from "@hivemind/contract";
import {
  type Event as EventRow,
  encodedJsonBytes,
  type Plan as PlanRow,
  type PlanView,
  planKey,
  type TaskView,
} from "@hivemind/db";

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

function eventActor(row: EventRow): Actor {
  if (row.actorKind === "system") return { kind: "system" };
  if (row.actorKind === "user" && row.actorUserId) return { kind: "user", userId: row.actorUserId };
  if (row.actorKind === "project_key" && row.actorKeyId) {
    return { kind: "project_key", keyId: row.actorKeyId };
  }
  // event_actor_check rules this out.
  throw new Error(`Event ${row.id} has no actor.`);
}

/**
 * An Event row as the contract's Event. The stored type and payload are
 * returned as they are, so `@hivemind/db`'s Event catalog (src/event.ts) must
 * use the contract's types and payloads; the DTO is validated against
 * `eventSchema` here so a row that does not fit fails with its type named
 * rather than as an anonymous output-validation error. The whole encoded DTO
 * is bounded by `MAX_EVENT_BYTES` (64 KiB), which #11 sizes its frames from.
 */
export function toEventDto(row: EventRow): Event {
  const dto = {
    id: row.id,
    projectId: row.projectId,
    seq: row.seq,
    writerXid: row.writerXid,
    type: row.type,
    payloadVersion: row.payloadVersion,
    payload: row.payload,
    actor: eventActor(row),
    actorSessionId: row.actorSessionId,
    planId: row.planId,
    taskId: row.taskId,
    sessionId: row.sessionId,
    effectiveAt: row.effectiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
  const parsed = eventSchema.safeParse(dto);
  if (!parsed.success) {
    throw new Error(`Event ${row.id} (${row.type}) does not match the contract: ${parsed.error}`);
  }
  const bytes = encodedJsonBytes(parsed.data);
  if (bytes > MAX_EVENT_BYTES) {
    throw new Error(`Event ${row.id} encodes to ${bytes} bytes; the limit is ${MAX_EVENT_BYTES}.`);
  }
  return parsed.data;
}
