/**
 * ADR files: the parser, the cross-file checks and the serializer for the
 * format ADR-0001 fixes. The server (ADR sync) and the CLI (`adr new`,
 * `adr status`, `adr supersede`, `adr sync --check`) both use this module, so
 * a file means the same thing on both sides.
 *
 * The frontmatter grammar has three keys, so it is parsed here without a YAML
 * library (ADR-0009 limits this package to zod and oRPC). Parsing never
 * throws: bad input comes back as `{ ok: false, errors }`, each error with a
 * stable `code` and a human `message`.
 */

export const ADR_DIRECTORY = "docs/adr";

/** Larger files are a hard error, checked on the encoded size before decoding. */
export const MAX_ADR_FILE_BYTES = 64 * 1024;

/** In UTF-16 code units, as zod's `.max()` counts. */
export const MAX_ADR_TITLE_LENGTH = 200;

export const MIN_ADR_NUMBER = 1;
export const MAX_ADR_NUMBER = 9999;

export const MAX_ADR_SLUG_LENGTH = 100;

export const ADR_STATUSES = ["proposed", "accepted", "superseded", "deprecated"] as const;

export type AdrStatus = (typeof ADR_STATUSES)[number];

/** The H2 sections in the order ADR-0001 requires; the last one is optional. */
export const ADR_SECTIONS: readonly string[] = [
  "Context",
  "Decision",
  "Consequences",
  "Alternatives considered",
];
const REQUIRED_SECTION_COUNT = 3;

/** `NNNN-slug.md`: four digits, then lowercase words joined by single hyphens. */
export const ADR_FILE_NAME_PATTERN = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export const ADR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Why a file, or a set of files, cannot be stored. ADR sync refuses the whole
 * commit when any file has one of these.
 */
export const ADR_ERROR_CODES = [
  "ADR_FILE_NAME_INVALID",
  "ADR_TOO_LARGE",
  "ADR_NOT_UTF8",
  "ADR_FRONTMATTER_MISSING",
  "ADR_FRONTMATTER_UNTERMINATED",
  "ADR_FRONTMATTER_INVALID",
  "ADR_FRONTMATTER_UNKNOWN_KEY",
  "ADR_FRONTMATTER_DUPLICATE_KEY",
  "ADR_STATUS_MISSING",
  "ADR_STATUS_INVALID",
  "ADR_DATE_MISSING",
  "ADR_DATE_INVALID",
  "ADR_SUPERSEDES_INVALID",
  "ADR_TITLE_MISSING",
  "ADR_TITLE_INVALID",
  "ADR_NUMBER_DUPLICATE",
] as const;

export type AdrErrorCode = (typeof ADR_ERROR_CODES)[number];

/**
 * Problems that do not stop a file from being stored. The first two come from
 * one file (`parseAdrContent`), the next four from a set of files
 * (`validateAdrSet`), and the last two from the server, which compares a
 * synced file with its number's reservation.
 */
export const ADR_WARNING_CODES = [
  "ADR_SECTION_MISSING",
  "ADR_SECTION_ORDER",
  "ADR_SUPERSEDES_MISSING_TARGET",
  "ADR_SUPERSEDES_CYCLE",
  "ADR_SUPERSEDED_TWICE",
  "ADR_SUPERSEDED_WITHOUT_SUCCESSOR",
  "ADR_NUMBER_UNRESERVED",
  "ADR_SLUG_DIFFERS_FROM_RESERVATION",
] as const;

export type AdrWarningCode = (typeof ADR_WARNING_CODES)[number];

export type AdrError = { code: AdrErrorCode; message: string };
export type AdrWarning = { code: AdrWarningCode; message: string };

/** The frontmatter values. `supersedes` is `[]` when the key is absent. */
export type AdrFrontmatter = {
  status: AdrStatus;
  /** `YYYY-MM-DD`. */
  date: string;
  supersedes: number[];
};

/** What one file's contents say, independent of its file name. */
export type ParsedAdrContent = AdrFrontmatter & {
  title: string;
  /** Everything after the frontmatter's closing `---` line, unchanged. */
  body: string;
  warnings: AdrWarning[];
};

