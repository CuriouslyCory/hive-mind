import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADR_ERROR_CODES,
  ADR_WARNING_CODES,
  type AdrSetEntry,
  type AdrStatus,
  adrContentSha256,
  adrFileName,
  adrFilePath,
  formatAdrNumber,
  MAX_ADR_FILE_BYTES,
  MAX_ADR_TITLE_LENGTH,
  padAdrNumber,
  parseAdrContent,
  parseAdrFile,
  parseAdrFileName,
  parseAdrIdentifier,
  renderAdrTemplate,
  rewriteAdrFrontmatter,
  serializeAdrFrontmatter,
  slugifyAdrTitle,
  validateAdrSet,
} from "../src/index.ts";

// fileURLToPath, not URL.pathname: pathname keeps percent-encoding.
const adrDirectory = fileURLToPath(new URL("../../../docs/adr/", import.meta.url));

const encoder = new TextEncoder();

const FRONTMATTER = "---\nstatus: accepted\ndate: 2026-10-05\n---\n";
const BODY = [
  "",
  "# A decision",
  "",
  "## Context",
  "",
  "Why.",
  "",
  "## Decision",
  "",
  "What.",
  "",
  "## Consequences",
  "",
  "Effects.",
  "",
].join("\n");
const VALID = FRONTMATTER + BODY;

/** A file with the given frontmatter lines and the standard body. */
function withFrontmatter(...lines: string[]): string {
  return `---\n${lines.map((line) => `${line}\n`).join("")}---\n${BODY}`;
}

/** A file with the standard frontmatter and the given body lines. */
function withBody(...lines: string[]): string {
  return FRONTMATTER + lines.join("\n");
}

function errorCodes(contents: string | Uint8Array): string[] {
  const result = parseAdrContent(contents);
  return result.ok ? [] : result.errors.map((error) => error.code);
}

function titleOf(contents: string | Uint8Array): string | undefined {
  const result = parseAdrContent(contents);
  return result.ok ? result.adr.title : undefined;
}

function parsed(contents: string | Uint8Array) {
  const result = parseAdrContent(contents);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.adr;
}

describe("the repository's ADRs", () => {
  const fileNames = readdirSync(adrDirectory).sort();

  it("finds the ADR files", () => {
    expect(fileNames.length).toBeGreaterThanOrEqual(16);
  });

  it.each(fileNames)("%s parses with no errors or warnings", (fileName) => {
    const result = parseAdrFile(fileName, readFileSync(join(adrDirectory, fileName)));
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok && result.adr.warnings).toEqual([]);
  });

  it("parses ADR-0001 as accepted with its real title, not the template's", () => {
    const result = parseAdrFile(
      "0001-record-architecture-decisions.md",
      readFileSync(join(adrDirectory, "0001-record-architecture-decisions.md")),
    );
    expect(result.ok && result.adr).toMatchObject({
      number: 1,
      slug: "record-architecture-decisions",
      status: "accepted",
      date: "2026-09-29",
      supersedes: [],
      title: "Record architecture decisions as repo files",
    });
  });

  it("parses ADR-0014, which is larger than 16 KiB", () => {
    const fileName = fileNames.find((name) => name.startsWith("0014-")) ?? "";
    const bytes = readFileSync(join(adrDirectory, fileName));
    expect(bytes.byteLength).toBeGreaterThan(16 * 1024);
    expect(parseAdrFile(fileName, bytes).ok).toBe(true);
  });

  it("has a consistent supersedes graph", () => {
    const entries = fileNames.map((fileName) => {
      const result = parseAdrFile(fileName, readFileSync(join(adrDirectory, fileName)));
      if (!result.ok) throw new Error(fileName);
      return { ...result.adr, path: `docs/adr/${fileName}` };
    });
    expect(validateAdrSet(entries)).toEqual({ errors: [], warnings: [] });
  });

  it("rewrites each file's frontmatter unchanged when nothing changes", () => {
    for (const fileName of fileNames) {
      const bytes = readFileSync(join(adrDirectory, fileName));
      const result = rewriteAdrFrontmatter(bytes, {});
      expect(result.ok && Buffer.compare(encoder.encode(result.contents), bytes)).toBe(0);
    }
  });
});

