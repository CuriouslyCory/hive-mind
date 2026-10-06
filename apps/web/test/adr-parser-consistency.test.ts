import {
  ADR_STATUSES,
  adrContentSha256,
  adrPageSchema,
  adrSummarySchema,
  getAdrOutputSchema,
  MAX_ADR_CONTENT_BATCH_FILES,
  MAX_ADR_PROBLEMS,
  MAX_ADR_SUPERSEDES,
  MAX_ADR_TITLE_LENGTH,
  MAX_PAGE_LIMIT,
  type ParsedAdrContent,
  parseAdrContent,
  renderAdrTemplate,
  syncAdrsOutputSchema,
  uploadAdrContentsOutputSchema,
} from "@hivemind/contract";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, type SignedInUser } from "./support/api";

// One property across the ADR layers (#19, ADR-0017): every file the parser
// accepts is one the upload route accepts, @hivemind/db stores, ADR sync
// applies and the read routes return within the contract's output schemas;
// every file it refuses, the upload route refuses with the parser's codes.
// Three review bugs were files the parser accepted and a later layer refused:
// a NUL (Postgres text), a title of only Unicode whitespace (storeAdrContents,
// so the upload answered 500) and a supersedes list longer than the output
// schema allows. The contents are ADR-0001's template with hostile edits from
// a seeded generator; ADR_PROPERTY_SEED=<n> runs another seed.

const SEED = Number(process.env.ADR_PROPERTY_SEED ?? 19);
const CASES = 600;

/** mulberry32: small, seedable, and the same sequence on every platform. */
function createRng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    int,
    chance: (probability: number) => next() < probability,
    pick<T>(items: readonly T[]): T {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    },
  };
}

type Rng = ReturnType<typeof createRng>;

function characters(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => String.fromCharCode(from + offset));
}

const CLASSES = {
  ascii: characters(0x20, 0x7e),
  "unicode whitespace": [
    "\u00a0",
    ...characters(0x2000, 0x200b),
    "\u2028",
    "\u2029",
    "\u3000",
    "\ufeff",
  ],
  // NUL on its own as well: Postgres text cannot store it.
  NUL: ["\u0000"],
  C0: characters(0x00, 0x1f),
  DEL: ["\u007f"],
  C1: characters(0x80, 0x9f),
  bidi: [
    "\u061c",
    "\u200e",
    "\u200f",
    ...characters(0x202a, 0x202e),
    ...characters(0x2066, 0x2069),
  ],
  "lone surrogate": [0xd800, 0xdbff, 0xdc00, 0xdfff].map((code) => String.fromCharCode(code)),
  astral: ["\u{1f600}", "\u{10000}", "\u{10ffff}", "\u{1d11e}", "\u{20000}"],
  markdown: ["#", "`", "```", "~~~", " #", "---"],
} satisfies Record<string, string[]>;

type CharacterClass = keyof typeof CLASSES;
const CLASS_NAMES = Object.keys(CLASSES) as CharacterClass[];
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Letters with `count` characters of `name` spread among them. */
function hostile(rng: Rng, name: CharacterClass, count: number): string {
  let text = "";
  for (let added = 0; added < count; ) {
    if (rng.chance(0.5)) {
      text += rng.pick(CLASSES[name]);
      added += 1;
    } else {
      text += rng.pick([...LETTERS]);
    }
  }
  return text;
}

// ADR-0001's template, split into the lines a case edits.
const TEMPLATE = (() => {
  const rendered = renderAdrTemplate({ title: "Placeholder", date: "2026-10-05" });
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
  const lines = rendered.contents.split("\n");
  const close = lines.indexOf("---", 1);
  const body = lines.slice(close + 1);
  const titleIndex = body.findIndex((line) => line.startsWith("# "));
  return {
    frontmatter: lines.slice(1, close),
    before: body.slice(0, titleIndex),
    after: body.slice(titleIndex + 1),
  };
})();

interface Draft {
  bom: string;
  closing: string;
  frontmatter: string[];
  before: string[];
  titlePrefix: string;
  title: string;
  after: string[];
  eol: "lf" | "crlf" | "mixed" | "cr";
}

interface Case {
  index: number;
  /** What was done to the template, for failure messages. */
  mutations: string[];
  content: string;
}