export type ParsedAdrFile = ParsedAdrContent & { number: number; slug: string };

export type AdrFailure = { ok: false; errors: AdrError[] };

export type AdrResult<T> = { ok: true; adr: T } | AdrFailure;

export type AdrFileNameResult =
  | { ok: true; number: number; slug: string }
  | { ok: false; error: AdrError };

// --- Numbers, identifiers and file names ---

function assertAdrNumber(value: number): void {
  if (!Number.isInteger(value) || value < MIN_ADR_NUMBER || value > MAX_ADR_NUMBER) {
    throw new RangeError(
      `ADR numbers run from ${MIN_ADR_NUMBER} to ${MAX_ADR_NUMBER}; got ${value}.`,
    );
  }
}

/** `15` → `"0015"`. Throws a RangeError outside 1–9999. */
export function padAdrNumber(value: number): string {
  assertAdrNumber(value);
  return String(value).padStart(4, "0");
}

/** `15` → `"ADR-0015"`, the form ADRs are cited by. Throws a RangeError outside 1–9999. */
export function formatAdrNumber(value: number): string {
  return `ADR-${padAdrNumber(value)}`;
}

/** `(15, "adr-sync")` → `"0015-adr-sync.md"`. Throws a RangeError on an invalid number or slug. */
export function adrFileName(value: number, slug: string): string {
  if (!isAdrSlug(slug)) throw new RangeError(`Not an ADR slug: ${quote(slug)}.`);
  return `${padAdrNumber(value)}-${slug}.md`;
}

/** The repository-relative path, `docs/adr/0015-adr-sync.md`. */
export function adrFilePath(value: number, slug: string): string {
  return `${ADR_DIRECTORY}/${adrFileName(value, slug)}`;
}

export function isAdrSlug(value: string): boolean {
  return value.length <= MAX_ADR_SLUG_LENGTH && ADR_SLUG_PATTERN.test(value);
}

/**
 * A command-line ADR identifier: `ADR-0015`, `adr-0015`, `0015` or `15` → 15.
 * Up to four digits, 1–9999, no sign, spaces or other prefix. Null otherwise.
 */
export function parseAdrIdentifier(input: string): number | null {
  const match = /^(?:adr-)?(\d{1,4})$/i.exec(input);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return value >= MIN_ADR_NUMBER ? value : null;
}

const SLUGIFY_MAX_LENGTH = 60;

/**
 * A default slug for `adr new`: the title lowercased with accents removed,
 * each run of characters other than a-z and 0-9 replaced by one hyphen, and
 * cut at a word boundary to at most 60 characters. Null when nothing is left
 * (for example a title written only in a non-Latin script).
 */
export function slugifyAdrTitle(title: string): string | null {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > SLUGIFY_MAX_LENGTH) {
      if (slug === "") slug = word.slice(0, SLUGIFY_MAX_LENGTH);
      break;
    }
    slug = next;
  }
  return slug === "" ? null : slug;
}

/**
 * A file name (not a path) such as `0015-adr-sync.md`. The number comes from
 * the name only (ADR-0001).
 */
export function parseAdrFileName(fileName: string): AdrFileNameResult {
  const match = ADR_FILE_NAME_PATTERN.exec(fileName);
  const value = Number(match?.[1]);
  const slug = match?.[2];
  if (!slug || value < MIN_ADR_NUMBER || slug.length > MAX_ADR_SLUG_LENGTH) {
    return {
      ok: false,
      error: {
        code: "ADR_FILE_NAME_INVALID",
        message: `${quote(fileName)} is not an ADR file name. Use NNNN-slug.md: a number from 0001 to 9999, then lowercase words joined by hyphens (at most ${MAX_ADR_SLUG_LENGTH} characters).`,
      },
    };
  }
  return { ok: true, number: value, slug };
}

// --- Parsing ---

/**
 * Parses one file: its name and its contents. Both are checked, so a bad name
 * and bad contents are reported together.
 */
