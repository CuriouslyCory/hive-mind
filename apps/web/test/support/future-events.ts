import { randomUUID } from "node:crypto";
import { type Db, type Event as EventRow, schema } from "@hivemind/db";

// Events as a newer deployment would have stored them, for tests of reads
// after a rollback (ADR-0015, issue #15). These are the only direct Event
// inserts in the web tests: everything else is written through the API or the
// db helpers. `seq` and `writer_xid` come from Postgres, as for real writes.

/** A unique string that must never appear in a response, page or log. */
export function canary(): string {
  return `hm-canary-${randomUUID()}`;
}

/** The stored details a newer writer might use, each hiding `secret`. */
export function futureShapes(secret: string) {
  return {
    "unknown type": { type: "plan.archived", payloadVersion: 1, payload: { secret } },
    "newer reason": { type: "task.released", payloadVersion: 1, payload: { reason: secret } },
    "unsupported version": {
      type: "plan.log_appended",
      payloadVersion: 2,
      payload: { message: secret },
    },
    "extra field": {
      type: "task.done",
      payloadVersion: 1,
      payload: { from: "in_progress", secret },
    },
  } as const;
}

export type FutureEventInput = Pick<EventRow, "projectId" | "type" | "payloadVersion"> & {
  payload: unknown;
} & Partial<
    Pick<
      EventRow,
      | "id"
      | "actorKind"
      | "actorUserId"
      | "actorKeyId"
      | "actorSessionId"
      | "planId"
      | "taskId"
      | "sessionId"
      | "creationFingerprint"
      | "effectiveAt"
      | "createdAt"
    >
  >;

/**
 * Inserts one Event row as stored by a writer this build may not know. The
 * actor defaults to the system; the affected records must belong to the
 * Project (the composite foreign keys check it).
 */
export async function insertFutureEvent(db: Db, input: FutureEventInput): Promise<EventRow> {
  const now = new Date();
  const [row] = await db
    .insert(schema.event)
    .values({
      actorKind: "system",
      effectiveAt: now,
      createdAt: now,
      ...input,
    })
    .returning();
  if (!row) throw new Error("event insert returned no row");
  return row;
}
