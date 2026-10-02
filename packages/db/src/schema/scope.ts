import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "../columns.ts";
import { isSha256Hex, oneOf } from "./checks.ts";
import { agentSession } from "./coordination.ts";
import { project } from "./project.ts";

// A Scope is a repository path or glob a Session declared it works in, or a
// path it touched (CONTEXT.md, issue #12 "Scopes and overlap"). Values are
// stored normalized; matching is in src/scope.ts.

export const SCOPE_SOURCES = ["declared", "touched"] as const;
export type ScopeSource = (typeof SCOPE_SOURCES)[number];

export const scope = pgTable(
  "scope",
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "restrict" }),
    sessionId: uuid().notNull(),
    source: text({ enum: SCOPE_SOURCES }).notNull(),
    // A declared glob or a touched path, repository-relative POSIX.
    value: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "scope_session_fk",
      columns: [table.sessionId, table.projectId],
      foreignColumns: [agentSession.id, agentSession.projectId],
    }).onDelete("restrict"),
    // Deduplicates, and serves lookups by Session. Declared and touched
    // Scopes with the same value are distinct records.
    unique("scope_session_id_source_value_unique").on(table.sessionId, table.source, table.value),
    index("scope_project_id_idx").on(table.projectId),
    check("scope_source_check", oneOf("source", SCOPE_SOURCES)),
  ],
);

// The receipt for one accepted batch of a touched-path collection: which
// paths it carried and their fingerprint, so an exact replay is recognized
// and finalize can recompute the collection's manifest from what the server
// actually stored. Operational metadata, not a domain Event. Batches are
// bounded (at most 16 paths), so `paths` is too.
export const scopeCollectionBatch = pgTable(
  "scope_collection_batch",
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "restrict" }),
    sessionId: uuid().notNull(),
    // The generation this batch belongs to (agent_session.collection_id when
    // it was accepted).
    collectionId: uuid().notNull(),
    batchIndex: integer().notNull(),
    paths: text().array().notNull(),
    fingerprint: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "scope_collection_batch_session_fk",
      columns: [table.sessionId, table.projectId],
      foreignColumns: [agentSession.id, agentSession.projectId],
    }).onDelete("restrict"),
    unique("scope_collection_batch_session_collection_index_unique").on(
      table.sessionId,
      table.collectionId,
      table.batchIndex,
    ),
    check("scope_collection_batch_index_check", sql`${table.batchIndex} >= 0`),
    check("scope_collection_batch_fingerprint_check", isSha256Hex("fingerprint")),
  ],
);

export type Scope = typeof scope.$inferSelect;
export type ScopeCollectionBatch = typeof scopeCollectionBatch.$inferSelect;