export function parseAdrFile(
  fileName: string,
  contents: string | Uint8Array,
): AdrResult<ParsedAdrFile> {
  const name = parseAdrFileName(fileName);
  const content = parseAdrContent(contents);
  const errors = [...(name.ok ? [] : [name.error]), ...(content.ok ? [] : content.errors)];
  if (!name.ok || !content.ok) return { ok: false, errors };
  return { ok: true, adr: { ...content.adr, number: name.number, slug: name.slug } };
}

/**
 * Parses a file's contents, which may be raw bytes (validated as UTF-8) or a
 * string. A leading BOM and CRLF line endings are accepted. Only `\n` and
 * `\r\n` end a line.
 *
 * - The frontmatter must open on the first line with `---` and close with
 *   `---`. Each line inside is `key: value` starting in column 0, with spaces
 *   or tabs after the colon; blank lines are allowed. Keys: `status`, `date`
 *   and, only when non-empty, `supersedes` as a flow list of plain integers
 *   such as `[4, 7]`. Quotes, comments and other YAML forms are errors.
 * - The title is the first ATX H1 (`# Title`) outside fenced code blocks.
 * - Section order is checked on the H2s outside fenced code blocks.
 */
export function parseAdrContent(contents: string | Uint8Array): AdrResult<ParsedAdrContent> {
  const decoded = decodeAdr(contents);
  if (!decoded.ok) return { ok: false, errors: [decoded.error] };
  const split = splitFrontmatter(decoded.text);
  if (!split.ok) return { ok: false, errors: [split.error] };

  const errors: AdrError[] = [];
  const frontmatter = readFrontmatter(split.frontmatterLines, errors);
  const body = decoded.text.slice(split.bodyStart);
  const scan = scanBody(body, split.bodyFirstLine);

  let title = "";
  if (!scan.title || scan.title.text === "") {
    errors.push({
      code: "ADR_TITLE_MISSING",
      message: "The file has no title: add an H1 line, `# Title`, outside any code block.",
    });
  } else {
    title = scan.title.text;
    const titleProblem = adrTitleProblem(title);
    if (titleProblem) {
      errors.push({
        code: "ADR_TITLE_INVALID",
        message: `Line ${scan.title.line}: the title ${titleProblem}`,
      });
    }
  }

  if (!frontmatter || errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    adr: { ...frontmatter, title, body, warnings: sectionWarnings(scan.sections) },
  };
}

type Decoded = { ok: true; text: string } | { ok: false; error: AdrError };

const utf8Encoder = new TextEncoder();

function decodeAdr(contents: string | Uint8Array): Decoded {
  const size =
    typeof contents === "string" ? utf8Encoder.encode(contents).byteLength : contents.byteLength;
  if (size > MAX_ADR_FILE_BYTES) {
    return {
      ok: false,
      error: {
        code: "ADR_TOO_LARGE",
        message: `The file is ${size} bytes; an ADR may be at most ${MAX_ADR_FILE_BYTES} bytes.`,
      },
    };
  }
  let text: string;
  if (typeof contents === "string") {
    // A lone surrogate has no UTF-8 encoding.
    if (!contents.isWellFormed()) return notUtf8();
    text = contents;
  } else {
    try {
      // ignoreBOM keeps a BOM in the text so it is removed the same way for
      // bytes and strings below.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents);
    } catch {
      return notUtf8();
    }
  }
  return { ok: true, text: text.startsWith("\uFEFF") ? text.slice(1) : text };
}

function notUtf8(): Decoded {
  return { ok: false, error: { code: "ADR_NOT_UTF8", message: "The file is not valid UTF-8." } };
}

type Line = { text: string; line: number };

type Split =
  | { ok: true; frontmatterLines: Line[]; bodyStart: number; bodyFirstLine: number }
  | { ok: false; error: AdrError };

/** Lines of `text` from `start`, without their `\n` or `\r\n`, with 1-based numbers. */
function* lines(text: string, start = 0, firstLine = 1): Generator<Line & { end: number }> {
  let offset = start;
  let line = firstLine;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline + 1;
    let content = text.slice(offset, newline === -1 ? text.length : newline);
    if (newline !== -1 && content.endsWith("\r")) content = content.slice(0, -1);
    yield { text: content, line, end };
    offset = end;
    line += 1;
  }
}

