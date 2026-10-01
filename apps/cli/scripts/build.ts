// Compiles the CLI into a standalone `hivemind` executable with the pinned Bun.
//
//   node scripts/build.ts [--target <target>] [--entry <file>] [--outfile <path>]
//                         [--commit <sha>] [--default-origin <url>]
//
// --target          bun-linux-x64 | bun-linux-arm64 | bun-darwin-x64 | bun-darwin-arm64.
//                   Default: the host. Host builds go to dist/hivemind, others
//                   to dist/<target>/hivemind.
// --entry           Entry file, relative to apps/cli. Default: src/index.ts.
//                   Test and native-smoke entries reuse the same flags.
// --commit          Commit embedded for --version. Default: $HIVEMIND_BUILD_COMMIT,
//                   else "unknown". Not read from git, so a Turborepo cache hit
//                   can never replay a binary stamped with a stale commit.
// --default-origin  Backend used when neither --server nor HIVEMIND_URL is set.
//                   Default: PRODUCTION_ORIGIN from src/build-info.ts.
//
// Runs on Node (`pnpm build`), not Bun: Bun is a devDependency whose install
// script is not run (pnpm-workspace.yaml), so this script resolves the
// lockfile-pinned @oven/bun-* binary itself, both to run `bun build` and as the
// executable base for the target, so no runtime is downloaded at build time.
//
// pnpm installs only the host's optional platform packages (STATE.md D11), so
// a host can build only its own target. Release binaries are built on each
// target's native runner (.github/workflows/cli-native.yml and release.yml),
// which also runs that binary's native smoke test. Building another target
// here fails with a message naming the missing packages.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PRODUCTION_ORIGIN } from "../src/build-info.ts";

export const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const;
export type Target = (typeof TARGETS)[number];

export const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// npm package holding the Bun runtime for each target. Bun names arm64 aarch64.
const RUNTIME_PACKAGES: Record<Target, string> = {
  "bun-linux-x64": "@oven/bun-linux-x64",
  "bun-linux-arm64": "@oven/bun-linux-aarch64",
  "bun-darwin-x64": "@oven/bun-darwin-x64",
  "bun-darwin-arm64": "@oven/bun-darwin-aarch64",
};

// Keychain addon each Darwin target embeds (src/credentials/keychain-binding.ts).
// Linux targets embed no addon.
const ADDON_PACKAGES: Partial<Record<Target, string>> = {
  "bun-darwin-x64": "@napi-rs/keyring-darwin-x64",
  "bun-darwin-arm64": "@napi-rs/keyring-darwin-arm64",
};

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Target {
  const target = `bun-${platform}-${arch}`;
  if (!isTarget(target)) {
    throw new Error(
      `hivemind does not support ${platform}/${arch}. Supported: ${TARGETS.join(", ")}`,
    );
  }
  return target;
}

/**
 * Accepts https origins, or http only on loopback (STATE.md D3). Rejects
 * paths, queries, fragments and userinfo so the embedded value is a bare origin.
 */
export function validateOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--default-origin is not a URL: ${value}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`--default-origin must be https (http only for localhost): ${value}`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`--default-origin must be a bare origin without path or credentials: ${value}`);
  }
  return url.origin;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The exact Bun version apps/cli pins; also checked against each runtime package. */
export function pinnedBunVersion(): string {
  const manifest = readJson(join(CLI_ROOT, "package.json")) as {
    devDependencies?: Record<string, string>;
  };
  const version = manifest.devDependencies?.bun;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`apps/cli/package.json must pin bun to an exact version, found ${version}`);
  }
  return version;
}

function resolveFromBun(pkg: string): string | undefined {
  // The runtime packages are optional dependencies of `bun`, so pnpm links
  // them next to it in the store; resolve from there.
  const fromBun = createRequire(
    createRequire(join(CLI_ROOT, "package.json")).resolve("bun/package.json"),
  );
  try {
    return fromBun.resolve(`${pkg}/package.json`);
  } catch {
    return undefined;
  }
}

function resolveFromCli(pkg: string): string | undefined {
  try {
    return createRequire(join(CLI_ROOT, "package.json")).resolve(`${pkg}/package.json`);
  } catch {
    return undefined;
  }
}

/**
 * Platform packages `target` needs that this install lacks. Empty for the host;
 * for other targets usually not, because pnpm installs only the host's optional
 * platform packages.
 */
export function missingTargetPackages(target: Target): string[] {
  const missing: string[] = [];
  if (resolveFromBun(RUNTIME_PACKAGES[target]) === undefined)
    missing.push(RUNTIME_PACKAGES[target]);
  const addon = ADDON_PACKAGES[target];
  if (addon !== undefined && resolveFromCli(addon) === undefined) missing.push(addon);
  return missing;
}

