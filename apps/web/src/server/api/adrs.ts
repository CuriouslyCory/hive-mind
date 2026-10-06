import {
  type Adr,
  type AdrProblem,
  type AdrSummary,
  type AdrSyncState,
  type AdrSyncWarning,
  adrContentSha256,
  formatAdrNumber,
  MAX_ADR_PROBLEM_MESSAGE_LENGTH,
  MAX_ADR_PROBLEMS,
  MAX_ADR_SUPERSEDES,
  MAX_ADR_SYNC_WARNINGS,
  MAX_ADR_WARNINGS,
  parseAdrContent,
  parseAdrFileName,
  validateAdrSet,
} from "@hivemind/contract";
import {
  type AdrContentInput,
  type AdrSyncEntry,
  type AdrSyncNotice,
  type AdrSyncState as AdrSyncStateRecord,
  type AdrView,
  type AdrWithChain,
  type Db,
  getAdr as getAdrRecord,
  listAdrs as listAdrRecords,
  reserveAdr as reserveAdrRecord,
  storeAdrContents,
  syncAdrs as syncAdrRecords,
} from "@hivemind/db";
import { adr, adrContent } from "@hivemind/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { apiError } from "./authorize";
import { adrNotFound, authorizeProject, coordinationError } from "./coordination-auth";
import { api } from "./implementer";
import { decodeKeysetCursor, encodeKeysetCursor, INT4_POSITION } from "./keyset";
import { pageLimit } from "./pagination";

// ADR reservations and ADR sync (issue #19, ADR-0017). The repository's
// `docs/adr/` files are the source of truth; hive-mind hands out the numbers
// and keeps a read-only copy of the files as of the last ADR sync. Each
// handler authorizes the Project first (`coordination-auth.ts`; Members, or
// keys with `adr:read`/`adr:write`), then calls `@hivemind/db`.
//
// The server never trusts what a client says about a file: the upload route
// parses every file with the contract's parser and recomputes its hash, and
// sync names only files the upload route accepted. Content is never in a list
// or an Event.

/** How many items an error message lists before "and N more." */
const LISTED_PROBLEMS = 20;

/** `GET /projects/{id}/adrs`: highest number first, without content. */
export const listAdrs = api.projects.adrs.list.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["adr:read"]);
    const limit = pageLimit(input.limit);
    const scope = ["adrs", input.id, input.status, input.state];
    const beforeNumber = input.cursor
      ? Number(decodeKeysetCursor(scope, input.cursor, [INT4_POSITION])[0])
      : undefined;
    const page = await listAdrRecords(db, {
      projectId: input.id,
      status: input.status,
      state: input.state,
      limit,
      beforeNumber,
    });
    const last = page.items.at(-1);
    return {
      items: page.items.map(toAdrSummaryDto),
      nextCursor: page.hasMore && last ? encodeKeysetCursor(scope, [String(last.number)]) : null,
      lastSync: toAdrSyncStateDto(page.sync),
    };
  },
);

/** `POST /projects/{id}/adrs`: reserve the next number under the client's UUID, replay-safe. */
export const reserveAdr = api.projects.adrs.reserve.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["adr:write"]);
    const outcome = await reserveAdrRecord(db, {
      projectId: input.id,
      principal: access.principal,
      sessionId: input.sessionId,
      id: input.adrId,
      title: input.title,
      slug: input.slug,
      gitBranch: input.gitBranch,
      floor: input.floor,
    });
    switch (outcome.status) {
      case "created":
      case "replay": {
        // A replay returns the ADR as it is now, which may be published since.
        const found = await getAdrRecord(db, { projectId: input.id, number: outcome.adr.number });
        if (!found) throw new Error(`ADR ${outcome.adr.id} was not found after its reservation.`);
        return { adr: toAdrDto(found), created: outcome.status === "created" };
      }
      case "floor_too_high":
      case "numbers_exhausted":
        throw apiError("CONFLICT", outcome.message);
      case "invalid":
        throw apiError("BAD_REQUEST", outcome.message);
      default:
        throw coordinationError(outcome);
    }
  },
);

/** `GET /projects/{id}/adrs/{number}`: any state, with content and the last sync. */
export const getAdr = api.projects.adrs.get.handler(
  async ({ input, context: { principal, db } }) => {
    await authorizeProject(db, principal, input.id, ["adr:read"]);
    const found = await getAdrRecord(db, { projectId: input.id, number: input.number });
    if (!found) throw adrNotFound();
    return { adr: toAdrDto(found), lastSync: toAdrSyncStateDto(found.sync) };
  },
);

