import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  adrContentSha256,
  formatAdrNumber,
  parseAdrContent,
  parseAdrFileName,
} from "@hivemind/contract";
import { sendJson, sendOrpcError } from "./api-server.ts";
import type { CoordinationRequest, FakeOwner } from "./fake-coordination.ts";

/**
 * In-memory ADR routes for the fake backend (issue #19): reservations with
 * creation replay and the floor rule, content upload parsed with the real
 * contract parser and addressed by its own sha256, and a compare-and-set
 * sync that marks absent rows removed and raises the counter. It answers
 * with the contract's DTO shapes. Notices are reduced to the two the CLI
 * prints specially (`ADR_RESERVATION_TAKEN`, `ADR_NUMBER_UNRESERVED`); the
 * real rules are tested in packages/db and apps/web.
 */

type Actor = { kind: "user"; userId: string } | { kind: "project_key"; keyId: string };

export interface FakeAdrRow {
  id: string;
  projectId: string;
  number: number;
  state: "reserved" | "published" | "removed";
  title: string;
  slug: string;
  path: string | null;
  status: string | null;
  date: string | null;
  supersedes: number[];
  contentSha256: string | null;
  commitSha: string | null;
  syncedAt: string | null;
  reservation: {
    title: string;
    slug: string;
    gitBranch: string | null;
    reservedBy: Actor;
    sessionId: string | null;
    reservedAt: string;
  } | null;
  reservationTaken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FakeAdrSync {
  commitSha: string;
  syncedAt: string;
  syncedBy: Actor;
  /** The manifest, to answer a repeat of the same sync as a replay. */
  manifest: string;
}

export interface FakeAdrs {
  /** Rows by Project, then number. */
  rows: Map<string, Map<number, FakeAdrRow>>;
  /** Uploaded valid content by sha256 (any Project). */
  contents: Map<string, string>;
  syncs: Map<string, FakeAdrSync>;
  next: Map<string, number>;
  /** The next reservation gets exactly this number (then the knob clears). */
  forceNextNumber: number | undefined;
  /** Answer the next reservation with this CONFLICT message (then the knob clears). */
  reserveConflict: string | undefined;
  handle(request: CoordinationRequest, response: ServerResponse): Promise<void>;
}

const now = () => new Date().toISOString();

export function createFakeAdrs(
  replay: (
    kind: string,
    id: string,
    owner: FakeOwner,
    input: unknown,
  ) => "new" | "replay" | "conflict",
): FakeAdrs {
  const rows = new Map<string, Map<number, FakeAdrRow>>();
  const contents = new Map<string, string>();
  const syncs = new Map<string, FakeAdrSync>();
  const next = new Map<string, number>();
  const reservationIds = new Map<string, { projectId: string; number: number }>();

  const actorOf = (owner: FakeOwner): Actor =>
    owner.kind === "user"
      ? { kind: "user", userId: owner.userId }
      : { kind: "project_key", keyId: owner.keyId };
  const projectRows = (projectId: string) => {
    let map = rows.get(projectId);
    if (!map) {
      map = new Map();
      rows.set(projectId, map);
    }
    return map;
  };
  const lastSync = (projectId: string) => {
    const sync = syncs.get(projectId);
    return sync
      ? { commitSha: sync.commitSha, syncedAt: sync.syncedAt, syncedBy: sync.syncedBy }
      : null;
  };
  const warningsOf = (row: FakeAdrRow) => {
    const content = row.contentSha256 ? contents.get(row.contentSha256) : undefined;
    const parsed = content === undefined ? null : parseAdrContent(content);
    return parsed?.ok ? parsed.adr.warnings : [];
  };
  const summary = (row: FakeAdrRow) => ({ ...row, warningCount: warningsOf(row).length });
  const detail = (row: FakeAdrRow) => ({
    ...summary(row),
    content: row.contentSha256 ? (contents.get(row.contentSha256) ?? null) : null,
    supersededBy: [...projectRows(row.projectId).values()]
      .filter((other) => other.state === "published" && other.supersedes.includes(row.number))
      .map((other) => other.number)
      .sort((a, b) => a - b),
    warnings: warningsOf(row),
  });

  const fake: FakeAdrs = {
    rows,
    contents,
    syncs,
    next,
    forceNextNumber: undefined,
    reserveConflict: undefined,
    async handle(request, response) {
      const { method, projectId, parts, query, body, owner } = request;
      const ok = (value: unknown) => sendJson(response, 200, value);
      const conflict = (message: string) => sendOrpcError(response, 409, "CONFLICT", message);
      const badRequest = (message = "Input validation failed") =>
        sendOrpcError(response, 400, "BAD_REQUEST", message);
      const own = projectRows(projectId);
      const [, sub] = parts;

      // GET /adrs
      if (sub === undefined && method === "GET") {
        const status = query.get("status");
        const state = query.get("state");
        const items = [...own.values()]
          .filter((row) => (!status || row.status === status) && (!state || row.state === state))
          .sort((a, b) => b.number - a.number)
          .map(summary);
        const limit = Number(query.get("limit") ?? 50);
        const offset = Number(query.get("cursor")?.slice(1) ?? 0);
        return ok({
          items: items.slice(offset, offset + limit),
          nextCursor: offset + limit < items.length ? `o${offset + limit}` : null,
          lastSync: lastSync(projectId),
        });
      }

      // POST /adrs: reserve
      if (sub === undefined && method === "POST") {
        const adrId = String(body.adrId);
        const outcome = replay("adr", adrId, owner, {
          title: body.title,
          slug: body.slug,
          gitBranch: body.gitBranch,
          sessionId: body.sessionId,
        });
        if (outcome === "conflict") return conflict("The id is already used for another request.");
        if (outcome === "replay") {
          const known = reservationIds.get(adrId);
          const row = known && rows.get(known.projectId)?.get(known.number);
          if (!row || known?.projectId !== projectId) {
            return sendOrpcError(response, 404, "NOT_FOUND", "Not found.");
          }
          return ok({ adr: detail(row), created: false });
        }
        if (fake.reserveConflict !== undefined) {
          const message = fake.reserveConflict;
          fake.reserveConflict = undefined;
          return conflict(message);
        }
        const highest = Math.max(0, ...own.keys());
        const counter = Math.max(next.get(projectId) ?? 1, highest + 1);
        const floor = typeof body.floor === "number" ? body.floor : 0;
        if (floor + 1 - counter > 100) {
          return conflict(
            `The floor ${floor} is more than 100 past the next ADR number, ${counter}. Run \`hivemind adr sync\` on the default branch first.`,
          );
        }
        let number = Math.max(counter, floor + 1);
        if (fake.forceNextNumber !== undefined) {
          number = fake.forceNextNumber;
          fake.forceNextNumber = undefined;
        }
        if (number > 9999) return conflict("This Project has used every ADR number up to 9999.");
        next.set(projectId, number + 1);
        const at = now();
        const row: FakeAdrRow = {
          id: adrId,
          projectId,
          number,
          state: "reserved",
          title: String(body.title),
          slug: String(body.slug),
          path: null,
          status: null,
          date: null,
          supersedes: [],
          contentSha256: null,
          commitSha: null,
          syncedAt: null,
          reservation: {
            title: String(body.title),
            slug: String(body.slug),
            gitBranch: typeof body.gitBranch === "string" ? body.gitBranch : null,
            reservedBy: actorOf(owner),
            sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
            reservedAt: at,
          },
          reservationTaken: false,
          createdAt: at,
          updatedAt: at,
        };
        own.set(number, row);
        reservationIds.set(adrId, { projectId, number });
        return ok({ adr: detail(row), created: true });
      }

      // POST /adrs/contents
      if (sub === "contents" && method === "POST") {
        const files = Array.isArray(body.files) ? (body.files as Record<string, unknown>[]) : [];
        if (files.length === 0 || files.length > 50) return badRequest();
        const results = [];
        for (const file of files) {
          const content = String(file.content);
          const sha256 = String(file.sha256);
          const parsed = parseAdrContent(content);
          const actual = await adrContentSha256(content);
          if (!parsed.ok) {
            results.push({
              sha256,
              valid: false,
              created: false,
              errors: parsed.errors,
              warnings: [],
            });
            continue;
          }
          if (actual !== sha256) {
            results.push({
              sha256,
              valid: false,
              created: false,
              errors: [
                { code: "ADR_SHA256_MISMATCH", message: "The sha256 does not match the content." },
              ],
              warnings: [],
            });
            continue;
          }
          const created = !contents.has(sha256);
          contents.set(sha256, content);
          results.push({ sha256, valid: true, created, errors: [], warnings: parsed.adr.warnings });
        }
        return ok({ files: results });
      }

      // POST /adrs/sync
      if (sub === "sync" && method === "POST") {
        const commitSha = String(body.commitSha);
        const base = (body.baseCommitSha ?? null) as string | null;
        const directory = String(body.directory);
        const entries = (Array.isArray(body.entries) ? body.entries : []) as {
          fileName: string;
          sha256: string;
        }[];
        const manifest = JSON.stringify([directory, entries]);
        const current = syncs.get(projectId) ?? null;
        const counts = { added: 0, updated: 0, removed: 0, unchanged: 0 };
        if (current?.commitSha === commitSha) {
          if (current.manifest !== manifest) {
            return conflict(`Commit ${commitSha} was already synced with different files.`);
          }
          return ok({
            changed: false,
            lastSync: lastSync(projectId),
            previousCommitSha: commitSha,
            forced: body.forced === true,
            ...counts,
            unchanged: entries.length,
            changes: [],
            warnings: { items: [], complete: true },
          });
        }
        if ((current?.commitSha ?? null) !== base) {
          return conflict(
            `The ADR copy is at commit ${current?.commitSha ?? "no commit"}, not ${base}. Another ADR sync finished first.`,
          );
        }
        const byNumber = new Map<number, string[]>();
        const parsedEntries = [];
        for (const entry of entries) {
          const name = parseAdrFileName(entry.fileName);
          if (!name.ok) return badRequest();
          const path = `${directory}/${entry.fileName}`;
          byNumber.set(name.number, [...(byNumber.get(name.number) ?? []), path]);
          const content = contents.get(entry.sha256);
          if (content === undefined) {
            return badRequest(
              `ADR sync refused: ${path}: The content ${entry.sha256} was not uploaded.`,
            );
          }
          const parsed = parseAdrContent(content);
          if (!parsed.ok) return badRequest();
          parsedEntries.push({
            ...entry,
            number: name.number,
            slug: name.slug,
            path,
            adr: parsed.adr,
          });
        }
        const duplicates = [...byNumber].filter(([, paths]) => paths.length > 1);
        if (duplicates.length > 0) {
          return conflict(
            `More than one file has the same ADR number: ${duplicates
              .map(([number, paths]) => `${formatAdrNumber(number)} (${paths.join(", ")})`)
              .join("; ")}`,
          );
        }
        const at = now();
        const changes = [];
        const warnings = [];
        const seen = new Set<number>();
        for (const entry of parsedEntries.sort((a, b) => a.number - b.number)) {
          seen.add(entry.number);
          const row = own.get(entry.number);
          const fields = {
            state: "published" as const,
            title: entry.adr.title,
            slug: entry.slug,
            path: entry.path,
            status: entry.adr.status,
            date: entry.adr.date,
            supersedes: entry.adr.supersedes,
            contentSha256: entry.sha256,
          };
          if (row?.state !== "published") {
            const change = row?.state === "removed" ? "restored" : "added";
            changes.push({
              number: entry.number,
              change,
              path: entry.path,
              statusFrom: null,
              statusTo: entry.adr.status,
            });
            counts.added += 1;
            if (row?.reservation && row.state === "reserved") {
              const taken =
                row.reservation.slug !== entry.slug && row.reservation.title !== entry.adr.title;
              if (taken) {
                warnings.push({
                  number: entry.number,
                  path: entry.path,
                  code: "ADR_RESERVATION_TAKEN",
                  message: `${formatAdrNumber(entry.number)} was reserved for "${row.reservation.title}" (${row.reservation.slug}), but ${entry.path} took the number. The reserved ADR needs a new number: run hivemind adr new for it.`,
                });
              }
              Object.assign(row, fields, {
                reservationTaken: taken,
                commitSha,
                syncedAt: at,
                updatedAt: at,
              });
            } else if (row) {
              Object.assign(row, fields, { commitSha, syncedAt: at, updatedAt: at });
            } else {
              if (current !== null) {
                warnings.push({
                  number: entry.number,
                  path: entry.path,
                  code: "ADR_NUMBER_UNRESERVED",
                  message: `${formatAdrNumber(entry.number)} was not reserved with hivemind adr new.`,
                });
              }
              own.set(entry.number, {
                id: randomUUID(),
                projectId,
                number: entry.number,
                ...fields,
                commitSha,
                syncedAt: at,
                reservation: null,
                reservationTaken: false,
                createdAt: at,
                updatedAt: at,
              });
            }
          } else if (row.contentSha256 !== entry.sha256 || row.path !== entry.path) {
            changes.push({
              number: entry.number,
              change: "updated",
              path: entry.path,
              statusFrom: row.status,
              statusTo: entry.adr.status,
            });
            counts.updated += 1;
            Object.assign(row, fields, { commitSha, syncedAt: at, updatedAt: at });
          } else counts.unchanged += 1;
        }
        for (const row of own.values()) {
          if (row.state === "published" && !seen.has(row.number)) {
            changes.push({
              number: row.number,
              change: "removed",
              path: row.path,
              statusFrom: row.status,
              statusTo: null,
            });
            counts.removed += 1;
            Object.assign(row, { state: "removed", syncedAt: at, updatedAt: at });
          }
        }
        changes.sort((a, b) => a.number - b.number);
        next.set(projectId, Math.max(next.get(projectId) ?? 1, Math.max(0, ...seen) + 1));
        syncs.set(projectId, { commitSha, syncedAt: at, syncedBy: actorOf(owner), manifest });
        return ok({
          changed: true,
          lastSync: lastSync(projectId),
          previousCommitSha: current?.commitSha ?? null,
          forced: body.forced === true,
          ...counts,
          changes,
          warnings: { items: warnings, complete: true },
        });
      }

      // GET /adrs/{number}
      if (sub !== undefined && method === "GET" && /^[1-9][0-9]{0,3}$/.test(sub)) {
        const row = own.get(Number(sub));
        if (!row) return sendOrpcError(response, 404, "NOT_FOUND", "ADR not found.");
        return ok({ adr: detail(row), lastSync: lastSync(projectId) });
      }
      return sendOrpcError(response, 404, "NOT_FOUND", "Not found.");
    },
  };
  return fake;
}