function generateTitle(rng: Rng): [string, string] {
  switch (rng.pick(["hostile", "hostile", "whitespace", "long", "hashes", "empty", "padded"])) {
    case "hostile": {
      const name = rng.pick(CLASS_NAMES);
      return [`title with ${name}`, `Title ${hostile(rng, name, rng.int(1, 4))} end`];
    }
    case "whitespace": {
      const count = rng.int(1, 5);
      const title = Array.from({ length: count }, () => rng.pick(CLASSES["unicode whitespace"]));
      return ["title of only unicode whitespace", title.join("")];
    }
    case "long": {
      const target = MAX_ADR_TITLE_LENGTH + rng.int(-3, 3);
      let title = "L";
      while (title.length < target) {
        title += rng.chance(0.2) ? rng.pick(CLASSES.astral) : rng.pick([...LETTERS]);
      }
      return [`title of ${title.length} code units`, title];
    }
    case "hashes": {
      const title = rng.pick(["Title ##", "##", "Title#", "Title \\#", "# Title", "Title #\u00a0"]);
      return [`title ${JSON.stringify(title)}`, title];
    }
    case "empty":
      return ["empty title", ""];
    default: {
      const space = rng.pick(CLASSES["unicode whitespace"]);
      return ["title padded with unicode whitespace", `${space}Title${space}`];
    }
  }
}

function generateSupersedes(rng: Rng): [string, string] {
  const count = rng.pick([
    1,
    2,
    5,
    MAX_ADR_SUPERSEDES - 1,
    MAX_ADR_SUPERSEDES,
    MAX_ADR_SUPERSEDES + 1,
    MAX_ADR_SUPERSEDES + 2,
    100,
  ]);
  const used = new Set<string>();
  const tokens: string[] = [];
  while (tokens.length < count) {
    const token = String(rng.chance(0.15) ? rng.pick([1, 2, 9998, 9999]) : rng.int(1, 9999));
    if (!used.has(token)) tokens.push(token);
    used.add(token);
  }
  let label = `supersedes with ${count} entries`;
  if (rng.chance(0.25)) {
    const flaw = rng.chance(0.3)
      ? (tokens[0] ?? "1")
      : rng.pick(["0", "10000", "01", "-1", "1.0", "", "0x10", "\u0661"]);
    tokens.splice(rng.int(0, tokens.length), 0, flaw);
    label += ` and ${JSON.stringify(flaw)}`;
  }
  const separator = rng.chance(0.8) ? ", " : rng.pick([",", " , ", ",\t", ",\u00a0"]);
  if (separator !== ", ") label += `, separated by ${JSON.stringify(separator)}`;
  let value = `[${tokens.join(separator)}]`;
  if (rng.chance(0.1)) {
    value = rng.pick(["[]", tokens.join(", "), `${value}\u00a0`, `${value} `]);
    label += `, written ${JSON.stringify(value.slice(0, 12))}…`;
  }
  return [label, `supersedes: ${value}`];
}

const MUTATIONS: Record<string, (rng: Rng, draft: Draft) => string> = {
  title(rng, draft) {
    const [label, title] = generateTitle(rng);
    draft.title = title;
    return label;
  },
  titleLine(rng, draft) {
    draft.titlePrefix = rng.pick([
      "#\t",
      "   # ",
      "    # ",
      "#",
      "####### ",
      "\u00a0# ",
      "\ufeff# ",
      "## ",
    ]);
    return `title line starts ${JSON.stringify(draft.titlePrefix)}`;
  },
  status(rng, draft) {
    const name = rng.pick(CLASS_NAMES);
    const value = rng.pick([
      ...ADR_STATUSES,
      "Proposed",
      "",
      "proposed ",
      "proposed\t",
      `proposed${hostile(rng, name, 1)}`,
    ]);
    draft.frontmatter[0] = `status: ${value}`;
    return `status ${JSON.stringify(value)}`;
  },
  date(rng, draft) {
    const value = rng.pick([
      "0001-01-01",
      "9999-12-31",
      "2000-02-29",
      "1900-02-29",
      "2024-02-29",
      "2024-02-30",
      "2026-13-01",
      "0000-01-01",
      "2026-1-5",
      "2026-10-05T00:00",
      `2026-10-05${rng.pick(CLASSES[rng.pick(CLASS_NAMES)])}`,
    ]);
    draft.frontmatter[1] = `date: ${value}`;
    return `date ${JSON.stringify(value)}`;
  },
  supersedes(rng, draft) {
    const [label, line] = generateSupersedes(rng);
    draft.frontmatter.push(line);
    return label;
  },
  frontmatterLine(rng, draft) {
    const name = rng.pick(CLASS_NAMES);
    const line = rng.pick([
      "author: someone",
      "status: accepted",
      " status: accepted",
      "",
      "# comment",
      "date:2026-10-05",
      hostile(rng, name, 2),
      "---",
      "--- ",
      "---\u00a0",
    ]);
    draft.frontmatter.splice(rng.int(0, draft.frontmatter.length), 0, line);
    return `frontmatter line ${JSON.stringify(line)}`;
  },
  bodyLine(rng, draft) {
    const name = rng.pick(CLASS_NAMES);
    const text = hostile(rng, name, rng.int(1, 6));
    const line = rng.chance(0.5)
      ? text
      : rng.pick([
          "---",
          "```",
          "~~~",
          "````js",
          "# Second title",
          "## Context",
          "`inline` code",
          "    # indented code",
        ]);
    const target = rng.chance(0.2) ? draft.before : draft.after;
    target.splice(rng.int(0, target.length), 0, line);
    const where = target === draft.before ? "line before the title" : "body line";
    return `${where}${line === text ? ` with ${name}` : ""} ${JSON.stringify(line)}`;
  },
  eol(rng, draft) {
    draft.eol = rng.pick(["crlf", "crlf", "mixed", "cr"]);
    return `${draft.eol} line endings`;
  },
  bom(rng, draft) {
    draft.bom = "\ufeff";
    if (rng.chance(0.3)) draft.closing = rng.pick(["--- ", "---\t", "----", " ---"]);
    return `BOM, closing line ${JSON.stringify(draft.closing)}`;
  },
  dropSection(rng, draft) {
    const sections = draft.after.filter((line) => line.startsWith("## "));
    if (sections.length === 0) return "without sections";
    const section = rng.pick(sections);
    draft.after.splice(draft.after.indexOf(section), 1);
    return `without ${JSON.stringify(section)}`;
  },
};

