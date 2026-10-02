import { type Db, type EventFilter, listEvents, projectHasSession } from "@hivemind/db";
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
