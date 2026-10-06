import { and, eq, inArray, sql } from "drizzle-orm";
import { type Transaction, withAuthorizedCoordinationLock } from "./coordination.ts";
import { createOnce } from "./creation.ts";
import { type AdrSyncChange, insertEvent, MAX_ADR_SYNC_EVENT_CHANGES } from "./event.ts";
import { creationFingerprint, sha256Hex } from "./fingerprint.ts";
import type { Db } from "./index.ts";
import { effectiveSessionStatus } from "./liveness.ts";
import {
  assertStorableText,
  type CreationFailure,
  type SessionEnded,
  type SessionForbidden,
  type SessionNotFound,
} from "./plan.ts";
import { type Actor, type Principal, samePrincipal, sessionOwner } from "./principal.ts";
import {
  ADR_STATUSES,
  type Adr,
  type AdrContentWarning,
  type AdrStatus,
  adr,
  adrContent,
  MAX_ADR_CONTENT_BYTES,
  MAX_ADR_NUMBER,
  MAX_ADR_TITLE_LENGTH,
} from "./schema/adr.ts";
import { agentSession } from "./schema/coordination.ts";
import { project } from "./schema/project.ts";

// ADR reservations and ADR sync (issue #19, ADR-0017). hive-mind owns the
// numbers: `reserveAdr` hands one out under the Project lock, and a number is
// never handed out twice. Everything else is a copy of the repository's
// `docs/adr/` files as of one commit: `storeAdrContents` stores uploaded
// files by content hash, and `syncAdrs` applies one commit's manifest in a
// single transaction, all or nothing.
//
// This package never parses ADR files: it cannot import the contract
// package's parser. The API parses every file and passes the parsed fields
// in; this module checks only what its own invariants need. Results are
// plain outcome unions that apps/web maps to API errors.

/** The furthest a reservation's `floor` may move the counter (issue #19, "Seeding"). */
export const MAX_ADR_FLOOR_ADVANCE = 100;

/** The most files one ADR sync may list. */
export const MAX_ADR_SYNC_ENTRIES = 2000;

/** The longest path an ADR sync entry may have, in UTF-16 code units. */
export const MAX_ADR_PATH_LENGTH = 1024;

/** A slug as ADR file names write it (ADR-0001). */
export const ADR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * An ADR file's path: `docs/adr/NNNN-slug.md` under the directory holding
 * `.hivemind.json`, which may be below the repository root. Groups: the
 * number's four digits, the slug.
 */
const ADR_PATH = /^(?:[^/]+\/)*docs\/adr\/(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A full commit hash: SHA-1, or SHA-256 for repositories that use it. */
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Who writes an ADR change: the authorized principal and, optionally, its Session. */
export interface AdrWriter {
  projectId: string;
  principal: Principal;
  /** The actor Session; must be the principal's own in this Project and not ended or abandoned. */
  sessionId?: string | null;
}

// An outcome that ends a transaction early, rolling back what it wrote (and,
// inside `createOnce`, its savepoint). `returningOutcome` turns it back into
// a value. The same pattern as src/plan.ts.
class Outcome<T> extends Error {
  constructor(readonly outcome: T) {
    super("adr outcome");
  }
}

async function returningOutcome<T, O>(run: () => Promise<T>): Promise<T | O> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Outcome) return error.outcome as O;
    throw error;
  }
}

/** The actor Session must be the principal's own in this Project and still open at `now`. */
async function checkActorSession(
  tx: Transaction,
  writer: AdrWriter,
  now: Date,
): Promise<SessionNotFound | SessionForbidden | SessionEnded | null> {
  if (!writer.sessionId) return null;
  const [row] = await tx
    .select()
    .from(agentSession)
    .where(and(eq(agentSession.id, writer.sessionId), eq(agentSession.projectId, writer.projectId)))
    .limit(1);
  if (!row) return { status: "session_not_found" };
  if (!samePrincipal(sessionOwner(row), writer.principal)) return { status: "session_forbidden" };
  const status = effectiveSessionStatus(row, now);
  if (status === "ended" || status === "abandoned") return { status: "session_ended" };
  return null;
}

function actorOf(writer: AdrWriter): Actor {
  return { ...writer.principal, sessionId: writer.sessionId ?? null };
}