describe("parseAdrFileName", () => {
  it("reads the number and slug", () => {
    expect(parseAdrFileName("0015-adr-numbers-and-repo-sync.md")).toEqual({
      ok: true,
      number: 15,
      slug: "adr-numbers-and-repo-sync",
    });
    expect(parseAdrFileName("9999-x.md")).toMatchObject({ ok: true, number: 9999 });
    expect(parseAdrFileName("0002-m4.md")).toMatchObject({ ok: true, number: 2, slug: "m4" });
    expect(parseAdrFileName(`0001-${"a".repeat(100)}.md`).ok).toBe(true);
  });

  it.each([
    "0000-zero.md",
    "00015-five-digits.md",
    "015-three-digits.md",
    "0015-Uppercase.md",
    "0015-adr-sync.MD",
    "0015-.md",
    "0015-a--b.md",
    "0015-a-.md",
    "0015-a_b.md",
    "0015-a b.md",
    "0015-adr.md.bak",
    "docs/adr/0015-adr.md",
    "README.md",
    "template.md",
    `0001-${"a".repeat(101)}.md`,
  ])("rejects %s", (fileName) => {
    const result = parseAdrFileName(fileName);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("ADR_FILE_NAME_INVALID");
  });

  it("reports a bad name and bad contents together", () => {
    const result = parseAdrFile("0000-x.md", withFrontmatter("status: draft", "date: 2026-10-05"));
    expect(!result.ok && result.errors.map((error) => error.code)).toEqual([
      "ADR_FILE_NAME_INVALID",
      "ADR_STATUS_INVALID",
    ]);
  });
});

