import { and, desc, eq, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import { agentSession } from "./schema/coordination.ts";
import { type Event, event } from "./schema/event.ts";

// Event reads (issue #12 step 5): a Project's activity, one Plan's log and
// one Session's history, newest (highest seq) first. Pages continue by seq,
// which is unique; gaps in it are normal and never mean a missing Event.
// These are plain reads: M2 implements neither a stream nor the
// (writer_xid, seq) safe-horizon queries of #11.

/** Which Events of the Project to list. */
export type EventFilter =
  | { kind: "project" }
  /** Events whose affected Plan is this one (its log entries included). */
  | { kind: "plan"; planId: string }
  /** Events the Session acted through or that affected it. */
  | { kind: "session"; sessionId: string };

const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** Whether `value` is a decimal a Postgres bigint can hold, so the cast cannot fail. */
function isSeq(value: string): boolean {
  return DECIMAL.test(value) && BigInt(value) <= MAX_BIGINT;
}

/**
 * A page of the Project's Events matching `filter`, newest first.
 * `beforeSeq` (a decimal string from a previous page) continues after that
 * page's last Event. The caller resolves the Plan or Session within the
 * Project first; ids from another Project match nothing here anyway.
 */
export async function listEvents(
  db: Db,
  input: { projectId: string; filter: EventFilter; limit: number; beforeSeq?: string },
): Promise<{ items: Event[]; hasMore: boolean }> {
  const conditions: SQL[] = [eq(event.projectId, input.projectId)];
  const { filter } = input;
  if (filter.kind === "plan") conditions.push(eq(event.planId, filter.planId));
  if (filter.kind === "session") {
    conditions.push(
      or(eq(event.actorSessionId, filter.sessionId), eq(event.sessionId, filter.sessionId)) as SQL,
    );
  }
  if (input.beforeSeq !== undefined) {
    if (!isSeq(input.beforeSeq)) throw new Error("beforeSeq must be a decimal bigint.");
    conditions.push(sql`${event.seq} < ${input.beforeSeq}::bigint`);
  }
  const rows = await db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.seq))
    .limit(input.limit + 1);
  return { items: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
}

/** Whether `sessionId` names a Session of the Project, whoever owns it. */
export async function projectHasSession(
  db: Db,
  projectId: string,
  sessionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentSession.id })
    .from(agentSession)
    .where(and(eq(agentSession.id, sessionId), eq(agentSession.projectId, projectId)))
    .limit(1);
  return row !== undefined;
}