/** A principal as an ADR reservation's `reserved_by_*` columns. */
function reservedByColumns(principal: Principal) {
  return principal.kind === "user"
    ? {
        reservedByKind: "user" as const,
        reservedByUserId: principal.userId,
        reservedByKeyId: null,
      }
    : {
        reservedByKind: "project_key" as const,
        reservedByUserId: null,
        reservedByKeyId: principal.keyId,
      };
}

function normalizedTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Whether a synced file took a number reserved for another ADR: the file's
 * slug and title both differ from the reservation's. The file wins, and the
 * reserved ADR needs a new number. Only the slug differing is reported as
 * `slug_differs` instead, since the author may have renamed the file.
 */
export function isReservationTaken(
  row: Pick<Adr, "state" | "slug" | "reservedSlug" | "reservedTitle">,
  fileTitle: string | null,
): boolean {
  if (row.state === "reserved" || row.reservedSlug === null || row.reservedTitle === null) {
    return false;
  }
  if (row.slug === row.reservedSlug) return false;
  return fileTitle === null || normalizedTitle(fileTitle) !== normalizedTitle(row.reservedTitle);
}

// --- Reservation -----------------------------------------------------------

export interface ReserveAdrInput extends AdrWriter {
  /** The caller's UUID for the reservation, for replay. */
  id: string;
  /** At most `MAX_ADR_TITLE_LENGTH` UTF-16 code units, not blank. */
  title: string;
  slug: string;
  /** The caller's git branch, or null when it could not tell. */
  gitBranch?: string | null;
  /**
   * The highest ADR number the client saw in its working tree and on the
   * default branch, 0 if none. Recorded in the Event; not part of the
   * replay fingerprint, so a retry that recomputed it still replays.
   */
  floor?: number;
}

export type ReserveAdrOutcome =
  /** `created`: a new number. `replay`: the same reservation, as it is now; no Event. */
  | { status: "created" | "replay"; adr: Adr }
  | CreationFailure
  /** The input breaks a rule the API also enforces. */
  | { status: "invalid"; message: string }
  /** `floor` would move the counter more than `MAX_ADR_FLOOR_ADVANCE`. A conflict. */
  | { status: "floor_too_high"; floor: number; nextNumber: number; message: string }
  /** The next number would be past `MAX_ADR_NUMBER`. A conflict. */
  | { status: "numbers_exhausted"; message: string }
  | SessionNotFound
  | SessionForbidden
  | SessionEnded;

function reserveInputProblem(input: ReserveAdrInput): string | null {
  const title = input.title;
  if (title.trim() === "") return "The title must not be blank.";
  if (title.length > MAX_ADR_TITLE_LENGTH) {
    return `The title is longer than ${MAX_ADR_TITLE_LENGTH} characters.`;
  }
  if (!ADR_SLUG.test(input.slug)) {
    return "The slug must be lowercase letters and digits joined by single hyphens.";
  }
  const floor = input.floor ?? 0;
  if (!Number.isInteger(floor) || floor < 0 || floor > MAX_ADR_NUMBER) {
    return `The floor must be an integer from 0 to ${MAX_ADR_NUMBER}.`;
  }
  return null;
}

/**
 * Reserves the Project's next ADR number under the caller's UUID, or
 * recognizes a retry of the same reservation (`replay`, which allocates
 * nothing and writes no Event). Under the Project lock the number is
 * `greatest(next_adr_number, floor + 1, highest existing number + 1)`, and
 * the counter moves past it. A floor that would move the counter more than
 * `MAX_ADR_FLOOR_ADVANCE` is refused, so a stray floor cannot burn the number
 * space: ADR sync, not the floor, brings in large existing sets. Writes
 * `adr.reserved` in the same transaction.
 */
