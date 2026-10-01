import { describe, expect, it } from "vitest";
import {
  displayScopeValue,
  findScopeOverlaps,
  normalizeDeclaredPattern,
  normalizeTouchedPath,
  SCOPE_COMPARISON_BUDGET,
  type ScopeEntry,
  ScopeMatchContext,
} from "../src/scope.ts";

const declared = (value: string) => ({ source: "declared", value }) as const;
const touched = (value: string) => ({ source: "touched", value }) as const;

/** Compares two declared patterns in a fresh context. */
function intersect(a: string, b: string, context = new ScopeMatchContext()) {
  return context.compare(declared(a), declared(b));
}

/** Matches a declared pattern against a touched path in a fresh context. */
function matches(pattern: string, path: string): boolean {
  return new ScopeMatchContext().compare(declared(pattern), touched(path)).status === "overlap";
}

describe("normalizeDeclaredPattern", () => {
  it.each([
    ["src/**", "src/**"],
    ["**/**/x.ts", "**/x.ts"],
    ["a/**/**/**", "a/**"],
    ["*.ts", "*.ts"],
    ["a/!b", "a/!b"],
    ["docs/日本語/*.md", "docs/日本語/*.md"],
  ])("accepts %j as %j", (input, pattern) => {
    expect(normalizeDeclaredPattern(input)).toEqual({ status: "valid", pattern });
  });

  it.each([
    ["", "empty"],
    ["\uD800.ts", "invalid_utf8"],
    ["/src/**", "absolute"],
    ["../x", "traversal"],
    ["a/./b", "traversal"],
    ["a/..", "traversal"],
    ["./a", "traversal"],
    ["a//b", "empty_segment"],
    ["a/", "empty_segment"],
    ["a\\b", "backslash"],
    ["a\0b", "control_character"],
    ["a\nb", "control_character"],
    ["a\u007fb", "control_character"],
    ["a\u0085b", "control_character"],
    ["!src/**", "negation"],
    ["src/{a,b}.ts", "brace"],
    ["src/*.{ts", "brace"],
    ["src/[ab].ts", "character_class"],
    ["src/a].ts", "character_class"],
    ["@(a|b)", "extglob"],
    ["src/!(x)", "extglob"],
    ["+(a)", "extglob"],
    ["*(a)", "extglob"],
    ["?(a)", "extglob"],
    ["a**", "partial_globstar"],
    ["**b/c", "partial_globstar"],
    ["***", "partial_globstar"],
  ])("rejects %j as %s", (input, reason) => {
    const result = normalizeDeclaredPattern(input);
    expect(result).toMatchObject({ status: "invalid", reason });
    expect(result.status === "invalid" && result.message).toBeTruthy();
  });

  it("bounds a pattern at 256 bytes of UTF-8, counting multi-byte characters", () => {
    expect(normalizeDeclaredPattern("a".repeat(256)).status).toBe("valid");
    expect(normalizeDeclaredPattern("a".repeat(257))).toMatchObject({ reason: "too_long" });
    // 85 three-byte characters are 255 bytes.
    expect(normalizeDeclaredPattern(`${"日".repeat(85)}*`).status).toBe("valid");
    expect(normalizeDeclaredPattern(`${"日".repeat(85)}**`)).toMatchObject({ reason: "too_long" });
    expect(normalizeDeclaredPattern("😀".repeat(64)).status).toBe("valid");
    expect(normalizeDeclaredPattern(`${"😀".repeat(64)}a`)).toMatchObject({ reason: "too_long" });
  });
});

