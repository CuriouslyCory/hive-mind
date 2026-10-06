import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  type AdrContentInput,
  type AdrSyncEntry,
  type SyncAdrsInput,
  storeAdrContents,
  syncAdrs,
} from "../../src/adr.ts";
import { sha256Hex } from "../../src/fingerprint.ts";
import type { Db } from "../../src/index.ts";
import type { Principal } from "../../src/principal.ts";
import { type AdrStatus, adr } from "../../src/schema/adr.ts";
import { event } from "../../src/schema/event.ts";
import { project } from "../../src/schema/project.ts";

// ADR files for the ADR tests, already "parsed": the fields a real parser
// would read from the generated markdown.

export interface AdrFile {
  content: AdrContentInput;
  entry: AdrSyncEntry;
}

export function adrFile(
  number: number,
  slug: string,
  options: { title?: string; status?: AdrStatus; supersedes?: number[]; body?: string } = {},
): AdrFile {
  const title = options.title ?? `Decision ${number}`;
  const status = options.status ?? "accepted";
  const supersedes = options.supersedes ?? [];
  const supersedesLine = supersedes.length > 0 ? `supersedes: [${supersedes.join(", ")}]\n` : "";
  const contentMd =
    `---\nstatus: ${status}\ndate: 2026-10-05\n${supersedesLine}---\n\n# ${title}\n\n` +
    `## Context\n\n${options.body ?? "Why."}\n`;
  const sha256 = sha256Hex(contentMd);
  const name = `${String(number).padStart(4, "0")}-${slug}.md`;
  return {
    content: { sha256, contentMd, title, status, date: "2026-10-05", supersedes, warnings: [] },
    entry: { path: `docs/adr/${name}`, sha256, number, slug },
  };
}

/** Files 1..count with slugs `decision-N`. */
export function adrFiles(count: number, from = 1): AdrFile[] {
  return Array.from({ length: count }, (_, i) => adrFile(from + i, `decision-${from + i}`));
}

/** A random full commit hash. */
export function commitSha(): string {
  return randomBytes(20).toString("hex");
}

export interface SyncContext {
  projectId: string;
  principal: Principal;
}

/** Uploads the files' content, then syncs them as `commit` on `base`. */
export async function uploadAndSync(
  db: Db,
  context: SyncContext,
  files: AdrFile[],
  options: Partial<Pick<SyncAdrsInput, "commitSha" | "baseCommitSha" | "forced">> = {},
) {
  if (files.length > 0) {
    const stored = await storeAdrContents(db, {
      ...context,
      items: files.map((file) => file.content),
    });
    if (stored.status !== "ok") throw new Error(`storeAdrContents: ${JSON.stringify(stored)}`);
  }
  return syncAdrs(db, {
    ...context,
    commitSha: options.commitSha ?? commitSha(),
    baseCommitSha: options.baseCommitSha ?? null,
    forced: options.forced ?? false,
    entries: files.map((file) => file.entry),
  });
}

export async function adrRows(db: Db, projectId: string) {
  return db.select().from(adr).where(eq(adr.projectId, projectId)).orderBy(asc(adr.number));
}

export async function adrEvents(db: Db, projectId: string) {
  return db.select().from(event).where(eq(event.projectId, projectId)).orderBy(asc(event.seq));
}

export async function projectAdrState(db: Db, projectId: string) {
  const [row] = await db
    .select({
      nextAdrNumber: project.nextAdrNumber,
      adrSyncedCommitSha: project.adrSyncedCommitSha,
      adrSyncedAt: project.adrSyncedAt,
      adrSyncedByKind: project.adrSyncedByKind,
      adrSyncedByUserId: project.adrSyncedByUserId,
      adrSyncedByKeyId: project.adrSyncedByKeyId,
      updatedAt: project.updatedAt,
    })
    .from(project)
    .where(eq(project.id, projectId));
  if (!row) throw new Error(`no project ${projectId}`);
  return row;
}