export async function reserveAdr(db: Db, input: ReserveAdrInput): Promise<ReserveAdrOutcome> {
  const problem = reserveInputProblem(input);
  if (problem) return { status: "invalid", message: problem };
  assertStorableText({ title: input.title, gitBranch: input.gitBranch });
  const floor = input.floor ?? 0;
  const gitBranch = input.gitBranch ?? null;
  const fingerprint = creationFingerprint({
    title: input.title,
    slug: input.slug,
    gitBranch,
    sessionId: input.sessionId ?? null,
  });

  return returningOutcome(() =>
    withAuthorizedCoordinationLock(db, input, async ({ tx, now }) => {
      const outcome = await createOnce(
        tx,
        {
          kind: "adr",
          projectId: input.projectId,
          id: input.id,
          principal: input.principal,
          fingerprint,
        },
        // The number is allocated here, after the replay check, so a retry
        // never consumes one.
        async (sp) => {
          const session = await checkActorSession(sp, input, now);
          if (session) throw new Outcome(session);
          const number = await allocateAdrNumber(sp, input.projectId, floor);
          const [row] = await sp
            .insert(adr)
            .values({
              id: input.id,
              projectId: input.projectId,
              number,
              state: "reserved",
              slug: input.slug,
              reservedTitle: input.title,
              reservedSlug: input.slug,
              gitBranch,
              ...reservedByColumns(input.principal),
              reservedSessionId: input.sessionId ?? null,
              creationFingerprint: fingerprint,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!row) throw new Error("adr insert returned no row");
          await insertEvent(sp, {
            projectId: input.projectId,
            type: "adr.reserved",
            payload: { adrId: row.id, number, title: input.title, slug: input.slug, floor },
            actor: actorOf(input),
            now,
          });
          return row;
        },
      );
      if (outcome.status === "conflict") return { status: "conflict" } as const;
      if (outcome.status === "not_found") return { status: "id_not_found" } as const;
      return { status: outcome.status, adr: outcome.row };
    }),
  );
}

/**
 * Picks the reservation's number and moves the counter past it, or throws an
 * `Outcome` refusing it. Call it under the Project lock. Raw SQL, so the
 * Project's updated_at is left alone (as `allocatePlanNumber` does).
 */
async function allocateAdrNumber(
  tx: Transaction,
  projectId: string,
  floor: number,
): Promise<number> {
  const result = await tx.execute<{ next: number; highest: number }>(sql`
    select p.next_adr_number as next,
      coalesce((select max(a.number) from adr a where a.project_id = p.id), 0)::int as highest
    from project p where p.id = ${projectId}
  `);
  const current = result.rows[0];
  if (!current) throw new Error(`Project ${projectId} does not exist.`);
  const base = Math.max(current.next, current.highest + 1);
  const number = Math.max(base, floor + 1);
  if (number - base > MAX_ADR_FLOOR_ADVANCE) {
    throw new Outcome({
      status: "floor_too_high",
      floor,
      nextNumber: base,
      message:
        `The highest local ADR number, ${floor}, is more than ${MAX_ADR_FLOOR_ADVANCE} past ` +
        `the next number hive-mind would reserve (${base}). Run \`hivemind adr sync\` on the default branch first.`,
    } as const);
  }
  if (number > MAX_ADR_NUMBER) {
    throw new Outcome({
      status: "numbers_exhausted",
      message: `This Project has used every ADR number up to ${MAX_ADR_NUMBER}.`,
    } as const);
  }
  await tx.execute(sql`update project set next_adr_number = ${number + 1} where id = ${projectId}`);
  return number;
}

// --- Content upload --------------------------------------------------------

/** One ADR file the API parsed and validated, with the fields it read. */
export interface AdrContentInput {
  /** Lowercase hex sha256 of `contentMd`'s UTF-8 bytes. */
  sha256: string;
  contentMd: string;
  title: string;
  status: AdrStatus;
  /** `YYYY-MM-DD`. */
  date: string;
  supersedes: number[];
  warnings: AdrContentWarning[];
}

export type StoreAdrContentsOutcome =
  /** `stored`: hashes inserted now. `existing`: hashes this Project already had. */
  | { status: "ok"; stored: string[]; existing: string[] }
  /** Items that break a stored invariant; nothing was stored. */
  | { status: "invalid"; problems: { sha256: string; message: string }[] };

function contentProblem(item: AdrContentInput): string | null {
  if (!SHA256.test(item.sha256)) return "sha256 must be 64 lowercase hex digits.";
  if (Buffer.byteLength(item.contentMd, "utf8") > MAX_ADR_CONTENT_BYTES) {
    return `The file is larger than ${MAX_ADR_CONTENT_BYTES} bytes.`;
  }
  if (sha256Hex(item.contentMd) !== item.sha256) return "sha256 does not match the content.";
  if (item.title.trim() === "") return "The title must not be blank.";
  if (!(ADR_STATUSES as readonly string[]).includes(item.status)) return "Unknown status.";
  if (!DATE.test(item.date)) return "date must be YYYY-MM-DD.";
  if (!item.supersedes.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_ADR_NUMBER)) {
    return `supersedes must list numbers from 1 to ${MAX_ADR_NUMBER}.`;
  }
  for (const value of [item.contentMd, item.title, ...item.warnings.map((w) => w.message)]) {
    if (value.includes("\u0000")) return "The file contains a NUL character.";
  }
  return null;
}

