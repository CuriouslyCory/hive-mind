import { z } from "zod";
import { actorSchema } from "./auth.ts";
import {
  countSchema,
  decimalStringSchema,
  idSchema,
  markdownSchema,
  pageSchema,
  paginationInputShape,
  timestampSchema,
} from "./common.ts";
import {
  actorSessionInputShape,
  planKeySchema,
  planRefSchema,
  planStatusSchema,
  planTitleSchema,
  targetPlanStatusSchema,
} from "./plan.ts";
import { MAX_COLLECTION_BATCH_PATHS, scopeValueSchema } from "./scope.ts";
import { agentNameSchema, sessionIntentSchema, sessionStatusSchema } from "./session.ts";
import { blockReasonSchema, taskStatusSchema, taskTitleSchema } from "./task.ts";

/**
 * Largest encoded Event DTO (JSON, UTF-8). Every payload is bounded so the
 * whole Event fits; dashboards and streams size their frames from this.
 */
export const MAX_EVENT_BYTES = 64 * 1024;

/** Version of every payload below. A changed payload shape gets a new version. */
export const EVENT_PAYLOAD_VERSION = 1;

/** Why a claim ended without `done`. Clients must accept reasons they do not know. */
export const CLAIM_RELEASE_REASONS = [
  "released",
  "stolen",
  "lease_expired",
  "session_stale",
  "session_ended",
  "session_abandoned",
  "plan_abandoned",
] as const;

export const claimReleaseReasonSchema = z.enum(CLAIM_RELEASE_REASONS);

/**
 * Why a Session's touched-path coverage became incomplete for good: paths the
 * client omitted, paths the server could not store as written, paths beyond
 * the Session's touched-Scope limit, or a collection replaced by a newer one
 * before it was finalized.
 */
export const COVERAGE_LOST_REASONS = [
  "omitted_paths",
  "unrepresentable_paths",
  "touched_capacity",
  "collection_superseded",
] as const;

export const coverageLostReasonSchema = z.enum(COVERAGE_LOST_REASONS);

/** Session fields an update can change, as `session.updated` lists them. */
export const SESSION_UPDATE_FIELDS = [
  "agent",
  "intent",
  "hostname",
  "gitBranch",
  "gitCommit",
  "status",
] as const;

// Payloads, version 1, by Event type. They hold what changed, not whole
// records or requests, and never credentials.
const eventPayloads = {
  "plan.created": z.strictObject({
    key: planKeySchema,
    title: planTitleSchema,
    status: planStatusSchema,
  }),
  "plan.updated": z.strictObject({
    /** The new title, or null if unchanged. */
    title: planTitleSchema.nullable(),
    bodyChanged: z.boolean(),
  }),
  "plan.status_changed": z.strictObject({
    from: planStatusSchema,
    to: targetPlanStatusSchema,
  }),
  /** A Plan log entry. Its Event UUID is the client-generated entry ID. */
  "plan.log_appended": z.strictObject({
    message: markdownSchema(),
  }),
  "task.added": z.strictObject({
    title: taskTitleSchema,
    position: countSchema,
  }),
  /** `sessionId` (affected) is the new holder; a steal names the former one. */
  "task.claimed": z.strictObject({
    stolenFromSessionId: idSchema.nullable(),
    leaseExpiresAt: timestampSchema,
  }),
  /** `sessionId` (affected) is the Session that lost the claim. */
  "task.released": z.strictObject({
    reason: claimReleaseReasonSchema,
  }),
  "task.started": z.strictObject({
    from: taskStatusSchema,
  }),
  "task.blocked": z.strictObject({
    from: taskStatusSchema,
    reason: blockReasonSchema,
  }),
  "task.done": z.strictObject({
    from: taskStatusSchema,
  }),
  "session.started": z.strictObject({
    agent: agentNameSchema,
    intent: sessionIntentSchema,
  }),
  "session.updated": z.strictObject({
    fields: z.array(z.enum(SESSION_UPDATE_FIELDS)).min(1).max(SESSION_UPDATE_FIELDS.length),
  }),
  /** The new focus is the Event's affected `planId`/`taskId` (both null when cleared). */
  "session.attached": z.strictObject({
    previousPlanId: idSchema.nullable(),
    previousTaskId: idSchema.nullable(),
  }),
  "session.heartbeat": z.strictObject({
    from: sessionStatusSchema,
    to: z.enum(["active", "idle"]),
    renewedClaimCount: countSchema,
    releasedClaimCount: countSchema,
    collectionId: idSchema,
  }),
  /** A Session lapsing to stale or abandoned, written by the sweep or by a later mutation. */
  "session.status_changed": z.strictObject({
    from: sessionStatusSchema,
    to: z.enum(["stale", "abandoned"]),
  }),
  "session.ended": z.strictObject({
    from: sessionStatusSchema,
    summary: markdownSchema(),
  }),
  "scope.added": z.strictObject({
    scopeId: idSchema,
    pattern: scopeValueSchema,
  }),
  "scope.removed": z.strictObject({
    scopeId: idSchema,
    pattern: scopeValueSchema,
  }),
  /** Touched paths one collection batch newly stored. */
  "scope.touched": z.strictObject({
    collectionId: idSchema,
    paths: z.array(scopeValueSchema).min(1).max(MAX_COLLECTION_BATCH_PATHS),
  }),
  /** A collection matched its manifest; `pathCount` distinct paths. */
  "scope.collection_finalized": z.strictObject({
    collectionId: idSchema,
    pathCount: countSchema,
  }),
  /**
   * The Session's touched-path coverage became incomplete for the rest of its
   * life; written once, when that first happens. `pathCount` is how many
   * paths were affected, null when unknown (a superseded collection that
   * never registered a manifest).
   */
  "scope.coverage_lost": z.strictObject({
    collectionId: idSchema.nullable(),
    reason: coverageLostReasonSchema,
    pathCount: countSchema.nullable(),
  }),
} as const;