describe("normalizeTouchedPath", () => {
  it.each([
    "src/a.ts",
    ".env",
    "src/*.ts",
    "src/a?b",
    "src/a\\b.ts",
    "line\nbreak",
    "...",
    "a/.b/..c",
    "日本語/ファイル.md",
  ])("accepts %j literally", (path) => {
    expect(normalizeTouchedPath(path)).toEqual({ status: "valid", path });
  });

  it.each([
    ["", "empty"],
    ["a\0b", "nul"],
    ["/etc/passwd", "absolute"],
    ["a/../b", "traversal"],
    ["./a", "traversal"],
    ["..", "traversal"],
    ["a//b", "empty_segment"],
    ["a/", "empty_segment"],
  ])("rejects %j as %s", (path, reason) => {
    expect(normalizeTouchedPath(path)).toMatchObject({ status: "invalid", reason });
  });

  it("reports invalid UTF-8 as incomplete coverage, from bytes or a lone surrogate", () => {
    expect(normalizeTouchedPath(new Uint8Array([0x61, 0xff, 0x62]))).toMatchObject({
      status: "incomplete",
      reason: "invalid_utf8",
    });
    expect(normalizeTouchedPath("a\uDC00b")).toMatchObject({
      status: "incomplete",
      reason: "invalid_utf8",
    });
    expect(normalizeTouchedPath(new TextEncoder().encode("src/é.ts"))).toEqual({
      status: "valid",
      path: "src/é.ts",
    });
  });

  it("reports a path over 256 bytes as incomplete coverage, counting multi-byte characters", () => {
    expect(normalizeTouchedPath("é".repeat(128)).status).toBe("valid");
    expect(normalizeTouchedPath(`${"é".repeat(128)}a`)).toMatchObject({
      status: "incomplete",
      reason: "too_long",
    });
    expect(normalizeTouchedPath(`${"日".repeat(85)}a`).status).toBe("valid");
    expect(normalizeTouchedPath(`${"日".repeat(85)}ab`)).toMatchObject({ reason: "too_long" });
  });
});

describe("displayScopeValue", () => {
  it("escapes backslashes, controls and display-reordering characters", () => {
    expect(displayScopeValue("a\nb\\c\td\r\u0007\u007f\u0085‮⁦x")).toBe(
      "a\\nb\\\\c\\td\\r\\u{7}\\u{7F}\\u{85}\\u{202E}\\u{2066}x",
    );
    expect(displayScopeValue("src/日本.ts")).toBe("src/日本.ts");
  });

  it("never displays two values the same", () => {
    expect(displayScopeValue("a\\nb")).not.toBe(displayScopeValue("a\nb"));
  });
});

describe("declared/declared intersection", () => {
  it.each([
    ["*.ts", "*.tsx"],
    ["*", "*/*"],
    ["src/**", "apps/**"],
    ["a/*/b", "a/b"],
    // The only common string is `..`, which is not a path.
    [".?", "?."],
    // The only common string is `a/../b`.
    ["a/.?/b", "a/?./b"],
    // The only common string is `a/./b`.
    ["a/.*/b", "a/?/b"],
  ])("%j and %j are disjoint", (a, b) => {
    expect(intersect(a, b)).toEqual({ status: "disjoint" });
    expect(intersect(b, a)).toEqual({ status: "disjoint" });
  });

  it.each([
    ["packages/**", "packages/db/**", "packages/db"],
    ["**/x.ts", "x.ts", "x.ts"],
    ["packages/**/x", "packages/x", "packages/x"],
    ["src/*", "src/**", "src/a"],
    ["**", "**", "a"],
    // `*` may match nothing, and `.ts` is a dotfile.
    ["*.ts", "**", ".ts"],
    // Shortest common string `a//b` has an empty segment.
    ["a/*/b", "a/**/b", "a/c/b"],
    // Shortest common strings `.` and `..` are not paths.
    ["*", ".*", ".a"],
    ["**/*", ".?", ".a"],
    ["*/x", "..*/x", "..a/x"],
    // Dotfiles and dot-directories are not special.
    ["**/config", ".git/*", ".git/config"],
    ["日*", "*本", "日本"],
    ["?.md", "😀*", "😀.md"],
  ])("%j and %j intersect with shortest witness %j", (a, b, witness) => {
    expect(intersect(a, b)).toEqual({ status: "overlap", witness });
    expect(intersect(b, a)).toMatchObject({ status: "overlap" });
  });

  it("picks a stand-in character outside both patterns' literals", () => {
    const literals = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
    expect(intersect(`?/${literals}`, "?/*")).toEqual({
      status: "overlap",
      witness: `À/${literals}`,
    });
  });

  it("returns unknown, not disjoint, when the state budget runs out", () => {
    const context = new ScopeMatchContext({ stateBudget: 8 });
    expect(intersect("**/a/**/b/**/c", "**/c/**/b/**/a", context)).toEqual({
      status: "unknown",
      reason: "state_budget_exhausted",
    });
    // A pair that fits the budget still decides.
    expect(intersect("a", "b", context)).toEqual({ status: "disjoint" });
  });

  it("decides large patterns within the default budget, and not below what they need", () => {
    // Two 256-byte patterns whose `?*` runs can advance independently: the
    // search visits about 64,000 states before proving them disjoint.
    const a = `${"?*".repeat(127)}/x`;
    const b = `${"*?".repeat(127)}/y`;
    expect(new TextEncoder().encode(a)).toHaveLength(256);
    expect(intersect(a, b)).toEqual({ status: "disjoint" });
    expect(intersect(a, b, new ScopeMatchContext({ stateBudget: 60_000 }))).toEqual({
      status: "unknown",
      reason: "state_budget_exhausted",
    });
  });
});