const CONTENT_INSERT_CHUNK = 100;

/**
 * Stores parsed ADR files for a Project, addressed by content hash.
 * Idempotent: a hash the Project already has is left as it is, since content
 * rows never change. Checks that each hash matches its content. Writes no
 * Event: uploaded content is not part of the copy until a sync names it.
 */
export async function storeAdrContents(
  db: Db,
  input: { projectId: string; principal: Principal; items: AdrContentInput[] },
): Promise<StoreAdrContentsOutcome> {
  const problems = input.items.flatMap((item) => {
    const message = contentProblem(item);
    return message ? [{ sha256: item.sha256, message }] : [];
  });
  if (problems.length > 0) return { status: "invalid", problems };
  const unique = [...new Map(input.items.map((item) => [item.sha256, item])).values()];

  return withAuthorizedCoordinationLock(db, input, async ({ tx, now }) => {
    const stored: string[] = [];
    for (let start = 0; start < unique.length; start += CONTENT_INSERT_CHUNK) {
      const chunk = unique.slice(start, start + CONTENT_INSERT_CHUNK);
      const rows = await tx
        .insert(adrContent)
        .values(
          chunk.map((item) => ({
            projectId: input.projectId,
            contentSha256: item.sha256,
            contentMd: item.contentMd,
            title: item.title,
            status: item.status,
            date: item.date,
            supersedes: item.supersedes,
            warnings: item.warnings,
            createdAt: now,
          })),
        )
        .onConflictDoNothing({ target: [adrContent.projectId, adrContent.contentSha256] })
        .returning({ sha256: adrContent.contentSha256 });
      stored.push(...rows.map((row) => row.sha256));
    }
    const inserted = new Set(stored);
    return {
      status: "ok",
      stored,
      existing: unique.map((item) => item.sha256).filter((sha) => !inserted.has(sha)),
    };
  });
}

// --- Sync ------------------------------------------------------------------

/** One file of the synced commit's `docs/adr/`. */
export interface AdrSyncEntry {
  path: string;
  /** The sha256 of an `adr_content` row this Project already stored. */
  sha256: string;
  /** The number and slug from the file name; checked against `path`. */
  number: number;
  slug: string;
}

export interface SyncAdrsInput extends AdrWriter {
  /** The commit whose tree the entries were read from. */
  commitSha: string;
  /** The commit the client believes was synced last (null: never synced). Compared and set. */
  baseCommitSha: string | null;
  /** The client skipped its ancestry check. Recorded in the Event; the comparison still applies. */
  forced: boolean;
  entries: AdrSyncEntry[];
}

/** Why an entry, or the request, cannot be applied. Every one is a bad request. */
export type AdrSyncProblemReason =
  | "invalid_commit_sha"
  | "too_many_entries"
  | "invalid_path"
  | "number_mismatch"
  | "invalid_sha256"
  | "duplicate_path"
  | "missing_content";

export interface AdrSyncProblem {
  reason: AdrSyncProblemReason;
  /** The entry's path; null for a problem with the request as a whole. */
  path: string | null;
  message: string;
}

/**
 * The warnings only a sync can find, by comparing a file with its number's
 * reservation. The codes are the contract's `ADR_WARNING_CODES` of the same
 * names; warnings about the set of files (supersedes targets and the like)
 * come from the contract's parser, which the API runs.
 */
export const ADR_SYNC_NOTICE_CODES = [
  /** A file with a number nobody reserved: it bypassed `adr new`. */
  "ADR_NUMBER_UNRESERVED",
  /** A reserved number's file has another slug but the reserved title. */
  "ADR_SLUG_DIFFERS_FROM_RESERVATION",
  /** A file took a number reserved for another ADR, which needs a new number. */
  "ADR_RESERVATION_TAKEN",
] as const;
export type AdrSyncNoticeCode = (typeof ADR_SYNC_NOTICE_CODES)[number];

