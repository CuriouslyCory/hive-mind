import { readFileSync } from "node:fs";
import { type AnyContractRouter, isContractProcedure } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ADR_ERROR_CODES,
  ADR_STATES,
  ADR_STATUSES,
  ADR_SYNC_CHANGE_KINDS,
  ADR_WARNING_CODES,
  type Adr,
  type AdrSummary,
  adrChangeSchema,
  adrContentSha256,
  adrPageSchema,
  adrProblemSchema,
  adrSchema,
  adrStateSchema,
  adrStatusSchema,
  adrSummarySchema,
  adrSyncWarningSchema,
  apiContract,
  cliEnvelopeSchema,
  formatAdrNumber,
  getAdrInputSchema,
  getAdrOutputSchema,
  isAdrDirectory,
  listAdrsInputSchema,
  MAX_ADR_CONTENT_BATCH_FILES,
  MAX_ADR_CONTENT_LENGTH,
  MAX_ADR_DIRECTORY_BYTES,
  MAX_ADR_FILE_BYTES,
  MAX_ADR_FILE_NAME_LENGTH,
  MAX_ADR_NUMBER,
  MAX_ADR_PATH_LENGTH,
  MAX_ADR_PROBLEM_MESSAGE_LENGTH,
  MAX_ADR_PROBLEMS,
  MAX_ADR_SLUG_LENGTH,
  MAX_ADR_SUPERSEDES,
  MAX_ADR_SYNC_CHANGES,
  MAX_ADR_SYNC_ENTRIES,
  MAX_ADR_SYNC_WARNINGS,
  MAX_ADR_TITLE_LENGTH,
  MAX_ADR_UPLOAD_BODY_BYTES,
  MAX_ADR_WARNINGS,
  MAX_MANAGEMENT_BODY_BYTES,
  MAX_PAGE_LIMIT,
  newAdrTitleSchema,
  padAdrNumber,
  parseAdrContent,
  reserveAdrInputSchema,
  reserveAdrOutputSchema,
  syncAdrsInputSchema,
  syncAdrsOutputSchema,
  uploadAdrContentsInputSchema,
  uploadAdrContentsOutputSchema,
  utf8ByteLength,
} from "../src/index.ts";

// The ADR routes of #19 (ADR-0017). Like the coordination fixtures, every
// file here is pinned: never edit one to make a test pass.

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), "utf8"));
}

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

function jsonBytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

const PROJECT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SESSION_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const UUID = "6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b";
const COMMIT = "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const SHA256 = "a".repeat(64);
const WIDE = "€";
const QUOTE = '"';

/** The installed CLI reads at most this much of a response (apps/cli/src/client.ts). */
const CLI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const ADR_RESPONSE_FIXTURES: Record<string, string> = {
  listAdrs: "adr-page.json",
  reserveAdr: "reserve-adr.json",
  getAdr: "adr.json",
  uploadAdrContents: "upload-adr-contents.json",
  syncAdrs: "sync-adrs.json",
};

function outputSchemas(router: AnyContractRouter): Map<string, z.ZodType> {
  const schemas = new Map<string, z.ZodType>();
  for (const child of Object.values(router)) {
    if (isContractProcedure(child)) {
      const { route, outputSchema } = child["~orpc"];
      if (route.operationId) schemas.set(route.operationId, outputSchema as z.ZodType);
    } else {
      for (const [id, schema] of outputSchemas(child as AnyContractRouter)) schemas.set(id, schema);
    }
  }
  return schemas;
}

describe("ADR routes", () => {
  const routes = fixture("routes.adr.json") as Array<{
    procedure: string;
    operationId: string;
    path: string;
  }>;

  it("are the five ADR procedures under /projects/{id}/adrs", () => {
    expect(routes.map((route) => route.procedure)).toEqual([
      "projects.adrs.list",
      "projects.adrs.reserve",
      "projects.adrs.get",
      "projects.adrs.contents",
      "projects.adrs.sync",
    ]);
    for (const route of routes) expect(route.path).toMatch(/^\/projects\/\{id\}\/adrs/);
  });

  it("have a response fixture each", () => {
    expect(Object.keys(ADR_RESPONSE_FIXTURES).sort()).toEqual(
      routes.map((route) => route.operationId).sort(),
    );
  });

  const schemas = outputSchemas(apiContract);
  it.each(Object.entries(ADR_RESPONSE_FIXTURES))("%s parses %s unchanged", (operationId, name) => {
    const value = fixture(name);
    expect(schemas.get(operationId)?.parse(value)).toEqual(value);
  });
});

