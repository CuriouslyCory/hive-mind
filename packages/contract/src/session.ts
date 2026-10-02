import { z } from "zod";
import {
  idSchema,
  markdownSchema,
  pageSchema,
  paginationInputShape,
  textSchema,
  timestampSchema,
} from "./common.ts";
import { planKeySchema, planRefSchema } from "./plan.ts";
import { claimedTaskIdsSchema } from "./task.ts";

export const MAX_AGENT_NAME_LENGTH = 120;
export const MAX_SESSION_INTENT_LENGTH = 2048;
export const MAX_HOSTNAME_LENGTH = 255;
export const MAX_GIT_BRANCH_LENGTH = 255;

// Lifecycle timing. The server judges all of it with database time; these
// copies tell clients how often to heartbeat and when a Session lapses.
export const HEARTBEAT_INTERVAL_SECONDS = 60;
/** A Session is stale at exactly `lastHeartbeatAt` plus this. */
export const SESSION_STALE_AFTER_SECONDS = 5 * 60;
/** A Session is abandoned at exactly `lastHeartbeatAt` plus this; a heartbeat cannot revive it. */
export const SESSION_ABANDONED_AFTER_SECONDS = 30 * 60;
/** A claim lease expires this long after it was taken or last renewed. */
export const CLAIM_LEASE_SECONDS = 5 * 60;

/**
 * A Session's effective status, computed from `lastHeartbeatAt` and database
 * time when it is read, not trusted from the stored row. `active` and `idle`
 * are live: they hold claims and take part in overlap checks.
 */
export const SESSION_STATUSES = ["active", "idle", "stale", "ended", "abandoned"] as const;

export const sessionStatusSchema = z.enum(SESSION_STATUSES);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** The statuses a caller can choose (Session update and heartbeat). */
export const liveSessionStatusSchema = z.enum(["active", "idle"]);

/**
 * `GET /projects/{id}/sessions?status=`: one effective status, `live`
 * (active or idle) or `terminal` (ended or abandoned).
 */
export const sessionListFilterSchema = z.enum(["live", "terminal", ...SESSION_STATUSES]);

export type SessionListFilter = z.infer<typeof sessionListFilterSchema>;

/**
 * Who owns a Session, fixed at start: a User, or a Project key acting as
 * itself. `keyId` stays after the key is revoked or deleted, but a revoked key
 * cannot continue the Session.
 */
export const SESSION_OWNER_KINDS = ["user", "key"] as const;

export const sessionOwnerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: idSchema }),
  z.strictObject({ kind: z.literal("key"), keyId: idSchema }),
]);

export type SessionOwner = z.infer<typeof sessionOwnerSchema>;

export const agentNameSchema = textSchema(MAX_AGENT_NAME_LENGTH);
export const sessionIntentSchema = textSchema(MAX_SESSION_INTENT_LENGTH);
export const hostnameSchema = textSchema(MAX_HOSTNAME_LENGTH);
export const gitBranchSchema = textSchema(MAX_GIT_BRANCH_LENGTH);

/** A full SHA-1 or SHA-256 object name, lowercase. */
export const gitCommitSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Must be a full lowercase commit hash.");

export const sessionSummarySchema = markdownSchema();

export const sessionSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  owner: sessionOwnerSchema,
  agent: agentNameSchema,
  intent: sessionIntentSchema,
  status: sessionStatusSchema,
  // Machine and git metadata the client had; null when unavailable (for
  // example outside a git worktree), never guessed.
  hostname: hostnameSchema.nullable(),
  gitBranch: gitBranchSchema.nullable(),
  gitCommit: gitCommitSchema.nullable(),
  /** Current focus only; attaching neither claims nor releases a Task. */
  attachedPlanId: idSchema.nullable(),
  attachedPlanKey: planKeySchema.nullable(),
  attachedTaskId: idSchema.nullable(),
  /** The first accepted final summary. */
  summary: sessionSummarySchema.nullable(),
  /**
   * False while touched-path coverage is incomplete: the current collection
   * is unfinished or failed, or coverage was lost earlier in the Session
   * (which stays false until the Session ends).
   */
  scopeComplete: z.boolean(),
  startedAt: timestampSchema,
  lastHeartbeatAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionPageSchema = pageSchema(sessionSchema);

export type SessionPage = z.infer<typeof sessionPageSchema>;

/**
 * `POST /projects/{id}/sessions`: start an `active` Session owned by the
 * caller. `sessionId` is generated once by the client; replay follows
 * `createPlanInputSchema`. Omitted metadata is stored as null.
 */
export const startSessionInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  agent: agentNameSchema,
  intent: sessionIntentSchema,
  hostname: hostnameSchema.optional(),
  gitBranch: gitBranchSchema.optional(),
  gitCommit: gitCommitSchema.optional(),
});

export type StartSessionInput = z.input<typeof startSessionInputSchema>;

export const startSessionOutputSchema = z.strictObject({
  session: sessionSchema,
  created: z.boolean(),
});

export type StartSessionOutput = z.infer<typeof startSessionOutputSchema>;

