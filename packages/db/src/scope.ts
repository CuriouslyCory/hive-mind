/**
 * Scope values and overlap detection (issue #12, "Scopes and overlap").
 *
 * A Scope is either a declared glob pattern or a touched path, both
 * repository-relative POSIX. Everything here is pure: no database access and
 * no dependencies, so the same code runs in tests, handlers and the sweep.
 *
 * Pattern grammar. A pattern is `/`-separated segments. A segment is `**`
 * (zero or more complete segments) or a run of literal characters, `*` (zero
 * or more characters other than `/`) and `?` (exactly one Unicode code point
 * other than `/`). There is no escaping, so a declared pattern cannot name a
 * literal `*` or `?`. Dotfiles are not special: `*` matches `.env` and `**`
 * crosses `.git`, as in git's wildmatch without `FNM_PERIOD`; for overlap
 * detection the broader match is the safe one. `X/**` also matches `X`
 * itself, because `**` may match zero segments.
 *
 * Path rule. Matching, witnesses and touched paths only ever involve
 * normalized paths: nonempty, no leading, trailing or repeated `/`, and no
 * segment exactly `.` or `..`. Characters are compared as exact code points;
 * there is no Unicode normalization or case folding.
 */

/** UTF-8 bound for one declared pattern or touched path. */
export const SCOPE_VALUE_MAX_BYTES = 256;
/** Product states one declared/declared comparison may visit. */
export const SCOPE_PAIR_STATE_BUDGET = 65_536;
/** Matcher comparisons one request may run (see `ScopeMatchContext`). */
export const SCOPE_COMPARISON_BUDGET = 4_096;

export type ScopeSource = "declared" | "touched";

// ---------------------------------------------------------------------------
// Validation and normalization
// ---------------------------------------------------------------------------

export type DeclaredPatternInvalidReason =
  | "invalid_utf8"
  | "empty"
  | "too_long"
  | "control_character"
  | "backslash"
  | "absolute"
  | "negation"
  | "brace"
  | "character_class"
  | "extglob"
  | "empty_segment"
  | "traversal"
  | "partial_globstar";

export type DeclaredPatternResult =
  /** `pattern` is the normalized form: repeated `**` segments collapsed to one. */
  | { status: "valid"; pattern: string }
  | { status: "invalid"; reason: DeclaredPatternInvalidReason; message: string };

/**
 * Validates a declared glob pattern and returns its normalized form, which is
 * what should be stored and compared. Rejects rather than repairs: a trailing
 * `/`, a leading `./` or a backslash is an error, not something to guess at.
 */
export function normalizeDeclaredPattern(input: string): DeclaredPatternResult {
  const invalid = (reason: DeclaredPatternInvalidReason, message: string) =>
    ({ status: "invalid", reason, message }) as const;

  if (!input.isWellFormed()) return invalid("invalid_utf8", "Pattern is not valid UTF-8.");
  if (input === "") return invalid("empty", "Pattern is empty.");
  const bytes = utf8Length(input);
  if (bytes > SCOPE_VALUE_MAX_BYTES) {
    return invalid(
      "too_long",
      `Pattern is ${bytes} bytes; the limit is ${SCOPE_VALUE_MAX_BYTES} bytes of UTF-8.`,
    );
  }
  for (const char of input) {
    if (isControl(char.codePointAt(0) ?? 0)) {
      return invalid(
        "control_character",
        `Pattern contains the control character ${displayScopeValue(char)}.`,
      );
    }
  }
  if (input.includes("\\")) {
    return invalid("backslash", "Pattern contains a backslash; use `/` and no escapes.");
  }
  if (input.startsWith("/")) {
    return invalid("absolute", "Pattern is absolute; use a repository-relative path.");
  }
  if (input.startsWith("!")) return invalid("negation", "Negated patterns are not supported.");
  if (/[{}]/.test(input)) return invalid("brace", "Brace expansion is not supported.");
  if (/[[\]]/.test(input)) {
    return invalid("character_class", "Character classes (`[...]`) are not supported.");
  }
  if (/[?*+@!]\(/.test(input)) {
    return invalid("extglob", "Extended globs such as `@(...)` are not supported.");
  }

  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "") {
      return invalid(
        "empty_segment",
        "Pattern has an empty segment (a leading, trailing or repeated `/`).",
      );
    }
    if (segment === "." || segment === "..") {
      return invalid("traversal", "Pattern has a `.` or `..` segment.");
    }
    if (segment.includes("**") && segment !== "**") {
      return invalid("partial_globstar", "`**` must be a whole segment, as in `src/**/x`.");
    }
    // `**/**` matches exactly what `**` matches.
    if (segment === "**" && segments.at(-1) === "**") continue;
    segments.push(segment);
  }
  return { status: "valid", pattern: segments.join("/") };
}