describe("ADR response fixtures", () => {
  const detail = (fixture("adr.json") as { adr: Adr }).adr;

  it("hold content whose hash and parsed fields match the ADR", async () => {
    const content = detail.content ?? "";
    expect(await adrContentSha256(content)).toBe(detail.contentSha256);
    const parsed = parseAdrContent(content);
    expect(parsed.ok && parsed.adr).toMatchObject({
      title: detail.title,
      status: detail.status,
      date: detail.date,
      supersedes: detail.supersedes,
      warnings: detail.warnings,
    });
    expect(detail.warningCount).toBe(detail.warnings.length);
    expect(detail.path).toBe(`docs/adr/${padAdrNumber(detail.number)}-${detail.slug}.md`);
  });

  it("list the same ADRs as summaries, without content", () => {
    const page = fixture("adr-page.json") as { items: AdrSummary[]; lastSync: unknown };
    const { content: _, supersededBy: __, warnings: ___, ...summary } = detail;
    expect(page.items).toContainEqual(summary);
    expect(page.lastSync).toEqual((fixture("adr.json") as { lastSync: unknown }).lastSync);
    for (const item of page.items) {
      expect(accepts(adrSummarySchema, { ...item, content: detail.content })).toBe(false);
    }
  });

  it("show a reservation with no copy and a reservation of its own", () => {
    const reserved = (fixture("reserve-adr.json") as { adr: Adr }).adr;
    expect(reserved).toMatchObject({
      state: "reserved",
      path: null,
      status: null,
      date: null,
      supersedes: [],
      contentSha256: null,
      commitSha: null,
      syncedAt: null,
      content: null,
      reservationTaken: false,
      title: reserved.reservation?.title,
      slug: reserved.reservation?.slug,
    });
  });

  it("report upload problems per file", async () => {
    const upload = fixture("upload-adr-contents.json") as {
      files: Array<{ sha256: string; valid: boolean; errors: unknown[] }>;
    };
    expect(upload.files.map((file) => file.valid)).toEqual([true, false]);
    expect(upload.files[0]?.sha256).toBe(detail.contentSha256);
    expect(upload.files[1]?.errors).not.toEqual([]);
  });

  it("count a sync's changes as the adr.synced Event does", () => {
    const sync = fixture("sync-adrs.json") as {
      added: number;
      updated: number;
      removed: number;
      changes: Array<{ change: string }>;
    };
    const count = (...kinds: string[]) =>
      sync.changes.filter((change) => kinds.includes(change.change)).length;
    expect(sync.added).toBe(count("added", "restored"));
    expect(sync.updated).toBe(count("updated"));
    expect(sync.removed).toBe(count("removed"));
  });
});