/**
 * `POST /projects/{id}/adrs/contents`: parses each file and stores the valid
 * ones by sha256. A problem with one file is reported in its result, never as
 * an error of the request. Writes no Event.
 */
export const uploadAdrContents = api.projects.adrs.contents.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["adr:write"]);
    const checked = await Promise.all(input.files.map(checkAdrFile));
    const items = checked.flatMap((file) => (file.item ? [file.item] : []));
    let stored = new Set<string>();
    if (items.length > 0) {
      const outcome = await storeAdrContents(db, {
        projectId: input.id,
        principal: access.principal,
        items,
      });
      // The parser checks everything storeAdrContents does, so this is a bug.
      if (outcome.status !== "ok") {
        throw new Error(`storeAdrContents refused parsed files: ${JSON.stringify(outcome)}`);
      }
      stored = new Set(outcome.stored);
    }
    return {
      files: checked.map(({ sha256, item, errors, warnings }) => ({
        sha256,
        valid: item !== null,
        created: stored.has(sha256),
        errors: errors.slice(0, MAX_ADR_PROBLEMS).map(toProblem),
        warnings: warnings.slice(0, MAX_ADR_PROBLEMS).map(toProblem),
      })),
    };
  },
);

interface CheckedAdrFile {
  /** The sha256 the client sent, which its result is reported under. */
  sha256: string;
  /** What to store; null when the file has an error. */
  item: AdrContentInput | null;
  errors: AdrProblem[];
  warnings: AdrProblem[];
}

/** Parses one uploaded file and checks its claimed sha256 against the content. */
async function checkAdrFile(file: { sha256: string; content: string }): Promise<CheckedAdrFile> {
  const parsed = parseAdrContent(file.content);
  const errors: AdrProblem[] = parsed.ok ? [] : [...parsed.errors];
  const warnings: AdrProblem[] = parsed.ok ? [...parsed.adr.warnings] : [];
  if (parsed.ok && parsed.adr.supersedes.length > MAX_ADR_SUPERSEDES) {
    errors.push({
      code: "ADR_SUPERSEDES_INVALID",
      message: `supersedes lists ${parsed.adr.supersedes.length} ADRs; an ADR may supersede at most ${MAX_ADR_SUPERSEDES}.`,
    });
  }
  // Content is addressed by its hash, so a wrong one would let a client
  // store a file under another file's address.
  if ((await adrContentSha256(file.content)) !== file.sha256) {
    errors.push({ code: "ADR_SHA256_MISMATCH", message: "The sha256 does not match the content." });
  }
  if (!parsed.ok || errors.length > 0) return { sha256: file.sha256, item: null, errors, warnings };
  const { title, status, date, supersedes } = parsed.adr;
  return {
    sha256: file.sha256,
    item: {
      sha256: file.sha256,
      contentMd: file.content,
      title,
      status,
      date,
      supersedes,
      warnings: warnings.slice(0, MAX_ADR_WARNINGS).map(toProblem),
    },
    errors,
    warnings,
  };
}

/**
 * `POST /projects/{id}/adrs/sync`: make the copy match one commit's ADR
 * files, all or nothing, compare-and-set on the last synced commit.
 */
