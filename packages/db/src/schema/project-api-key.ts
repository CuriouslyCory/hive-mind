import { foreignKey, index, pgTable, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "../columns.ts";
import { apikey } from "./auth.ts";
import { project } from "./project.ts";

// Binds an API key to the one Project it may act on. The api-key plugin knows
// only the owning organization; this table is the application's record of
// which Project a key was issued for, and authorization reads it on every
// request. A key without a row here is unusable. Clients never supply it, and
// key metadata is never consulted.

export const projectApiKey = pgTable(
  "project_api_key",
  {
    // One binding per key, so a key can never act on two Projects.
    keyId: uuid().primaryKey(),
    projectId: uuid().notNull(),
    // The organization that owns both the key and the Project. The two
    // composite foreign keys below make the database reject a binding from a
    // key of one organization to a Project of another.
    organizationId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // Cascade: the plugin deletes keys itself (revocation, and its cleanup of
    // expired keys during verification), and the binding means nothing once
    // its key is gone. Restricting would make those deletes fail.
    // Names are explicit because the defaults exceed Postgres's 63 bytes.
    foreignKey({
      name: "project_api_key_key_fk",
      columns: [table.keyId, table.organizationId],
      foreignColumns: [apikey.id, apikey.referenceId],
    }).onDelete("cascade"),
    // Restrict: deleting a Project with bound keys must revoke those keys
    // first. Cascading would delete only the binding, leaving live keys that
    // fail closed but that no Project's key list shows, so no one could find
    // and revoke them.
    foreignKey({
      name: "project_api_key_project_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("restrict"),
    index("project_api_key_project_id_idx").on(table.projectId),
  ],
);

export type ProjectApiKey = typeof projectApiKey.$inferSelect;