/**
 * Something a sync applied that someone should look at, reported when the
 * file is published. Only in the answer: never stored or put in the Event.
 * `ADR_RESERVATION_TAKEN` stays visible afterwards as `reservationTaken`.
 */
export interface AdrSyncNotice {
  code: AdrSyncNoticeCode;
  number: number;
  path: string;
  /** Plain text, at most a few hundred characters. */
  message: string;
}

/** The Project's last ADR sync: what the copy is as of. */
export interface AdrSyncState {
  commitSha: string;
  syncedAt: Date;
  syncedBy: Principal;
}

/** A change in a sync answer: the Event's change, plus the path (the last one for `removed`). */
export type AdrSyncSummaryChange = AdrSyncChange & { path: string };

export interface AdrSyncSummary {
  /** The sync this answer is about, as now recorded on the Project. */
  lastSync: AdrSyncState;
  /** The commit synced before this one (on a replay, the same commit). */
  previousCommitSha: string | null;
  forced: boolean;
  /** `added` includes `restored`, as in the Event. */
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** Every change, in number order (the Event lists at most 100). */
  changes: AdrSyncSummaryChange[];
  notices: AdrSyncNotice[];
  /** The counter after the sync: the number the next reservation gets at least. */
  nextNumber: number;
}

export type SyncAdrsOutcome =
  /**
   * Applied. `replay`: the Project was already synced at this commit with
   * the same files, so nothing was written (a retry of a lost answer).
   */
  | { status: "ok"; replay: boolean; summary: AdrSyncSummary }
  /** A bad request: invalid entries or content not uploaded. Nothing applied. */
  | { status: "invalid"; problems: AdrSyncProblem[] }
  /** Two files share a number. A conflict; nothing applied. */
  | { status: "duplicate_numbers"; duplicates: { number: number; paths: string[] }[] }
  /** `baseCommitSha` is not the last synced commit. A conflict; nothing applied. */
  | { status: "stale_base"; currentCommitSha: string | null }
  /** This commit was synced already with different files. A conflict; nothing applied. */
  | { status: "commit_mismatch"; currentCommitSha: string }
  | SessionNotFound
  | SessionForbidden
  | SessionEnded;

/** The request-level and per-entry problems that need no database read. */
function syncInputProblems(input: SyncAdrsInput): AdrSyncProblem[] {
  const problems: AdrSyncProblem[] = [];
  if (!COMMIT_SHA.test(input.commitSha)) {
    problems.push({
      reason: "invalid_commit_sha",
      path: null,
      message: "commitSha must be a full lowercase commit hash.",
    });
  }
  if (input.baseCommitSha !== null && !COMMIT_SHA.test(input.baseCommitSha)) {
    problems.push({
      reason: "invalid_commit_sha",
      path: null,
      message: "baseCommitSha must be null or a full lowercase commit hash.",
    });
  }
  if (input.entries.length > MAX_ADR_SYNC_ENTRIES) {
    problems.push({
      reason: "too_many_entries",
      path: null,
      message: `A sync lists at most ${MAX_ADR_SYNC_ENTRIES} files.`,
    });
    return problems;
  }
  const seen = new Set<string>();
  for (const entry of input.entries) {
    const match = entry.path.length <= MAX_ADR_PATH_LENGTH ? ADR_PATH.exec(entry.path) : null;
    const segments = entry.path.split("/");
    const number = match ? Number(match[1]) : 0;
    if (!match || number < 1 || segments.some((s) => s === "." || s === "..")) {
      problems.push({
        reason: "invalid_path",
        path: entry.path,
        message: "The path must end in docs/adr/NNNN-slug.md with a number from 0001 to 9999.",
      });
    } else if (number !== entry.number || match[2] !== entry.slug) {
      problems.push({
        reason: "number_mismatch",
        path: entry.path,
        message: "The number and slug must be the ones in the file name.",
      });
    }
    if (!SHA256.test(entry.sha256)) {
      problems.push({
        reason: "invalid_sha256",
        path: entry.path,
        message: "sha256 must be 64 lowercase hex digits.",
      });
    }
    if (seen.has(entry.path)) {
      problems.push({ reason: "duplicate_path", path: entry.path, message: "Listed twice." });
    }
    seen.add(entry.path);
  }
  return problems;
}