export const syncAdrs = api.projects.adrs.sync.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["adr:write"]);
    const entries: AdrSyncEntry[] = input.entries.map((entry) => {
      const name = parseAdrFileName(entry.fileName);
      // The input schema accepts only names the parser accepts.
      if (!name.ok) throw apiError("BAD_REQUEST", name.error.message);
      return {
        path: `${input.directory}/${entry.fileName}`,
        sha256: entry.sha256,
        number: name.number,
        slug: name.slug,
      };
    });
    const outcome = await syncAdrRecords(db, {
      projectId: input.id,
      principal: access.principal,
      sessionId: input.sessionId,
      commitSha: input.commitSha,
      baseCommitSha: input.baseCommitSha,
      forced: input.forced ?? false,
      entries,
    });
    switch (outcome.status) {
      case "ok": {
        const { summary } = outcome;
        const warnings = outcome.replay
          ? []
          : await syncWarnings(db, input.id, entries, summary.notices, summary.previousCommitSha);
        return {
          changed: !outcome.replay,
          lastSync: toSyncStateDto(summary.lastSync),
          previousCommitSha: summary.previousCommitSha,
          forced: summary.forced,
          added: summary.added,
          updated: summary.updated,
          removed: summary.removed,
          unchanged: summary.unchanged,
          changes: outcome.replay
            ? []
            : summary.changes.map(({ number, change, path, statusFrom, statusTo }) => ({
                number,
                change,
                path,
                statusFrom,
                statusTo,
              })),
          warnings: {
            items: warnings.slice(0, MAX_ADR_SYNC_WARNINGS),
            complete: warnings.length <= MAX_ADR_SYNC_WARNINGS,
          },
        };
      }
      case "duplicate_numbers":
        throw apiError(
          "CONFLICT",
          `More than one file has the same ADR number: ${listed(
            outcome.duplicates.map(
              ({ number, paths }) => `${formatAdrNumber(number)} (${paths.join(", ")})`,
            ),
          )}`,
        );
      case "stale_base":
        throw apiError(
          "CONFLICT",
          `The ADR copy is at ${commitName(outcome.currentCommitSha)}, not ` +
            `${commitName(input.baseCommitSha)}. Another ADR sync finished first.`,
        );
      case "commit_mismatch":
        throw apiError(
          "CONFLICT",
          `Commit ${outcome.currentCommitSha} was already synced with different files.`,
        );
      case "invalid":
        throw apiError(
          "BAD_REQUEST",
          `ADR sync refused: ${listed(
            outcome.problems.map(({ path, message }) =>
              truncated(path ? `${path}: ${message}` : message),
            ),
          )}`,
        );
      default:
        throw coordinationError(outcome);
    }
  },
);

function commitName(sha: string | null): string {
  return sha ? `commit ${sha}` : "no commit (never synced)";
}

/** The first `LISTED_PROBLEMS` items joined with "; ", then how many more. */
function listed(items: string[]): string {
  const shown = items.slice(0, LISTED_PROBLEMS).join("; ");
  const more = items.length - LISTED_PROBLEMS;
  return more > 0 ? `${shown}; and ${more} more.` : `${shown}.`;
}

/**
 * The notices of an applied sync, in number order: the reservation notices
 * `syncAdrs` found, and the supersedes-graph warnings of the synced set
 * (`validateAdrSet`). The first sync of a repository reports no unreserved
 * numbers, since every existing file would be one.
 */
async function syncWarnings(
  db: Db,
  projectId: string,
  entries: AdrSyncEntry[],
  notices: AdrSyncNotice[],
  previousCommitSha: string | null,
): Promise<AdrSyncWarning[]> {
  const kept = notices.filter(
    (notice) => previousCommitSha !== null || notice.code !== "ADR_NUMBER_UNRESERVED",
  );
  const reservations = await reservationsOf(
    db,
    projectId,
    kept.filter((notice) => notice.code !== "ADR_NUMBER_UNRESERVED").map((n) => n.number),
  );
  const warnings: AdrSyncWarning[] = kept.map((notice) => ({
    number: notice.number,
    path: notice.path,
    code: notice.code,
    message: truncated(noticeMessage(notice, reservations.get(notice.number))),
  }));

  // Content rows never change, so these facts are the synced files' even if
  // another sync has finished since.
  const facts = await contentFacts(db, projectId, entries);
  const pathOf = new Map(entries.map((entry) => [entry.number, entry.path]));
  const set = entries.flatMap((entry) => {
    const fact = facts.get(entry.sha256);
    return fact ? [{ number: entry.number, path: entry.path, ...fact }] : [];
  });
  for (const warning of validateAdrSet(set).warnings) {
    const path = pathOf.get(warning.number);
    if (!path) continue;
    warnings.push({
      number: warning.number,
      path,
      code: warning.code,
      message: truncated(warning.message),
    });
  }
  return warnings.sort((a, b) => a.number - b.number);
}

function noticeMessage(
  notice: AdrSyncNotice,
  reservation: { title: string; slug: string } | undefined,
): string {
  const name = formatAdrNumber(notice.number);
  switch (notice.code) {
    case "ADR_NUMBER_UNRESERVED":
      return `${name} was not reserved with hivemind adr new.`;
    case "ADR_RESERVATION_TAKEN":
      return reservation
        ? `${name} was reserved for "${reservation.title}" (${reservation.slug}), but ${notice.path} took the number. The reserved ADR needs a new number: run hivemind adr new for it.`
        : notice.message;
    case "ADR_SLUG_DIFFERS_FROM_RESERVATION": {
      const slug = parseAdrFileName(notice.path.slice(notice.path.lastIndexOf("/") + 1));
      return reservation && slug.ok
        ? `${notice.path} has the slug ${slug.slug}; ${name} was reserved as ${reservation.slug}.`
        : notice.message;
    }
  }
}