function splitFrontmatter(text: string): Split {
  const frontmatterLines: Line[] = [];
  let opened = false;
  for (const current of lines(text)) {
    if (!opened) {
      if (trimBlanksEnd(current.text) !== "---") break;
      opened = true;
      continue;
    }
    if (trimBlanksEnd(current.text) === "---") {
      return {
        ok: true,
        frontmatterLines,
        bodyStart: current.end,
        bodyFirstLine: current.line + 1,
      };
    }
    frontmatterLines.push(current);
  }
  if (!opened) {
    return {
      ok: false,
      error: {
        code: "ADR_FRONTMATTER_MISSING",
        message: "The file must start with frontmatter: a `---` line on line 1.",
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "ADR_FRONTMATTER_UNTERMINATED",
      message: "The frontmatter that opens on line 1 has no closing `---` line.",
    },
  };
}

const FRONTMATTER_KEYS = ["status", "date", "supersedes"] as const;
type FrontmatterKey = (typeof FRONTMATTER_KEYS)[number];

function isFrontmatterKey(key: string): key is FrontmatterKey {
  return (FRONTMATTER_KEYS as readonly string[]).includes(key);
}

function readFrontmatter(frontmatterLines: Line[], errors: AdrError[]): AdrFrontmatter | null {
  const errorCount = errors.length;
  const fail = (code: AdrErrorCode, line: number | null, message: string) => {
    errors.push({ code, message: line === null ? message : `Line ${line}: ${message}` });
  };

  const values = new Map<FrontmatterKey, Line>();
  for (const { text, line } of frontmatterLines) {
    const trimmed = trimBlanksEnd(text);
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    const key = colon === -1 ? "" : trimmed.slice(0, colon);
    const rest = colon === -1 ? "" : trimmed.slice(colon + 1);
    if (isBlank(trimmed[0]) || key === "" || (rest !== "" && !isBlank(rest[0]))) {
      fail(
        "ADR_FRONTMATTER_INVALID",
        line,
        "frontmatter lines must be `key: value`, starting in the first column.",
      );
    } else if (!isFrontmatterKey(key)) {
      fail(
        "ADR_FRONTMATTER_UNKNOWN_KEY",
        line,
        `unknown frontmatter key ${quote(key)}. The keys are status, date and supersedes.`,
      );
    } else if (values.has(key)) {
      fail("ADR_FRONTMATTER_DUPLICATE_KEY", line, `${key} appears more than once.`);
    } else {
      values.set(key, { text: trimBlanksStart(rest), line });
    }
  }

  const statusLine = values.get("status");
  let status: AdrStatus | undefined;
  if (!statusLine) {
    fail("ADR_STATUS_MISSING", null, "The frontmatter has no status.");
  } else if (isAdrStatus(statusLine.text)) {
    status = statusLine.text;
  } else {
    fail("ADR_STATUS_INVALID", statusLine.line, statusProblem(statusLine.text) ?? "");
  }

  const dateLine = values.get("date");
  const dateError = dateLine && dateProblem(dateLine.text);
  if (!dateLine) fail("ADR_DATE_MISSING", null, "The frontmatter has no date.");
  else if (dateError) fail("ADR_DATE_INVALID", dateLine.line, dateError);

  const supersedesLine = values.get("supersedes");
  const supersedes = supersedesLine ? parseSupersedes(supersedesLine.text) : [];
  if (supersedesLine && typeof supersedes === "string") {
    fail("ADR_SUPERSEDES_INVALID", supersedesLine.line, supersedes);
  }

  if (errors.length > errorCount || !status || !dateLine || typeof supersedes === "string") {
    return null;
  }
  return { status, date: dateLine.text, supersedes };
}

export function isAdrStatus(value: string): value is AdrStatus {
  return (ADR_STATUSES as readonly string[]).includes(value);
}

function statusProblem(value: string): string | null {
  if (isAdrStatus(value)) return null;
  return `status ${quote(value)} is not one of ${ADR_STATUSES.join(", ")}.`;
}

/** A real calendar date written `YYYY-MM-DD`, years 0001 to 9999. */
function dateProblem(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return `date ${quote(value)} is not a calendar date written YYYY-MM-DD.`;
  }
  return null;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * `[4]` or `[4, 7]`: distinct plain integers from 1 to 9999. A leading zero is
 * refused because YAML 1.1 reads `0008` as a malformed octal (ADR-0001), and
 * `[]` because ADR-0001 writes the key only when the list is non-empty.
 */
function parseSupersedes(value: string): number[] | string {
  const shape = "supersedes must be a list of ADR numbers such as [4] or [4, 7]";
  if (!value.startsWith("[") || !value.endsWith("]")) return `${shape}.`;
  const inner = trimBlanksEnd(trimBlanksStart(value.slice(1, -1)));
  if (inner === "") return `${shape}. Leave the key out when the ADR supersedes nothing.`;
  const numbers: number[] = [];
  for (const item of inner.split(",")) {
    const text = trimBlanksEnd(trimBlanksStart(item));
    if (!/^[1-9]\d{0,3}$/.test(text)) {
      return `${shape}, written without leading zeros, from 1 to ${MAX_ADR_NUMBER}; ${quote(text)} is not.`;
    }
    const number = Number(text);
    if (numbers.includes(number)) return `supersedes lists ${number} more than once.`;
    numbers.push(number);
  }
  return numbers;
}

type Heading = { text: string; line: number };

/** The first H1 and every H2 outside fenced code blocks. */
function scanBody(body: string, firstLine: number): { title?: Heading; sections: Heading[] } {
  let title: Heading | undefined;
  const sections: Heading[] = [];
  let fence: Fence | null = null;
  for (const { text, line } of lines(body, 0, firstLine)) {
    if (fence) {
      if (closesFence(text, fence)) fence = null;
      continue;
    }
    fence = opensFence(text);
    if (fence) continue;
    const heading = atxHeading(text);
    if (heading?.level === 1 && !title) title = { text: heading.text, line };
    if (heading?.level === 2) sections.push({ text: heading.text, line });
  }
  return title ? { title, sections } : { sections };
}

type Fence = { marker: "`" | "~"; length: number };

/** Up to three leading spaces, as CommonMark allows before a fence or heading. */
function indentOf(text: string): number {
  let indent = 0;
  while (indent < text.length && text[indent] === " ") indent += 1;
  return indent;
}

function runOf(text: string, start: number, char: string): number {
  let end = start;
  while (text[end] === char) end += 1;
  return end - start;
}

function opensFence(text: string): Fence | null {
  const indent = indentOf(text);
  if (indent > 3) return null;
  const marker = text[indent];
  if (marker !== "`" && marker !== "~") return null;
  const length = runOf(text, indent, marker);
  if (length < 3) return null;
  // A backtick fence's info string cannot contain a backtick (CommonMark).
  if (marker === "`" && text.indexOf("`", indent + length) !== -1) return null;
  return { marker, length };
}

function closesFence(text: string, fence: Fence): boolean {
  const indent = indentOf(text);
  if (indent > 3) return false;
  const length = runOf(text, indent, fence.marker);
  return length >= fence.length && trimBlanksEnd(text.slice(indent + length)) === "";
}

/** An ATX heading: `#` to `######`, then a space, a tab or the end of the line. */
function atxHeading(text: string): { level: number; text: string } | null {
  const indent = indentOf(text);
  if (indent > 3) return null;
  const level = runOf(text, indent, "#");
  if (level < 1 || level > 6) return null;
  const after = indent + level;
  if (after < text.length && !isBlank(text[after])) return null;
  let content = trimBlanksEnd(text.slice(after));
  // An optional closing sequence of `#`s, preceded by a space or tab, is not
  // part of the heading.
  let hashes = content.length;
  while (hashes > 0 && content[hashes - 1] === "#") hashes -= 1;
  if (hashes < content.length && (hashes === 0 || isBlank(content[hashes - 1]))) {
    content = content.slice(0, hashes);
  }
  return { level, text: trimBlanksEnd(trimBlanksStart(content)) };
}

function sectionWarnings(sections: Heading[]): AdrWarning[] {
  const found: string[] = [];
  for (const { text } of sections) {
    if (ADR_SECTIONS.includes(text) && !found.includes(text)) found.push(text);
  }
  const warnings: AdrWarning[] = ADR_SECTIONS.slice(0, REQUIRED_SECTION_COUNT)
    .filter((section) => !found.includes(section))
    .map((section) => ({
      code: "ADR_SECTION_MISSING",
      message: `The file has no \`## ${section}\` section.`,
    }));
  const ordered = [...found].sort((a, b) => ADR_SECTIONS.indexOf(a) - ADR_SECTIONS.indexOf(b));
  if (found.some((section, index) => section !== ordered[index])) {
    warnings.push({
      code: "ADR_SECTION_ORDER",
      message: `The sections are in the order ${found.join(", ")}; ADR sections go in the order ${ADR_SECTIONS.join(", ")}.`,
    });
  }
  return warnings;
}

// C0 and C1 control characters, as nameSchema in common.ts rejects them.
const CONTROL_CHARACTERS = /\p{Cc}/u;

/** Why `title` cannot be an ADR title, completing "the title …", or null. */
function adrTitleProblem(title: string): string | null {
  if (title.length > MAX_ADR_TITLE_LENGTH) {
    return `is ${title.length} characters; the limit is ${MAX_ADR_TITLE_LENGTH}.`;
  }
  if (CONTROL_CHARACTERS.test(title)) return "contains a tab or another control character.";
  return null;
}

// --- Cross-file checks ---

export type AdrSetEntry = {
  number: number;
  /** Shown in messages about duplicate numbers. */
  path: string;
  status: AdrStatus;
  supersedes: readonly number[];
};

/** A problem found by comparing files; `number` is the ADR it is reported on. */
export type AdrSetProblem<C> = { number: number; code: C; message: string };

export type AdrSetValidation = {
  /** Duplicate numbers. ADR sync refuses the commit when there are any. */
  errors: AdrSetProblem<AdrErrorCode>[];
  warnings: AdrSetProblem<AdrWarningCode>[];
};

/**
 * Checks the supersedes graph of one set of ADRs, such as every file in
 * `docs/adr/` at one commit: duplicate numbers (an error), and as warnings a
 * `supersedes` entry naming a missing ADR, a supersedes cycle (including an
 * ADR that supersedes itself), an ADR superseded by more than one ADR, and a
 * `superseded` ADR that no ADR supersedes. Results are sorted by number.
 * When a number is duplicated, the graph checks use its first entry.
 */
export function validateAdrSet(entries: readonly AdrSetEntry[]): AdrSetValidation {
  const errors: AdrSetProblem<AdrErrorCode>[] = [];
  const warnings: AdrSetProblem<AdrWarningCode>[] = [];
  const byNumber = new Map<number, AdrSetEntry>();
  const paths = new Map<number, string[]>();
  for (const entry of entries) {
    if (!byNumber.has(entry.number)) byNumber.set(entry.number, entry);
    paths.set(entry.number, [...(paths.get(entry.number) ?? []), entry.path]);
  }
  for (const [number, numberPaths] of paths) {
    if (numberPaths.length > 1) {
      errors.push({
        number,
        code: "ADR_NUMBER_DUPLICATE",
        message: `${numberPaths.length} files have the number ${formatAdrNumber(number)}: ${numberPaths.join(", ")}.`,
      });
    }
  }

  const supersededBy = new Map<number, number[]>();
  for (const entry of byNumber.values()) {
    for (const target of entry.supersedes) {
      if (!byNumber.has(target)) {
        warnings.push({
          number: entry.number,
          code: "ADR_SUPERSEDES_MISSING_TARGET",
          message: `${formatAdrNumber(entry.number)} supersedes ${formatAdrNumber(target)}, which does not exist.`,
        });
        continue;
      }
      supersededBy.set(target, [...(supersededBy.get(target) ?? []), entry.number]);
    }
  }

  for (const entry of byNumber.values()) {
    const successors = supersededBy.get(entry.number) ?? [];
    if (successors.length > 1) {
      warnings.push({
        number: entry.number,
        code: "ADR_SUPERSEDED_TWICE",
        message: `${formatAdrNumber(entry.number)} is superseded by more than one ADR: ${successors
          .sort((a, b) => a - b)
          .map(formatAdrNumber)
          .join(", ")}.`,
      });
    }
    if (entry.status === "superseded" && successors.length === 0) {
      warnings.push({
        number: entry.number,
        code: "ADR_SUPERSEDED_WITHOUT_SUCCESSOR",
        message: `${formatAdrNumber(entry.number)} has status superseded, but no ADR lists it in supersedes.`,
      });
    }
  }

  for (const cycle of supersedesCycles(byNumber)) {
    const names = cycle.map(formatAdrNumber).join(", ");
    for (const number of cycle) {
      warnings.push({
        number,
        code: "ADR_SUPERSEDES_CYCLE",
        message:
          cycle.length === 1
            ? `${formatAdrNumber(number)} lists itself in supersedes.`
            : `${formatAdrNumber(number)} is in a supersedes cycle: ${names}.`,
      });
    }
  }

  const byPosition = (a: { number: number }, b: { number: number }) => a.number - b.number;
  return { errors: errors.sort(byPosition), warnings: warnings.sort(byPosition) };
}

/**
 * The strongly connected components of the supersedes graph that contain a
 * cycle, each sorted. Tarjan's algorithm, iterative so a long chain cannot
 * overflow the stack.
 */
function supersedesCycles(byNumber: Map<number, AdrSetEntry>): number[][] {
  const index = new Map<number, number>();
  const lowLink = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const cycles: number[][] = [];
  let counter = 0;
  const targetsOf = (number: number) =>
    (byNumber.get(number)?.supersedes ?? []).filter((target) => byNumber.has(target));

  for (const root of byNumber.keys()) {
    if (index.has(root)) continue;
    const work: { number: number; next: number }[] = [{ number: root, next: 0 }];
    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { number: number; next: number };
      const targets = targetsOf(frame.number);
      if (frame.next < targets.length) {
        const target = targets[frame.next] as number;
        frame.next += 1;
        if (!index.has(target)) {
          index.set(target, counter);
          lowLink.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ number: target, next: 0 });
        } else if (onStack.has(target)) {
          lowLink.set(
            frame.number,
            Math.min(lowLink.get(frame.number) as number, index.get(target) as number),
          );
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(
          parent.number,
          Math.min(lowLink.get(parent.number) as number, lowLink.get(frame.number) as number),
        );
      }
      if (lowLink.get(frame.number) !== index.get(frame.number)) continue;
      const component: number[] = [];
      let member: number | undefined;
      do {
        member = stack.pop() as number;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.number);
      if (component.length > 1 || targets.includes(frame.number)) {
        cycles.push(component.sort((a, b) => a - b));
      }
    }
  }
  return cycles;
}