describe("ADR CLI envelopes", () => {
  const data = (name: string) => (fixture(name) as { data: Record<string, unknown> }).data;

  it.each([
    ["cli.adr-new.json", "adr new"],
    ["cli.adr-list.json", "adr list"],
    ["cli.adr-show.json", "adr show"],
    ["cli.adr-status.json", "adr status"],
    ["cli.adr-supersede.json", "adr supersede"],
    ["cli.adr-sync.json", "adr sync"],
  ])("%s is a v1 %s envelope", (name, command) => {
    expect(fixture(name)).toMatchObject({ schemaVersion: 1, command, ok: true });
  });

  it("carry the API responses of list, new and show", () => {
    expect(data("cli.adr-list.json")).toEqual(fixture("adr-page.json"));
    const { file, ...reserve } = data("cli.adr-new.json");
    expect(reserve).toEqual(fixture("reserve-adr.json"));
    const reserved = (fixture("reserve-adr.json") as { adr: Adr }).adr;
    expect(file).toEqual({
      path: `docs/adr/${padAdrNumber(reserved.number)}-${reserved.slug}.md`,
      status: "created",
    });
    const { local, ...show } = data("cli.adr-show.json");
    expect(show).toEqual(fixture("adr.json"));
    expect(local).toEqual({ match: "differs", path: (show.adr as Adr).path });
  });

  const path = z.string().min(1);
  const localStatusSchema = cliEnvelopeSchema(
    z.strictObject({
      number: z.int(),
      path,
      status: adrStatusSchema,
      previousStatus: adrStatusSchema,
      date: z.iso.date(),
      changed: z.boolean(),
    }),
  );

  it("pin adr status and adr supersede, which make no server call", () => {
    expect(localStatusSchema.parse(fixture("cli.adr-status.json"))).toEqual(
      fixture("cli.adr-status.json"),
    );
    const supersede = cliEnvelopeSchema(
      z.strictObject({
        superseded: z.strictObject({
          number: z.int(),
          path,
          status: z.literal("superseded"),
          previousStatus: adrStatusSchema,
          date: z.iso.date(),
          changed: z.boolean(),
        }),
        superseding: z.strictObject({
          number: z.int(),
          path,
          supersedes: z.array(z.int()),
          changed: z.boolean(),
        }),
        changed: z.boolean(),
      }),
    );
    expect(supersede.parse(fixture("cli.adr-supersede.json"))).toEqual(
      fixture("cli.adr-supersede.json"),
    );
  });

  it("pin adr sync with the sync result's counts, changes and warnings", () => {
    const sync = cliEnvelopeSchema(
      z.strictObject({
        outcome: z.enum(["synced", "up_to_date", "already_synced_past", "dry_run", "checked"]),
        ref: z.string().nullable(),
        commitSha: z.string().nullable(),
        baseCommitSha: z.string().nullable(),
        forced: z.boolean(),
        fileCount: z.int(),
        uploadedFileCount: z.int(),
        added: z.int(),
        updated: z.int(),
        removed: z.int(),
        unchanged: z.int(),
        changes: z.array(adrChangeSchema),
        warnings: z.strictObject({ items: z.array(adrSyncWarningSchema), complete: z.boolean() }),
      }),
    );
    const value = fixture("cli.adr-sync.json");
    expect(sync.parse(value)).toEqual(value);
    const result = fixture("sync-adrs.json") as Record<string, unknown>;
    const cli = data("cli.adr-sync.json");
    for (const field of ["added", "updated", "removed", "unchanged", "changes", "warnings"]) {
      expect(cli[field]).toEqual(result[field]);
    }
    expect(cli.baseCommitSha).toBe(result.previousCommitSha);
  });
});

describe("ADR states and statuses", () => {
  it("keep the reservation lifecycle out of the status vocabulary", () => {
    expect([...ADR_STATES]).toEqual(["reserved", "published", "removed"]);
    expect(adrStatusSchema.options).toEqual([...ADR_STATUSES]);
    for (const state of ADR_STATES) expect(accepts(adrStatusSchema, state)).toBe(false);
    for (const status of ADR_STATUSES) expect(accepts(adrStateSchema, status)).toBe(false);
  });

  it("describe sync changes with the adr.synced Event's kinds", () => {
    expect(adrChangeSchema.shape.change.options).toEqual([...ADR_SYNC_CHANGE_KINDS]);
  });

  it("accept every parser code and later ones, but only ADR_ codes", () => {
    for (const code of [...ADR_ERROR_CODES, ...ADR_WARNING_CODES, "ADR_SHA256_MISMATCH"]) {
      expect(accepts(adrProblemSchema, { code, message: "m" })).toBe(true);
    }
    expect(ADR_WARNING_CODES).toContain("ADR_RESERVATION_TAKEN");
    for (const code of ["adr_section_missing", "SECTION_MISSING", "ADR_", ""]) {
      expect(accepts(adrProblemSchema, { code, message: "m" })).toBe(false);
    }
  });
});