// Weights: titles and the supersedes list are where the parser and the later
// layers have disagreed.
const MUTATION_NAMES = [
  ...["title", "title", "title", "title", "supersedes", "supersedes"],
  ...["bodyLine", "bodyLine", "bodyLine"],
  ...["titleLine", "status", "date", "frontmatterLine", "eol", "bom", "dropSection"],
];

function generateCase(rng: Rng, index: number): Case {
  const draft: Draft = {
    bom: "",
    closing: "---",
    frontmatter: [...TEMPLATE.frontmatter],
    before: [...TEMPLATE.before],
    titlePrefix: "# ",
    title: "Generated decision",
    after: [...TEMPLATE.after],
    eol: "lf",
  };
  const mutations: string[] = [];
  const count = rng.pick([1, 1, 1, 1, 2, 2, 3]);
  for (let applied = 0; applied < count; applied++) {
    const mutate = MUTATIONS[rng.pick(MUTATION_NAMES)];
    if (mutate) mutations.push(mutate(rng, draft));
  }
  const lines = [
    "---",
    ...draft.frontmatter,
    draft.closing,
    ...draft.before,
    `${draft.titlePrefix}${draft.title}`,
    ...draft.after,
  ];
  let content = draft.bom;
  lines.forEach((line, position) => {
    if (position > 0) {
      const mode = draft.eol === "mixed" ? rng.pick(["lf", "crlf"] as const) : draft.eol;
      content += { lf: "\n", crlf: "\r\n", cr: "\r" }[mode];
    }
    content += line;
  });
  return { index, mutations, content };
}

function generateCases(seed: number): Case[] {
  const rng = createRng(seed);
  return Array.from({ length: CASES }, (_, index) => generateCase(rng, index));
}

/**
 * What the upload route must answer for `content`: the parser's verdict, plus
 * the route's own bound on supersedes (MAX_ADR_SUPERSEDES), which the parser
 * leaves to it (adr-api.ts).
 */
function expectedUpload(content: string): {
  valid: boolean;
  codes: string[];
  parsed?: ParsedAdrContent;
} {
  const parsed = parseAdrContent(content);
  if (!parsed.ok) {
    return {
      valid: false,
      codes: parsed.errors.slice(0, MAX_ADR_PROBLEMS).map((error) => error.code),
    };
  }
  if (parsed.adr.supersedes.length > MAX_ADR_SUPERSEDES) {
    return { valid: false, codes: ["ADR_SUPERSEDES_INVALID"] };
  }
  return { valid: true, codes: [], parsed: parsed.adr };
}

function describeCase(entry: Case): string {
  const mutations = entry.mutations.length > 0 ? entry.mutations.join("; ") : "the template";
  // Every character outside printable ASCII escaped, so none is invisible.
  const content = JSON.stringify(entry.content).replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `seed ${SEED}, case ${entry.index} (${mutations}), content ${content}`;
}

