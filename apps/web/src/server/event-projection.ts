import {
  type Actor,
  type Event,
  eventMetadataSchema,
  idSchema,
  type KnownEvent,
  knownEventSchema,
  MAX_EVENT_BYTES,
  UNAVAILABLE_EVENT_TYPE,
} from "@hivemind/contract";
import { type Event as EventRow, encodedJsonBytes, MAX_EVENT_PAYLOAD_BYTES } from "@hivemind/db";

// The one way a stored Event becomes what a reader sees (ADR-0015, issue
// #15). API pages, Plan log replay, both Event stream adapters and the
// dashboard all go through `projectEvent`, so an Event written by a newer
// deployment reads the same everywhere after a rollback: a known Event is
// returned unchanged, and one whose details this build cannot read becomes
// `event.unavailable`, keeping its id, attribution, affected records and
// feed position. Only validated, declared fields are returned; the stored
// type, version and payload of an unavailable Event are never copied out.

/** Why a stored Event cannot be served at all. */
export type EventProjectionFailure =
  /** An id, actor, affected record or timestamp column is not valid. */
  | "invalid_metadata"
  /** `payload_version` is not a positive integer. */
  | "invalid_payload_version"
  /** The stored payload is over `MAX_EVENT_PAYLOAD_BYTES`, the writer's limit. */
  | "payload_too_large"
  /** The Event as returned would be over `MAX_EVENT_BYTES`. */
  | "event_too_large";

/**
 * A stored Event that is corrupt rather than merely newer. Its message names
 * only the failure and the Event's UUID, never stored values, so it is safe to
 * log; the API answers it with a generic 500.
 */
export class EventProjectionError extends Error {
  readonly code: EventProjectionFailure;

  constructor(code: EventProjectionFailure, eventId: string | null) {
    super(`Event ${eventId ?? "with an invalid id"} cannot be read: ${code}.`);
    this.name = "EventProjectionError";
    this.code = code;
  }
}

/** Decodes Events this build knows. Production uses `knownEventSchema`. */
export interface KnownEventDecoder {
  safeParse(value: unknown): { success: true; data: KnownEvent } | { success: false };
}

/**
 * A projection over the vocabulary `known`. Only tests choose another
 * vocabulary, to read as an older build would; callers use `projectEvent`.
 */
export function createEventProjector(known: KnownEventDecoder): (row: EventRow) => Event {
  return (row) => {
    const safeId = idSchema.safeParse(row.id).success ? row.id : null;
    const fail = (code: EventProjectionFailure) => new EventProjectionError(code, safeId);

    const metadata = eventMetadataSchema.safeParse({
      id: row.id,
      projectId: row.projectId,
      seq: row.seq,
      writerXid: row.writerXid,
      actor: actorOf(row),
      actorSessionId: row.actorSessionId,
      planId: row.planId,
      taskId: row.taskId,
      sessionId: row.sessionId,
      effectiveAt: isoTimestamp(row.effectiveAt),
      createdAt: isoTimestamp(row.createdAt),
    });
    if (!metadata.success) throw fail("invalid_metadata");
    if (!Number.isSafeInteger(row.payloadVersion) || row.payloadVersion < 1) {
      throw fail("invalid_payload_version");
    }
    // The writer's own limit, measured the way `insertEvent` measures it. An
    // oversized payload is corruption, not a newer vocabulary.
    if (encodedJsonBytes(row.payload) > MAX_EVENT_PAYLOAD_BYTES) throw fail("payload_too_large");

    const decoded = known.safeParse({
      ...metadata.data,
      type: row.type,
      payloadVersion: row.payloadVersion,
      payload: row.payload,
    });
    // An unknown type or version, a newer enum value, and a payload with
    // extra, missing or mistyped fields all look the same from here: details
    // this build cannot vouch for.
    const projected: Event = decoded.success
      ? decoded.data
      : { ...metadata.data, type: UNAVAILABLE_EVENT_TYPE, payloadVersion: 1, payload: {} };

    if (encodedJsonBytes(projected) > MAX_EVENT_BYTES) throw fail("event_too_large");
    return projected;
  };
}

/** A stored Event as this build's readers see it. */
export const projectEvent = createEventProjector(knownEventSchema);

// Returns undefined for an inconsistent row, which then fails metadata
// validation; `event_actor_check` rules that out for stored rows.
function actorOf(row: EventRow): Actor | undefined {
  if (row.actorKind === "system") return { kind: "system" };
  if (row.actorKind === "user" && row.actorUserId) return { kind: "user", userId: row.actorUserId };
  if (row.actorKind === "project_key" && row.actorKeyId) {
    return { kind: "project_key", keyId: row.actorKeyId };
  }
  return undefined;
}

function isoTimestamp(value: Date): string | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}