describe("ADR inputs", () => {
  const reserve = { id: PROJECT_ID, adrId: UUID, title: "Use keyset pages", slug: "keyset" };

  it("list with the pagination idiom and the state and status filters", () => {
    expect(listAdrsInputSchema.parse({ id: PROJECT_ID, limit: "100" }).limit).toBe(100);
    expect(accepts(listAdrsInputSchema, { id: PROJECT_ID, status: "superseded" })).toBe(true);
    expect(accepts(listAdrsInputSchema, { id: PROJECT_ID, state: "removed" })).toBe(true);
    expect(accepts(listAdrsInputSchema, { id: PROJECT_ID, status: "reserved" })).toBe(false);
    expect(accepts(listAdrsInputSchema, { id: PROJECT_ID, state: "accepted" })).toBe(false);
  });

  it.each([
    [15, 15],
    ["15", 15],
    ["1", 1],
    ["9999", 9999],
  ])("get accepts the number %j", (number, parsed) => {
    expect(getAdrInputSchema.parse({ id: PROJECT_ID, number }).number).toBe(parsed);
  });

  it.each([0, 10_000, 1.5, "0", "015", "0015", "ADR-0015", "10000", "1e1", " 15", ""])(
    "get rejects the number %j",
    (number) => {
      expect(accepts(getAdrInputSchema, { id: PROJECT_ID, number })).toBe(false);
    },
  );

  it("reserve under a client UUID with a title that reads back as the H1", () => {
    expect(accepts(reserveAdrInputSchema, reserve)).toBe(true);
    const { adrId: _, ...withoutId } = reserve;
    expect(accepts(reserveAdrInputSchema, withoutId)).toBe(false);
    for (const title of ["Use C#", "Décision über 決定", "x".repeat(MAX_ADR_TITLE_LENGTH)]) {
      expect(accepts(reserveAdrInputSchema, { ...reserve, title })).toBe(true);
    }
    for (const title of [
      "",
      "   ",
      " Leading space",
      "Trailing space ",
      "Closing hashes ##",
      "#",
      "Tab\tinside",
      "Line\nbreak",
      "Escape \u001b[2J",
      "x".repeat(MAX_ADR_TITLE_LENGTH + 1),
    ]) {
      expect(accepts(newAdrTitleSchema, title)).toBe(false);
      expect(accepts(reserveAdrInputSchema, { ...reserve, title })).toBe(false);
    }
  });

  it("reserve with a valid slug, floor and Session, and nothing the server derives", () => {
    for (const slug of ["a", "adr-sync", "a".repeat(MAX_ADR_SLUG_LENGTH)]) {
      expect(accepts(reserveAdrInputSchema, { ...reserve, slug })).toBe(true);
    }
    for (const slug of ["", "Upper", "trailing-", "double--hyphen", "a".repeat(101), "é"]) {
      expect(accepts(reserveAdrInputSchema, { ...reserve, slug })).toBe(false);
    }
    for (const floor of [0, 17, MAX_ADR_NUMBER]) {
      expect(accepts(reserveAdrInputSchema, { ...reserve, floor })).toBe(true);
    }
    for (const floor of [-1, 10_000, 1.5, "17"]) {
      expect(accepts(reserveAdrInputSchema, { ...reserve, floor })).toBe(false);
    }
    const full = { ...reserve, gitBranch: "feat/adr", sessionId: SESSION_ID };
    expect(accepts(reserveAdrInputSchema, full)).toBe(true);
    for (const field of ["number", "reservedBy", "state", "principal"]) {
      expect(accepts(reserveAdrInputSchema, { ...reserve, [field]: 1 })).toBe(false);
    }
  });

  it("upload 1 to 50 distinct files of at most 65,536 code units", () => {
    const file = { sha256: SHA256, content: "x" };
    const files = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...file,
        sha256: i.toString(16).padStart(64, "0"),
      }));
    const upload = (value: unknown) => accepts(uploadAdrContentsInputSchema, value);
    expect(upload({ id: PROJECT_ID, files: files(1) })).toBe(true);
    expect(upload({ id: PROJECT_ID, files: files(MAX_ADR_CONTENT_BATCH_FILES) })).toBe(true);
    expect(upload({ id: PROJECT_ID, files: files(MAX_ADR_CONTENT_BATCH_FILES + 1) })).toBe(false);
    expect(upload({ id: PROJECT_ID, files: [] })).toBe(false);
    expect(upload({ id: PROJECT_ID, files: [file, file] })).toBe(false);
    // Empty and invalid content is the parser's to report, per file.
    expect(upload({ id: PROJECT_ID, files: [{ ...file, content: "" }] })).toBe(true);
    const longest = "x".repeat(MAX_ADR_CONTENT_LENGTH);
    expect(upload({ id: PROJECT_ID, files: [{ ...file, content: longest }] })).toBe(true);
    expect(upload({ id: PROJECT_ID, files: [{ ...file, content: `${longest}x` }] })).toBe(false);
    expect(upload({ id: PROJECT_ID, files: [{ ...file, sha256: "A".repeat(64) }] })).toBe(false);
    expect(upload({ id: PROJECT_ID, files: [{ ...file, path: "docs/adr/0001-a.md" }] })).toBe(
      false,
    );
  });

  const sync = {
    id: PROJECT_ID,
    commitSha: COMMIT,
    baseCommitSha: null,
    directory: "docs/adr",
    entries: [{ fileName: "0001-record-decisions.md", sha256: SHA256 }],
  };

  it("sync one commit against an explicit base", () => {
    expect(accepts(syncAdrsInputSchema, sync)).toBe(true);
    expect(accepts(syncAdrsInputSchema, { ...sync, entries: [] })).toBe(true);
    expect(accepts(syncAdrsInputSchema, { ...sync, baseCommitSha: "b".repeat(64) })).toBe(true);
    expect(accepts(syncAdrsInputSchema, { ...sync, forced: true, sessionId: SESSION_ID })).toBe(
      true,
    );
    const { baseCommitSha: _, ...withoutBase } = sync;
    expect(accepts(syncAdrsInputSchema, withoutBase)).toBe(false);
    for (const commitSha of ["HEAD", COMMIT.toUpperCase(), COMMIT.slice(0, 7), `${COMMIT}0`]) {
      expect(accepts(syncAdrsInputSchema, { ...sync, commitSha })).toBe(false);
    }
  });

  it.each([
    ["0001-record-decisions.md", true],
    ["9999-x.md", true],
    [`0015-${"a".repeat(MAX_ADR_SLUG_LENGTH)}.md`, true],
    [`0015-${"a".repeat(MAX_ADR_SLUG_LENGTH + 1)}.md`, false],
    ["0000-zero.md", false],
    ["00015-five-digits.md", false],
    ["015-three-digits.md", false],
    ["0015-Upper.md", false],
    ["0015-x.MD", false],
    ["0015-x", false],
    ["docs/adr/0015-x.md", false],
    ["README.md", false],
  ])("sync file name %j valid: %s", (fileName, valid) => {
    expect(accepts(syncAdrsInputSchema, { ...sync, entries: [{ fileName, sha256: SHA256 }] })).toBe(
      valid,
    );
  });

  it.each([
    ["docs/adr", true],
    ["services/api/docs/adr", true],
    ["a b/docs/adr", true],
    ["décisions/docs/adr", true],
    [`${"d".repeat(MAX_ADR_DIRECTORY_BYTES - 9)}/docs/adr`, true],
    [`${"d".repeat(MAX_ADR_DIRECTORY_BYTES - 8)}/docs/adr`, false],
    [`${WIDE.repeat(83)}/docs/adr`, false],
    ["/docs/adr", false],
    ["docs/adr/", false],
    ["docs/adrs", false],
    ["mydocs/adr", false],
    ["docs", false],
    ["a//docs/adr", false],
    ["./docs/adr", false],
    ["../docs/adr", false],
    ["a\\docs/adr", false],
    ["a\u0000/docs/adr", false],
    ["a\ud800/docs/adr", false],
    ["", false],
  ])("sync directory %j valid: %s", (directory, valid) => {
    expect(isAdrDirectory(directory)).toBe(valid);
    expect(accepts(syncAdrsInputSchema, { ...sync, directory })).toBe(valid);
  });

  it("sync at most 1,000 distinct file names", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        fileName: `${padAdrNumber(i + 1)}-adr.md`,
        sha256: SHA256,
      }));
    expect(accepts(syncAdrsInputSchema, { ...sync, entries: entries(MAX_ADR_SYNC_ENTRIES) })).toBe(
      true,
    );
    expect(
      accepts(syncAdrsInputSchema, { ...sync, entries: entries(MAX_ADR_SYNC_ENTRIES + 1) }),
    ).toBe(false);
    const entry = sync.entries[0];
    expect(accepts(syncAdrsInputSchema, { ...sync, entries: [entry, entry] })).toBe(false);
    // Two files with one number are the server's CONFLICT, not a schema error.
    expect(
      accepts(syncAdrsInputSchema, {
        ...sync,
        entries: [entry, { fileName: "0001-other-slug.md", sha256: SHA256 }],
      }),
    ).toBe(true);
  });
});

