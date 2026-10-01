import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The contract is shared by the server and the compiled CLI. Importing server
// code (the database, better-auth, Next) would drag it into the CLI binary and
// tie the wire contract to implementation details (ADR-0009). The checks use an
// allowlist, so a new dependency needs a deliberate edit here.
const ALLOWED_RUNTIME_DEPENDENCIES = ["@orpc/contract", "zod"];
const ALLOWED_DEV_DEPENDENCIES = [
  "@hivemind/config",
  "@types/node",
  "typescript",
  "vite",
  "vitest",
];

const packageRoot = new URL("..", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

// Static imports and re-exports, side-effect imports, dynamic import() and require().
const SPECIFIER =
  /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

describe("package boundaries", () => {
  it("finds every import form", () => {
    const sample = [
      'import { a } from "one";',
      'import type { B } from "two";',
      'export * from "three";',
      'import "four";',
      'const x = await import("five");',
      'const y = require("six");',
      "import {\n  multi,\n  line,\n} from 'seven';",
    ].join("\n");
    expect(importSpecifiers(sample)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
    ]);
  });

  it("imports only zod, @orpc/contract and its own files from src", () => {
    const files = sourceFiles(join(packageRoot, "src"));
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      importSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => !specifier.startsWith("./"))
        .filter((specifier) => !ALLOWED_RUNTIME_DEPENDENCIES.includes(specifier))
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it("declares only allowed dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(ALLOWED_RUNTIME_DEPENDENCIES);
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual(ALLOWED_DEV_DEPENDENCIES);
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });
});