describe("parseAdrContent", () => {
  it("parses a valid file", () => {
    expect(parseAdrContent(VALID)).toEqual({
      ok: true,
      adr: {
        status: "accepted",
        date: "2026-10-05",
        supersedes: [],
        title: "A decision",
        body: BODY,
        warnings: [],
      },
    });
  });

  it("accepts bytes and strings alike", () => {
    expect(parseAdrContent(encoder.encode(VALID))).toEqual(parseAdrContent(VALID));
  });

  describe("line endings and BOM", () => {
    const crlf = VALID.replaceAll("\n", "\r\n");

    it("accepts CRLF and keeps the body's CRLF", () => {
      const adr = parsed(crlf);
      expect(adr).toMatchObject({ status: "accepted", date: "2026-10-05", title: "A decision" });
      expect(adr.body).toBe(BODY.replaceAll("\n", "\r\n"));
      expect(adr.warnings).toEqual([]);
    });

    it("accepts a BOM in bytes and in a string", () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(VALID)]);
      expect(parsed(bom)).toEqual(parsed(VALID));
      expect(parsed(`\uFEFF${VALID}`)).toEqual(parsed(VALID));
      expect(parsed(`\uFEFF${crlf}`).title).toBe("A decision");
    });

    it("accepts a BOM only once, at the start", () => {
      expect(errorCodes(`\uFEFF\uFEFF${VALID}`)).toEqual(["ADR_FRONTMATTER_MISSING"]);
    });
  });

  describe("frontmatter position", () => {
    it.each([
      ["a blank first line", `\n${VALID}`],
      ["a leading space", ` ${VALID}`],
      ["a heading first", `# Title\n\n${VALID}`],
      ["no frontmatter", BODY],
      ["an empty file", ""],
      ["a `---` block later in the file", `# Title\n\n${FRONTMATTER}\n## Context\n`],
      ["a YAML document marker", `---\n${VALID}`.replace("---\n---", "--- yaml\n---")],
    ])("rejects %s", (_name, contents) => {
      expect(errorCodes(contents)).toEqual(["ADR_FRONTMATTER_MISSING"]);
    });

    it("rejects unterminated frontmatter", () => {
      expect(errorCodes("---\nstatus: accepted\ndate: 2026-10-05\n\n# Title\n")).toEqual([
        "ADR_FRONTMATTER_UNTERMINATED",
      ]);
      expect(errorCodes("---")).toEqual(["ADR_FRONTMATTER_UNTERMINATED"]);
    });

    it("ignores `---` blocks after the frontmatter", () => {
      const adr = parsed(
        withBody(BODY, "---", "status: deprecated", "date: 2020-01-01", "---", ""),
      );
      expect(adr).toMatchObject({ status: "accepted", date: "2026-10-05", title: "A decision" });
    });

    it("accepts trailing spaces on the delimiter lines", () => {
      expect(parsed(`--- \nstatus: accepted\ndate: 2026-10-05\n---\t${BODY}`).status).toBe(
        "accepted",
      );
    });
  });

  describe("frontmatter keys", () => {
    it("reads supersedes", () => {
      expect(
        parsed(withFrontmatter("status: accepted", "date: 2026-10-05", "supersedes: [4]")),
      ).toMatchObject({ supersedes: [4] });
      expect(
        parsed(withFrontmatter("status: accepted", "date: 2026-10-05", "supersedes: [ 7 ,\t4 ]")),
      ).toMatchObject({ supersedes: [7, 4] });
      expect(
        parsed(withFrontmatter("supersedes: [9999]", "date: 2026-10-05", "status: accepted")),
      ).toMatchObject({ supersedes: [9999] });
    });

    it.each([
      "[0008]",
      "[08]",
      "[]",
      "[ ]",
      "[0]",
      "[10000]",
      "[-1]",
      "[+4]",
      "[4.0]",
      "[1e3]",
      "[4,]",
      "[4,,7]",
      "[4, 4]",
      "4",
      "[4",
      "4]",
      "[[4]]",
      "['4']",
      "",
      "- 4",
    ])("rejects supersedes: %s", (value) => {
      expect(
        errorCodes(withFrontmatter("status: accepted", "date: 2026-10-05", `supersedes: ${value}`)),
      ).toEqual(["ADR_SUPERSEDES_INVALID"]);
    });

    it("rejects an unknown key", () => {
      expect(
        errorCodes(withFrontmatter("status: accepted", "date: 2026-10-05", "title: X")),
      ).toEqual(["ADR_FRONTMATTER_UNKNOWN_KEY"]);
      expect(errorCodes(withFrontmatter("Status: accepted", "date: 2026-10-05"))).toEqual([
        "ADR_FRONTMATTER_UNKNOWN_KEY",
        "ADR_STATUS_MISSING",
      ]);
      expect(errorCodes(withFrontmatter("status : accepted", "date: 2026-10-05"))).toEqual([
        "ADR_FRONTMATTER_UNKNOWN_KEY",
        "ADR_STATUS_MISSING",
      ]);
    });

    it("rejects a duplicate key", () => {
      expect(
        errorCodes(withFrontmatter("status: accepted", "date: 2026-10-05", "status: proposed")),
      ).toEqual(["ADR_FRONTMATTER_DUPLICATE_KEY"]);
      expect(
        errorCodes(
          withFrontmatter(
            "status: accepted",
            "date: 2026-10-05",
            "supersedes: [4]",
            "supersedes: [5]",
          ),
        ),
      ).toEqual(["ADR_FRONTMATTER_DUPLICATE_KEY"]);
    });

    it("rejects a missing status or date", () => {
      expect(errorCodes(withFrontmatter("date: 2026-10-05"))).toEqual(["ADR_STATUS_MISSING"]);
      expect(errorCodes(withFrontmatter("status: accepted"))).toEqual(["ADR_DATE_MISSING"]);
      expect(errorCodes(withFrontmatter())).toEqual(["ADR_STATUS_MISSING", "ADR_DATE_MISSING"]);
    });

    it.each(["draft", "Accepted", '"accepted"', "'accepted'", "accepted # comment", ""])(
      "rejects status: %s",
      (value) => {
        expect(errorCodes(withFrontmatter(`status: ${value}`, "date: 2026-10-05"))).toEqual([
          "ADR_STATUS_INVALID",
        ]);
      },
    );

    it.each(["accepted", "proposed", "superseded", "deprecated"])("accepts status: %s", (value) => {
      expect(parsed(withFrontmatter(`status: ${value}`, "date: 2026-10-05")).status).toBe(value);
    });

    it.each([
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-10-00",
      "2026-1-05",
      "26-10-05",
      "0000-01-01",
      "2025-02-29",
      "1900-02-29",
      "'2026-10-05'",
      "2026-10-05T00:00:00Z",
      "2026/10/05",
      "",
    ])("rejects date: %s", (value) => {
      expect(errorCodes(withFrontmatter("status: accepted", `date: ${value}`))).toEqual([
        "ADR_DATE_INVALID",
      ]);
    });

    it.each(["2024-02-29", "2000-02-29", "2026-12-31", "0001-01-01"])(
      "accepts date: %s",
      (value) => {
        expect(parsed(withFrontmatter("status: accepted", `date: ${value}`)).date).toBe(value);
      },
    );
  });

  describe("whitespace", () => {
    it("accepts tabs after the colon, trailing blanks and blank lines", () => {
      const adr = parsed(withFrontmatter("status:\taccepted", "", "date:  2026-10-05 \t", "   "));
      expect(adr).toMatchObject({ status: "accepted", date: "2026-10-05" });
    });

    it.each([
      ["no space after the colon", "status:accepted"],
      ["an indented key", "  status: accepted"],
      ["a tab-indented key", "\tstatus: accepted"],
      ["a comment line", "# comment"],
      ["a list item", "- accepted"],
      ["a line without a colon", "accepted"],
    ])("rejects %s", (_name, line) => {
      expect(errorCodes(withFrontmatter(line, "status: accepted", "date: 2026-10-05"))[0]).toBe(
        "ADR_FRONTMATTER_INVALID",
      );
    });

    it("reads ATX headings the CommonMark way", () => {
      expect(titleOf(withBody("#\tTabbed title"))).toBe("Tabbed title");
      expect(titleOf(withBody("   # Three spaces"))).toBe("Three spaces");
      expect(titleOf(withBody("# Closed #"))).toBe("Closed");
      expect(titleOf(withBody("# Closed ###   "))).toBe("Closed");
      expect(titleOf(withBody("# C#"))).toBe("C#");
      expect(titleOf(withBody("#   Spaced   title   "))).toBe("Spaced   title");
      expect(titleOf(withBody("## Context", "# Late title"))).toBe("Late title");
      expect(titleOf(withBody("# First", "# Second"))).toBe("First");
    });

    it.each([
      ["no space after #", "#Title"],
      ["four spaces of indentation", "    # Title"],
      ["a tab before #", "\t# Title"],
      ["a non-breaking space after #", "#\u00a0Title"],
      ["an H2 only", "## Title"],
      ["an empty H1", "#"],
      ["an H1 of closing hashes", "# ###"],
      ["seven #s", "####### Title"],
      ["a setext heading", "Title\n====="],
    ])("does not take a title from %s", (_name, line) => {
      expect(errorCodes(withBody(line, ""))).toEqual(["ADR_TITLE_MISSING"]);
    });
  });

  describe("fenced code", () => {
    it.each([
      ["a backtick fence", ["```", "# Fenced", "```"]],
      ["a tilde fence", ["~~~", "# Fenced", "~~~"]],
      ["a fence with an info string", ["```markdown", "# Fenced", "```"]],
      ["an indented fence", ["   ```", "# Fenced", "  ```"]],
      ["a longer closing fence", ["```", "# Fenced", "`````"]],
      ["a fence that never closes", ["```", "# Fenced"]],
      ["a shorter run that does not close", ["````", "```", "# Fenced", "````"]],
      ["the other marker that does not close", ["~~~", "```", "# Fenced", "~~~"]],
      ["a closing fence with text that does not close", ["```", "``` not a close", "# Fenced"]],
    ])("ignores an H1 inside %s", (_name, lines) => {
      expect(errorCodes(withBody(...lines, ""))).toEqual(["ADR_TITLE_MISSING"]);
    });

    it("finds the title after a fence closes", () => {
      expect(titleOf(withBody("```", "# Fenced", "```", "# Real", ""))).toBe("Real");
      expect(titleOf(withBody("````", "```", "# Fenced", "````", "# Real", ""))).toBe("Real");
    });

    it("does not treat a backtick run with a backtick in its info string as a fence", () => {
      expect(titleOf(withBody("``` a ` b", "# Real", ""))).toBe("Real");
    });

    it("does not treat four-space-indented backticks as a fence", () => {
      expect(titleOf(withBody("    ```", "# Real", ""))).toBe("Real");
    });

    it("ignores sections inside fences", () => {
      const adr = parsed(
        withBody(
          "# Title",
          "```",
          "## Consequences",
          "## Decision",
          "## Context",
          "```",
          "## Context",
          "## Decision",
          "## Consequences",
          "",
        ),
      );
      expect(adr.warnings).toEqual([]);
    });
  });

  describe("title", () => {
    it("keeps markdown and HTML in the title as plain text", () => {
      const title = "Use <script>alert(1)</script>, **bold**, `code` & [a link](javascript:x)";
      expect(titleOf(withBody(`# ${title}`, ""))).toBe(title);
    });

    it("limits the title to 200 characters", () => {
      expect(titleOf(withBody(`# ${"x".repeat(MAX_ADR_TITLE_LENGTH)}`))).toHaveLength(200);
      expect(errorCodes(withBody(`# ${"x".repeat(MAX_ADR_TITLE_LENGTH + 1)}`))).toEqual([
        "ADR_TITLE_INVALID",
      ]);
    });

    it("rejects control characters in the title", () => {
      expect(errorCodes(withBody("# Ring \u0007 bell"))).toEqual(["ADR_TITLE_INVALID"]);
      expect(errorCodes(withBody("# Escape \u001b[31m red"))).toEqual(["ADR_TITLE_INVALID"]);
      expect(errorCodes(withBody("# Tab\tinside"))).toEqual(["ADR_TITLE_INVALID"]);
    });

    it("reports every error at once", () => {
      expect(
        errorCodes(`---\nstatus: draft\ndate: 2026-02-30\nowner: me\n---\n\nNo title.\n`),
      ).toEqual([
        "ADR_FRONTMATTER_UNKNOWN_KEY",
        "ADR_STATUS_INVALID",
        "ADR_DATE_INVALID",
        "ADR_TITLE_MISSING",
      ]);
    });
  });

  describe("sections", () => {
    function warningCodes(...lines: string[]): string[] {
      return parsed(withBody("# Title", ...lines, "")).warnings.map((warning) => warning.code);
    }

    it("accepts the optional section and extra H2s", () => {
      expect(
        warningCodes(
          "## Context",
          "## Notes",
          "## Decision",
          "## Consequences",
          "## Alternatives considered",
        ),
      ).toEqual([]);
    });

    it("warns about each missing section", () => {
      expect(warningCodes("## Context", "## Decision")).toEqual(["ADR_SECTION_MISSING"]);
      expect(warningCodes()).toEqual([
        "ADR_SECTION_MISSING",
        "ADR_SECTION_MISSING",
        "ADR_SECTION_MISSING",
      ]);
      expect(warningCodes("### Context", "## Decision", "## Consequences")).toEqual([
        "ADR_SECTION_MISSING",
      ]);
    });

    it("warns about sections out of order", () => {
      expect(warningCodes("## Decision", "## Context", "## Consequences")).toEqual([
        "ADR_SECTION_ORDER",
      ]);
      expect(
        warningCodes("## Context", "## Alternatives considered", "## Decision", "## Consequences"),
      ).toEqual(["ADR_SECTION_ORDER"]);
    });
  });

  describe("encoding and size", () => {
    it("rejects bytes that are not UTF-8", () => {
      const valid = encoder.encode(VALID);
      const at = valid.indexOf(encoder.encode("Why.")[0] ?? 0);
      for (const bad of [[0xff], [0xc3], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf8, 0x88, 0x80]]) {
        const bytes = new Uint8Array([...valid.slice(0, at), ...bad, ...valid.slice(at)]);
        expect(errorCodes(bytes)).toEqual(["ADR_NOT_UTF8"]);
      }
      expect(errorCodes(new Uint8Array([0xfe, 0xff, 0x00, 0x2d]))).toEqual(["ADR_NOT_UTF8"]);
    });

    it("rejects a string with a lone surrogate", () => {
      expect(errorCodes(withBody("# Title \ud800", ""))).toEqual(["ADR_NOT_UTF8"]);
    });

    it("accepts multi-byte UTF-8", () => {
      expect(titleOf(withBody("# Décision über 決定 🐝", ""))).toBe("Décision über 決定 🐝");
    });

    function padded(bytes: number): string {
      const filler = bytes - encoder.encode(`${VALID}\n`).byteLength;
      return `${VALID}${"x".repeat(filler)}\n`;
    }

    it("accepts exactly 64 KiB and rejects one byte more", () => {
      expect(encoder.encode(padded(MAX_ADR_FILE_BYTES)).byteLength).toBe(65_536);
      expect(parseAdrContent(padded(MAX_ADR_FILE_BYTES)).ok).toBe(true);
      expect(parseAdrContent(encoder.encode(padded(MAX_ADR_FILE_BYTES))).ok).toBe(true);
      expect(errorCodes(padded(65_537))).toEqual(["ADR_TOO_LARGE"]);
      expect(errorCodes(encoder.encode(padded(65_537)))).toEqual(["ADR_TOO_LARGE"]);
    });

    it("measures a string's size in UTF-8 bytes, not characters", () => {
      const contents = withBody("# Title", "€".repeat(22_000));
      expect(contents.length).toBeLessThan(MAX_ADR_FILE_BYTES);
      expect(errorCodes(contents)).toEqual(["ADR_TOO_LARGE"]);
    });

    it("handles very long lines quickly", () => {
      const started = performance.now();
      expect(parsed(withBody("# Title", "x".repeat(60_000), "")).title).toBe("Title");
      expect(
        errorCodes(withFrontmatter(`status: ${" ".repeat(60_000)}x`, "date: 2026-10-05")),
      ).toEqual(["ADR_STATUS_INVALID"]);
      expect(errorCodes(withBody(`# ${" #".repeat(30_000)}x`, ""))).toEqual(["ADR_TITLE_INVALID"]);
      expect(errorCodes(withBody(`${"#".repeat(60_000)} Title`, ""))).toEqual([
        "ADR_TITLE_MISSING",
      ]);
      expect(errorCodes(withBody(`${"`".repeat(60_000)}`, "# Fenced", ""))).toEqual([
        "ADR_TITLE_MISSING",
      ]);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it("cuts user text in messages", () => {
      const result = parseAdrContent(
        withFrontmatter(`${"k".repeat(500)}: v`, "status: accepted", "date: 2026-10-05"),
      );
      expect(!result.ok && result.errors[0]?.message.length).toBeLessThan(200);
    });
  });
});

