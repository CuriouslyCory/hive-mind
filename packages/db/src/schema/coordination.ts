import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  type PgTableExtraConfigValue,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "../columns.ts";
import { user } from "./auth.ts";
import { isSha256Hex, oneOf } from "./checks.ts";
import { project } from "./project.ts";

// Plans, Tasks and Sessions (CONTEXT.md), the M2 coordination records of issue
// #12. They live in one module because Tasks and Sessions reference each other
// (a Task's claim holder, a Session's attached Task).
//
// Every record stores its project_id, and every reference between records is a
// composite foreign key that includes it, so the database rejects a Task in one
// Project pointing at a Plan or Session in another. Each referenced table has a
// unique (id, project_id) target for those keys. Foreign keys to Projects and
// to these records restrict deletes: history is never removed as a side effect.
//
// Status columns are text with check constraints listing the allowed values,
// the same approach M0 and M1 took for roles; the TypeScript unions below are
// the single source for those lists.
//
// Mutations go through `withCoordinationLock` (src/coordination.ts), which
// serializes each Project's coordination writes. Updates written in raw SQL
// must set updated_at themselves (ADR-0005).

export const PLAN_STATUSES = ["draft", "active", "paused", "done", "abandoned"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SESSION_STATUSES = ["active", "idle", "stale", "ended", "abandoned"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Who owns a Session: a User, or a Project key acting as itself. */
export const SESSION_OWNER_KINDS = ["user", "key"] as const;
export type SessionOwnerKind = (typeof SESSION_OWNER_KINDS)[number];

/** Who created a Plan or Task. The same values as an Event's actor kind, minus `system`. */
export const CREATOR_KINDS = ["user", "project_key"] as const;
export type CreatorKind = (typeof CREATOR_KINDS)[number];

/**
 * The principal that created a row: a User or a Project key. The key id is
 * historical identity, with no foreign key, because keys are deleted on
 * revocation and the record must outlive them. Never a raw key or its hash.
 */
function creatorColumns() {
  return {
    createdByKind: text({ enum: CREATOR_KINDS }).notNull(),
    createdByUserId: uuid().references(() => user.id, { onDelete: "restrict" }),
    createdByKeyId: uuid(),
  };
}

/** Exactly one creator id, matching the kind. */
function creatorCheck(table: string) {
  return check(
    `${table}_created_by_check`,
    sql.raw(
      "(created_by_kind = 'user' and created_by_user_id is not null and created_by_key_id is null) or " +
        "(created_by_kind = 'project_key' and created_by_key_id is not null and created_by_user_id is null)",
    ),
  );
}

export const plan = pgTable(
  "plan",
  {
    // Callers may supply the id (a CLI-generated UUID, for creation replay).
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "restrict" }),
    // The N of the Plan's PLAN-N key, allocated from project.next_plan_number
    // by `allocatePlanNumber` under the Project lock.
    number: integer().notNull(),
    title: text().notNull(),
    // Markdown.
    body: text().notNull().default(""),
    status: text({ enum: PLAN_STATUSES }).notNull().default("draft"),
    // Optional: a Plan created by a Project key has no owning User.
    ownerUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    ...creatorColumns(),
    // Fingerprint of the original creation input, compared on replay. It is
    // never updated, even when the Plan is edited.
    creationFingerprint: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("plan_project_id_number_unique").on(table.projectId, table.number),
    // Target of the composite foreign keys from Tasks, Sessions and Events.
    unique("plan_id_project_id_unique").on(table.id, table.projectId),
    index("plan_project_id_status_idx").on(table.projectId, table.status),
    check("plan_status_check", oneOf("status", PLAN_STATUSES)),
    check("plan_number_check", sql`${table.number} > 0`),
    check("plan_creation_fingerprint_check", isSha256Hex("creation_fingerprint")),
    creatorCheck("plan"),
  ],
);

export const task = pgTable(
  "task",
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "restrict" }),
    planId: uuid().notNull(),
    title: text().notNull(),
    // Ordering within the Plan only; Tasks are identified by UUID.
    position: integer().notNull(),
    status: text({ enum: TASK_STATUSES }).notNull().default("todo"),
    // Set exactly while the Task is blocked.
    blockReason: text(),
    // The claim: the holding Session, when it claimed, and when the lease
    // expires without renewal. All three are set or all are null. An expired
    // lease is not cleared until a mutation or the sweep reconciles it, so
    // readers compare lease_expires_at with database time.
    claimedBySessionId: uuid(),
    claimedAt: timestamptz(),
    leaseExpiresAt: timestamptz(),
    ...creatorColumns(),
    creationFingerprint: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The annotation breaks the type cycle between task and agent_session.
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "task_plan_fk",
      columns: [table.planId, table.projectId],
      foreignColumns: [plan.id, plan.projectId],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_claimed_by_session_fk",
      columns: [table.claimedBySessionId, table.projectId],
      foreignColumns: [agentSession.id, agentSession.projectId],
    }).onDelete("restrict"),
    unique("task_id_project_id_unique").on(table.id, table.projectId),
    // Target of a Session's attachment, which names both its Plan and Task.
    unique("task_id_plan_id_project_id_unique").on(table.id, table.planId, table.projectId),
    index("task_plan_id_position_idx").on(table.planId, table.position),
    index("task_project_id_status_idx").on(table.projectId, table.status),
    // Finds a Session's claims (heartbeat, end) and expired leases (sweep).
    index("task_claimed_by_session_id_idx")
      .on(table.claimedBySessionId)
      .where(sql`${table.claimedBySessionId} is not null`),
    index("task_project_id_lease_expires_at_idx")
      .on(table.projectId, table.leaseExpiresAt)
      .where(sql`${table.leaseExpiresAt} is not null`),
    check("task_status_check", oneOf("status", TASK_STATUSES)),
    check(
      "task_claim_check",
      sql.raw(
        "(claimed_by_session_id is null and claimed_at is null and lease_expires_at is null) or " +
          "(claimed_by_session_id is not null and claimed_at is not null and lease_expires_at is not null)",
      ),
    ),
    // Done clears the claim.
    check(
      "task_done_unclaimed_check",
      sql.raw("status <> 'done' or claimed_by_session_id is null"),
    ),
    check("task_block_reason_check", sql.raw("(status = 'blocked') = (block_reason is not null)")),
    check("task_creation_fingerprint_check", isSha256Hex("creation_fingerprint")),
    creatorCheck("task"),
  ],
);