export type TouchedPathResult =
  | { status: "valid"; path: string }
  /** Not a repository-relative path at all. */
  | {
      status: "invalid";
      reason: "empty" | "nul" | "absolute" | "empty_segment" | "traversal";
      message: string;
    }
  /**
   * A real path that cannot be represented as a Scope. Callers record it as
   * incomplete coverage, not as an error: dropping it would hide an overlap.
   */
  | { status: "incomplete"; reason: "invalid_utf8" | "too_long"; message: string };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Validates a touched path. The path is literal: `*`, `?`, newline and `\`
 * are ordinary characters, and a backslash is never a separator. Accepts raw
 * bytes (as git prints them) or a string; a string with a lone surrogate is
 * how invalid UTF-8 arrives through JSON.
 */
export function normalizeTouchedPath(input: string | Uint8Array): TouchedPathResult {
  let path: string;
  if (typeof input === "string") {
    path = input;
  } else {
    try {
      path = utf8Decoder.decode(input);
    } catch {
      path = "\uD800"; // Any ill-formed string; handled just below.
    }
  }
  if (!path.isWellFormed()) {
    return { status: "incomplete", reason: "invalid_utf8", message: "Path is not valid UTF-8." };
  }

  const invalid = (
    reason: "empty" | "nul" | "absolute" | "empty_segment" | "traversal",
    message: string,
  ) => ({ status: "invalid", reason, message }) as const;
  if (path === "") return invalid("empty", "Path is empty.");
  if (path.includes("\0")) return invalid("nul", "Path contains a NUL character.");
  if (path.startsWith("/")) {
    return invalid("absolute", "Path is absolute; use a repository-relative path.");
  }
  for (const segment of path.split("/")) {
    if (segment === "") {
      return invalid("empty_segment", "Path has an empty segment (a trailing or repeated `/`).");
    }
    if (segment === "." || segment === "..") {
      return invalid("traversal", "Path has a `.` or `..` segment.");
    }
  }

  const bytes = utf8Length(path);
  if (bytes > SCOPE_VALUE_MAX_BYTES) {
    return {
      status: "incomplete",
      reason: "too_long",
      message: `Path is ${bytes} bytes; the limit is ${SCOPE_VALUE_MAX_BYTES} bytes of UTF-8.`,
    };
  }
  return { status: "valid", path };
}

/**
 * Makes a Scope value safe to print on one terminal line. Escapes `\` as
 * `\\`, C0/C1 controls and DEL (`\n`, `\t`, `\r`, otherwise `\u{..}`), the
 * bidirectional and line-separator format characters that can reorder or
 * split displayed text, and lone surrogates. The result is unambiguous, so
 * two different values never display the same.
 */
export function displayScopeValue(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (isControl(code) || isDisplayFormat(code) || (code >= 0xd800 && code <= 0xdfff)) {
      out += `\\u{${code.toString(16).toUpperCase()}}`;
    } else out += char;
  }
  return out;
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isDisplayFormat(code: number): boolean {
  return (
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** UTF-8 length of a well-formed string. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Compiling patterns to epsilon-NFAs
// ---------------------------------------------------------------------------

/** Marks an edge that accepts any one code point other than `/`. */
const ANY = null;

interface Edge {
  on: string | typeof ANY;
  to: number;
}

/**
 * An epsilon-NFA over code points with, for every state, the moves of its
 * epsilon closure precomputed, so a step from a state is one table lookup.
 */
interface CompiledPattern {
  start: number;
  /** Literal moves from the closure of each state, keyed by code point. */
  literal: Map<string, number[]>[];
  /** Moves on any code point other than `/`, from the closure of each state. */
  any: number[][];
  /** Whether the closure of each state contains the accepting state. */
  accepting: boolean[];
  /** Every code point that appears on a literal edge, `/` included. */
  alphabet: Set<string>;
}

function compilePattern(pattern: string): CompiledPattern {
  const edges: Edge[][] = [];
  const epsilon: number[][] = [];
  const add = () => {
    edges.push([]);
    epsilon.push([]);
    return edges.length - 1;
  };
  const edge = (from: number, on: Edge["on"], to: number) => edges[from]?.push({ on, to });
  const fresh = (from: number) => {
    const state = add();
    epsilon[from]?.push(state);
    return state;
  };

  const start = add();
  let current = start;
  const segments = pattern.split("/");
  // Whether the previous `**` already consumed the `/` before this segment.
  let separatorConsumed = false;
  segments.forEach((segment, index) => {
    const first = index === 0;
    const last = index === segments.length - 1;
    if (segment === "**") {
      if (first && last) {
        // Any string; the path rule is enforced elsewhere.
        current = fresh(current);
        edge(current, ANY, current);
        edge(current, "/", current);
      } else if (last) {
        // `X/**`: (/[^/]*)*, so zero segments leaves `X`.
        const exit = add();
        const inner = add();
        epsilon[current]?.push(exit);
        edge(current, "/", inner);
        edge(inner, ANY, inner);
        edge(inner, "/", inner);
        epsilon[inner]?.push(exit);
        current = exit;
      } else {
        // `**/Y` is ([^/]*/)* Y and `X/**/Y` is X / ([^/]*/)* Y: zero
        // segments joins X and Y with a single `/`.
        if (!first) {
          const next = add();
          edge(current, "/", next);
          current = next;
        }
        const loop = fresh(current);
        const inner = add();
        edge(loop, ANY, inner);
        edge(inner, ANY, inner);
        edge(inner, "/", loop);
        edge(loop, "/", loop);
        current = loop;
      }
      separatorConsumed = !last;
      return;
    }

    if (!first && !separatorConsumed) {
      const next = add();
      edge(current, "/", next);
      current = next;
    }
    separatorConsumed = false;
    for (const char of segment) {
      if (char === "*") {
        current = fresh(current);
        edge(current, ANY, current);
      } else {
        const next = add();
        edge(current, char === "?" ? ANY : char, next);
        current = next;
      }
    }
  });
  const accept = current;

  const literal: Map<string, number[]>[] = [];
  const any: number[][] = [];
  const accepting: boolean[] = [];
  const alphabet = new Set<string>();
  for (let state = 0; state < edges.length; state++) {
    const closure = epsilonClosure(state, epsilon);
    const moves = new Map<string, number[]>();
    const anyMoves: number[] = [];
    for (const member of closure) {
      for (const { on, to } of edges[member] ?? []) {
        if (on === ANY) {
          anyMoves.push(to);
        } else {
          alphabet.add(on);
          const targets = moves.get(on);
          if (targets) targets.push(to);
          else moves.set(on, [to]);
        }
      }
    }
    literal.push(moves);
    any.push(anyMoves);
    accepting.push(closure.has(accept));
  }
  return { start, literal, any, accepting, alphabet };
}

function epsilonClosure(state: number, epsilon: number[][]): Set<number> {
  const closure = new Set([state]);
  const stack = [state];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    for (const target of epsilon[next] ?? []) {
      if (!closure.has(target)) {
        closure.add(target);
        stack.push(target);
      }
    }
  }
  return closure;
}

/** States reachable from `state` on `char`. */
function step(pattern: CompiledPattern, state: number, char: string): number[] {
  const literal = pattern.literal[state]?.get(char) ?? [];
  if (char === "/") return literal;
  const any = pattern.any[state] ?? [];
  return literal.length === 0 ? any : any.length === 0 ? literal : [...literal, ...any];
}

function matchesPath(pattern: CompiledPattern, path: string): boolean {
  let states = new Set([pattern.start]);
  for (const char of path) {
    const next = new Set<number>();
    for (const state of states) for (const target of step(pattern, state, char)) next.add(target);
    if (next.size === 0) return false;
    states = next;
  }
  for (const state of states) if (pattern.accepting[state]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Declared/declared intersection
// ---------------------------------------------------------------------------

/**
 * A DFA for the path rule, run in lockstep with both patterns so the search
 * only accepts normalized paths. Rejecting an invalid shortest witness after
 * the fact could hide a longer valid one; this cannot.
 */
const PathState = {
  /** At the start of a segment: nothing read yet, or just after `/`. */
  SegmentStart: 0,
  /** The segment so far is `.`. */
  Dot: 1,
  /** The segment so far is `..`. */
  DotDot: 2,
  /** The segment is nonempty and not `.` or `..`; the only accepting state. */
  Name: 3,
} as const;
const PATH_STATES = 4;
const DEAD = -1;

function pathStep(state: number, char: string): number {
  if (char === "/") return state === PathState.Name ? PathState.SegmentStart : DEAD;
  if (char !== ".") return PathState.Name;
  if (state === PathState.SegmentStart) return PathState.Dot;
  if (state === PathState.Dot) return PathState.DotDot;
  return PathState.Name;
}

/**
 * A code point that is in neither pattern's literal alphabet. Every such code
 * point moves both patterns and the path DFA identically (only `?`, `*` and
 * `**` accept it), so trying this one stands in for all of them.
 */
function otherCodePoint(a: CompiledPattern, b: CompiledPattern): string {
  const preferred = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
  for (const char of preferred) if (!a.alphabet.has(char) && !b.alphabet.has(char)) return char;
  // At most 512 literal code points exist across two patterns.
  for (let code = 0xc0; ; code++) {
    const char = String.fromCodePoint(code);
    if (!a.alphabet.has(char) && !b.alphabet.has(char)) return char;
  }
}

type Intersection =
  | { status: "disjoint" }
  | { status: "overlap"; witness: string }
  | { status: "unknown"; reason: "state_budget_exhausted" };

/**
 * Breadth-first search of the product of both patterns and the path DFA. The
 * first accepting product state found gives a shortest normalized path that
 * both patterns match.
 */
function intersect(a: CompiledPattern, b: CompiledPattern, stateBudget: number): Intersection {
  const other = otherCodePoint(a, b);
  const bStates = b.accepting.length;
  const key = (sa: number, sb: number, sp: number) => (sa * bStates + sb) * PATH_STATES + sp;

  const states: [number, number, number][] = [[a.start, b.start, PathState.SegmentStart]];
  // The search tree, for rebuilding the witness: parent index and the code point read.
  const parents: number[] = [-1];
  const chars: string[] = [""];
  const visited = new Set([key(a.start, b.start, PathState.SegmentStart)]);

  for (let index = 0; index < states.length; index++) {
    const [sa, sb, sp] = states[index] ?? [0, 0, 0];
    const symbols = new Set([other]);
    for (const char of a.literal[sa]?.keys() ?? []) symbols.add(char);
    for (const char of b.literal[sb]?.keys() ?? []) symbols.add(char);
    symbols.add(".");
    symbols.add("/");
    for (const char of symbols) {
      const np = pathStep(sp, char);
      if (np === DEAD) continue;
      const nextA = step(a, sa, char);
      if (nextA.length === 0) continue;
      const nextB = step(b, sb, char);
      for (const na of nextA) {
        for (const nb of nextB) {
          const k = key(na, nb, np);
          if (visited.has(k)) continue;
          if (a.accepting[na] && b.accepting[nb] && np === PathState.Name) {
            let witness = char;
            for (let at = index; at > 0; at = parents[at] ?? 0) {
              witness = (chars[at] ?? "") + witness;
            }
            return { status: "overlap", witness };
          }
          if (visited.size >= stateBudget) {
            return { status: "unknown", reason: "state_budget_exhausted" };
          }
          visited.add(k);
          states.push([na, nb, np]);
          parents.push(index);
          chars.push(char);
        }
      }
    }
  }
  return { status: "disjoint" };
}

// ---------------------------------------------------------------------------
// Comparisons and budgets
// ---------------------------------------------------------------------------

/** A Scope value with its source. Values must already be normalized. */
export interface ScopeValue {
  source: ScopeSource;
  value: string;
}

export type ScopeComparison =
  | { status: "disjoint" }
  /** `witness` is a normalized path both Scopes match. */
  | { status: "overlap"; witness: string }
  /** Not decided. Treat as a possible overlap, never as disjoint. */
  | { status: "unknown"; reason: "state_budget_exhausted" | "comparison_budget_exhausted" };

/**
 * Per-request matcher state: compiled patterns, finished comparisons and the
 * comparison budget. Create one per request and use it for every comparison,
 * so a request does bounded work however many Sessions it compares.
 */
export class ScopeMatchContext {
  readonly stateBudget: number;
  readonly comparisonBudget: number;
  #comparisonsUsed = 0;
  readonly #compiled = new Map<string, CompiledPattern>();
  readonly #results = new Map<string, ScopeComparison>();

  constructor(options: { stateBudget?: number; comparisonBudget?: number } = {}) {
    this.stateBudget = options.stateBudget ?? SCOPE_PAIR_STATE_BUDGET;
    this.comparisonBudget = options.comparisonBudget ?? SCOPE_COMPARISON_BUDGET;
  }

  /** Matcher comparisons run so far; repeated and touched/touched ones are free. */
  get comparisonsUsed(): number {
    return this.#comparisonsUsed;
  }

  /**
   * Compares two Scopes. Touched/touched is literal equality and costs
   * nothing. Declared/touched runs the pattern on the path; declared/declared
   * searches for a common path within the state budget. Each of those uses
   * one comparison, unless the same pair was already compared. Throws a
   * `TypeError` for an invalid declared pattern: check stored values with
   * `normalizeDeclaredPattern` first.
   */
  compare(a: ScopeValue, b: ScopeValue): ScopeComparison {
    if (a.source === "touched" && b.source === "touched") {
      return a.value === b.value ? { status: "overlap", witness: a.value } : { status: "disjoint" };
    }
    if (a.source === "touched" || b.source === "touched") {
      const [pattern, path] = a.source === "declared" ? [a.value, b.value] : [b.value, a.value];
      return this.#once(`t\0${pattern}\0${path}`, () =>
        matchesPath(this.#compile(pattern), path)
          ? { status: "overlap", witness: path }
          : { status: "disjoint" },
      );
    }
    const [first, second] = a.value <= b.value ? [a.value, b.value] : [b.value, a.value];
    return this.#once(`d\0${first}\0${second}`, () =>
      intersect(this.#compile(first), this.#compile(second), this.stateBudget),
    );
  }

  #compile(pattern: string): CompiledPattern {
    let compiled = this.#compiled.get(pattern);
    if (!compiled) {
      const normalized = normalizeDeclaredPattern(pattern);
      if (normalized.status !== "valid") {
        throw new TypeError(
          `Invalid declared pattern ${displayScopeValue(pattern)}: ${normalized.message}`,
        );
      }
      compiled = compilePattern(normalized.pattern);
      this.#compiled.set(pattern, compiled);
    }
    return compiled;
  }

  #once(key: string, compare: () => ScopeComparison): ScopeComparison {
    const cached = this.#results.get(key);
    if (cached) return cached;
    if (this.#comparisonsUsed >= this.comparisonBudget) {
      return { status: "unknown", reason: "comparison_budget_exhausted" };
    }
    this.#comparisonsUsed++;
    const result = compare();
    this.#results.set(key, result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Session overlap report
// ---------------------------------------------------------------------------

/** One Scope row: the Session that holds it, its source and its stored value. */
export interface ScopeEntry {
  sessionId: string;
  source: ScopeSource;
  value: string;
}

export interface ScopeOverlap {
  /** The other Session. */
  sessionId: string;
  /** The selected Session's Scope. */
  selected: ScopeValue;
  /** The other Session's Scope. */
  other: ScopeValue;
  /** A normalized path both Scopes match. */
  witness: string;
}

/**
 * Why a report is incomplete. Each one means an overlap was not ruled out,
 * so it must be shown as a possible overlap, never dropped.
 */
export type ScopeIncompleteReason =
  /** A stored value failed validation, so it could match anything. */
  | { kind: "invalid_entry"; sessionId: string; source: ScopeSource; value: string }
  /** This pattern pair needed more product states than the budget allows. */
  | { kind: "state_budget_exhausted"; sessionId: string; selected: ScopeValue; other: ScopeValue }
  /** The request ran out of comparisons; these Sessions were not fully compared. */
  | { kind: "comparison_budget_exhausted"; sessionIds: string[]; skippedComparisons: number };

function invalidEntry({ sessionId, source, value }: ScopeEntry): ScopeIncompleteReason {
  return { kind: "invalid_entry", sessionId, source, value };
}

export interface ScopeOverlapReport {
  overlaps: ScopeOverlap[];
  /** True only when every pair was decided. */
  complete: boolean;
  incomplete: ScopeIncompleteReason[];
}

/**
 * Finds the overlaps between the selected Session's Scopes and every other
 * Session's. `entries` holds the Scope rows of the selected Session and of
 * the Sessions to compare against (the caller picks which, for example the
 * Project's live Sessions); rows of the selected Session are recognized by
 * `selectedSessionId`. Duplicate rows are ignored.
 *
 * Results follow the order of first appearance of each other Session. For
 * each one, touched/touched equality runs first and is never skipped; then
 * selected-declared/other-touched, selected-touched/other-declared and
 * declared/declared comparisons, until the context's budget runs out.
 */
export function findScopeOverlaps(
  input: { selectedSessionId: string; entries: readonly ScopeEntry[] },
  context: ScopeMatchContext = new ScopeMatchContext(),
): ScopeOverlapReport {
  const overlaps: ScopeOverlap[] = [];
  const incomplete: ScopeIncompleteReason[] = [];
  const skippedSessions = new Set<string>();
  let skippedComparisons = 0;

  const sessions = new Map<string, { declared: Set<string>; touched: Set<string> }>();
  const sessionOf = (sessionId: string) => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { declared: new Set(), touched: new Set() };
      sessions.set(sessionId, session);
    }
    return session;
  };
  sessionOf(input.selectedSessionId);
  for (const entry of input.entries) {
    if (entry.source === "declared") {
      const normalized = normalizeDeclaredPattern(entry.value);
      if (normalized.status === "valid") {
        sessionOf(entry.sessionId).declared.add(normalized.pattern);
      } else {
        incomplete.push(invalidEntry(entry));
      }
    } else if (normalizeTouchedPath(entry.value).status === "valid") {
      sessionOf(entry.sessionId).touched.add(entry.value);
    } else {
      incomplete.push(invalidEntry(entry));
    }
  }

  const selected = sessionOf(input.selectedSessionId);
  for (const [sessionId, other] of sessions) {
    if (sessionId === input.selectedSessionId) continue;

    for (const path of other.touched) {
      if (selected.touched.has(path)) {
        const value: ScopeValue = { source: "touched", value: path };
        overlaps.push({ sessionId, selected: value, other: value, witness: path });
      }
    }

    const pairs: [ScopeValue, ScopeValue][] = [];
    for (const pattern of selected.declared) {
      for (const path of other.touched) {
        pairs.push([
          { source: "declared", value: pattern },
          { source: "touched", value: path },
        ]);
      }
    }
    for (const path of selected.touched) {
      for (const pattern of other.declared) {
        pairs.push([
          { source: "touched", value: path },
          { source: "declared", value: pattern },
        ]);
      }
    }
    for (const mine of selected.declared) {
      for (const theirs of other.declared) {
        pairs.push([
          { source: "declared", value: mine },
          { source: "declared", value: theirs },
        ]);
      }
    }

    for (const [mine, theirs] of pairs) {
      const result = context.compare(mine, theirs);
      if (result.status === "overlap") {
        overlaps.push({ sessionId, selected: mine, other: theirs, witness: result.witness });
      } else if (result.status === "unknown") {
        if (result.reason === "comparison_budget_exhausted") {
          skippedSessions.add(sessionId);
          skippedComparisons++;
        } else {
          incomplete.push({
            kind: "state_budget_exhausted",
            sessionId,
            selected: mine,
            other: theirs,
          });
        }
      }
    }
  }

  if (skippedComparisons > 0) {
    incomplete.push({
      kind: "comparison_budget_exhausted",
      sessionIds: [...skippedSessions],
      skippedComparisons,
    });
  }
  return { overlaps, complete: incomplete.length === 0, incomplete };
}