// The body limits must never reject a request the schemas accept and a
// client can build. JSON escapes `"` and `\` with 2 bytes; other characters
// a valid ADR may contain are written as their UTF-8 bytes, since the parser
// refuses the control characters JSON would write as 6-byte escapes.
describe("ADR request sizes", () => {
  it("fit the largest reservation in the 16 KiB management limit", () => {
    const body = {
      adrId: UUID,
      title: WIDE.repeat(MAX_ADR_TITLE_LENGTH),
      slug: "a".repeat(MAX_ADR_SLUG_LENGTH),
      floor: MAX_ADR_NUMBER,
      gitBranch: QUOTE.repeat(255),
      sessionId: SESSION_ID,
    };
    expect(accepts(reserveAdrInputSchema, { id: PROJECT_ID, ...body })).toBe(true);
    expect(jsonBytes(body)).toBeLessThan(MAX_MANAGEMENT_BODY_BYTES);
  });

  it("fit the largest sync manifest in one upload body", () => {
    const body = {
      commitSha: "c".repeat(64),
      baseCommitSha: "b".repeat(64),
      forced: true,
      directory: `${QUOTE.repeat(MAX_ADR_DIRECTORY_BYTES - 9)}/docs/adr`,
      entries: Array.from({ length: MAX_ADR_SYNC_ENTRIES }, (_, i) => ({
        fileName: `${padAdrNumber(i + 1)}-${"a".repeat(MAX_ADR_SLUG_LENGTH)}.md`,
        sha256: SHA256,
      })),
      sessionId: SESSION_ID,
    };
    expect(body.entries[0]?.fileName).toHaveLength(MAX_ADR_FILE_NAME_LENGTH);
    expect(accepts(syncAdrsInputSchema, { id: PROJECT_ID, ...body })).toBe(true);
    expect(jsonBytes(body)).toBeLessThan(MAX_ADR_UPLOAD_BODY_BYTES);
  });

  /** A valid ADR of exactly 64 KiB whose body is `filler` repeated. */
  function maximalFile(filler: string): string {
    const head = "---\nstatus: accepted\ndate: 2026-10-05\n---\n\n# Title\n\n## Context\n\n";
    const repeats = Math.floor(
      (MAX_ADR_FILE_BYTES - utf8ByteLength(head)) / utf8ByteLength(filler),
    );
    const content = head + filler.repeat(repeats);
    return content + "x".repeat(MAX_ADR_FILE_BYTES - utf8ByteLength(content));
  }

  it.each([
    ["quotes", QUOTE],
    ["backslashes", "\\"],
    ["line breaks and tabs", "\r\n\t"],
    ["three-byte characters", WIDE],
    ["four-byte characters", "🐝"],
    ["C1 controls and separators", "\u0085 ‮"],
  ])("fit a valid 64 KiB file of %s in one contents body", async (_name, filler) => {
    const content = maximalFile(filler);
    expect(utf8ByteLength(content)).toBe(MAX_ADR_FILE_BYTES);
    expect(parseAdrContent(content).ok).toBe(true);
    const body = { files: [{ sha256: await adrContentSha256(content), content }] };
    expect(accepts(uploadAdrContentsInputSchema, { id: PROJECT_ID, ...body })).toBe(true);
    expect(jsonBytes(body)).toBeLessThan(MAX_ADR_UPLOAD_BODY_BYTES);
  });

  it("refuse the 6-byte JSON escapes in the parser, before any upload", () => {
    expect(parseAdrContent(maximalFile("\u0001")).ok).toBe(false);
  });
});

