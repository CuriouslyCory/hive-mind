import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "../columns.ts";
import { user } from "./auth.ts";
import { isSha256Hex, oneOf } from "./checks.ts";
import { agentSession, CREATOR_KINDS } from "./coordination.ts";
import { project } from "./project.ts";

// ADRs (CONTEXT.md, issue #19, ADR-0017). The repository's `docs/adr/` files
// are the source of truth. hive-mind owns only the number reservations and
// the counter (project.next_adr_number); everything else here is a
// read-only copy of the files as of the commit an ADR sync read
// (project.adr_synced_commit_sha).
//
// Writes go through src/adr.ts under the Project lock (ADR-0014), with their
// Event in the same transaction. Updates written in raw SQL must set
// updated_at themselves (ADR-0005).

/** An ADR's status, as its file's frontmatter states it (ADR-0001). */
export const ADR_STATUSES = ["proposed", "accepted", "superseded", "deprecated"] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

/**
 * Where a number is in hive-mind's copy, separate from the file's status and
 * never shown as one. `reserved`: handed out by `adr new`, no file synced yet.
 * `published`: the last sync found a file with this number. `removed`: an
 * earlier sync found one and a later sync did not; the row is kept.
 */
export const ADR_STATES = ["reserved", "published", "removed"] as const;
export type AdrState = (typeof ADR_STATES)[number];

/** The largest ADR number: file names have four digits. */
export const MAX_ADR_NUMBER = 9999;

/** The longest reservation title, in UTF-16 code units. */
export const MAX_ADR_TITLE_LENGTH = 200;

/** The most ADRs one file may supersede, as the API's responses bound it. */
export const MAX_ADR_SUPERSEDES = 64;

/** The largest stored ADR file, in UTF-8 bytes. */
export const MAX_ADR_CONTENT_BYTES = 64 * 1024;

/**
 * A problem the parser found in a file that still let it be stored, such as a
 * missing section. `code` is the parser's stable identifier; this package
 * stores and returns warnings without interpreting them.
 */
export interface AdrContentWarning {
  code: string;
  message: string;
}

const COMMIT_SHA = "'^[0-9a-f]{40}([0-9a-f]{24})?$'";

/**
 * One uploaded ADR file, addressed by the sha256 of its content, with the
 * fields the API parsed from it. Immutable: a changed file is a new row, and
 * rows are never updated. Rows no `adr` refers to are left in place; removing
 * them is retention work for M7 (#1).
 */
export const adrContent = pgTable(
  "adr_content",
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "restrict" }),
    // Lowercase hex sha256 of content_md's UTF-8 bytes.
    contentSha256: text().notNull(),
    // The whole file, frontmatter included.
    contentMd: text().notNull(),
    // The first H1 outside fenced code.
    title: text().notNull(),
    status: text({ enum: ADR_STATUSES }).notNull(),
    // The frontmatter `date`: the day the current status was set.
    date: date({ mode: "string" }).notNull(),
    // Numbers of the ADRs this one supersedes, in file order. No foreign
    // key: a target may be missing, and "superseded by" is a query.
    supersedes: integer().array().notNull().default(sql`'{}'::integer[]`),
    warnings: jsonb().$type<AdrContentWarning[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [
    // Content is addressed within its Project, and this is the target of
    // adr's composite foreign key.
    unique("adr_content_project_id_content_sha256_unique").on(table.projectId, table.contentSha256),
    check("adr_content_sha256_check", isSha256Hex("content_sha256")),
    check("adr_content_status_check", oneOf("status", ADR_STATUSES)),
    check("adr_content_title_check", sql.raw("title <> ''")),
    check(
      "adr_content_size_check",
      sql.raw(`octet_length(content_md) <= ${MAX_ADR_CONTENT_BYTES}`),
    ),
    check(
      "adr_content_supersedes_check",
      sql.raw(`0 < all (supersedes) and ${MAX_ADR_NUMBER} >= all (supersedes)`),
    ),
  ],
);