describe("ADR identifiers", () => {
  it.each([
    ["ADR-0015", 15],
    ["adr-0015", 15],
    ["Adr-15", 15],
    ["0015", 15],
    ["15", 15],
    ["1", 1],
    ["9999", 9999],
    ["ADR-9999", 9999],
  ])("reads %s as %i", (input, expected) => {
    expect(parseAdrIdentifier(input)).toBe(expected);
  });

  it.each([
    "0",
    "0000",
    "ADR-0000",
    "10000",
    "00015",
    "ADR0015",
    "ADR-",
    "ADR 15",
    " 15",
    "15 ",
    "+15",
    "-15",
    "1e3",
    "15.0",
    "0x0f",
    "fifteen",
    "",
    "١٥",
  ])("rejects %j", (input) => {
    expect(parseAdrIdentifier(input)).toBeNull();
  });

  it("formats numbers and file names", () => {
    expect(formatAdrNumber(15)).toBe("ADR-0015");
    expect(formatAdrNumber(9999)).toBe("ADR-9999");
    expect(padAdrNumber(7)).toBe("0007");
    expect(adrFileName(15, "adr-sync")).toBe("0015-adr-sync.md");
    expect(adrFilePath(15, "adr-sync")).toBe("docs/adr/0015-adr-sync.md");
    for (const bad of [0, 10_000, 1.5, Number.NaN]) {
      expect(() => formatAdrNumber(bad)).toThrow(RangeError);
    }
    expect(() => adrFileName(15, "Bad Slug")).toThrow(RangeError);
  });

  it("slugifies titles", () => {
    expect(slugifyAdrTitle("ADR numbers and repo sync")).toBe("adr-numbers-and-repo-sync");
    expect(slugifyAdrTitle("  Décision: über   C++ & Zod 4!  ")).toBe("decision-uber-c-zod-4");
    expect(slugifyAdrTitle("決定")).toBeNull();
    expect(slugifyAdrTitle("")).toBeNull();
    const long = slugifyAdrTitle("word ".repeat(40)) ?? "";
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-")).toBe(false);
    expect(slugifyAdrTitle("x".repeat(80))).toBe("x".repeat(60));
    for (const title of ["ADR numbers", "Décision", "x".repeat(80)]) {
      expect(parseAdrFileName(adrFileName(1, slugifyAdrTitle(title) ?? "")).ok).toBe(true);
    }
  });
});