describe("declared/touched and touched/touched comparison", () => {
  it("matches a touched path literally against one pattern", () => {
    expect(matches("**/x", "x")).toBe(true);
    expect(matches("packages/**/x", "packages/x")).toBe(true);
    expect(matches("packages/**", "packages")).toBe(true);
    expect(matches("packages/**", "packagesx/a")).toBe(false);
    expect(matches("*.ts", "a.tsx")).toBe(false);
    expect(matches("*", ".env")).toBe(true);
    expect(matches("src/*", "src/a/b")).toBe(false);
    expect(matches("?.md", "😀.md")).toBe(true);
    expect(matches("?.md", "ab.md")).toBe(false);
  });

  it("treats wildcard characters and backslashes in touched paths as ordinary characters", () => {
    expect(matches("*.ts", "*.ts")).toBe(true);
    expect(matches("src/*", "src/a\\b")).toBe(true);
    expect(matches("src/a/*", "src/a\\b")).toBe(false);
    expect(matches("a?", "a\n")).toBe(true);
    const context = new ScopeMatchContext();
    expect(context.compare(touched("*.ts"), touched("a.ts"))).toEqual({ status: "disjoint" });
    expect(context.compare(touched("src/*"), touched("src/*"))).toEqual({
      status: "overlap",
      witness: "src/*",
    });
    expect(context.comparisonsUsed).toBe(0);
  });

  it("caches compiled patterns and finished comparisons per context", () => {
    const context = new ScopeMatchContext();
    intersect("src/**", "src/*.ts", context);
    intersect("src/*.ts", "src/**", context);
    context.compare(declared("src/**"), touched("src/a.ts"));
    context.compare(touched("src/a.ts"), declared("src/**"));
    expect(context.comparisonsUsed).toBe(2);
  });

  it("throws on an invalid declared pattern", () => {
    expect(() => intersect("../x", "x")).toThrow(TypeError);
  });
});

/** An independent matcher: splits into segments and recurses. */
function bruteMatch(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = path.split("/");
  const segment = (p: string[], s: string[]): boolean => {
    if (p.length === 0) return s.length === 0;
    const [head, ...rest] = p;
    if (head === "*") return segment(rest, s) || (s.length > 0 && segment(p, s.slice(1)));
    return s.length > 0 && (head === "?" || head === s[0]) && segment(rest, s.slice(1));
  };
  const walk = (i: number, j: number): boolean => {
    if (i === patternSegments.length) return j === pathSegments.length;
    if (patternSegments[i] === "**") {
      return walk(i + 1, j) || (j < pathSegments.length && walk(i, j + 1));
    }
    return (
      j < pathSegments.length &&
      segment([...(patternSegments[i] ?? "")], [...(pathSegments[j] ?? "")]) &&
      walk(i + 1, j + 1)
    );
  };
  return walk(0, 0);
}