function targetNotInstalled(target: Target, missing: readonly string[]): Error {
  return new Error(
    `cannot build ${target} here: ${missing.join(", ")} not installed. pnpm installs only ` +
      `this host's platform packages, so build ${target} on a native ${target.slice(4)} ` +
      "runner (see .github/workflows/cli-native.yml), or run 'pnpm install' if this is the host.",
  );
}

function assertTargetInstalled(target: Target): void {
  const missing = missingTargetPackages(target);
  if (missing.length > 0) throw targetNotInstalled(target, missing);
}

/** Path to the Bun executable for `target`, from the installed @oven/bun-* package. */
export function bunExecutable(target: Target): string {
  const pkg = RUNTIME_PACKAGES[target];
  const manifestPath = resolveFromBun(pkg);
  if (manifestPath === undefined) throw targetNotInstalled(target, missingTargetPackages(target));
  const version = readJson(manifestPath).version;
  const pinned = pinnedBunVersion();
  if (version !== pinned) {
    throw new Error(
      `${pkg} is ${String(version)} but apps/cli pins bun ${pinned}. Run 'pnpm install'.`,
    );
  }
  return join(dirname(manifestPath), "bin", "bun");
}

export interface BuildOptions {
  target?: Target;
  entry?: string;
  outfile?: string;
  commit?: string;
  defaultOrigin?: string;
}

export interface BuildPlan {
  bun: string;
  args: string[];
  outfile: string;
  defines: Record<string, string>;
}

/** Computes the `bun build` invocation without running it. */
export function planBuild(options: BuildOptions = {}): BuildPlan {
  const host = hostTarget();
  const target = options.target ?? host;
  // Checked up front: a missing Darwin addon would otherwise surface as an
  // unresolved require deep in Bun's output.
  assertTargetInstalled(target);
  const entry = options.entry ?? "src/index.ts";
  const outfile = resolve(
    CLI_ROOT,
    options.outfile ??
      (options.target === undefined ? "dist/hivemind" : join("dist", target, "hivemind")),
  );
  const commit = options.commit ?? process.env.HIVEMIND_BUILD_COMMIT ?? "unknown";
  if (!/^[0-9A-Za-z._-]{1,64}$/.test(commit)) {
    throw new Error(`--commit must be a short identifier such as a git SHA: ${commit}`);
  }
  const version = readJson(join(CLI_ROOT, "package.json")).version;
  if (typeof version !== "string") throw new Error("apps/cli/package.json has no version");

  // Values are JSON literals; `--define` substitutes them as expressions.
  const defines: Record<string, string> = {
    HIVEMIND_BUILD_VERSION: JSON.stringify(version),
    HIVEMIND_BUILD_COMMIT: JSON.stringify(commit),
    HIVEMIND_BUILD_TARGET: JSON.stringify(target),
    HIVEMIND_DEFAULT_ORIGIN: JSON.stringify(
      validateOrigin(options.defaultOrigin ?? PRODUCTION_ORIGIN),
    ),
  };

  const args = [
    "build",
    // Build-time hygiene: ignore any .env next to the sources, and never
    // inline process.env values (tokens included) into the bundle.
    "--no-env-file",
    "--env=disable",
    "--compile",
    `--target=${target}`,
    `--compile-executable-path=${bunExecutable(target)}`,
    // Runtime hygiene: the compiled binary must not read .env, bunfig.toml,
    // tsconfig.json or package.json from the directory it is run in, or a
    // repository could change its behavior (issue #3 step 9).
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    "--minify",
    "--sourcemap=none",
    ...Object.entries(defines).map(([name, value]) => `--define=${name}=${value}`),
    `--outfile=${outfile}`,
    entry,
  ];
  return { bun: bunExecutable(host), args, outfile, defines };
}

/** Compiles one binary and returns its path. Throws with Bun's output on failure. */
export function build(options: BuildOptions = {}): string {
  const plan = planBuild(options);
  mkdirSync(dirname(plan.outfile), { recursive: true });
  const result = spawnSync(plan.bun, plan.args, {
    cwd: CLI_ROOT,
    encoding: "utf8",
    // Bun sees only what it needs to run. Nothing from the caller's
    // environment, such as HIVEMIND_TOKEN, can reach the bundle.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`bun build failed (exit ${result.status}):\n${result.stderr}${result.stdout}`);
  }
  return plan.outfile;
}

function runFromCommandLine(): void {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      entry: { type: "string" },
      outfile: { type: "string" },
      commit: { type: "string" },
      "default-origin": { type: "string" },
    },
    strict: true,
  });
  if (values.target !== undefined && !isTarget(values.target)) {
    throw new Error(`unknown --target ${values.target}. Expected one of: ${TARGETS.join(", ")}`);
  }
  const outfile = build({
    target: values.target,
    entry: values.entry,
    outfile: values.outfile,
    commit: values.commit,
    defaultOrigin: values["default-origin"],
  });
  const shown = relative(process.cwd(), outfile);
  process.stdout.write(`built ${shown.startsWith("..") ? outfile : shown}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runFromCommandLine();
  } catch (error) {
    process.stderr.write(`build: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