// The table for Sessions (agent runs). better-auth owns the `session` table
// name for login sessions, so this one is agent_session (ADR-0005, CONTEXT.md).
export const agentSession = pgTable(
  "agent_session",
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "restrict" }),
    // The owner, fixed at start: a User, or a Project key acting as itself.
    // No code path updates these three columns. The key id has no foreign key
    // for the same reason as a creator's (see creatorColumns). The owner is
    // also the Session's creator, so there are no separate creator columns.
    ownerKind: text({ enum: SESSION_OWNER_KINDS }).notNull(),
    userId: uuid().references(() => user.id, { onDelete: "restrict" }),
    keyId: uuid(),
    // The stored status; effective liveness is computed from
    // last_heartbeat_at and database time, since the sweep may lag.
    status: text({ enum: SESSION_STATUSES }).notNull().default("active"),
    agent: text().notNull(),
    intent: text().notNull(),
    // Machine and git metadata. Null means the client could not determine it
    // (for example, outside a git worktree), never a guess.
    machine: text(),
    gitBranch: text(),
    gitCommit: text(),
    worktreePath: text(),
    // Optional context. Attaching neither claims nor releases a Task.
    attachedPlanId: uuid(),
    attachedTaskId: uuid(),
    lastHeartbeatAt: timestamptz().notNull().defaultNow(),
    // When the Session became ended or abandoned.
    endedAt: timestamptz(),
    // The first accepted final summary (markdown) and its fingerprint; a
    // repeated end compares fingerprints.
    summary: text(),
    summaryFingerprint: text(),
    // Touched-path collection. collection_id is the current generation; the
    // manifest (expected batches, path count, content hash) is registered
    // after the client collects, and collection_complete becomes true only
    // when that generation is finalized. Receipts for its batches are in
    // scope_collection_batch.
    collectionId: uuid(),
    collectionExpectedBatches: integer(),
    collectionPathCount: integer(),
    collectionContentHash: text(),
    collectionComplete: boolean().notNull().default(false),
    // Sticky: once historical touched-path coverage is lost (capacity or
    // representation failures, or an unfinished collection superseded), it
    // stays true for the rest of the Session.
    scopeHistoryIncomplete: boolean().notNull().default(false),
    creationFingerprint: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("agent_session_id_project_id_unique").on(table.id, table.projectId),
    foreignKey({
      name: "agent_session_attached_plan_fk",
      columns: [table.attachedPlanId, table.projectId],
      foreignColumns: [plan.id, plan.projectId],
    }).onDelete("restrict"),
    // Includes the attached Plan, so the attached Task must belong to it.
    foreignKey({
      name: "agent_session_attached_task_fk",
      columns: [table.attachedTaskId, table.attachedPlanId, table.projectId],
      foreignColumns: [task.id, task.planId, task.projectId],
    }).onDelete("restrict"),
    index("agent_session_project_id_status_idx").on(table.projectId, table.status),
    index("agent_session_project_id_last_heartbeat_at_idx").on(
      table.projectId,
      table.lastHeartbeatAt,
    ),
    index("agent_session_user_id_idx").on(table.userId),
    index("agent_session_key_id_idx").on(table.keyId),
    check("agent_session_status_check", oneOf("status", SESSION_STATUSES)),
    check(
      "agent_session_owner_check",
      sql.raw(
        "(owner_kind = 'user' and user_id is not null and key_id is null) or " +
          "(owner_kind = 'key' and key_id is not null and user_id is null)",
      ),
    ),
    // A composite foreign key is not checked when any of its columns is null,
    // so a Task without its Plan would escape the attached-Task key.
    check(
      "agent_session_attached_task_check",
      sql.raw("attached_task_id is null or attached_plan_id is not null"),
    ),
    check(
      "agent_session_ended_check",
      sql.raw("(status in ('ended', 'abandoned')) = (ended_at is not null)"),
    ),
    check(
      "agent_session_summary_check",
      sql.raw(
        "(summary is null and summary_fingerprint is null) or " +
          "(summary is not null and summary_fingerprint ~ '^[0-9a-f]{64}$')",
      ),
    ),
    check(
      "agent_session_collection_manifest_check",
      sql.raw(
        "(collection_expected_batches is null and collection_path_count is null and collection_content_hash is null) or " +
          "(collection_id is not null and collection_expected_batches >= 0 and collection_path_count >= 0 " +
          "and collection_content_hash is not null)",
      ),
    ),
    check(
      "agent_session_collection_complete_check",
      sql.raw("not collection_complete or collection_content_hash is not null"),
    ),
    check("agent_session_creation_fingerprint_check", isSha256Hex("creation_fingerprint")),
  ],
);

export type Plan = typeof plan.$inferSelect;
export type Task = typeof task.$inferSelect;
export type AgentSession = typeof agentSession.$inferSelect;