/** A small seeded generator, so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  return (n: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % n;
  };
}

function randomPattern(next: (n: number) => number): string {
  for (;;) {
    const segments = Array.from({ length: 1 + next(3) }, () =>
      next(5) === 0 ? "**" : Array.from({ length: 1 + next(3) }, () => "ab.*?"[next(5)]).join(""),
    );
    const result = normalizeDeclaredPattern(segments.join("/"));
    if (result.status === "valid") return result.pattern;
  }
}

/** Every normalized path over `alphabet` up to `maxLength`, shortest first. */
function allPaths(alphabet: string, maxLength: number): string[] {
  let level = [""];
  const paths: string[] = [];
  for (let length = 1; length <= maxLength; length++) {
    level = level.flatMap((prefix) => [...alphabet].map((char) => prefix + char));
    for (const path of level) if (normalizeTouchedPath(path).status === "valid") paths.push(path);
  }
  return paths;
}

describe("cross-check against a brute-force matcher", () => {
  const maxLength = 5;
  const paths = allPaths("ab./", maxLength);

  it("finds a shortest valid witness exactly when one exists", () => {
    const next = random(12);
    const outcomes = { overlap: 0, disjoint: 0 };
    for (let round = 0; round < 400; round++) {
      const a = randomPattern(next);
      const b = randomPattern(next);
      const shortest = paths.find((path) => bruteMatch(a, path) && bruteMatch(b, path));
      const result = intersect(a, b);
      const label = `${a} vs ${b}`;
      outcomes[result.status === "overlap" ? "overlap" : "disjoint"]++;
      if (result.status === "overlap") {
        expect(normalizeTouchedPath(result.witness).status, label).toBe("valid");
        expect(bruteMatch(a, result.witness), label).toBe(true);
        expect(bruteMatch(b, result.witness), label).toBe(true);
        if (shortest !== undefined) expect([...result.witness].length, label).toBe(shortest.length);
        else expect([...result.witness].length, label).toBeGreaterThan(maxLength);
      } else {
        expect(result.status, label).toBe("disjoint");
        expect(shortest, label).toBeUndefined();
      }
    }
    // The generator must exercise both outcomes for the check to mean anything.
    expect(outcomes.overlap).toBeGreaterThan(50);
    expect(outcomes.disjoint).toBeGreaterThan(50);
  });

  it("matches touched paths, including literal wildcard characters, like the brute force", () => {
    const next = random(34);
    const touchedPaths = allPaths("a.*/", 4);
    for (let round = 0; round < 100; round++) {
      const pattern = randomPattern(next);
      for (const path of touchedPaths) {
        expect(matches(pattern, path), `${pattern} vs ${path}`).toBe(bruteMatch(pattern, path));
      }
    }
  });
});

