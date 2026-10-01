import { z } from "zod";
import { countSchema, idSchema, timestampSchema } from "./common.ts";
import { planSummarySchema } from "./plan.ts";
import { MAX_DECLARED_SCOPES_PER_SESSION, overlapSchema, scopeSchema } from "./scope.ts";
import { sessionSchema } from "./session.ts";
import { taskSchema } from "./task.ts";

/**
 * Most records in each section of the Project status. A section with more
 * records says so in `complete`; the paged routes named below list them all.
 */
export const MAX_STATUS_SECTION_ITEMS = 20;

/**
 * `GET /projects/{id}/status`. `sessionId` selects the Session whose claims
 * fill `myClaims` and whose Scopes `overlaps` compares; it must be a Session
 * of this Project (NOT_FOUND otherwise). Without it the server picks none:
 * `myClaims` is `[]` and `overlaps` compares the live Sessions with each other.
 */
export const getProjectStatusInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema.optional(),
});

export type GetProjectStatusInput = z.input<typeof getProjectStatusInputSchema>;

/**
 * A live Session with its declared Scopes (all of them: at most 32). Touched
 * paths are counted here and listed by `GET .../sessions/{sessionId}/scopes`.
 */
export const liveSessionEntrySchema = z.strictObject({
  session: sessionSchema,
  declaredScopes: z.array(scopeSchema).max(MAX_DECLARED_SCOPES_PER_SESSION),
  touchedScopeCount: countSchema,
  claimCount: countSchema,
});

export type LiveSessionEntry = z.infer<typeof liveSessionEntrySchema>;

function section<T extends z.ZodType>(item: T) {
  return z.array(item).max(MAX_STATUS_SECTION_ITEMS);
}

/**
 * A Project overview computed from one database timestamp (`asOf`), with no
 * writes. Each section is bounded; `complete.<section>` is false when more
 * records exist than the section holds.
 */
export const projectStatusSchema = z.strictObject({
  projectId: idSchema,
  asOf: timestampSchema,
  selectedSessionId: idSchema.nullable(),
  /** `active` Plans with progress, newest first. All: `GET .../plans?status=active`. */
  activePlans: section(planSummarySchema),
  /** Live Sessions, most recent heartbeat first. All: `GET .../sessions?status=live`. */
  liveSessions: section(liveSessionEntrySchema),
  /**
   * The selected Session's usable claims; `[]` without a selected Session.
   * All: `GET .../sessions/{sessionId}/claims`.
   */
  myClaims: section(taskSchema),
  /** Ended or abandoned Sessions, most recent heartbeat first. All: `GET .../sessions?status=terminal`. */
  recentTerminalSessions: section(sessionSchema),
  /**
   * Scope overlaps among live Sessions. `complete: false` here also covers an
   * exhausted budget or incomplete coverage, so it is never a false all-clear.
   * All for one Session: `GET .../sessions/{sessionId}/overlaps`.
   */
  overlaps: section(overlapSchema),
  complete: z.strictObject({
    activePlans: z.boolean(),
    liveSessions: z.boolean(),
    myClaims: z.boolean(),
    recentTerminalSessions: z.boolean(),
    overlaps: z.boolean(),
  }),
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
