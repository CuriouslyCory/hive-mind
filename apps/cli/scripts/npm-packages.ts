// Generates and packs the public npm packages from the release binaries.
//
//   node scripts/npm-packages.ts --assets <dir> --out-dir <dir>
//   node scripts/npm-packages.ts --binary <target>=<path> [...] --out-dir <dir>
//   node scripts/npm-packages.ts verify --out-dir <dir> [--assets <dir>]
//
// The launcher package is npm/package.template.json plus npm/bin/hivemind.js.
// Its name in that template is the only place the public name is written
// (ADR-0012, docs/setup.md H7); each binary ships in `<name>-<os>-<arch>`, an optional
// dependency limited to that platform by os/cpu/libc. Every package gets
// apps/cli's version, so the published launcher, its binaries and the
// GitHub release always agree.
//
// Why optional platform packages rather than downloading on first run: the
// binary arrives through the registry with npm's integrity check, installs
// work offline and behind registry mirrors, nothing runs at install time
// (pnpm and npm can block install scripts), and the GitHub repository can stay
// private. The cost is publishing five packages instead of one.
//
// --assets reads the binaries out of the release archives, so the npm packages
// hold the same bytes as the smoke-tested GitHub release assets. Output:
// <out-dir>/*.tgz from `npm pack`, and <out-dir>/npm-packages.json listing
// name, version, file and integrity for the publish job.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CLI_ROOT, isTarget, TARGETS, type Target } from "./build.ts";
import {
  archiveName,
  BINARY_NAME,
  cliVersion,
  inspectBinary,
  readTarGz,
  sha256,
  targetParts,
} from "./release-assets.ts";

const NPM_DIR = join(CLI_ROOT, "npm");
const LAUNCHER_FILES = ["README.md", "bin/hivemind.js", "package.json"];
const PLATFORM_FILES = ["README.md", `bin/${BINARY_NAME}`, "package.json"];

interface Template {
  name: string;
  repository: unknown;
  [key: string]: unknown;
}

export function launcherTemplate(): Template {
  return JSON.parse(readFileSync(join(NPM_DIR, "package.template.json"), "utf8")) as Template;
}

/** The public launcher package name; npm/package.template.json is its single source. */
export function launcherName(): string {
  return launcherTemplate().name;
}

export function platformPackageName(target: Target, name: string = launcherName()): string {
  const { os, arch } = targetParts(target);
  return `${name}-${os}-${arch}`;
}

export interface PackedPackage {
  name: string;
  version: string;
  file: string;
  integrity: string;
  shasum: string;
  files: { path: string; mode: number }[];
}

