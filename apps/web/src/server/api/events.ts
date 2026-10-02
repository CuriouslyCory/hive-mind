import { decodeFeedCursor, type EventStreamFrame, type FeedPosition } from "@hivemind/contract";
import { type Db, type EventFilter, listEvents, projectHasSession } from "@hivemind/db";
import { apiError } from "./authorize";
import { authorizeProject, sessionNotFound } from "./coordination-auth";
import { toEventDto } from "./coordination-dto";
import { api } from "./implementer";
import { decodeKeysetCursor, encodeKeysetCursor, SEQ_POSITION } from "./keyset";
import { pageLimit } from "./pagination";

// Event reads (issue #12 step 5): a Project's activity and one Session's
// history; a Plan's log is in plans.ts. Newest (highest seq) first, paged by
// seq with cursors bound to the Project and the filtered record.

/**
 * One page of the Project's Events matching `filter`, as the contract's
 * Event page. Call it after authorizing the Project and resolving the
 * filtered Plan or Session within it.
 */
export async function listEventPage(
  db: Db,
  projectId: string,
  filter: EventFilter,
  input: { limit?: number; cursor?: string },
) {
  const scope = [
    "events",
    projectId,
    filter.kind,
    filter.kind === "plan" ? filter.planId : filter.kind === "session" ? filter.sessionId : null,
  ];
  const limit = pageLimit(input.limit);
  const beforeSeq = input.cursor
    ? decodeKeysetCursor(scope, input.cursor, [SEQ_POSITION])[0]
    : undefined;
  const page = await listEvents(db, { projectId, filter, limit, beforeSeq });
  const last = page.items.at(-1);
  return {
    items: page.items.map(toEventDto),
    nextCursor: page.hasMore && last ? encodeKeysetCursor(scope, [last.seq]) : null,
  };
}

/** `GET /projects/{id}/events`: every Event of the Project. */
export const listProjectEvents = api.projects.events.list.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["event:read"]);
    return listEventPage(db, input.id, { kind: "project" }, input);
  },
);

/**
 * Where a stream starts: the `Last-Event-ID` header (oRPC passes it to the
 * handler as `lastEventId`), else the `cursor` query parameter, else `null`
 * for the current safe boundary. An invalid cursor is 400 (ADR-0010).
 */
export function streamStart(
  projectId: string,
  lastEventId: string | undefined,
  cursor: string | undefined,
): FeedPosition | null {
  const presented = lastEventId ?? cursor;
  if (presented === undefined) return null;
  const decoded = decodeFeedCursor(presented, projectId);
  if (!decoded.ok)
    throw apiError("BAD_REQUEST", "The cursor is not one this Project's Event stream issued.");
  return decoded.position;
}

/**
 * `GET /projects/{id}/events/stream`. PLACEHOLDER until the stream engine of
 * issue #11 replaces it: it checks access and the cursor before the stream
 * opens, as the engine will, then ends the stream without sending a frame.
 */
export const streamProjectEvents = api.projects.events.stream.handler(
  async ({ input, lastEventId, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["event:read"]);
    streamStart(input.id, lastEventId, input.cursor);
    return (async function* (): AsyncGenerator<EventStreamFrame> {})();
  },
);

/**
 * `GET /projects/{id}/sessions/{sessionId}/events`: Events the Session acted
 * through or that affected it. Any Session of the Project, whoever owns it.
 */
export const listSessionEvents = api.projects.sessions.events.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["session:read", "event:read"]);
    if (!(await projectHasSession(db, input.id, input.sessionId))) throw sessionNotFound();
    return listEventPage(db, input.id, { kind: "session", sessionId: input.sessionId }, input);
  },
);
