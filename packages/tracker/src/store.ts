import type { Db, Transaction } from "@hivemind/db";
import {
  type TrackerScan,
  trackerBacklogIssue,
  trackerBacklogPhase,
  trackerBacklogStep,
  trackerBlogIdea,
  trackerChangelogEntry,
  trackerScan,
} from "@hivemind/db/schema";
import { and, asc, count, desc, eq, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { defaultBacklogSteps } from "./backlog-steps.ts";
import {
  batchInput,
  deleteBlogIdeaInput,
  deleteChangelogEntryInput,
  deleteIssueInput,
  deletePhaseInput,
  deleteStepInput,
  isTrackerCommandName,
  recordScanInput,
  saveBlogIdeaInput,
  saveChangelogEntryInput,
  saveIssueInput,
  savePhaseInput,
  saveStepInput,
  setStepCompleteInput,
  type TrackerCommandName,
} from "./input.ts";
import type {
  BacklogPhaseView,
  BacklogStepView,
  NextStepView,
  ScanKind,
  TrackerScanView,
  TrackerSnapshot,
} from "./types.ts";

// The tracker's reads and its rules (docs/tracker.md). Every writer, the page's
// server action and the agent CLI alike, goes through `runTrackerCommand` or
// `runTrackerBatch`, so the rules live only here.
//
// This module is loaded by the CLI under Node's type stripping, so it imports
// runtime values only from packages that load that way: @hivemind/db's schema
// entry, not its root (whose modules use syntax Node cannot strip).
//
// Optimistic concurrency: a caller sends back the `updatedAt` it read, and the
// write's WHERE clause includes it. Writes here store updated_at at
// millisecond precision, the precision a JavaScript Date (and so the ISO
// string a caller holds) has, and an update always moves it forward by at
// least a millisecond, so two writes never leave the same value.

export type TrackerErrorKind = "input" | "conflict" | "not_found" | "rule";

/** A refusal whose message is safe to show to the user or agent that sent the command. */
export class TrackerError extends Error {
  readonly kind: TrackerErrorKind;

  constructor(kind: TrackerErrorKind, message: string) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
  }
}

/** The input failed validation. The message lists each failing field path. */
export class TrackerInputError extends TrackerError {
  constructor(message: string) {
    super("input", message);
  }
}

/** The row changed since the caller read it. */
export class TrackerConflictError extends TrackerError {
  constructor(message: string) {
    super("conflict", message);
  }
}

export class TrackerNotFoundError extends TrackerError {
  constructor(message: string) {
    super("not_found", message);
  }
}

/** The input is valid but a tracker rule forbids the change. */
export class TrackerRuleError extends TrackerError {
  constructor(message: string) {
    super("rule", message);
  }
}

const MAX_LISTED_ISSUES = 10;

function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const listed = result.error.issues.slice(0, MAX_LISTED_ISSUES).map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${path || "(input)"}: ${issue.message}`;
  });
  const more = result.error.issues.length - listed.length;
  if (more > 0) listed.push(`and ${more} more`);
  throw new TrackerInputError(`Invalid input: ${listed.join("; ")}`);
}

/** The current time at millisecond precision, for a new row's updated_at. */
const nowMs = () => sql`date_trunc('milliseconds', clock_timestamp())`;

/** The current time at millisecond precision, but always after the row's previous updated_at. */
function nextUpdatedAt(column: AnyPgColumn): SQL {
  return sql`greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', ${column}) + interval '1 millisecond')`;
}

/** Matches the row only if it is unchanged since the caller read `updatedAt`. No condition without one. */
function unchangedSince(column: AnyPgColumn, updatedAt: string | undefined): SQL | undefined {
  if (updatedAt === undefined) return undefined;
  return sql`date_trunc('milliseconds', ${column}) = ${updatedAt}::timestamptz`;
}

/** Refuses a write against a row the caller read before its last change. */
function assertUnchanged(current: Date, updatedAt: string | undefined, what: string): void {
  if (updatedAt !== undefined && current.getTime() !== new Date(updatedAt).getTime()) {
    throw changedError(what);
  }
}

function changedError(what: string): TrackerConflictError {
  return new TrackerConflictError(`${what} changed since you read it; refresh and try again.`);
}

