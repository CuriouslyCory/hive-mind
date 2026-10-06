import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "../columns.ts";
import { organization, user } from "./auth.ts";

/** Who ran a Project's last ADR sync. The same values as `CREATOR_KINDS` (schema/coordination.ts). */
const ADR_SYNCED_BY_KINDS = ["user", "project_key"] as const;

// A Project is a codebase an organization coordinates work on (CONTEXT.md).
// Plans, Tasks, Sessions, Scopes and Events belong to a Project (M2,
// src/schema/coordination.ts). Create Projects with `createOrReuseProject` (src/project.ts),
// which is safe to call concurrently for the same slug.

export const project = pgTable(
  "project",
  {
    id: id(),
    // Restrict, not cascade: Projects will own Plans, Tasks and Events (M2),
    // so deleting an organization must deal with its Projects explicitly
    // rather than drop them as a side effect. Organization deletion is off
    // until then (ADR-0007).
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    slug: text().notNull(),
    name: text().notNull(),
    repoUrl: text(),
    // The N of the next PLAN-N key, allocated by `allocatePlanNumber`
    // (src/coordination.ts) under the Project lock. The default lets inserts
    // written for M1's columns keep working. Internal: not part of the
    // Project DTO.
    nextPlanNumber: integer().notNull().default(1),
    // When the coordination sweep last finished a batch for this Project, so
    // it rotates through Projects oldest (or never swept) first. Internal: not
    // part of the Project DTO. Set in raw SQL, which leaves updated_at alone.
    coordinationSweptAt: timestamptz(),
    // The number the next ADR reservation gets, unless an ADR or floor is
    // already at or past it (`reserveAdr`, src/adr.ts). Raised by ADR sync.
    // Internal, like next_plan_number.
    nextAdrNumber: integer().notNull().default(1),
    // The last ADR sync: the commit it read, when, and who ran it (a User or
    // a Project key; the key id is history, with no foreign key). All null
    // until the first sync. Set in raw SQL, which leaves updated_at alone.
    adrSyncedCommitSha: text(),
    adrSyncedAt: timestamptz(),
    adrSyncedByKind: text({ enum: ADR_SYNCED_BY_KINDS }),
    adrSyncedByUserId: uuid().references(() => user.id, { onDelete: "restrict" }),
    adrSyncedByKeyId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Also serves lookups by organization.
    unique("project_organization_id_slug_unique").on(table.organizationId, table.slug),
    // The target of project_api_key's foreign key; see there.
    unique("project_id_organization_id_unique").on(table.id, table.organizationId),
    // The sweep's order: never swept first, then oldest, then by id.
    index("project_coordination_swept_at_idx").on(
      table.coordinationSweptAt.asc().nullsFirst(),
      table.id,
    ),
    check("project_next_adr_number_check", sql.raw("next_adr_number >= 1")),
    check(
      "project_adr_synced_check",
      sql.raw(
        "(adr_synced_commit_sha is null and adr_synced_at is null and adr_synced_by_kind is null " +
          "and adr_synced_by_user_id is null and adr_synced_by_key_id is null) or " +
          "(adr_synced_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' and adr_synced_at is not null and (" +
          "(adr_synced_by_kind = 'user' and adr_synced_by_user_id is not null and adr_synced_by_key_id is null) or " +
          "(adr_synced_by_kind = 'project_key' and adr_synced_by_key_id is not null and adr_synced_by_user_id is null)))",
      ),
    ),
  ],
);

export type Project = typeof project.$inferSelect;