function duplicateNumbers(entries: AdrSyncEntry[]): { number: number; paths: string[] }[] {
  const byNumber = new Map<number, string[]>();
  for (const entry of entries) {
    byNumber.set(entry.number, [...(byNumber.get(entry.number) ?? []), entry.path]);
  }
  return [...byNumber.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([number, paths]) => ({ number, paths: paths.sort() }))
    .sort((a, b) => a.number - b.number);
}

interface StoredRow {
  row: Adr;
  status: AdrStatus | null;
}

interface ContentFacts {
  title: string;
  status: AdrStatus;
  supersedes: number[];
}

/** Whether the published rows are exactly the manifest (number, path and content). */
function sameManifest(rows: StoredRow[], entries: AdrSyncEntry[]): boolean {
  const published = new Map(
    rows.filter(({ row }) => row.state === "published").map(({ row }) => [row.number, row]),
  );
  if (published.size !== entries.length) return false;
  return entries.every((entry) => {
    const row = published.get(entry.number);
    return row?.path === entry.path && row.contentSha256 === entry.sha256;
  });
}

const UPSERT_CHUNK = 500;

/**
 * Applies one commit's ADR files to the Project's copy, in one transaction
 * under the Project lock, all or nothing:
 *
 * - compare-and-set on the synced commit: `baseCommitSha` must be the last
 *   synced commit (`forced` does not skip this), and a sync of the commit
 *   already synced with the same files is a replay that writes nothing;
 * - every hash must be uploaded already (`storeAdrContents`), and no two
 *   files may share a number;
 * - each file's number becomes `published` with the file's path, slug and
 *   content. A reserved number's row keeps its reservation; a file nobody
 *   reserved gets a new row. `commit_sha` moves only when the content
 *   changes (or a removed file comes back);
 * - published numbers missing from the commit become `removed`, keeping
 *   their last copy. Rows are never deleted. Reserved numbers with no file
 *   stay `reserved`. A removed number whose file reappears is `restored` on
 *   the same row;
 * - the counter moves past the highest synced number, and the Project records
 *   the commit, the time and the principal;
 * - exactly one `adr.synced` Event is written, even when nothing changed.
 */