describe("findScopeOverlaps", () => {
  const entry = (sessionId: string, source: ScopeEntry["source"], value: string) => ({
    sessionId,
    source,
    value,
  });

  it("reports touched, mixed and declared overlaps with witnesses", () => {
    const report = findScopeOverlaps({
      selectedSessionId: "s1",
      entries: [
        entry("s1", "declared", "packages/db/**"),
        entry("s1", "touched", "README.md"),
        entry("s2", "touched", "README.md"),
        entry("s2", "touched", "packages/db/src/a.ts"),
        entry("s2", "touched", "apps/web/x.ts"),
        entry("s3", "declared", "apps/**"),
        entry("s4", "declared", "*.md"),
        entry("s4", "declared", "packages/**"),
      ],
    });
    expect(report).toEqual({
      complete: true,
      incomplete: [],
      overlaps: [
        {
          sessionId: "s2",
          selected: touched("README.md"),
          other: touched("README.md"),
          witness: "README.md",
        },
        {
          sessionId: "s2",
          selected: declared("packages/db/**"),
          other: touched("packages/db/src/a.ts"),
          witness: "packages/db/src/a.ts",
        },
        {
          sessionId: "s4",
          selected: touched("README.md"),
          other: declared("*.md"),
          witness: "README.md",
        },
        {
          sessionId: "s4",
          selected: declared("packages/db/**"),
          other: declared("packages/**"),
          witness: "packages/db",
        },
      ],
    });
  });

  it("reports nothing, completely, for a Session without Scopes", () => {
    expect(
      findScopeOverlaps({ selectedSessionId: "s1", entries: [entry("s2", "declared", "**")] }),
    ).toEqual({ overlaps: [], complete: true, incomplete: [] });
  });

  it("marks the report incomplete for an invalid stored value", () => {
    const report = findScopeOverlaps({
      selectedSessionId: "s1",
      entries: [entry("s1", "declared", "src/**"), entry("s2", "declared", "../src/**")],
    });
    expect(report.complete).toBe(false);
    expect(report.incomplete).toEqual([
      { kind: "invalid_entry", sessionId: "s2", source: "declared", value: "../src/**" },
    ]);
  });

  it("marks the report incomplete when a pair exhausts the state budget", () => {
    const report = findScopeOverlaps(
      {
        selectedSessionId: "s1",
        entries: [entry("s1", "declared", "**/a/**/b"), entry("s2", "declared", "**/b/**/a")],
      },
      new ScopeMatchContext({ stateBudget: 4 }),
    );
    expect(report).toEqual({
      overlaps: [],
      complete: false,
      incomplete: [
        {
          kind: "state_budget_exhausted",
          sessionId: "s2",
          selected: declared("**/a/**/b"),
          other: declared("**/b/**/a"),
        },
      ],
    });
  });

  it("stops at 4,096 comparisons per request but still compares touched paths", () => {
    const sessions = SCOPE_COMPARISON_BUDGET / 2 + 1;
    const others = Array.from({ length: sessions }, (_, index) => [
      entry(`o${index}`, "declared", `dir${index}/**`),
      entry(`o${index}`, "touched", "shared.ts"),
    ]).flat();
    const context = new ScopeMatchContext();
    const report = findScopeOverlaps(
      {
        selectedSessionId: "s1",
        entries: [
          entry("s1", "declared", "src/**"),
          entry("s1", "touched", "shared.ts"),
          ...others,
        ],
      },
      context,
    );
    expect(context.comparisonsUsed).toBe(SCOPE_COMPARISON_BUDGET);
    expect(report.complete).toBe(false);
    // Every Session shares `shared.ts`, budget or not.
    expect(report.overlaps.filter((overlap) => overlap.witness === "shared.ts")).toHaveLength(
      sessions,
    );
    const exhausted = report.incomplete.find(
      (reason) => reason.kind === "comparison_budget_exhausted",
    );
    expect(exhausted).toBeDefined();
    if (exhausted?.kind !== "comparison_budget_exhausted") return;
    // `src/**` vs `shared.ts` is compared once; then each other Session
    // needs two comparisons, `shared.ts` and `src/**` against its `dirN/**`.
    // The last two Sessions get one of their four.
    expect(exhausted.skippedComparisons).toBe(3);
    expect(exhausted.sessionIds).toEqual([`o${sessions - 2}`, `o${sessions - 1}`]);
  });

  it("does not spend comparisons on repeated pairs", () => {
    const context = new ScopeMatchContext({ comparisonBudget: 1 });
    const report = findScopeOverlaps(
      {
        selectedSessionId: "s1",
        entries: [
          entry("s1", "declared", "src/**"),
          entry("s2", "declared", "src/*.ts"),
          entry("s3", "declared", "src/*.ts"),
          entry("s3", "declared", "src/*.ts"),
        ],
      },
      context,
    );
    expect(report.complete).toBe(true);
    expect(report.overlaps.map((overlap) => overlap.sessionId)).toEqual(["s2", "s3"]);
    expect(context.comparisonsUsed).toBe(1);
  });
});