describe("renderAdrTemplate", () => {
  // The template as ADR-0001 prints it, inside its ```markdown fence.
  const adr0001 = readFileSync(join(adrDirectory, "0001-record-architecture-decisions.md"), "utf8");
  const template = /\n```markdown\n([\s\S]*?\n)```\n/.exec(adr0001)?.[1] ?? "";

  it("renders ADR-0001's template", () => {
    expect(template).toContain("# Title of the decision");
    const result = renderAdrTemplate({ title: "ADR numbers and repo sync", date: "2026-10-05" });
    expect(result.ok && result.contents).toBe(
      template
        .replace("YYYY-MM-DD", "2026-10-05")
        .replace("# Title of the decision", "# ADR numbers and repo sync"),
    );
  });

  it("adds supersedes after date", () => {
    const result = renderAdrTemplate({ title: "Next", date: "2026-10-05", supersedes: [4, 7] });
    expect(result.ok && result.contents).toBe(
      template
        .replace("date: YYYY-MM-DD\n", "date: 2026-10-05\nsupersedes: [4, 7]\n")
        .replace("# Title of the decision", "# Next"),
    );
    const empty = renderAdrTemplate({ title: "Next", date: "2026-10-05", supersedes: [] });
    expect(empty.ok && empty.contents).not.toContain("supersedes");
  });

  it("parses back to what it was given, with no warnings", () => {
    const title = "Use <b>HTML</b> & C# in a `title`";
    const result = renderAdrTemplate({ title, date: "2024-02-29", supersedes: [12] });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(parseAdrFile("0015-x.md", result.contents)).toMatchObject({
      ok: true,
      adr: {
        number: 15,
        status: "proposed",
        date: "2024-02-29",
        supersedes: [12],
        title,
        warnings: [],
      },
    });
  });

  it.each([
    ["", "ADR_TITLE_INVALID"],
    [" leading space", "ADR_TITLE_INVALID"],
    ["trailing space ", "ADR_TITLE_INVALID"],
    ["closing hashes #", "ADR_TITLE_INVALID"],
    ["#", "ADR_TITLE_INVALID"],
    ["two\nlines", "ADR_TITLE_INVALID"],
    ["tab\there", "ADR_TITLE_INVALID"],
    ["x".repeat(201), "ADR_TITLE_INVALID"],
  ])("rejects the title %j", (title, code) => {
    const result = renderAdrTemplate({ title, date: "2026-10-05" });
    expect(!result.ok && result.errors.map((error) => error.code)).toEqual([code]);
  });

  it("rejects an invalid date or supersedes list", () => {
    const result = renderAdrTemplate({ title: "T", date: "2026-02-30", supersedes: [0, 4] });
    expect(!result.ok && result.errors.map((error) => error.code)).toEqual([
      "ADR_DATE_INVALID",
      "ADR_SUPERSEDES_INVALID",
    ]);
    for (const supersedes of [[4, 4], [10_000], [1.5], [-1]]) {
      const bad = renderAdrTemplate({ title: "T", date: "2026-10-05", supersedes });
      expect(bad.ok).toBe(false);
    }
  });
});

