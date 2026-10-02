import { EVENT_TYPES } from "@hivemind/contract";
import type { StreamEvent } from "./project-event-stream";

// Which live Events make a dashboard page re-read itself from the server
// (issue #11). The overview shows the whole Project, so every Event counts.
// Detail pages count Events whose affected records they show, including the
// claim, Scope and liveness changes of the Sessions they list. An Event type
// this build does not know refreshes every page.

/** What a page shows, as it registers with `ProjectLivePage` from its server render. */
export type LiveUpdateScope =
  /** The Project overview: every Event of the Project. */
  | { kind: "project" }
  /**
   * A Plan page. `taskIds` and `sessionIds` are the Plan's Tasks and the
   * Sessions it shows (attached, claiming or recently active); the server
   * render passes them, so they follow refreshes.
   */
  | {
      kind: "plan";
      planId: string;
      taskIds?: readonly string[];
      sessionIds?: readonly string[];
    }
  /** A Session page, with the Plan and Task it is attached to, if any. */
  | { kind: "session"; sessionId: string; planId?: string | null; taskId?: string | null };

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Whether this build knows the Event type. Unknown types refresh every page. */
export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}

/** The overview: any Event of the Project. */
export function affectsProjectOverview(_event: StreamEvent): boolean {
  return true;
}

function previousPlanId(event: StreamEvent): unknown {
  const payload = event.payload;
  return typeof payload === "object" && payload !== null && "previousPlanId" in payload
    ? payload.previousPlanId
    : undefined;
}

/**
 * A Plan page: Events of the Plan or its Tasks (claims included, since task
 * Events carry the Plan), a Session leaving the Plan, and any Event of a
 * Session the page shows (Scope, heartbeat and liveness changes).
 */
export function affectsPlan(
  event: StreamEvent,
  scope: { planId: string; taskIds?: readonly string[]; sessionIds?: readonly string[] },
): boolean {
  if (!isKnownEventType(event.type)) return true;
  if (event.planId === scope.planId) return true;
  if (event.taskId !== null && scope.taskIds?.includes(event.taskId)) return true;
  if (event.type === "session.attached" && previousPlanId(event) === scope.planId) return true;
  const sessions = scope.sessionIds ?? [];
  return (
    (event.sessionId !== null && sessions.includes(event.sessionId)) ||
    (event.actorSessionId !== null && sessions.includes(event.actorSessionId))
  );
}

/**
 * A Session page: Events that affected the Session or that it acted
 * through, and changes to the Plan or Task it is attached to.
 */
export function affectsSession(
  event: StreamEvent,
  scope: { sessionId: string; planId?: string | null; taskId?: string | null },
): boolean {
  if (!isKnownEventType(event.type)) return true;
  if (event.sessionId === scope.sessionId || event.actorSessionId === scope.sessionId) return true;
  if (scope.taskId && event.taskId === scope.taskId) return true;
  return Boolean(scope.planId) && event.planId === scope.planId && event.type.startsWith("plan.");
}

/** The filter for `scope`. */
export function shouldRefreshFor(scope: LiveUpdateScope, event: StreamEvent): boolean {
  switch (scope.kind) {
    case "project":
      return affectsProjectOverview(event);
    case "plan":
      return affectsPlan(event, scope);
    case "session":
      return affectsSession(event, scope);
  }
}

function sortedIds(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])].sort();
}

/**
 * A string equal for two scopes exactly when they select the same Events,
 * whatever the order of their ids. The live-update registry compares keys
 * to tell whether the filter changed.
 */
export function liveUpdateScopeKey(scope: LiveUpdateScope): string {
  switch (scope.kind) {
    case "project":
      return JSON.stringify(["project"]);
    case "plan":
      return JSON.stringify([
        "plan",
        scope.planId,
        sortedIds(scope.taskIds),
        sortedIds(scope.sessionIds),
      ]);
    case "session":
      return JSON.stringify([
        "session",
        scope.sessionId,
        scope.planId ?? null,
        scope.taskId ?? null,
      ]);
  }
}