/** `GET /projects/{id}/sessions`: most recently started first. */
export const listSessionsInputSchema = z.strictObject({
  id: idSchema,
  status: sessionListFilterSchema.optional(),
  ...paginationInputShape,
});

export type ListSessionsInput = z.input<typeof listSessionsInputSchema>;

/**
 * `GET /projects/{id}/sessions/{sessionId}`, and the path of every Session
 * route. Every Session of the Project is readable; the routes that change a
 * Session need the caller's own, and another principal's is FORBIDDEN. A
 * Session of another Project, or none, is NOT_FOUND.
 */
export const getSessionInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
});

export type GetSessionInput = z.input<typeof getSessionInputSchema>;

/**
 * `PATCH /projects/{id}/sessions/{sessionId}`: edit the caller's own Session
 * (not ended or abandoned). Only supplied fields change; `null` clears
 * optional metadata. Equal values are a no-op.
 */
export const updateSessionInputSchema = z
  .strictObject({
    id: idSchema,
    sessionId: idSchema,
    agent: agentNameSchema.optional(),
    intent: sessionIntentSchema.optional(),
    hostname: hostnameSchema.nullable().optional(),
    gitBranch: gitBranchSchema.nullable().optional(),
    gitCommit: gitCommitSchema.nullable().optional(),
    status: liveSessionStatusSchema.optional(),
  })
  .refine(
    (input) =>
      [
        input.agent,
        input.intent,
        input.hostname,
        input.gitBranch,
        input.gitCommit,
        input.status,
      ].some((value) => value !== undefined),
    "Provide at least one field to change.",
  );

export type UpdateSessionInput = z.input<typeof updateSessionInputSchema>;

/** Session update and attach. `changed: false` is a no-op that wrote no Event. */
export const sessionChangeOutputSchema = z.strictObject({
  session: sessionSchema,
  changed: z.boolean(),
});

export type SessionChangeOutput = z.infer<typeof sessionChangeOutputSchema>;

/**
 * `POST /projects/{id}/sessions/{sessionId}/attach`: set the caller's Session
 * focus to a Plan of this Project and optionally one of its Tasks, or clear it
 * with `planRef: null`. A Task requires its own Plan.
 */
export const attachSessionInputSchema = z
  .strictObject({
    id: idSchema,
    sessionId: idSchema,
    planRef: planRefSchema.nullable(),
    taskId: idSchema.optional(),
  })
  .refine(
    (input) => input.taskId === undefined || input.planRef !== null,
    "A Task needs the Plan it belongs to.",
  );

export type AttachSessionInput = z.input<typeof attachSessionInputSchema>;

/**
 * `POST /projects/{id}/sessions/{sessionId}/heartbeat`. Renews the caller's
 * Session and its unexpired claims and opens a new touched-path collection.
 * A stale Session first loses its expired claims, then becomes live again;
 * an abandoned or ended one is CONFLICT. Without `status`, a stale Session
 * becomes `active` and a live one keeps its status.
 */
export const heartbeatSessionInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  status: liveSessionStatusSchema.optional(),
});

export type HeartbeatSessionInput = z.input<typeof heartbeatSessionInputSchema>;

export const heartbeatSessionOutputSchema = z.strictObject({
  session: sessionSchema,
  /** The effective status before this heartbeat. */
  previousStatus: sessionStatusSchema,
  /** Claims whose lease this heartbeat renewed. */
  renewedClaims: claimedTaskIdsSchema,
  /** Claims that had expired and were released instead of renewed. */
  releasedClaims: claimedTaskIdsSchema,
  /** The renewed leases' new expiry; null when nothing was renewed. */
  leaseExpiresAt: timestampSchema.nullable(),
  /**
   * The touched-path collection this heartbeat opened. It replaces any
   * earlier one; register its manifest, upload its batches and finalize it.
   */
  collectionId: idSchema,
  /** Coverage before the new collection: false once any coverage was lost. */
  historicalScopeComplete: z.boolean(),
});

export type HeartbeatSessionOutput = z.infer<typeof heartbeatSessionOutputSchema>;

/**
 * `POST /projects/{id}/sessions/{sessionId}/end`: end the caller's Session
 * with a final summary and release its claims (Task progress stays). The same
 * summary again is a no-op; a different one is CONFLICT. An abandoned
 * Session accepts its first summary and stays abandoned.
 */
export const endSessionInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  summary: sessionSummarySchema,
});

export type EndSessionInput = z.input<typeof endSessionInputSchema>;

export const endSessionOutputSchema = z.strictObject({
  session: sessionSchema,
  changed: z.boolean(),
  releasedClaims: claimedTaskIdsSchema,
});

export type EndSessionOutput = z.infer<typeof endSessionOutputSchema>;

/**
 * `GET /projects/{id}/sessions/{sessionId}/claims`: the Tasks the Session
 * holds a usable claim on, by claim time.
 */
export const listSessionClaimsInputSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  ...paginationInputShape,
});

export type ListSessionClaimsInput = z.input<typeof listSessionClaimsInputSchema>;
