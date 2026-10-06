import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { type AdrSyncState, isReservationTaken, storedSyncState } from "./adr.ts";
import { type Transaction, withReadSnapshot } from "./coordination.ts";
import type { Db } from "./index.ts";
import type { Principal } from "./principal.ts";
import {
  type Adr,
  type AdrContentWarning,
  type AdrState,
  type AdrStatus,
  adr,
  adrContent,
} from "./schema/adr.ts";
import { project } from "./schema/project.ts";

// Reads of a Project's ADRs (issue #19): the list, one ADR with its
// supersedes chain, recent ADRs for the overview, and the last sync. Each
// `get`/`list` function reads one snapshot; the `read*` forms run inside the
// caller's read transaction (the dashboard's snapshot). Never writes.

/** The reservation behind an ADR number, if it was reserved with `adr new`. */
export interface AdrReservation {
  title: string;
  slug: string;
  gitBranch: string | null;
  principal: Principal;
  sessionId: string | null;
  reservedAt: Date;
}

/** An ADR number as readers see it. Content is never included in lists. */
export interface AdrView {
  id: string;
  projectId: string;
  number: number;
  state: AdrState;
  slug: string;
  /** The synced file's path; null while only reserved. */
  path: string | null;
  /** The file's H1, or the reserved title while no file was synced. */
  title: string;
  /** From the synced file; null while only reserved. A removed row keeps its last copy's. */
  status: AdrStatus | null;
  date: string | null;
  supersedes: number[];
  warnings: AdrContentWarning[];
  contentSha256: string | null;
  /** The sync head commit at which the content last changed. */
  commitSha: string | null;
  /** When a sync last changed the row. */
  syncedAt: Date | null;
  reservation: AdrReservation | null;
  /** A file took this number though it was reserved for another ADR, which needs a new number. */
  reservationTaken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** One ADR with its file, frontmatter included; null while only reserved. */
export interface AdrDetail extends AdrView {
  contentMd: string | null;
}

/** An ADR named by a supersedes link, `depth` links from the ADR read. */
export interface AdrLink {
  number: number;
  depth: number;
  /** False when no synced file has this number ("not found"). */
  found: boolean;
  title: string | null;
  status: AdrStatus | null;
  state: AdrState | null;
}

/** How many links `readAdr` follows in each direction. */
export const MAX_ADR_CHAIN_DEPTH = 10;

const adrViewColumns = {
  row: adr,
  title: adrContent.title,
  status: adrContent.status,
  date: adrContent.date,
  supersedes: adrContent.supersedes,
  warnings: adrContent.warnings,
};

const withContent = and(
  eq(adrContent.projectId, adr.projectId),
  eq(adrContent.contentSha256, adr.contentSha256),
);

function selectAdrViews(tx: Db | Transaction) {
  return tx.select(adrViewColumns).from(adr).leftJoin(adrContent, withContent);
}

type AdrViewRow = Awaited<ReturnType<ReturnType<typeof selectAdrViews>["where"]>>[number];

function reservationOf(row: Adr): AdrReservation | null {
  if (row.reservedTitle === null || row.reservedSlug === null) return null;
  const principal: Principal | null =
    row.reservedByKind === "user" && row.reservedByUserId
      ? { kind: "user", userId: row.reservedByUserId }
      : row.reservedByKind === "project_key" && row.reservedByKeyId
        ? { kind: "project_key", keyId: row.reservedByKeyId }
        : null;
  // adr_reservation_check rules this out.
  if (!principal) throw new Error(`adr ${row.id} has a reservation without a principal`);
  return {
    title: row.reservedTitle,
    slug: row.reservedSlug,
    gitBranch: row.gitBranch,
    principal,
    sessionId: row.reservedSessionId,
    reservedAt: row.createdAt,
  };
}

function toAdrView({ row, title, status, date, supersedes, warnings }: AdrViewRow): AdrView {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    state: row.state,
    slug: row.slug,
    path: row.path,
    title: title ?? row.reservedTitle ?? "",
    status,
    date,
    supersedes: supersedes ?? [],
    warnings: warnings ?? [],
    contentSha256: row.contentSha256,
    commitSha: row.commitSha,
    syncedAt: row.syncedAt,
    reservation: reservationOf(row),
    reservationTaken: isReservationTaken(row, title),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The Project's last ADR sync, or null if it was never synced. */
export async function readAdrSyncState(
  tx: Db | Transaction,
  projectId: string,
): Promise<AdrSyncState | null> {
  const [row] = await tx
    .select({
      syncedCommitSha: project.adrSyncedCommitSha,
      syncedAt: project.adrSyncedAt,
      syncedByKind: project.adrSyncedByKind,
      syncedByUserId: project.adrSyncedByUserId,
      syncedByKeyId: project.adrSyncedByKeyId,
    })
    .from(project)
    .where(eq(project.id, projectId));
  return row?.syncedCommitSha ? storedSyncState(row) : null;
}

export interface ListAdrsInput {
  projectId: string;
  /** The synced file's status; reserved-only numbers have none and never match. */
  status?: AdrStatus;
  state?: AdrState;
  limit: number;
  /** Continues after the previous page's last (lowest) number. */
  beforeNumber?: number;
}

export interface AdrPage {
  /** Highest number first. */
  items: AdrView[];
  hasMore: boolean;
  sync: AdrSyncState | null;
}

/** A page of the Project's ADR numbers, highest first, with the last sync. */
export async function listAdrs(db: Db, input: ListAdrsInput): Promise<AdrPage> {
  return withReadSnapshot(db, (tx) => readAdrs(tx, input));
}

/** `listAdrs` inside the caller's read transaction. */
export async function readAdrs(tx: Db | Transaction, input: ListAdrsInput): Promise<AdrPage> {
  const conditions: SQL[] = [eq(adr.projectId, input.projectId)];
  if (input.status) conditions.push(eq(adrContent.status, input.status));
  if (input.state) conditions.push(eq(adr.state, input.state));
  if (input.beforeNumber !== undefined) {
    conditions.push(sql`${adr.number} < ${input.beforeNumber}`);
  }
  const rows = await selectAdrViews(tx)
    .where(and(...conditions))
    .orderBy(desc(adr.number))
    .limit(input.limit + 1);
  return {
    items: rows.slice(0, input.limit).map(toAdrView),
    hasMore: rows.length > input.limit,
    sync: await readAdrSyncState(tx, input.projectId),
  };
}

export interface AdrWithChain {
  adr: AdrDetail;
  /** ADRs this one supersedes, then the ones they supersede, up to `MAX_ADR_CHAIN_DEPTH`. */
  supersedes: AdrLink[];
  /** Published ADRs that supersede this one, then their successors, up to the same depth. */
  supersededBy: AdrLink[];
  /** Links continue past the depth limit in at least one direction. */
  chainTruncated: boolean;
  sync: AdrSyncState | null;
}

/** One ADR by number with its file and supersedes links, or undefined. */
export async function getAdr(
  db: Db,
  input: { projectId: string; number: number },
): Promise<AdrWithChain | undefined> {
  return withReadSnapshot(db, (tx) => readAdr(tx, input));
}

/** `getAdr` inside the caller's read transaction. */
export async function readAdr(
  tx: Db | Transaction,
  input: { projectId: string; number: number },
): Promise<AdrWithChain | undefined> {
  const [found] = await tx
    .select({ ...adrViewColumns, contentMd: adrContent.contentMd })
    .from(adr)
    .leftJoin(adrContent, withContent)
    .where(and(eq(adr.projectId, input.projectId), eq(adr.number, input.number)))
    .limit(1);
  if (!found) return undefined;
  const view = toAdrView(found);
  const back = await supersedesChain(tx, input.projectId, view);
  const forward = await supersededByChain(tx, input.projectId, view.number);
  return {
    adr: { ...view, contentMd: found.contentMd },
    supersedes: back.links,
    supersededBy: forward.links,
    chainTruncated: back.truncated || forward.truncated,
    sync: await readAdrSyncState(tx, input.projectId),
  };
}

async function viewsByNumber(
  tx: Db | Transaction,
  projectId: string,
  numbers: number[],
): Promise<Map<number, AdrView>> {
  if (numbers.length === 0) return new Map();
  const rows = await selectAdrViews(tx).where(
    and(eq(adr.projectId, projectId), inArray(adr.number, numbers)),
  );
  return new Map(rows.map((row) => [row.row.number, toAdrView(row)]));
}

function linkOf(number: number, depth: number, view: AdrView | undefined): AdrLink {
  // A reserved number has no file, so as a link target it is not found.
  if (!view || view.state === "reserved") {
    return { number, depth, found: false, title: null, status: null, state: view?.state ?? null };
  }
  return { number, depth, found: true, title: view.title, status: view.status, state: view.state };
}

/** Follows `supersedes` from `start`, breadth first, each number once. */
async function supersedesChain(
  tx: Db | Transaction,
  projectId: string,
  start: AdrView,
): Promise<{ links: AdrLink[]; truncated: boolean }> {
  const links: AdrLink[] = [];
  const seen = new Set([start.number]);
  let frontier = [...new Set(start.supersedes)].filter((n) => !seen.has(n));
  for (let depth = 1; frontier.length > 0; depth++) {
    if (depth > MAX_ADR_CHAIN_DEPTH) return { links, truncated: true };
    for (const n of frontier) seen.add(n);
    const views = await viewsByNumber(tx, projectId, frontier);
    const next = new Set<number>();
    for (const number of frontier.sort((a, b) => a - b)) {
      const view = views.get(number);
      links.push(linkOf(number, depth, view));
      if (view && view.state !== "reserved") {
        for (const target of view.supersedes) if (!seen.has(target)) next.add(target);
      }
    }
    frontier = [...next];
  }
  return { links, truncated: false };
}

/** Published ADRs whose file supersedes `number`, and their successors, breadth first. */
async function supersededByChain(
  tx: Db | Transaction,
  projectId: string,
  number: number,
): Promise<{ links: AdrLink[]; truncated: boolean }> {
  const links: AdrLink[] = [];
  const seen = new Set([number]);
  let frontier = [number];
  for (let depth = 1; frontier.length > 0; depth++) {
    const rows = await selectAdrViews(tx)
      .where(
        and(
          eq(adr.projectId, projectId),
          eq(adr.state, "published"),
          sql`${adrContent.supersedes} && array[${sql.join(
            frontier.map((n) => sql`${n}`),
            sql`, `,
          )}]::int[]`,
        ),
      )
      .orderBy(asc(adr.number));
    const successors = rows.map(toAdrView).filter((view) => !seen.has(view.number));
    if (successors.length === 0) break;
    if (depth > MAX_ADR_CHAIN_DEPTH) return { links, truncated: true };
    for (const view of successors) {
      seen.add(view.number);
      links.push(linkOf(view.number, depth, view));
    }
    frontier = successors.map((view) => view.number);
  }
  return { links, truncated: false };
}

/**
 * The Project's published ADRs that a sync changed most recently, newest
 * first (then highest number first), for the overview.
 */
export async function recentAdrs(
  db: Db,
  input: { projectId: string; limit: number },
): Promise<AdrView[]> {
  return withReadSnapshot(db, (tx) => readRecentAdrs(tx, input));
}

/** `recentAdrs` inside the caller's read transaction. */
export async function readRecentAdrs(
  tx: Db | Transaction,
  input: { projectId: string; limit: number },
): Promise<AdrView[]> {
  const rows = await selectAdrViews(tx)
    .where(and(eq(adr.projectId, input.projectId), eq(adr.state, "published")))
    .orderBy(desc(adr.syncedAt), desc(adr.number))
    .limit(input.limit);
  return rows.map(toAdrView);
}