/**
 * One ADR number of a Project: a reservation, an ADR copied by sync, or both
 * (a reservation whose file was synced). A row is never deleted and its
 * number never reused.
 */
export const adr = pgTable(
  "adr",
  {
    // A reservation's id is the caller's UUID (for creation replay); a row
    // first created by sync gets a generated one.
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "restrict" }),
    number: integer().notNull(),
    state: text({ enum: ADR_STATES }).notNull(),
    // The slug of the synced file, or the reserved slug until one is synced.
    slug: text().notNull(),
    // The synced file's path in the repository, and the content it had at
    // the last sync that found it. A removed row keeps both.
    path: text(),
    contentSha256: text(),
    // The sync head commit at which this row's content last changed.
    commitSha: text(),
    // When a sync last changed this row (content, path, slug or state).
    syncedAt: timestamptz(),
    // The reservation, if the number was reserved with `adr new`. These
    // columns never change after it, even when a file with another title
    // takes the number. The principal follows the creator columns of
    // schema/coordination.ts: the key id is history, with no foreign key.
    reservedTitle: text(),
    reservedSlug: text(),
    gitBranch: text(),
    reservedByKind: text({ enum: CREATOR_KINDS }),
    reservedByUserId: uuid().references(() => user.id, { onDelete: "restrict" }),
    reservedByKeyId: uuid(),
    reservedSessionId: uuid(),
    // Fingerprint of the reservation input, compared on replay.
    creationFingerprint: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Also orders a Project's ADRs by number.
    unique("adr_project_id_number_unique").on(table.projectId, table.number),
    unique("adr_id_project_id_unique").on(table.id, table.projectId),
    foreignKey({
      name: "adr_content_sha256_fk",
      columns: [table.projectId, table.contentSha256],
      foreignColumns: [adrContent.projectId, adrContent.contentSha256],
    }).onDelete("restrict"),
    foreignKey({
      name: "adr_reserved_session_fk",
      columns: [table.reservedSessionId, table.projectId],
      foreignColumns: [agentSession.id, agentSession.projectId],
    }).onDelete("restrict"),
    check("adr_number_check", sql.raw(`number between 1 and ${MAX_ADR_NUMBER}`)),
    check("adr_state_check", oneOf("state", ADR_STATES)),
    check("adr_slug_check", sql.raw("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'")),
    check(
      "adr_copy_check",
      sql.raw(
        "(state = 'reserved' and path is null and content_sha256 is null and commit_sha is null and synced_at is null) or " +
          "(state in ('published', 'removed') and path is not null and content_sha256 is not null " +
          `and commit_sha ~ ${COMMIT_SHA} and synced_at is not null)`,
      ),
    ),
    check(
      "adr_reservation_check",
      sql.raw(
        "(reserved_by_kind is null and reserved_by_user_id is null and reserved_by_key_id is null " +
          "and reserved_title is null and reserved_slug is null and git_branch is null " +
          "and reserved_session_id is null and creation_fingerprint is null) or " +
          "(reserved_title is not null and reserved_slug is not null and creation_fingerprint is not null and (" +
          "(reserved_by_kind = 'user' and reserved_by_user_id is not null and reserved_by_key_id is null) or " +
          "(reserved_by_kind = 'project_key' and reserved_by_key_id is not null and reserved_by_user_id is null)))",
      ),
    ),
    // A row with no reservation exists only because sync found a file.
    check("adr_unreserved_check", sql.raw("reserved_by_kind is not null or state <> 'reserved'")),
    check(
      "adr_reserved_title_check",
      sql.raw(
        `reserved_title is null or char_length(reserved_title) between 1 and ${MAX_ADR_TITLE_LENGTH}`,
      ),
    ),
    check(
      "adr_creation_fingerprint_check",
      sql.raw("creation_fingerprint is null or creation_fingerprint ~ '^[0-9a-f]{64}$'"),
    ),
  ],
);

export type AdrContent = typeof adrContent.$inferSelect;
export type Adr = typeof adr.$inferSelect;