describe("rewriteAdrFrontmatter", () => {
  /** Rewrites `prefix + BODY` and checks the result is `expected + BODY`, byte for byte. */
  function expectRewrite(
    original: Uint8Array,
    body: string,
    changes: Parameters<typeof rewriteAdrFrontmatter>[1],
    expectedFrontmatter: string,
  ) {
    const result = rewriteAdrFrontmatter(original, changes);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const rewritten = encoder.encode(result.contents);
    const bodyBytes = encoder.encode(body);
    // The body is the same bytes as the original's tail...
    expect(Buffer.compare(rewritten.slice(-bodyBytes.length), bodyBytes)).toBe(0);
    expect(Buffer.compare(original.slice(-bodyBytes.length), bodyBytes)).toBe(0);
    // ...and only the frontmatter before it changed.
    expect(new TextDecoder().decode(rewritten.slice(0, -bodyBytes.length))).toBe(
      expectedFrontmatter,
    );
    return result;
  }

  it("changes status and date and leaves the body byte-identical", () => {
    const result = expectRewrite(
      encoder.encode(VALID),
      BODY,
      { status: "deprecated", date: "2026-11-01" },
      "---\nstatus: deprecated\ndate: 2026-11-01\n---\n",
    );
    expect(result.adr).toMatchObject({
      status: "deprecated",
      date: "2026-11-01",
      title: "A decision",
    });
  });

  it("adds and removes supersedes", () => {
    const added = expectRewrite(
      encoder.encode(VALID),
      BODY,
      { supersedes: [4, 7] },
      "---\nstatus: accepted\ndate: 2026-10-05\nsupersedes: [4, 7]\n---\n",
    );
    expectRewrite(
      encoder.encode(added.contents),
      BODY,
      { supersedes: [] },
      "---\nstatus: accepted\ndate: 2026-10-05\n---\n",
    );
  });

  it("normalizes only the frontmatter of a CRLF file with a BOM", () => {
    const body = BODY.replaceAll("\n", "\r\n");
    const original = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...encoder.encode(
        `---\r\nstatus:\taccepted  \r\n\r\ndate: 2026-10-05\r\nsupersedes: [ 3 ]\r\n--- \r\n${body}`,
      ),
    ]);
    const result = expectRewrite(
      original,
      body,
      { status: "superseded" },
      "---\nstatus: superseded\ndate: 2026-10-05\nsupersedes: [3]\n---\n",
    );
    expect(result.contents.startsWith("\uFEFF")).toBe(false);
    expect(result.contents).toContain("\r\n## Context\r\n");
  });

  it("keeps a body with no trailing newline and odd bytes as they are", () => {
    const body = "\n# Title\r\n\n## Context\t\n\u00a0\n## Decision\n## Consequences\n\u2028end";
    expectRewrite(
      encoder.encode(`${FRONTMATTER}${body}`),
      body,
      { status: "deprecated" },
      "---\nstatus: deprecated\ndate: 2026-10-05\n---\n",
    );
  });

  it("round-trips the template", () => {
    const rendered = renderAdrTemplate({ title: "Round trip", date: "2026-10-05" });
    if (!rendered.ok) throw new Error("render failed");
    const accepted = rewriteAdrFrontmatter(rendered.contents, { status: "accepted" });
    expect(accepted.ok && accepted.contents).toBe(
      rendered.contents.replace("status: proposed", "status: accepted"),
    );
  });

  it("refuses an invalid file or an invalid change", () => {
    expect(rewriteAdrFrontmatter(withBody("No title."), { status: "accepted" })).toMatchObject({
      ok: false,
      errors: [{ code: "ADR_TITLE_MISSING" }],
    });
    expect(rewriteAdrFrontmatter(VALID, { status: "draft" as AdrStatus })).toMatchObject({
      ok: false,
      errors: [{ code: "ADR_STATUS_INVALID" }],
    });
    expect(rewriteAdrFrontmatter(VALID, { date: "2026-10-5" })).toMatchObject({
      ok: false,
      errors: [{ code: "ADR_DATE_INVALID" }],
    });
    expect(rewriteAdrFrontmatter(VALID, { supersedes: [8, 8] })).toMatchObject({
      ok: false,
      errors: [{ code: "ADR_SUPERSEDES_INVALID" }],
    });
  });

  it("serializes frontmatter canonically", () => {
    expect(
      serializeAdrFrontmatter({ status: "accepted", date: "2026-10-05", supersedes: [4] }),
    ).toBe("---\nstatus: accepted\ndate: 2026-10-05\nsupersedes: [4]\n---\n");
  });
});