export async function syncAdrs(db: Db, input: SyncAdrsInput): Promise<SyncAdrsOutcome> {
  const problems = syncInputProblems(input);
  if (problems.length > 0) return { status: "invalid", problems };
  const duplicates = duplicateNumbers(input.entries);
  if (duplicates.length > 0) return { status: "duplicate_numbers", duplicates };
  const entries = [...input.entries].sort((a, b) => a.number - b.number);

  return withAuthorizedCoordinationLock(db, input, async ({ tx, now }) => {
    const session = await checkActorSession(tx, input, now);
    if (session) return session;

    const [state] = await tx
      .select({
        nextNumber: project.nextAdrNumber,
        syncedCommitSha: project.adrSyncedCommitSha,
        syncedAt: project.adrSyncedAt,
        syncedByKind: project.adrSyncedByKind,
        syncedByUserId: project.adrSyncedByUserId,
        syncedByKeyId: project.adrSyncedByKeyId,
      })
      .from(project)
      .where(eq(project.id, input.projectId));
    if (!state) throw new Error(`Project ${input.projectId} does not exist.`);

    const stored: StoredRow[] = await tx
      .select({ row: adr, status: adrContent.status })
      .from(adr)
      .leftJoin(
        adrContent,
        and(
          eq(adrContent.projectId, adr.projectId),
          eq(adrContent.contentSha256, adr.contentSha256),
        ),
      )
      .where(eq(adr.projectId, input.projectId));

    if (state.syncedCommitSha === input.commitSha) {
      if (!sameManifest(stored, entries)) {
        return { status: "commit_mismatch", currentCommitSha: input.commitSha } as const;
      }
      return {
        status: "ok",
        replay: true,
        summary: {
          lastSync: storedSyncState(state),
          previousCommitSha: input.commitSha,
          forced: input.forced,
          added: 0,
          updated: 0,
          removed: 0,
          unchanged: entries.length,
          changes: [],
          notices: [],
          nextNumber: state.nextNumber,
        },
      } as const;
    }
    if (state.syncedCommitSha !== input.baseCommitSha) {
      return { status: "stale_base", currentCommitSha: state.syncedCommitSha } as const;
    }

    const contents = await loadContents(tx, input.projectId, entries);
    const missing = entries.filter((entry) => !contents.has(entry.sha256));
    if (missing.length > 0) {
      return {
        status: "invalid",
        problems: missing.map((entry) => ({
          reason: "missing_content" as const,
          path: entry.path,
          message: `No valid upload has sha256 ${entry.sha256}; upload the file first.`,
        })),
      } as const;
    }

    const writes = planSync(input.projectId, stored, entries, contents, input.commitSha, now);
    for (let start = 0; start < writes.upserts.length; start += UPSERT_CHUNK) {
      await tx
        .insert(adr)
        .values(writes.upserts.slice(start, start + UPSERT_CHUNK))
        .onConflictDoUpdate({
          target: [adr.projectId, adr.number],
          set: {
            state: sql`excluded.state`,
            slug: sql`excluded.slug`,
            path: sql`excluded.path`,
            contentSha256: sql`excluded.content_sha256`,
            commitSha: sql`excluded.commit_sha`,
            syncedAt: sql`excluded.synced_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
    if (writes.removedIds.length > 0) {
      await tx
        .update(adr)
        .set({ state: "removed", syncedAt: now, updatedAt: now })
        .where(and(eq(adr.projectId, input.projectId), inArray(adr.id, writes.removedIds)));
    }

    const highest = entries.at(-1)?.number ?? 0;
    const principal = input.principal;
    const updated = await tx.execute<{ next: number }>(sql`
      update project set
        next_adr_number = greatest(next_adr_number, ${highest + 1}),
        adr_synced_commit_sha = ${input.commitSha},
        adr_synced_at = ${now},
        adr_synced_by_kind = ${principal.kind},
        adr_synced_by_user_id = ${principal.kind === "user" ? principal.userId : null},
        adr_synced_by_key_id = ${principal.kind === "project_key" ? principal.keyId : null}
      where id = ${input.projectId}
      returning next_adr_number as next
    `);
    const nextNumber = updated.rows[0]?.next;
    if (nextNumber === undefined) throw new Error("project update returned no row");

    const counts = {
      added: writes.changes.filter((c) => c.change === "added" || c.change === "restored").length,
      updated: writes.changes.filter((c) => c.change === "updated").length,
      removed: writes.changes.filter((c) => c.change === "removed").length,
    };
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "adr.synced",
      payload: {
        commitSha: input.commitSha,
        previousCommitSha: state.syncedCommitSha,
        forced: input.forced,
        ...counts,
        changes: writes.changes
          .slice(0, MAX_ADR_SYNC_EVENT_CHANGES)
          .map(({ path: _path, ...change }) => change),
        truncated: writes.changes.length > MAX_ADR_SYNC_EVENT_CHANGES,
      },
      actor: actorOf(input),
      now,
    });

    return {
      status: "ok",
      replay: false,
      summary: {
        lastSync: { commitSha: input.commitSha, syncedAt: now, syncedBy: input.principal },
        previousCommitSha: state.syncedCommitSha,
        forced: input.forced,
        ...counts,
        unchanged: writes.unchanged,
        changes: writes.changes,
        notices: writes.notices,
        nextNumber,
      },
    } as const;
  });
}

async function loadContents(
  tx: Transaction,
  projectId: string,
  entries: AdrSyncEntry[],
): Promise<Map<string, ContentFacts>> {
  const hashes = [...new Set(entries.map((entry) => entry.sha256))];
  const contents = new Map<string, ContentFacts>();
  if (hashes.length === 0) return contents;
  const rows = await tx
    .select({
      sha256: adrContent.contentSha256,
      title: adrContent.title,
      status: adrContent.status,
      supersedes: adrContent.supersedes,
    })
    .from(adrContent)
    .where(and(eq(adrContent.projectId, projectId), inArray(adrContent.contentSha256, hashes)));
  for (const { sha256, ...facts } of rows) contents.set(sha256, facts);
  return contents;
}

/** The writes, changes and notices of one sync, computed before writing. */
function planSync(
  projectId: string,
  stored: StoredRow[],
  entries: AdrSyncEntry[],
  contents: Map<string, ContentFacts>,
  commitSha: string,
  now: Date,
) {
  const byNumber = new Map(stored.map((entry) => [entry.row.number, entry]));
  const upserts: (typeof adr.$inferInsert)[] = [];
  const changes: AdrSyncSummaryChange[] = [];
  const notices: AdrSyncNotice[] = [];
  let unchanged = 0;

  for (const entry of entries) {
    const content = contents.get(entry.sha256);
    if (!content) throw new Error(`content ${entry.sha256} was not loaded`);
    const existing = byNumber.get(entry.number);
    const { number, path } = entry;
    const write = {
      projectId,
      number,
      state: "published" as const,
      slug: entry.slug,
      path,
      contentSha256: entry.sha256,
      commitSha,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    if (!existing) {
      upserts.push(write);
      changes.push({ number, path, change: "added", statusFrom: null, statusTo: content.status });
      notices.push({
        code: "ADR_NUMBER_UNRESERVED",
        number,
        path,
        message: `ADR-${pad(number)} was not reserved with \`hivemind adr new\`.`,
      });
      continue;
    }

    const { row, status } = existing;
    if (row.state === "reserved" || row.state === "removed") {
      upserts.push(write);
      const change = row.state === "reserved" ? "added" : "restored";
      changes.push({ number, path, change, statusFrom: null, statusTo: content.status });
      const reservation = row.state === "reserved" ? reservationOf(row) : null;
      if (reservation) {
        const published = { ...row, state: "published" as const, slug: entry.slug };
        if (isReservationTaken(published, content.title)) {
          notices.push({
            code: "ADR_RESERVATION_TAKEN",
            number,
            path,
            message:
              `ADR-${pad(number)} was reserved for "${reservation.title}" (${reservation.slug}); ` +
              "this file took the number, so that ADR needs a new one from `hivemind adr new`.",
          });
        } else if (entry.slug !== reservation.slug) {
          notices.push({
            code: "ADR_SLUG_DIFFERS_FROM_RESERVATION",
            number,
            path,
            message: `ADR-${pad(number)} was reserved with the slug ${reservation.slug}.`,
          });
        }
      }
      continue;
    }

    // Published: an update if the path or content changed.
    const contentChanged = row.contentSha256 !== entry.sha256;
    if (!contentChanged && row.path === path) {
      unchanged++;
      continue;
    }
    upserts.push({ ...write, commitSha: contentChanged ? commitSha : row.commitSha });
    if (!status) throw new Error(`adr ${row.id} has no content`);
    changes.push({ number, path, change: "updated", statusFrom: status, statusTo: content.status });
  }

  const listed = new Set(entries.map((entry) => entry.number));
  const removedIds: string[] = [];
  for (const { row, status } of stored) {
    if (row.state !== "published" || listed.has(row.number)) continue;
    if (!status || !row.path) throw new Error(`adr ${row.id} has no content`);
    removedIds.push(row.id);
    changes.push({
      number: row.number,
      path: row.path,
      change: "removed",
      statusFrom: status,
      statusTo: null,
    });
  }
  changes.sort((a, b) => a.number - b.number);
  return { upserts, removedIds, changes, notices, unchanged };
}

function pad(number: number): string {
  return String(number).padStart(4, "0");
}

/** The reservation on a row, if it has one. */
function reservationOf(row: Adr): { title: string; slug: string } | null {
  return row.reservedTitle !== null && row.reservedSlug !== null
    ? { title: row.reservedTitle, slug: row.reservedSlug }
    : null;
}

/** The Project's recorded last sync, from its `adr_synced_*` columns once it has one. */
export function storedSyncState(state: {
  syncedCommitSha: string | null;
  syncedAt: Date | null;
  syncedByKind: "user" | "project_key" | null;
  syncedByUserId: string | null;
  syncedByKeyId: string | null;
}): AdrSyncState {
  const { syncedCommitSha, syncedAt, syncedByKind, syncedByUserId, syncedByKeyId } = state;
  const syncedBy: Principal | null =
    syncedByKind === "user" && syncedByUserId
      ? { kind: "user", userId: syncedByUserId }
      : syncedByKind === "project_key" && syncedByKeyId
        ? { kind: "project_key", keyId: syncedByKeyId }
        : null;
  // project_adr_synced_check rules this out.
  if (!syncedCommitSha || !syncedAt || !syncedBy) throw new Error("incomplete ADR sync state");
  return { commitSha: syncedCommitSha, syncedAt, syncedBy };
}
