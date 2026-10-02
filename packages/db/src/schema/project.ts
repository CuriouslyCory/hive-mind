import { index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "../columns.ts";
import { organization } from "./auth.ts";

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
  ],
);

export type Project = typeof project.$inferSelect;
