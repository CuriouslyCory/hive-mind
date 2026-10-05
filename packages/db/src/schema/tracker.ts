import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "../columns.ts";
import { oneOf } from "./checks.ts";

// The dev-only tracker (docs/tracker.md): the changelog, blog ideas, the
// backlog of GitHub issues with their step prompts, and the scan cursors the
// tracker skills record. The rows are about developing this repository, not
// Project data, so they have no project_id and no Events. Every write goes
// through @hivemind/tracker (packages/tracker), which holds the rules; the
// checks here hold the invariants a buggy writer could otherwise break.

export const TRACKER_SCAN_KINDS = ["git_history", "backlog"] as const;
export type TrackerScanKind = (typeof TRACKER_SCAN_KINDS)[number];

export const TRACKER_BLOG_STATUSES = ["idea", "draft", "published"] as const;
export type TrackerBlogStatus = (typeof TRACKER_BLOG_STATUSES)[number];

export const TRACKER_ISSUE_STATES = ["open", "closed"] as const;
export type TrackerIssueState = (typeof TRACKER_ISSUE_STATES)[number];

/** A completed run of a tracker scan skill and the source cursor it reviewed through. */
export const trackerScan = pgTable(
  "tracker_scan",
  {
    id: id(),
    kind: text({ enum: TRACKER_SCAN_KINDS }).notNull(),
    // When the scan finished. Never used as the source cursor.
    completedAt: timestamptz().notNull().defaultNow(),
    // Inclusive source cursor: the newest reviewed PR merge time (git_history)
    // or issue updatedAt (backlog). The next scan starts at it again.
    throughAt: timestamptz().notNull(),
    // The exact origin/main commit a git_history scan reviewed.
    throughSha: text(),
    note: text(),
    createdAt: createdAt(),
  },
  (table) => [
    index("tracker_scan_kind_completed_at_idx").on(table.kind, table.completedAt.desc()),
    check("tracker_scan_kind_check", oneOf("kind", TRACKER_SCAN_KINDS)),
    check(
      "tracker_scan_through_sha_check",
      sql.raw(
        "(kind = 'git_history' and through_sha ~ '^[0-9a-f]{40}$') or " +
          "(kind = 'backlog' and through_sha is null)",
      ),
    ),
  ],
);

export const trackerChangelogEntry = pgTable(
  "tracker_changelog_entry",
  {
    id: id(),
    // The UTC merge date the entry is grouped under.
    date: date({ mode: "string" }).notNull(),
    category: text().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    prNumbers: integer().array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("tracker_changelog_entry_date_idx").on(table.date.desc())],
);

export const trackerBlogIdea = pgTable(
  "tracker_blog_idea",
  {
    id: id(),
    title: text().notNull(),
    pitch: text().notNull(),
    notes: text(),
    prNumbers: integer().array().notNull().default([]),
    status: text({ enum: TRACKER_BLOG_STATUSES }).notNull().default("idea"),
    // Set exactly while published.
    publishedAt: timestamptz(),
    publishedUrl: text(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check("tracker_blog_idea_status_check", oneOf("status", TRACKER_BLOG_STATUSES)),
    check(
      "tracker_blog_idea_published_at_check",
      sql.raw("(status = 'published') = (published_at is not null)"),
    ),
    check(
      "tracker_blog_idea_published_url_check",
      sql.raw("published_url is null or status = 'published'"),
    ),
  ],
);

export const trackerBacklogPhase = pgTable("tracker_backlog_phase", {
  id: id(),
  title: text().notNull(),
  description: text(),
  sortOrder: integer().notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A GitHub issue on the backlog, identified by its number in the repository. */
export const trackerBacklogIssue = pgTable(
  "tracker_backlog_issue",
  {
    id: id(),
    issueNumber: integer().notNull(),
    title: text().notNull(),
    note: text(),
    state: text({ enum: TRACKER_ISSUE_STATES }).notNull().default("open"),
    // The issue's updatedAt on GitHub when the backlog review last read it.
    githubUpdatedAt: timestamptz(),
    sortOrder: integer().notNull().default(0),
    // A phase is deleted only once it is empty.
    phaseId: uuid()
      .notNull()
      .references(() => trackerBacklogPhase.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("tracker_backlog_issue_issue_number_unique").on(table.issueNumber),
    index("tracker_backlog_issue_phase_id_sort_order_idx").on(table.phaseId, table.sortOrder),
    check("tracker_backlog_issue_state_check", oneOf("state", TRACKER_ISSUE_STATES)),
    check("tracker_backlog_issue_number_check", sql`${table.issueNumber} > 0`),
  ],
);

/** One ordered step of a backlog issue, usually a prompt that starts an agent session. */
export const trackerBacklogStep = pgTable(
  "tracker_backlog_step",
  {
    id: id(),
    issueId: uuid()
      .notNull()
      .references(() => trackerBacklogIssue.id, { onDelete: "cascade" }),
    key: text().notNull(),
    label: text().notNull(),
    prompt: text(),
    sortOrder: integer().notNull().default(0),
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("tracker_backlog_step_issue_id_key_unique").on(table.issueId, table.key),
    index("tracker_backlog_step_issue_id_sort_order_idx").on(table.issueId, table.sortOrder),
  ],
);

export type TrackerScan = typeof trackerScan.$inferSelect;
export type TrackerChangelogEntry = typeof trackerChangelogEntry.$inferSelect;
export type TrackerBlogIdea = typeof trackerBlogIdea.$inferSelect;
export type TrackerBacklogPhase = typeof trackerBacklogPhase.$inferSelect;
export type TrackerBacklogIssue = typeof trackerBacklogIssue.$inferSelect;
export type TrackerBacklogStep = typeof trackerBacklogStep.$inferSelect;