// --- Serializing ---

/** The canonical frontmatter block: LF line endings, keys in ADR-0001's order. */
export function serializeAdrFrontmatter(frontmatter: AdrFrontmatter): string {
  const supersedes =
    frontmatter.supersedes.length > 0 ? `supersedes: [${frontmatter.supersedes.join(", ")}]\n` : "";
  return `---\nstatus: ${frontmatter.status}\ndate: ${frontmatter.date}\n${supersedes}---\n`;
}

function checkFrontmatter(frontmatter: AdrFrontmatter): AdrError[] {
  const errors: AdrError[] = [];
  const status = statusProblem(frontmatter.status);
  if (status) errors.push({ code: "ADR_STATUS_INVALID", message: status });
  const date = dateProblem(frontmatter.date);
  if (date) errors.push({ code: "ADR_DATE_INVALID", message: date });
  if (frontmatter.supersedes.length > 0) {
    const supersedes = parseSupersedes(`[${frontmatter.supersedes.join(", ")}]`);
    if (typeof supersedes === "string") {
      errors.push({ code: "ADR_SUPERSEDES_INVALID", message: supersedes });
    }
  }
  return errors;
}

export type AdrTemplateInput = {
  title: string;
  /** `YYYY-MM-DD`, the day the ADR is created. */
  date: string;
  supersedes?: readonly number[];
};