export type EventType = keyof typeof eventPayloads;

export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[];

const eventBaseShape = {
  id: idSchema,
  projectId: idSchema,
  /**
   * Database sequence, as a decimal string. It increases with insertion but
   * may have gaps; a gap is never a missing Event.
   */
  seq: decimalStringSchema,
  /** The writing transaction's ID (PostgreSQL xid8), as a decimal string. */
  writerXid: decimalStringSchema,
  payloadVersion: z.literal(EVENT_PAYLOAD_VERSION),
  actor: actorSchema,
  /** The Session the actor acted through, when there was one. */
  actorSessionId: idSchema.nullable(),
  // The records the change affected, separate from the actor's Session.
  planId: idSchema.nullable(),
  taskId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  /** When the change took effect (a lapse can be recorded after it happened). */
  effectiveAt: timestampSchema,
  /** When the Event was written. */
  createdAt: timestampSchema,
};

function eventVariant<T extends EventType>(type: T) {
  return z.strictObject({
    ...eventBaseShape,
    type: z.literal(type),
    payload: eventPayloads[type],
  });
}

/**
 * One coordination Event. Clients should handle `type` values they do not
 * know, since later versions add types.
 */
export const eventSchema = z.discriminatedUnion("type", [
  eventVariant("plan.created"),
  eventVariant("plan.updated"),
  eventVariant("plan.status_changed"),
  eventVariant("plan.log_appended"),
  eventVariant("task.added"),
  eventVariant("task.claimed"),
  eventVariant("task.released"),
  eventVariant("task.started"),
  eventVariant("task.blocked"),
  eventVariant("task.done"),
  eventVariant("session.started"),
  eventVariant("session.updated"),
  eventVariant("session.attached"),
  eventVariant("session.heartbeat"),
  eventVariant("session.status_changed"),
  eventVariant("session.ended"),
  eventVariant("scope.added"),
  eventVariant("scope.removed"),
  eventVariant("scope.touched"),
  eventVariant("scope.collection_finalized"),
  eventVariant("scope.coverage_lost"),
]);

export type Event = z.infer<typeof eventSchema>;

export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>;

/** A page of Events, newest (highest `seq`) first. */
export const eventPageSchema = pageSchema(eventSchema);

export type EventPage = z.infer<typeof eventPageSchema>;

/** `GET /projects/{id}/events`: every Event of the Project. */
export const listProjectEventsInputSchema = z.strictObject({
  id: idSchema,
  ...paginationInputShape,
});

export type ListProjectEventsInput = z.input<typeof listProjectEventsInputSchema>;

/**
 * `GET /projects/{id}/plans/{planRef}/log`: the Plan's activity, every Event
 * whose affected `planId` is the Plan, log entries included.
 */
export const listPlanLogInputSchema = z.strictObject({
  id: idSchema,
  planRef: planRefSchema,
  ...paginationInputShape,
});

export type ListPlanLogInput = z.input<typeof listPlanLogInputSchema>;

/**
 * `GET /projects/{id}/sessions/{sessionId}/events`: Events the Session acted
 * through (`actorSessionId`) or that affected it (`sessionId`).
 */
export const listSessionEventsInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  ...paginationInputShape,
});

export type ListSessionEventsInput = z.input<typeof listSessionEventsInputSchema>;

/**
 * `POST /projects/{id}/plans/{planRef}/log`: append a markdown entry, allowed
 * in any Plan status. `eventId` is generated once by the client and becomes
 * the Event's UUID; replay follows `createPlanInputSchema`.
 */
export const appendPlanLogInputSchema = z.strictObject({
  id: idSchema,
  planRef: planRefSchema,
  eventId: idSchema,
  message: markdownSchema(),
  ...actorSessionInputShape,
});

export type AppendPlanLogInput = z.input<typeof appendPlanLogInputSchema>;

export const appendPlanLogOutputSchema = z.strictObject({
  event: eventSchema,
  created: z.boolean(),
});

export type AppendPlanLogOutput = z.infer<typeof appendPlanLogOutputSchema>;
