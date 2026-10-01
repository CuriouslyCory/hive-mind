import { pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "../columns.ts";
import { organization } from "./auth.ts";

// A Project is a codebase an organization coordinates work on (CONTEXT.md).
// M1 creates only its identity; Plans, Tasks, Sessions, Scopes and Events
// arrive with M2. Create Projects with `createOrReuseProject` (src/project.ts),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Also serves lookups by organization.
    unique("project_organization_id_slug_unique").on(table.organizationId, table.slug),
    // The target of project_api_key's foreign key; see there.
    unique("project_id_organization_id_unique").on(table.id, table.organizationId),
  ],
);

export type Project = typeof project.$inferSelect;
