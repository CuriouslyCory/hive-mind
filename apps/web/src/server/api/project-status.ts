import { MAX_STATUS_SECTION_ITEMS } from "@hivemind/contract";
import { projectStatus } from "@hivemind/db";
import { authorizeProject, sessionNotFound } from "./coordination-auth";
import {
  toOverlapDto,
  toPlanSummaryDto,
  toScopeDto,
  toSessionDto,
  toTaskDto,
} from "./coordination-dto";
import { api } from "./implementer";

/**
 * `GET /projects/{id}/status` (issue #12, "Project status"): active Plans,
 * live Sessions with their declared Scopes, the selected Session's claims,
 * recent terminal Sessions and overlap warnings, all computed by
 * `@hivemind/db` from one database time and without writing. `myClaims` is
 * filled only for a Session the caller names (any Session of the Project, as
 * every Session is visible to it); the server never guesses one.
 */
export const getProjectStatus = api.projects.status.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, [
      "project:read",
      "plan:read",
      "task:read",
      "session:read",
      "scope:read",
    ]);
    const status = await projectStatus(db, {
      projectId: input.id,
      sessionId: input.sessionId,
      sectionLimit: MAX_STATUS_SECTION_ITEMS,
    });
    if (status.status !== "ok") throw sessionNotFound();
    return {
      projectId: input.id,
      asOf: status.asOf.toISOString(),
      selectedSessionId: status.selectedSessionId,
      activePlans: status.activePlans.items.map(toPlanSummaryDto),
      liveSessions: status.liveSessions.items.map((entry) => ({
        session: toSessionDto(entry),
        declaredScopes: entry.declaredScopes.map(toScopeDto),
        touchedScopeCount: entry.touchedScopeCount,
        claimCount: entry.claimCount,
      })),
      myClaims: status.myClaims.items.map(toTaskDto),
      recentTerminalSessions: status.recentTerminalSessions.items.map(toSessionDto),
      overlaps: status.overlaps.items.map(toOverlapDto),
      complete: {
        activePlans: status.activePlans.complete,
        liveSessions: status.liveSessions.complete,
        myClaims: status.myClaims.complete,
        recentTerminalSessions: status.recentTerminalSessions.complete,
        overlaps: status.overlaps.complete,
      },
    };
  },
);