describe("validateAdrSet", () => {
  function entry(number: number, status: AdrStatus, supersedes: number[] = []): AdrSetEntry {
    return { number, path: `docs/adr/${adrFileName(number, "x")}`, status, supersedes };
  }

  function warnings(entries: AdrSetEntry[]) {
    return validateAdrSet(entries).warnings.map(({ number, code }) => [number, code]);
  }

  it("accepts a consistent chain", () => {
    expect(
      validateAdrSet([
        entry(1, "accepted"),
        entry(2, "superseded"),
        entry(3, "superseded", [2]),
        entry(4, "accepted", [3]),
        entry(5, "proposed"),
      ]),
    ).toEqual({ errors: [], warnings: [] });
  });

  it("warns about a supersedes entry naming a missing ADR", () => {
    expect(warnings([entry(4, "accepted", [3, 9])])).toEqual([
      [4, "ADR_SUPERSEDES_MISSING_TARGET"],
      [4, "ADR_SUPERSEDES_MISSING_TARGET"],
    ]);
    expect(validateAdrSet([entry(4, "accepted", [3])]).warnings[0]?.message).toBe(
      "ADR-0004 supersedes ADR-0003, which does not exist.",
    );
  });

  it("warns about a superseded ADR that nothing supersedes", () => {
    expect(warnings([entry(1, "superseded"), entry(2, "accepted")])).toEqual([
      [1, "ADR_SUPERSEDED_WITHOUT_SUCCESSOR"],
    ]);
  });

  it("warns about an ADR superseded twice", () => {
    expect(
      warnings([entry(1, "superseded"), entry(2, "accepted", [1]), entry(3, "proposed", [1])]),
    ).toEqual([[1, "ADR_SUPERSEDED_TWICE"]]);
    expect(
      validateAdrSet([entry(1, "superseded"), entry(3, "accepted", [1]), entry(2, "accepted", [1])])
        .warnings[0]?.message,
    ).toBe("ADR-0001 is superseded by more than one ADR: ADR-0002, ADR-0003.");
  });

  it("warns about cycles, including an ADR that supersedes itself", () => {
    expect(
      warnings([
        entry(1, "superseded", [3]),
        entry(2, "superseded", [1]),
        entry(3, "superseded", [2]),
        entry(4, "accepted"),
      ]),
    ).toEqual([
      [1, "ADR_SUPERSEDES_CYCLE"],
      [2, "ADR_SUPERSEDES_CYCLE"],
      [3, "ADR_SUPERSEDES_CYCLE"],
    ]);
    expect(validateAdrSet([entry(5, "superseded", [5])]).warnings).toEqual([
      { number: 5, code: "ADR_SUPERSEDES_CYCLE", message: "ADR-0005 lists itself in supersedes." },
    ]);
    expect(
      validateAdrSet([entry(7, "superseded", [9]), entry(9, "superseded", [7])]).warnings[0]
        ?.message,
    ).toBe("ADR-0007 is in a supersedes cycle: ADR-0007, ADR-0009.");
  });

  it("does not report a chain feeding into a cycle as part of it", () => {
    expect(
      warnings([
        entry(1, "superseded", [2]),
        entry(2, "superseded", [1]),
        entry(3, "accepted", [2]),
      ]),
    ).toEqual([
      [1, "ADR_SUPERSEDES_CYCLE"],
      [2, "ADR_SUPERSEDED_TWICE"],
      [2, "ADR_SUPERSEDES_CYCLE"],
    ]);
  });

  it("reports duplicate numbers as an error", () => {
    const result = validateAdrSet([
      { ...entry(4, "accepted"), path: "docs/adr/0004-a.md" },
      { ...entry(4, "accepted"), path: "docs/adr/0004-b.md" },
      entry(5, "accepted"),
    ]);
    expect(result.errors).toEqual([
      {
        number: 4,
        code: "ADR_NUMBER_DUPLICATE",
        message: "2 files have the number ADR-0004: docs/adr/0004-a.md, docs/adr/0004-b.md.",
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("handles a long chain without recursion", () => {
    const chain = Array.from({ length: 9999 }, (_, index) =>
      entry(index + 1, index === 9998 ? "accepted" : "superseded", index === 0 ? [] : [index]),
    );
    expect(validateAdrSet(chain)).toEqual({ errors: [], warnings: [] });
    chain[0] = entry(1, "superseded", [9999]);
    expect(validateAdrSet(chain).warnings).toHaveLength(9999);
  });
});

describe("codes and hashing", () => {
  it("uses CLI-style codes", () => {
    for (const code of [...ADR_ERROR_CODES, ...ADR_WARNING_CODES]) {
      expect(code).toMatch(/^ADR_[A-Z0-9_]+$/);
    }
    expect(new Set([...ADR_ERROR_CODES, ...ADR_WARNING_CODES]).size).toBe(
      ADR_ERROR_CODES.length + ADR_WARNING_CODES.length,
    );
  });

  it("hashes the exact bytes with sha256", async () => {
    expect(await adrContentSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await adrContentSha256(encoder.encode(VALID))).toBe(await adrContentSha256(VALID));
    expect(await adrContentSha256(`\uFEFF${VALID}`)).not.toBe(await adrContentSha256(VALID));
  });
});