describe("the ADR content generator", () => {
  // Files the parser once accepted and a later layer refused: each must
  // appear with no other error, or the property cannot catch its return.
  it("covers the three classes of file the parser once let through", () => {
    const cases = generateCases(SEED).map((entry) => {
      const parsed = parseAdrContent(entry.content);
      return { entry, parsed, codes: parsed.ok ? [] : parsed.errors.map((error) => error.code) };
    });
    const only = (code: string) => (codes: string[]) => codes.length === 1 && codes[0] === code;
    const blankTitles = cases.filter(
      ({ entry, codes }) =>
        entry.mutations.includes("title of only unicode whitespace") &&
        only("ADR_TITLE_MISSING")(codes),
    );
    const nuls = cases.filter(
      ({ entry, codes }) =>
        only("ADR_CONTROL_CHARACTER")(codes) &&
        entry.content.includes("\u0000") &&
        parseAdrContent(entry.content.replaceAll("\u0000", "")).ok,
    );
    const longSupersedes = cases.filter(
      ({ parsed }) => parsed.ok && parsed.adr.supersedes.length > MAX_ADR_SUPERSEDES,
    );
    expect(
      [blankTitles.length, nuls.length, longSupersedes.length].map((count) => count > 0),
      `seed ${SEED}: blank titles, NULs, supersedes over ${MAX_ADR_SUPERSEDES}`,
    ).toEqual([true, true, true]);
  });
});