// The CLI rejects a response over 4 MiB, so the largest valid ADR responses
// must fit.
describe("ADR response sizes", () => {
  const reserved = (fixture("reserve-adr.json") as { adr: Adr }).adr;
  const published = (fixture("adr.json") as { adr: Adr }).adr;
  const longestPath = `${QUOTE.repeat(MAX_ADR_DIRECTORY_BYTES - 9)}/docs/adr/0001-${"a".repeat(MAX_ADR_SLUG_LENGTH)}.md`;
  const problem = {
    code: "ADR_SUPERSEDES_MISSING_TARGET",
    message: WIDE.repeat(MAX_ADR_PROBLEM_MESSAGE_LENGTH),
  };
  const full = <T>(item: T, count: number) => Array.from({ length: count }, () => item);

  it("bound paths to a sync's directory and file name", () => {
    expect(longestPath).toHaveLength(MAX_ADR_PATH_LENGTH);
    expect(accepts(adrChangeSchema.shape.path, longestPath)).toBe(true);
    expect(accepts(adrChangeSchema.shape.path, `a${longestPath}`)).toBe(false);
  });

  const summary: AdrSummary = {
    ...(fixture("adr-page.json") as { items: AdrSummary[] }).items[1],
    title: WIDE.repeat(MAX_ADR_TITLE_LENGTH),
    path: longestPath,
    supersedes: full(MAX_ADR_NUMBER, MAX_ADR_SUPERSEDES),
    reservation: {
      ...(reserved.reservation as NonNullable<Adr["reservation"]>),
      title: WIDE.repeat(MAX_ADR_TITLE_LENGTH),
      gitBranch: QUOTE.repeat(255),
    },
  } as AdrSummary;

  it.each([
    [
      "ADR page",
      adrPageSchema,
      {
        items: full(summary, MAX_PAGE_LIMIT),
        nextCursor: "c".repeat(512),
        lastSync: (fixture("adr.json") as { lastSync: unknown }).lastSync,
      },
    ],
    [
      "ADR",
      getAdrOutputSchema,
      {
        adr: {
          ...published,
          ...summary,
          content: QUOTE.repeat(MAX_ADR_CONTENT_LENGTH),
          supersededBy: Array.from({ length: MAX_ADR_NUMBER }, (_, i) => i + 1),
          warnings: full(problem, MAX_ADR_WARNINGS),
        },
        lastSync: null,
      },
    ],
    [
      "upload result",
      uploadAdrContentsOutputSchema,
      {
        files: full(
          {
            sha256: SHA256,
            valid: false,
            created: false,
            errors: full(problem, MAX_ADR_PROBLEMS),
            warnings: full(problem, MAX_ADR_PROBLEMS),
          },
          MAX_ADR_CONTENT_BATCH_FILES,
        ),
      },
    ],
    [
      "sync result",
      syncAdrsOutputSchema,
      {
        ...(fixture("sync-adrs.json") as object),
        changes: full(
          {
            number: 1,
            change: "updated",
            path: longestPath,
            statusFrom: "accepted",
            statusTo: "superseded",
          },
          MAX_ADR_SYNC_CHANGES,
        ),
        warnings: {
          items: full({ number: 1, path: longestPath, ...problem }, MAX_ADR_SYNC_WARNINGS),
          complete: false,
        },
      },
    ],
  ] as const)("a maximal %s fits the CLI's 4 MiB limit", (_name, schema, value) => {
    expect(schema.safeParse(value).error).toBeUndefined();
    expect(jsonBytes(value)).toBeLessThan(CLI_MAX_RESPONSE_BYTES);
  });

  it("never put content in a list item", () => {
    expect(Object.keys(adrSummarySchema.shape)).not.toContain("content");
    expect(Object.keys(adrSchema.shape)).toContain("content");
    expect(accepts(reserveAdrOutputSchema, { adr: reserved, created: true })).toBe(true);
  });

  it("cite ADRs as ADR-NNNN in human text", () => {
    expect(formatAdrNumber(published.number)).toBe("ADR-0017");
  });
});