/** Today's UTC date as `YYYY-MM-DD`. */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Whether `error`, or the driver error Drizzle wraps in its `cause`, violated the unique `constraint`. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { code?: unknown }).code === "23505" &&
      (candidate as { constraint?: unknown }).constraint === constraint,
  );
}

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

type Queryable = Db | Transaction;

// Reads

function scanView(scan: TrackerScan | undefined): TrackerScanView | null {
  if (!scan) return null;
  return {
    id: scan.id,
    kind: scan.kind,
    completedAt: iso(scan.completedAt),
    throughAt: iso(scan.throughAt),
    throughSha: scan.throughSha,
    note: scan.note,
  };
}

/** The newest completed scan of a kind, whose `throughAt` (and SHA) the next scan starts from. */
export async function getLatestScan(
  db: Queryable,
  kind: ScanKind,
): Promise<TrackerScanView | null> {
  const [scan] = await db
    .select()
    .from(trackerScan)
    .where(eq(trackerScan.kind, kind))
    .orderBy(desc(trackerScan.completedAt), desc(trackerScan.createdAt))
    .limit(1);
  return scanView(scan);
}

/** Everything the tracker shows, read from one consistent snapshot. */
export async function getTrackerSnapshot(db: Db): Promise<TrackerSnapshot> {
  return db.transaction(
    async (tx) => {
      const readAt = new Date();
      const gitScan = await getLatestScan(tx, "git_history");
      const backlogScan = await getLatestScan(tx, "backlog");
      const changelog = await tx
        .select()
        .from(trackerChangelogEntry)
        .orderBy(
          desc(trackerChangelogEntry.date),
          asc(trackerChangelogEntry.title),
          asc(trackerChangelogEntry.createdAt),
          asc(trackerChangelogEntry.id),
        );
      const blogIdeas = await tx
        .select()
        .from(trackerBlogIdea)
        .orderBy(
          asc(trackerBlogIdea.sortOrder),
          asc(trackerBlogIdea.createdAt),
          asc(trackerBlogIdea.id),
        );
      const phases = await tx
        .select()
        .from(trackerBacklogPhase)
        .orderBy(
          asc(trackerBacklogPhase.sortOrder),
          asc(trackerBacklogPhase.createdAt),
          asc(trackerBacklogPhase.id),
        );
      const issues = await tx
        .select()
        .from(trackerBacklogIssue)
        .orderBy(
          asc(trackerBacklogIssue.sortOrder),
          asc(trackerBacklogIssue.createdAt),
          asc(trackerBacklogIssue.id),
        );
      const steps = await tx
        .select()
        .from(trackerBacklogStep)
        .orderBy(
          asc(trackerBacklogStep.sortOrder),
          asc(trackerBacklogStep.createdAt),
          asc(trackerBacklogStep.id),
        );

      const stepsByIssue = Map.groupBy(steps, (step) => step.issueId);
      const issuesByPhase = Map.groupBy(issues, (issue) => issue.phaseId);
      const backlog: BacklogPhaseView[] = phases.map((phase) => ({
        id: phase.id,
        title: phase.title,
        description: phase.description,
        sortOrder: phase.sortOrder,
        updatedAt: iso(phase.updatedAt),
        issues: (issuesByPhase.get(phase.id) ?? []).map((issue) => ({
          id: issue.id,
          issueNumber: issue.issueNumber,
          title: issue.title,
          note: issue.note,
          state: issue.state,
          githubUpdatedAt: isoOrNull(issue.githubUpdatedAt),
          sortOrder: issue.sortOrder,
          updatedAt: iso(issue.updatedAt),
          steps: (stepsByIssue.get(issue.id) ?? []).map(
            (step): BacklogStepView => ({
              id: step.id,
              key: step.key,
              label: step.label,
              prompt: step.prompt,
              sortOrder: step.sortOrder,
              completedAt: isoOrNull(step.completedAt),
              updatedAt: iso(step.updatedAt),
            }),
          ),
        })),
      }));

      return {
        readAt: iso(readAt),
        gitScan,
        backlogScan,
        changelog: changelog.map((entry) => ({
          id: entry.id,
          date: entry.date,
          category: entry.category,
          title: entry.title,
          summary: entry.summary,
          prNumbers: entry.prNumbers,
          updatedAt: iso(entry.updatedAt),
        })),
        blogIdeas: blogIdeas.map((idea) => ({
          id: idea.id,
          title: idea.title,
          pitch: idea.pitch,
          notes: idea.notes,
          prNumbers: idea.prNumbers,
          status: idea.status,
          publishedAt: idea.publishedAt,
          publishedUrl: idea.publishedUrl,
          sortOrder: idea.sortOrder,
          updatedAt: iso(idea.updatedAt),
        })),
        backlog,
        nextStep: nextActionableStep(backlog),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * The Backlog tab's "Up next": in phase order, then issue order, the first
 * open issue with an unfinished step, and that step.
 */
export function nextActionableStep(backlog: readonly BacklogPhaseView[]): NextStepView | null {
  for (const phase of backlog) {
    for (const issue of phase.issues) {
      if (issue.state !== "open") continue;
      const step = issue.steps.find((candidate) => candidate.completedAt === null);
      if (step) {
        return {
          phaseTitle: phase.title,
          issueNumber: issue.issueNumber,
          issueTitle: issue.title,
          step,
        };
      }
    }
  }
  return null;
}

// Commands. Each validates its raw input, then reads and writes in the
// transaction it is given.

export async function saveChangelogEntry(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(saveChangelogEntryInput, raw);
  const values = {
    date: input.date,
    category: input.category,
    title: input.title,
    summary: input.summary,
    prNumbers: input.prNumbers,
  };
  if (input.id === undefined) {
    const [row] = await tx
      .insert(trackerChangelogEntry)
      .values({ ...values, updatedAt: nowMs() })
      .returning({ id: trackerChangelogEntry.id });
    return { id: insertedId(row) };
  }
  const [row] = await tx
    .update(trackerChangelogEntry)
    .set({ ...values, updatedAt: nextUpdatedAt(trackerChangelogEntry.updatedAt) })
    .where(
      and(
        eq(trackerChangelogEntry.id, input.id),
        unchangedSince(trackerChangelogEntry.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerChangelogEntry.id });
  if (!row) await refuseChangelogWrite(tx, input.id);
  return { id: input.id };
}

export async function deleteChangelogEntry(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(deleteChangelogEntryInput, raw);
  const [row] = await tx
    .delete(trackerChangelogEntry)
    .where(
      and(
        eq(trackerChangelogEntry.id, input.id),
        unchangedSince(trackerChangelogEntry.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerChangelogEntry.id });
  if (!row) await refuseChangelogWrite(tx, input.id);
  return { id: input.id };
}

async function refuseChangelogWrite(tx: Transaction, id: string): Promise<never> {
  const [row] = await tx
    .select({ id: trackerChangelogEntry.id })
    .from(trackerChangelogEntry)
    .where(eq(trackerChangelogEntry.id, id));
  if (row) throw changedError("The changelog entry");
  throw new TrackerNotFoundError("Changelog entry not found.");
}

/**
 * Creates or updates a blog idea. A published idea is a record of what went
 * out: it stays published, and only its publication date, URL and sort order
 * can change. To revise an announcement, create a new idea.
 */
export async function saveBlogIdea(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(saveBlogIdeaInput, raw);
  const previous = input.id === undefined ? undefined : await findBlogIdea(tx, input.id);
  if (previous) {
    assertUnchanged(previous.updatedAt, input.updatedAt, "The blog idea");
    if (previous.status === "published") {
      if (input.status !== "published") {
        throw new TrackerRuleError("A published blog idea cannot leave published.");
      }
      if (
        input.title !== previous.title ||
        input.pitch !== previous.pitch ||
        input.notes !== previous.notes ||
        input.prNumbers.join(",") !== previous.prNumbers.join(",")
      ) {
        throw new TrackerRuleError(
          "A published blog idea is locked: only its publication date, URL and sort order can change. Create a new idea to revise it.",
        );
      }
    }
  }

  const published = input.status === "published";
  const values = {
    title: input.title,
    pitch: input.pitch,
    notes: input.notes,
    prNumbers: input.prNumbers,
    status: input.status,
    // Becoming published without a date means published today (UTC).
    publishedAt: published ? (input.publishedAt ?? previous?.publishedAt ?? todayUtc()) : null,
    publishedUrl: published ? input.publishedUrl : null,
    sortOrder: input.sortOrder,
  };

  if (!previous) {
    const [row] = await tx
      .insert(trackerBlogIdea)
      .values({ ...values, updatedAt: nowMs() })
      .returning({ id: trackerBlogIdea.id });
    return { id: insertedId(row) };
  }
  // The status the rules were checked against is part of the condition, so a
  // publish that commits between the read and this write is never overwritten.
  const [row] = await tx
    .update(trackerBlogIdea)
    .set({ ...values, updatedAt: nextUpdatedAt(trackerBlogIdea.updatedAt) })
    .where(
      and(
        eq(trackerBlogIdea.id, previous.id),
        eq(trackerBlogIdea.status, previous.status),
        unchangedSince(trackerBlogIdea.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerBlogIdea.id });
  if (!row) await refuseBlogIdeaWrite(tx, previous.id);
  return { id: previous.id };
}

/** Deletes an unpublished blog idea. Published ideas are never deleted. */
export async function deleteBlogIdea(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(deleteBlogIdeaInput, raw);
  const previous = await findBlogIdea(tx, input.id);
  assertUnchanged(previous.updatedAt, input.updatedAt, "The blog idea");
  if (previous.status === "published") {
    throw new TrackerRuleError("A published blog idea cannot be deleted.");
  }
  const [row] = await tx
    .delete(trackerBlogIdea)
    .where(
      and(
        eq(trackerBlogIdea.id, previous.id),
        eq(trackerBlogIdea.status, previous.status),
        unchangedSince(trackerBlogIdea.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerBlogIdea.id });
  if (!row) await refuseBlogIdeaWrite(tx, previous.id);
  return { id: previous.id };
}

async function findBlogIdea(tx: Transaction, id: string) {
  const [idea] = await tx.select().from(trackerBlogIdea).where(eq(trackerBlogIdea.id, id));
  if (!idea) throw new TrackerNotFoundError("Blog idea not found.");
  return idea;
}

async function refuseBlogIdeaWrite(tx: Transaction, id: string): Promise<never> {
  const [row] = await tx
    .select({ id: trackerBlogIdea.id })
    .from(trackerBlogIdea)
    .where(eq(trackerBlogIdea.id, id));
  if (row) throw changedError("The blog idea");
  throw new TrackerNotFoundError("Blog idea not found.");
}

export async function savePhase(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(savePhaseInput, raw);
  const values = {
    title: input.title,
    description: input.description,
    sortOrder: input.sortOrder,
  };
  if (input.id === undefined) {
    const [row] = await tx
      .insert(trackerBacklogPhase)
      .values({ ...values, updatedAt: nowMs() })
      .returning({ id: trackerBacklogPhase.id });
    return { id: insertedId(row) };
  }
  const [row] = await tx
    .update(trackerBacklogPhase)
    .set({ ...values, updatedAt: nextUpdatedAt(trackerBacklogPhase.updatedAt) })
    .where(
      and(
        eq(trackerBacklogPhase.id, input.id),
        unchangedSince(trackerBacklogPhase.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerBacklogPhase.id });
  if (!row) {
    await findPhase(tx, input.id);
    throw changedError("The phase");
  }
  return { id: input.id };
}

/** Deletes an empty phase. Move or delete its issues first. */
export async function deletePhase(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(deletePhaseInput, raw);
  // The row lock makes an issue added concurrently wait for this delete (and
  // then fail its foreign key) instead of slipping in after the count.
  const phase = await findPhase(tx, input.id, true);
  assertUnchanged(phase.updatedAt, input.updatedAt, "The phase");
  const [issues] = await tx
    .select({ count: count() })
    .from(trackerBacklogIssue)
    .where(eq(trackerBacklogIssue.phaseId, phase.id));
  const issueCount = issues?.count ?? 0;
  if (issueCount > 0) {
    throw new TrackerRuleError(
      `The phase "${phase.title}" still has ${issueCount} issue${issueCount === 1 ? "" : "s"}; move or delete them first.`,
    );
  }
  await tx.delete(trackerBacklogPhase).where(eq(trackerBacklogPhase.id, phase.id));
  return { id: phase.id };
}

async function findPhase(tx: Transaction, id: string, forUpdate = false) {
  const query = tx.select().from(trackerBacklogPhase).where(eq(trackerBacklogPhase.id, id));
  const [phase] = await (forUpdate ? query.for("update") : query.for("key share"));
  if (!phase) throw new TrackerNotFoundError("Backlog phase not found.");
  return phase;
}

/**
 * Creates (`mode: "create"`) or updates (`mode: "update"`) the backlog entry
 * for a GitHub issue. The mode states which the caller expects, so creating an
 * issue that is already tracked, or updating one that is not, is refused
 * rather than silently doing the other.
 */
export async function saveIssue(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(saveIssueInput, raw);
  const existing = await findIssue(tx, input.issueNumber);
  if (input.mode === "create" && existing) {
    throw new TrackerRuleError(`Issue #${input.issueNumber} is already tracked.`);
  }
  if (input.mode === "update" && !existing) {
    throw new TrackerRuleError(`Issue #${input.issueNumber} is not tracked.`);
  }
  // Locks the phase against deletion until this transaction ends.
  await findPhase(tx, input.phaseId);
  const values = {
    title: input.title,
    note: input.note,
    phaseId: input.phaseId,
    sortOrder: input.sortOrder,
    state: input.state,
    githubUpdatedAt: input.githubUpdatedAt === null ? null : new Date(input.githubUpdatedAt),
  };

  if (!existing) {
    const [row] = await tx
      .insert(trackerBacklogIssue)
      .values({ ...values, issueNumber: input.issueNumber, updatedAt: nowMs() })
      .onConflictDoNothing({ target: trackerBacklogIssue.issueNumber })
      .returning({ id: trackerBacklogIssue.id });
    if (!row) throw new TrackerRuleError(`Issue #${input.issueNumber} is already tracked.`);
    const steps = input.steps ?? defaultBacklogSteps(input.issueNumber);
    if (steps.length > 0) {
      await tx
        .insert(trackerBacklogStep)
        .values(steps.map((step) => ({ ...step, issueId: row.id, updatedAt: nowMs() })));
    }
    return { id: row.id };
  }

  assertUnchanged(existing.updatedAt, input.updatedAt, `Issue #${input.issueNumber}`);
  const [row] = await tx
    .update(trackerBacklogIssue)
    .set({ ...values, updatedAt: nextUpdatedAt(trackerBacklogIssue.updatedAt) })
    .where(
      and(
        eq(trackerBacklogIssue.id, existing.id),
        unchangedSince(trackerBacklogIssue.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerBacklogIssue.id });
  if (!row) await refuseIssueWrite(tx, input.issueNumber);
  return { id: existing.id };
}

/** Removes an issue from the backlog, with its steps. */
export async function deleteIssue(tx: Transaction, raw: unknown): Promise<{ issueNumber: number }> {
  const input = parseInput(deleteIssueInput, raw);
  const issue = await findIssue(tx, input.issueNumber);
  if (!issue) throw new TrackerNotFoundError(`Issue #${input.issueNumber} is not tracked.`);
  assertUnchanged(issue.updatedAt, input.updatedAt, `Issue #${input.issueNumber}`);
  const [row] = await tx
    .delete(trackerBacklogIssue)
    .where(
      and(
        eq(trackerBacklogIssue.id, issue.id),
        unchangedSince(trackerBacklogIssue.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerBacklogIssue.id });
  if (!row) await refuseIssueWrite(tx, input.issueNumber);
  return { issueNumber: input.issueNumber };
}

async function findIssue(tx: Transaction, issueNumber: number) {
  const [issue] = await tx
    .select()
    .from(trackerBacklogIssue)
    .where(eq(trackerBacklogIssue.issueNumber, issueNumber));
  return issue;
}

async function refuseIssueWrite(tx: Transaction, issueNumber: number): Promise<never> {
  if (await findIssue(tx, issueNumber)) throw changedError(`Issue #${issueNumber}`);
  throw new TrackerNotFoundError(`Issue #${issueNumber} is not tracked.`);
}

/**
 * Creates or updates a step of a tracked issue. An existing step must belong to
 * that issue; a step never moves between issues. Keys are unique per issue.
 */
export async function saveStep(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(saveStepInput, raw);
  const [issue] = await tx
    .select({ id: trackerBacklogIssue.id })
    .from(trackerBacklogIssue)
    .where(eq(trackerBacklogIssue.issueNumber, input.issueNumber))
    .for("key share");
  if (!issue) throw new TrackerNotFoundError(`Issue #${input.issueNumber} is not tracked.`);
  if (input.id !== undefined) {
    const step = await findStep(tx, input.id);
    if (step.issueId !== issue.id) {
      throw new TrackerRuleError(`The step does not belong to issue #${input.issueNumber}.`);
    }
    assertUnchanged(step.updatedAt, input.updatedAt, "The step");
  }
  const duplicateKey = () =>
    new TrackerRuleError(`Issue #${input.issueNumber} already has a step with key "${input.key}".`);
  const [sameKey] = await tx
    .select({ id: trackerBacklogStep.id })
    .from(trackerBacklogStep)
    .where(
      and(
        eq(trackerBacklogStep.issueId, issue.id),
        eq(trackerBacklogStep.key, input.key),
        input.id === undefined ? undefined : ne(trackerBacklogStep.id, input.id),
      ),
    );
  if (sameKey) throw duplicateKey();

  const values = {
    key: input.key,
    label: input.label,
    prompt: input.prompt,
    sortOrder: input.sortOrder,
  };
  // A step with the same key committed after the check above is refused like
  // one found by it: the insert skips it, and the update fails the constraint.
  if (input.id === undefined) {
    const [row] = await tx
      .insert(trackerBacklogStep)
      .values({ ...values, issueId: issue.id, updatedAt: nowMs() })
      .onConflictDoNothing({ target: [trackerBacklogStep.issueId, trackerBacklogStep.key] })
      .returning({ id: trackerBacklogStep.id });
    if (!row) throw duplicateKey();
    return { id: row.id };
  }
  const id = input.id;
  const [row] = await tx
    .update(trackerBacklogStep)
    .set({ ...values, updatedAt: nextUpdatedAt(trackerBacklogStep.updatedAt) })
    .where(
      and(
        eq(trackerBacklogStep.id, id),
        unchangedSince(trackerBacklogStep.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerBacklogStep.id })
    .catch((error: unknown) => {
      if (isUniqueViolation(error, "tracker_backlog_step_issue_id_key_unique")) {
        throw duplicateKey();
      }
      throw error;
    });
  if (!row) await refuseStepWrite(tx, id);
  return { id };
}

export async function deleteStep(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(deleteStepInput, raw);
  const [row] = await tx
    .delete(trackerBacklogStep)
    .where(
      and(
        eq(trackerBacklogStep.id, input.id),
        unchangedSince(trackerBacklogStep.updatedAt, input.updatedAt),
      ),
    )
    .returning({ id: trackerBacklogStep.id });
  if (!row) await refuseStepWrite(tx, input.id);
  return { id: input.id };
}

/**
 * Marks a step complete (copying its prompt does this) or not. Completing a
 * step that is already complete keeps its original completion time and
 * leaves the row unchanged.
 */
export async function setStepComplete(
  tx: Transaction,
  raw: unknown,
): Promise<{ id: string; completedAt: string | null }> {
  const input = parseInput(setStepCompleteInput, raw);
  const [row] = await tx
    .update(trackerBacklogStep)
    .set({
      completedAt: input.complete ? nowMs() : null,
      updatedAt: nextUpdatedAt(trackerBacklogStep.updatedAt),
    })
    .where(
      and(
        eq(trackerBacklogStep.id, input.id),
        input.complete
          ? isNull(trackerBacklogStep.completedAt)
          : isNotNull(trackerBacklogStep.completedAt),
      ),
    )
    .returning({ id: trackerBacklogStep.id, completedAt: trackerBacklogStep.completedAt });
  const step = row ?? (await findStep(tx, input.id));
  return { id: step.id, completedAt: isoOrNull(step.completedAt) };
}

async function findStep(tx: Transaction, id: string) {
  const [step] = await tx.select().from(trackerBacklogStep).where(eq(trackerBacklogStep.id, id));
  if (!step) throw new TrackerNotFoundError("Step not found.");
  return step;
}

async function refuseStepWrite(tx: Transaction, id: string): Promise<never> {
  await findStep(tx, id);
  throw changedError("The step");
}

/** How far ahead of this machine's clock a scan cursor may be, for clock skew. */
const MAX_CURSOR_LEAD_MS = 5 * 60_000;

/**
 * Records a completed scan. `throughAt` is the inclusive source cursor (the
 * newest reviewed PR merge or issue update), never the completion time, which
 * is recorded as now.
 */
export async function recordScan(tx: Transaction, raw: unknown): Promise<{ id: string }> {
  const input = parseInput(recordScanInput, raw);
  if (input.kind === "git_history" && input.throughSha === null) {
    throw new TrackerRuleError(
      "A git_history scan needs throughSha: the full SHA of the origin/main commit it reviewed.",
    );
  }
  if (input.kind === "backlog" && input.throughSha !== null) {
    throw new TrackerRuleError("A backlog scan has no throughSha; send null.");
  }
  const throughAt = new Date(input.throughAt);
  if (throughAt.getTime() > Date.now() + MAX_CURSOR_LEAD_MS) {
    throw new TrackerRuleError(
      "throughAt is in the future. It is the newest reviewed source time, not the completion time.",
    );
  }
  const [row] = await tx
    .insert(trackerScan)
    .values({ kind: input.kind, throughAt, throughSha: input.throughSha, note: input.note })
    .returning({ id: trackerScan.id });
  return { id: insertedId(row) };
}

function insertedId(row: { id: string } | undefined): string {
  if (!row) throw new Error("The insert returned no row.");
  return row.id;
}

// Dispatch

export const trackerCommands = {
  "save-changelog-entry": saveChangelogEntry,
  "delete-changelog-entry": deleteChangelogEntry,
  "save-blog-idea": saveBlogIdea,
  "delete-blog-idea": deleteBlogIdea,
  "save-phase": savePhase,
  "delete-phase": deletePhase,
  "save-issue": saveIssue,
  "delete-issue": deleteIssue,
  "save-step": saveStep,
  "delete-step": deleteStep,
  "set-step-complete": setStepComplete,
  "record-scan": recordScan,
} as const satisfies Record<
  TrackerCommandName,
  (tx: Transaction, raw: unknown) => Promise<unknown>
>;

export type TrackerCommandResult<N extends TrackerCommandName> = Awaited<
  ReturnType<(typeof trackerCommands)[N]>
>;

/**
 * Runs one command in its own transaction. `name` is checked at runtime too,
 * since the server action receives it from the browser.
 */
export async function runTrackerCommand<N extends TrackerCommandName>(
  db: Db,
  name: N,
  raw: unknown,
): Promise<TrackerCommandResult<N>> {
  if (!isTrackerCommandName(name)) {
    throw new TrackerInputError(`Unknown command: ${JSON.stringify(String(name).slice(0, 100))}`);
  }
  const command = trackerCommands[name] as (
    tx: Transaction,
    raw: unknown,
  ) => Promise<TrackerCommandResult<N>>;
  return db.transaction((tx) => command(tx, raw));
}

/**
 * Runs `[{ command, input }, ...]` in order in one transaction and returns
 * each command's result. If any command fails, nothing is written, and the
 * error's message starts with the failing command's index.
 */
export async function runTrackerBatch(db: Db, raw: unknown): Promise<unknown[]> {
  const commands = parseInput(batchInput, raw);
  return db.transaction(async (tx) => {
    const results: unknown[] = [];
    for (const [index, { command, input }] of commands.entries()) {
      try {
        results.push(await trackerCommands[command](tx, input));
      } catch (error) {
        const prefix = `Batch command ${index} (${command})`;
        if (error instanceof TrackerError) {
          error.message = `${prefix}: ${error.message}`;
          throw error;
        }
        throw new Error(`${prefix} failed.`, { cause: error });
      }
    }
    return results;
  });
}