/** The reservations behind `numbers`, which never change once made. */
async function reservationsOf(
  db: Db,
  projectId: string,
  numbers: number[],
): Promise<Map<number, { title: string; slug: string }>> {
  if (numbers.length === 0) return new Map();
  const rows = await db
    .select({ number: adr.number, title: adr.reservedTitle, slug: adr.reservedSlug })
    .from(adr)
    .where(and(eq(adr.projectId, projectId), inArray(adr.number, numbers)));
  return new Map(
    rows.flatMap(({ number, title, slug }) =>
      title !== null && slug !== null ? [[number, { title, slug }] as const] : [],
    ),
  );
}

/** The status and supersedes of each synced file's stored content, by sha256. */
async function contentFacts(db: Db, projectId: string, entries: AdrSyncEntry[]) {
  const hashes = [...new Set(entries.map((entry) => entry.sha256))];
  if (hashes.length === 0) return new Map();
  const rows = await db
    .select({
      sha256: adrContent.contentSha256,
      status: adrContent.status,
      supersedes: adrContent.supersedes,
    })
    .from(adrContent)
    .where(and(eq(adrContent.projectId, projectId), inArray(adrContent.contentSha256, hashes)));
  return new Map(rows.map(({ sha256, ...fact }) => [sha256, fact]));
}

/** A parser or db message, at most `MAX_ADR_PROBLEM_MESSAGE_LENGTH` code units. */
export function truncated(message: string): string {
  if (message.length <= MAX_ADR_PROBLEM_MESSAGE_LENGTH) return message;
  let end = MAX_ADR_PROBLEM_MESSAGE_LENGTH - 1;
  // Never end on half of a surrogate pair.
  const last = message.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${message.slice(0, end)}…`;
}

function toProblem({ code, message }: { code: string; message: string }): AdrProblem {
  return { code, message: truncated(message) };
}

// ADR records as the contract's JSON (issue #19). Database views never reach
// a response directly: these pick the public fields and turn Dates into ISO
// strings. `warningCount` is the length of the detail's `warnings`.

function warningsOf(view: AdrView): AdrProblem[] {
  return view.warnings.slice(0, MAX_ADR_WARNINGS).map(toProblem);
}

/** An ADR without its content, as the ADR list shows it. */
export function toAdrSummaryDto(view: AdrView): AdrSummary {
  return {
    id: view.id,
    projectId: view.projectId,
    number: view.number,
    state: view.state,
    title: view.title,
    slug: view.slug,
    path: view.path,
    status: view.status,
    date: view.date,
    supersedes: [...view.supersedes],
    contentSha256: view.contentSha256,
    commitSha: view.commitSha,
    syncedAt: view.syncedAt?.toISOString() ?? null,
    reservation: view.reservation && {
      title: view.reservation.title,
      slug: view.reservation.slug,
      gitBranch: view.reservation.gitBranch,
      reservedBy: { ...view.reservation.principal },
      sessionId: view.reservation.sessionId,
      reservedAt: view.reservation.reservedAt.toISOString(),
    },
    reservationTaken: view.reservationTaken,
    warningCount: warningsOf(view).length,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

/** An ADR with its content, the published ADRs that supersede it, and its warnings. */
export function toAdrDto({ adr: view, supersededBy }: AdrWithChain): Adr {
  return {
    ...toAdrSummaryDto(view),
    content: view.contentMd,
    supersededBy: supersededBy.filter((link) => link.depth === 1).map((link) => link.number),
    warnings: warningsOf(view),
  };
}

function toSyncStateDto(state: AdrSyncStateRecord): AdrSyncState {
  return {
    commitSha: state.commitSha,
    syncedAt: state.syncedAt.toISOString(),
    syncedBy: { ...state.syncedBy },
  };
}

/** The Project's last ADR sync, or null before the first one. */
export function toAdrSyncStateDto(state: AdrSyncStateRecord | null): AdrSyncState | null {
  return state && toSyncStateDto(state);
}