/**
 * The new-ADR file `adr new` writes: ADR-0001's template, with `status:
 * proposed`, the given date and title, and a `supersedes` line when the list
 * is non-empty. Returns errors, rather than a file that would not parse back
 * to the same title, for a title that is empty, too long, has a control
 * character or has leading or trailing spaces or `#`s.
 */
export function renderAdrTemplate(
  input: AdrTemplateInput,
): { ok: true; contents: string } | AdrFailure {
  const frontmatter: AdrFrontmatter = {
    status: "proposed",
    date: input.date,
    supersedes: [...(input.supersedes ?? [])],
  };
  const errors = checkFrontmatter(frontmatter);
  const title = input.title;
  const titleProblem =
    adrTitleProblem(title) ??
    (title === "" || atxHeading(`# ${title}`)?.text !== title
      ? "must not be empty, start or end with a space, or end with #."
      : null);
  if (titleProblem)
    errors.push({ code: "ADR_TITLE_INVALID", message: `The title ${titleProblem}` });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    contents: `${serializeAdrFrontmatter(frontmatter)}
# ${title}

## Context

Why a decision is needed. Link #1 and the implementing issue or PR.

## Decision

What was decided.

## Consequences

What becomes easier or harder, and what was verified.

## Alternatives considered

Rejected options and why. Omit when the rejection was obvious.
`,
  };
}