describeDb("ADR files across the parser, the upload route, ADR sync and the read routes", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let projectId: string;

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    projectId = await api.createProject(owner);
  });

  afterAll(async () => {
    await api?.drop();
  });

  let commits = 0;
  /** A distinct full commit hash per sync. */
  const nextCommit = () => (++commits).toString(16).padStart(40, "0");

  async function upload(files: { sha256: string; entry: Case }[]) {
    return api.request(`/projects/${projectId}/adrs/contents`, {
      token: owner.token,
      body: { files: files.map(({ sha256, entry }) => ({ sha256, content: entry.content })) },
    });
  }

  async function sync(
    entries: { fileName: string; sha256: string }[],
    baseCommitSha: string | null,
  ) {
    const commitSha = nextCommit();
    const response = await api.request(`/projects/${projectId}/adrs/sync`, {
      token: owner.token,
      body: { commitSha, baseCommitSha, directory: "docs/adr", entries },
    });
    return { commitSha, response };
  }

  it("agree on every generated file", async () => {
    const failures: string[] = [];
    const fail = (entry: Case | null, problem: string) => {
      failures.push(entry ? `${problem} — ${describeCase(entry)}` : `seed ${SEED}: ${problem}`);
    };

    // Equal contents have one sha256, which one upload may list only once.
    const cases = new Map<string, Case>();
    for (const entry of generateCases(SEED)) {
      if (!cases.has(entry.content)) cases.set(entry.content, entry);
    }
    const hashed = await Promise.all(
      [...cases.values()].map(async (entry) => ({
        entry,
        sha256: await adrContentSha256(entry.content),
      })),
    );

    // 1. Upload: the parser's verdict, never a 500.
    const accepted: { entry: Case; sha256: string; parsed: ParsedAdrContent }[] = [];
    const check = (
      file: (typeof hashed)[number],
      result: { valid: boolean; errors: { code: string }[] },
    ) => {
      const expected = expectedUpload(file.entry.content);
      const codes = result.errors.map((error) => error.code);
      if (
        result.valid !== expected.valid ||
        JSON.stringify(codes) !== JSON.stringify(expected.codes)
      ) {
        fail(
          file.entry,
          `expected ${expected.valid ? "valid" : `invalid ${expected.codes.join(", ")}`}, the upload route says ${result.valid ? "valid" : `invalid ${codes.join(", ")}`}`,
        );
      }
      if (result.valid && expected.parsed) accepted.push({ ...file, parsed: expected.parsed });
    };
    for (let start = 0; start < hashed.length; start += MAX_ADR_CONTENT_BATCH_FILES) {
      const batch = hashed.slice(start, start + MAX_ADR_CONTENT_BATCH_FILES);
      const response = await upload(batch);
      if (response.status === 200) {
        const body = uploadAdrContentsOutputSchema.safeParse(await response.json());
        if (!body.success) {
          fail(null, `the upload answer does not match its schema: ${body.error.message}`);
          continue;
        }
        batch.forEach((file, position) => {
          const result = body.data.files[position];
          if (result) check(file, result);
          else fail(file.entry, "the upload result has no entry for this file");
        });
        continue;
      }
      // One file can fail a whole upload: upload them one at a time to name it.
      for (const file of batch) {
        const single = await upload([file]);
        if (single.status !== 200) {
          fail(
            file.entry,
            `the upload answered ${single.status}: ${(await single.text()).slice(0, 300)}`,
          );
          continue;
        }
        const result = uploadAdrContentsOutputSchema.parse(await single.json()).files[0];
        if (result) check(file, result);
      }
    }

    // 2. ADR sync of every accepted file, each under its own number.
    const byNumber = new Map(accepted.map((file, position) => [position + 1, file]));
    const entries = [...byNumber].map(([number, file]) => ({
      fileName: `${String(number).padStart(4, "0")}-case-${file.entry.index}.md`,
      sha256: file.sha256,
    }));
    const { response } = await sync(entries, null);
    if (response.status === 200) {
      const parsed = syncAdrsOutputSchema.safeParse(await response.json());
      if (!parsed.success)
        fail(null, `the sync answer does not match its schema: ${parsed.error.message}`);
    } else {
      fail(null, `the sync of all ${entries.length} accepted files answered ${response.status}`);
      // The sync is all or nothing: sync the files one at a time to name one.
      let base: string | null = null;
      for (const [position, entry] of entries.entries()) {
        const single = await sync([entry], base);
        const file = accepted[position];
        if (single.response.status === 200) base = single.commitSha;
        else if (file) {
          fail(
            file.entry,
            `the sync answered ${single.response.status}: ${(await single.response.text()).slice(0, 300)}`,
          );
        }
      }
    }

    // 3. The ADR list, every page within adrPageSchema.
    const listed = new Set<number>();
    let cursor: string | null = null;
    do {
      const query = `?limit=${MAX_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await api.request(`/projects/${projectId}/adrs${query}`, { token: owner.token });
      if (page.status !== 200) {
        fail(
          null,
          `GET /adrs${query} answered ${page.status}: ${(await page.text()).slice(0, 300)}`,
        );
        break;
      }
      const raw = (await page.json()) as {
        items?: { number?: number }[];
        nextCursor?: string | null;
      };
      const parsed = adrPageSchema.safeParse(raw);
      if (!parsed.success) {
        // Name the files whose items do not match.
        for (const item of raw.items ?? []) {
          const problem = adrSummarySchema.safeParse(item);
          const file = byNumber.get(item.number ?? 0);
          if (!problem.success && file)
            fail(
              file.entry,
              `GET /adrs lists it outside adrSummarySchema: ${problem.error.message}`,
            );
        }
        fail(
          null,
          `GET /adrs${query} does not match adrPageSchema: ${parsed.error.message.slice(0, 500)}`,
        );
      }
      for (const item of raw.items ?? []) if (item.number) listed.add(item.number);
      cursor = raw.nextCursor ?? null;
    } while (cursor);

    // 4. Each ADR within getAdrOutputSchema, with what the parser read.
    for (const [number, file] of byNumber) {
      if (!listed.has(number)) fail(file.entry, `ADR ${number} is missing from GET /adrs`);
      const response = await api.request(`/projects/${projectId}/adrs/${number}`, {
        token: owner.token,
      });
      if (response.status !== 200) {
        fail(
          file.entry,
          `GET /adrs/${number} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
        continue;
      }
      const parsed = getAdrOutputSchema.safeParse(await response.json());
      if (!parsed.success) {
        fail(
          file.entry,
          `GET /adrs/${number} does not match getAdrOutputSchema: ${parsed.error.message}`,
        );
        continue;
      }
      const { adr } = parsed.data;
      const read = {
        title: adr.title,
        status: adr.status,
        date: adr.date,
        supersedes: adr.supersedes,
        content: adr.content,
      };
      const want = { ...file.parsed, content: file.entry.content };
      for (const key of ["title", "status", "date", "supersedes", "content"] as const) {
        if (JSON.stringify(read[key]) !== JSON.stringify(want[key])) {
          fail(
            file.entry,
            `GET /adrs/${number} returns ${key} ${JSON.stringify(read[key])}, the parser read ${JSON.stringify(want[key])}`,
          );
        }
      }
    }
    expect(
      failures.slice(0, 10),
      `${failures.length} ADR files where the parser and a later layer disagree (seed ${SEED}; rerun with ADR_PROPERTY_SEED=${SEED})`,
    ).toEqual([]);
    expect(accepted.length, `seed ${SEED}: too few generated files are valid`).toBeGreaterThan(
      CASES / 5,
    );
  });
});