function npmPack(dir: string, outDir: string): PackedPackage {
  // Run from the package directory so npm reads that manifest, not the
  // workspace root (whose devEngines would reject npm).
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", outDir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" },
  });
  if (result.status !== 0) throw new Error(`npm pack in ${dir} failed:\n${result.stderr}`);
  const [packed] = JSON.parse(result.stdout) as {
    name: string;
    version: string;
    filename: string;
    integrity: string;
    shasum: string;
    files: { path: string; mode: number }[];
  }[];
  if (!packed) throw new Error(`npm pack in ${dir} printed nothing`);
  return {
    name: packed.name,
    version: packed.version,
    file: packed.filename,
    integrity: packed.integrity,
    shasum: packed.shasum,
    files: packed.files
      .map(({ path, mode }) => ({ path, mode }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Stages and packs the launcher plus one package per given binary. */
export function buildNpmPackages(options: {
  binaries: Partial<Record<Target, string>>;
  outDir: string;
  version?: string;
}): PackedPackage[] {
  const version = options.version ?? cliVersion();
  const template = launcherTemplate();
  const name = template.name;
  const readme = readFileSync(join(NPM_DIR, "README.md"), "utf8").replaceAll("{{name}}", name);
  const stage = join(options.outDir, "stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const packed: PackedPackage[] = [];

  for (const [target, binary] of Object.entries(options.binaries) as [Target, string][]) {
    const { os, arch } = targetParts(target);
    const problems = inspectBinary(readFileSync(binary), target);
    if (problems.length > 0) throw new Error(`${binary}: ${problems.join("; ")}`);
    const dir = join(stage, `${os}-${arch}`);
    mkdirSync(join(dir, "bin"), { recursive: true });
    copyFileSync(binary, join(dir, "bin", BINARY_NAME));
    chmodSync(join(dir, "bin", BINARY_NAME), 0o755);
    const platformName = platformPackageName(target, name);
    writeFileSync(
      join(dir, "README.md"),
      `# ${platformName}\n\nThe \`${BINARY_NAME}\` binary for ${os} ${arch}. Install [${name}](https://www.npmjs.com/package/${name}) instead; it selects this package for you.\n`,
    );
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: platformName,
          version,
          description: `The ${BINARY_NAME} binary for ${os} ${arch}, used by ${name}.`,
          repository: template.repository,
          os: [os],
          cpu: [arch],
          ...(os === "linux" ? { libc: ["glibc"] } : {}),
          files: [`bin/${BINARY_NAME}`, "README.md"],
        },
        null,
        2,
      )}\n`,
    );
    packed.push(npmPack(dir, options.outDir));
  }

  const launcher = join(stage, "launcher");
  mkdirSync(join(launcher, "bin"), { recursive: true });
  copyFileSync(join(NPM_DIR, "bin", "hivemind.js"), join(launcher, "bin", "hivemind.js"));
  chmodSync(join(launcher, "bin", "hivemind.js"), 0o755);
  writeFileSync(join(launcher, "README.md"), readme);
  writeFileSync(
    join(launcher, "package.json"),
    `${JSON.stringify(
      {
        ...template,
        version,
        optionalDependencies: Object.fromEntries(
          TARGETS.map((target) => [platformPackageName(target, name), version]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  packed.push(npmPack(launcher, options.outDir));
  writeFileSync(join(options.outDir, "npm-packages.json"), `${JSON.stringify(packed, null, 2)}\n`);
  return packed;
}

/** Reads the binary out of each release archive in `assetsDir` into `outDir`. */
export function binariesFromAssets(assetsDir: string, outDir: string, version: string) {
  const binaries: Partial<Record<Target, string>> = {};
  for (const target of TARGETS) {
    const entries = readTarGz(readFileSync(join(assetsDir, archiveName(version, target))));
    const entry = entries.find((candidate) => candidate.name === BINARY_NAME);
    if (entries.length !== 1 || !entry)
      throw new Error(`${archiveName(version, target)} is malformed`);
    const path = join(outDir, "binaries", target, BINARY_NAME);
    mkdirSync(join(outDir, "binaries", target), { recursive: true });
    writeFileSync(path, entry.data, { mode: 0o755 });
    binaries[target] = path;
  }
  return binaries;
}

/**
 * Problems with a packed set, empty if none: exactly the launcher and four
 * platform packages at `version`, only the expected files, an executable
 * binary per platform and, given the release assets, the same binary bytes.
 */
export function verifyNpmPackages(outDir: string, version: string, assetsDir?: string): string[] {
  const problems: string[] = [];
  const name = launcherName();
  const packed = JSON.parse(
    readFileSync(join(outDir, "npm-packages.json"), "utf8"),
  ) as PackedPackage[];
  const expected = [name, ...TARGETS.map((target) => platformPackageName(target, name))].sort();
  const names = packed.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    problems.push(`expected packages ${expected.join(", ")}; found ${names.join(", ")}`);
  }
  for (const entry of packed) {
    if (entry.version !== version)
      problems.push(`${entry.name} is ${entry.version}, not ${version}`);
    const tarball = readFileSync(join(outDir, entry.file));
    const files = readTarGz(tarball);
    const paths = files.map((file) => file.name.replace(/^package\//, "")).sort();
    const isLauncher = entry.name === name;
    const wanted = isLauncher ? LAUNCHER_FILES : PLATFORM_FILES;
    if (JSON.stringify(paths) !== JSON.stringify(wanted)) {
      problems.push(`${entry.name} holds ${paths.join(", ")}; expected ${wanted.join(", ")}`);
      continue;
    }
    const manifest = JSON.parse(
      String(files.find((file) => file.name === "package/package.json")?.data),
    ) as Record<string, unknown>;
    if (manifest.private === true) problems.push(`${entry.name} is private`);
    if (isLauncher) {
      const bin = manifest.bin as Record<string, string> | undefined;
      if (bin?.hivemind !== "bin/hivemind.js" || Object.keys(bin).length !== 1) {
        problems.push(`${name} bin must be exactly { hivemind: "bin/hivemind.js" }`);
      }
      const optional = manifest.optionalDependencies as Record<string, string> | undefined;
      for (const target of TARGETS) {
        if (optional?.[platformPackageName(target, name)] !== version) {
          problems.push(`${name} must depend on ${platformPackageName(target, name)}@${version}`);
        }
      }
      if (manifest.dependencies !== undefined) problems.push(`${name} must have no dependencies`);
      continue;
    }
    const target = TARGETS.find((candidate) => platformPackageName(candidate, name) === entry.name);
    const binary = files.find((file) => file.name === `package/bin/${BINARY_NAME}`);
    if (!target || !binary) continue;
    const { os, arch } = targetParts(target);
    if (JSON.stringify([manifest.os, manifest.cpu]) !== JSON.stringify([[os], [arch]])) {
      problems.push(`${entry.name} has os/cpu ${JSON.stringify([manifest.os, manifest.cpu])}`);
    }
    if ((binary.mode & 0o111) === 0)
      problems.push(`${entry.name}: bin/${BINARY_NAME} is not executable`);
    for (const problem of inspectBinary(binary.data, target))
      problems.push(`${entry.name}: ${problem}`);
    if (assetsDir !== undefined) {
      const archived = readTarGz(readFileSync(join(assetsDir, archiveName(version, target))))[0];
      if (!archived || sha256(archived.data) !== sha256(binary.data)) {
        problems.push(`${entry.name}: binary differs from ${archiveName(version, target)}`);
      }
    }
  }
  return problems;
}

function runFromCommandLine(): void {
  const args = process.argv.slice(2);
  const verify = args[0] === "verify";
  const { values } = parseArgs({
    args: verify ? args.slice(1) : args,
    options: {
      assets: { type: "string" },
      binary: { type: "string", multiple: true },
      "out-dir": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  if (!values["out-dir"]) throw new Error("--out-dir is required");
  const outDir = resolve(values["out-dir"]);
  const version = values.version ?? cliVersion();
  const assets = values.assets === undefined ? undefined : resolve(values.assets);

  if (verify) {
    const problems = verifyNpmPackages(outDir, version, assets);
    if (problems.length > 0)
      throw new Error(`npm packages in ${outDir}:\n  ${problems.join("\n  ")}`);
    process.stdout.write(`verified npm packages in ${outDir}\n`);
    return;
  }

  let binaries: Partial<Record<Target, string>> = {};
  if (assets !== undefined) binaries = binariesFromAssets(assets, outDir, version);
  for (const spec of values.binary ?? []) {
    const [target, path] = spec.split("=", 2);
    if (!target || !path || !isTarget(target))
      throw new Error(`--binary wants <target>=<path>: ${spec}`);
    binaries[target] = resolve(path);
  }
  for (const entry of buildNpmPackages({ binaries, outDir, version })) {
    process.stdout.write(`${entry.file}  ${entry.integrity}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runFromCommandLine();
  } catch (error) {
    process.stderr.write(`npm-packages: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