/**
 * Replaces the frontmatter of a valid ADR (`adr status`, `adr supersede`).
 * Keys missing from `changes` keep their value; `supersedes: []` removes the
 * line. Returns the new contents and their parsed result. The new
 * frontmatter is written canonically (LF, no BOM). Every byte
 * after the original closing `---` line is kept, so a CRLF file keeps CRLF in
 * its body and only the frontmatter block changes to LF: rewriting the body's
 * line endings would make the change look like a whole-file edit.
 */
export function rewriteAdrFrontmatter(
  contents: string | Uint8Array,
  changes: Partial<AdrFrontmatter>,
): { ok: true; contents: string; adr: ParsedAdrContent } | AdrFailure {
  const current = parseAdrContent(contents);
  if (!current.ok) return current;
  const frontmatter: AdrFrontmatter = {
    status: changes.status ?? current.adr.status,
    date: changes.date ?? current.adr.date,
    supersedes: [...(changes.supersedes ?? current.adr.supersedes)],
  };
  const errors = checkFrontmatter(frontmatter);
  if (errors.length > 0) return { ok: false, errors };
  const rewritten = serializeAdrFrontmatter(frontmatter) + current.adr.body;
  const parsed = parseAdrContent(rewritten);
  if (!parsed.ok) return parsed;
  return { ok: true, contents: rewritten, adr: parsed.adr };
}

// --- Content hashing ---

/**
 * The lowercase hex sha256 of a file's exact bytes (a string is hashed as its
 * UTF-8 encoding), which addresses ADR content. Uses Web Crypto, a global in
 * Node and Bun, so this package stays dependency-free.
 */
export async function adrContentSha256(contents: string | Uint8Array): Promise<string> {
  const bytes =
    typeof contents === "string" ? utf8Encoder.encode(contents) : new Uint8Array(contents);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- Text helpers ---

function isBlank(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function trimBlanksStart(text: string): string {
  let start = 0;
  while (isBlank(text[start])) start += 1;
  return text.slice(start);
}

function trimBlanksEnd(text: string): string {
  let end = text.length;
  while (end > 0 && isBlank(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/** User text in a message: JSON-quoted and cut to 40 characters. */
function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
}
