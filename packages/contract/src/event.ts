import { z } from "zod";
import {
  ADR_SLUG_PATTERN,
  ADR_STATUSES,
  MAX_ADR_NUMBER,
  MAX_ADR_SLUG_LENGTH,
  MAX_ADR_TITLE_LENGTH,
  MIN_ADR_NUMBER,
} from "./adr.ts";
import { actorSchema } from "./auth.ts";
import {
  countSchema,
  decimalStringSchema,
  idSchema,
  markdownSchema,
  pageSchema,
  paginationInputShape,
  textSchema,
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
import {
  agentNameSchema,
  gitCommitSchema,
  sessionIntentSchema,
  sessionStatusSchema,
} from "./session.ts";
import { blockReasonSchema, taskStatusSchema, taskTitleSchema } from "./task.ts";

/**
 * Largest encoded Event DTO (JSON, UTF-8). Every payload is bounded so the
 * whole Event fits; dashboards and streams size their frames from this.
 */
export const MAX_EVENT_BYTES = 64 * 1024;

/**
 * Version of every payload below. A changed payload shape or meaning gets a
 * new version; a value added to an enum may keep it (ADR-0015).
 */
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

/**
 * How one ADR's synced copy changed in an `adr.synced` Event: published for
 * the first time (`added`), published again after a sync removed it
 * (`restored`), changed in content or path (`updated`), or absent from the
 * synced commit (`removed`).
 */
export const ADR_SYNC_CHANGE_KINDS = ["added", "restored", "updated", "removed"] as const;

/** At most this many changes are listed in one `adr.synced` Event; the counts cover all. */
export const MAX_ADR_SYNC_EVENT_CHANGES = 100;

// ADR identity as `adr.*` payloads carry it. An ADR Event affects no Plan,
// Task or Session, so the ADR is named in the payload rather than in a new
// Event column (issue #19). The bounds are adr.ts's; adr-api.ts imports this
// module, so its schemas are not reused here.
const adrNumberSchema = z.int().min(MIN_ADR_NUMBER).max(MAX_ADR_NUMBER);
const adrStatusSchema = z.enum(ADR_STATUSES);
const adrTitleSchema = textSchema(MAX_ADR_TITLE_LENGTH);
const adrSlugSchema = z
  .string()
  .max(MAX_ADR_SLUG_LENGTH)
  .regex(ADR_SLUG_PATTERN, "Must be lowercase words joined by hyphens.");

const adrSyncChangeKindSchema = z.enum(ADR_SYNC_CHANGE_KINDS);

/** One ADR in an `adr.synced` Event. A status is null where no published copy exists. */
const adrSyncChangeSchema = z.discriminatedUnion("change", [
  z.strictObject({
    number: adrNumberSchema,
    change: adrSyncChangeKindSchema.extract(["added", "restored"]),
    statusFrom: z.null(),
    statusTo: adrStatusSchema,
  }),
  z.strictObject({
    number: adrNumberSchema,
    change: adrSyncChangeKindSchema.extract(["updated"]),
    statusFrom: adrStatusSchema,
    statusTo: adrStatusSchema,
  }),
  z.strictObject({
    number: adrNumberSchema,
    change: adrSyncChangeKindSchema.extract(["removed"]),
    statusFrom: adrStatusSchema,
    statusTo: z.null(),
  }),
]);

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
  /**
   * An ADR number was reserved. `floor` is the highest ADR number the client
   * saw locally and on the default branch, 0 when it saw none.
   */
  "adr.reserved": z.strictObject({
    adrId: idSchema,
    number: adrNumberSchema,
    title: adrTitleSchema,
    slug: adrSlugSchema,
    floor: z.int().min(0).max(MAX_ADR_NUMBER),
  }),
  /**
   * The ADRs were synced from `commitSha`. `previousCommitSha` is the commit
   * synced before, null for the first sync; `forced` means the client skipped
   * its ancestry check. The counts cover every change (`added` includes
   * `restored`); `changes` lists the first `MAX_ADR_SYNC_EVENT_CHANGES` in
   * number order, and `truncated` says whether there were more. No titles or
   * content.
   */
  "adr.synced": z.strictObject({
    commitSha: gitCommitSchema,
    previousCommitSha: gitCommitSchema.nullable(),
    forced: z.boolean(),
    added: countSchema,
    updated: countSchema,
    removed: countSchema,
    changes: z.array(adrSyncChangeSchema).max(MAX_ADR_SYNC_EVENT_CHANGES),
    truncated: z.boolean(),
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
    payloadVersion: z.literal(EVENT_PAYLOAD_VERSION),
    type: z.literal(type),
    payload: eventPayloads[type],
  });
}

/**
 * An Event of a type and payload version this build writes, with exactly its
 * declared payload: the writers' vocabulary. Every Event the current
 * `@hivemind/db` helpers write must match it (apps/web/test/event-catalog.test.ts).
 * Reads return `eventSchema`, which adds `event.unavailable`.
 */
export const knownEventSchema = z.discriminatedUnion("type", [
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
  eventVariant("adr.reserved"),
  eventVariant("adr.synced"),
]);

export type KnownEvent = z.infer<typeof knownEventSchema>;

/**
 * The stable fields every stored Event has, whatever its type and payload
 * version. A reader that cannot interpret an Event's details still returns
 * these (ADR-0015).
 */
export const eventMetadataSchema = z.strictObject(eventBaseShape);

export type EventMetadata = z.infer<typeof eventMetadataSchema>;

/**
 * The type of an Event whose details this build cannot read safely. It is a
 * response-only representation, never written: no Event type may use it.
 */
export const UNAVAILABLE_EVENT_TYPE = "event.unavailable";

/**
 * A stored Event whose type, payload version or payload this build does not
 * know, typically one written by a newer deployment before a rollback
 * (ADR-0015). It keeps the Event's id, attribution, affected records and feed
 * position; the original type, version and payload are withheld. Its
 * `payloadVersion` describes this empty payload, not the stored one.
 */
export const unavailableEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal(UNAVAILABLE_EVENT_TYPE),
  payloadVersion: z.literal(1),
  payload: z.strictObject({}),
});

export type UnavailableEvent = z.infer<typeof unavailableEventSchema>;

/**
 * One coordination Event as reads return it: a known Event, or
 * `event.unavailable` when this build cannot read its details. Clients
 * should handle `type` values they do not know, since later versions add
 * types.
 */
export const eventSchema = z.discriminatedUnion("type", [
  ...knownEventSchema.options,
  unavailableEventSchema,
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
