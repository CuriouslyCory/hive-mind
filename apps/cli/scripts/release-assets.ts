// Release archives and checksums for the hivemind binaries.
//
//   node scripts/release-assets.ts archive --binary <path> --target <target> --out-dir <dir>
//   node scripts/release-assets.ts checksums --dir <dir>
//   node scripts/release-assets.ts verify --dir <dir> [--version <version>]
//
// archive    Packs one binary as hivemind-<version>-<os>-<arch>.tar.gz holding a
//            single 0755 file named `hivemind`. The version is apps/cli's
//            package.json version, the same one build.ts embeds.
// checksums  Writes SHA256SUMS (sha256sum format) for every archive in <dir>.
// verify     Checks that <dir> holds exactly the four archives for one version
//            plus a SHA256SUMS that matches them, and that each archive holds
//            only a `hivemind` binary of the right format for its target.
//
// The tar writer is in-process rather than the system `tar` so that archives
// built on GNU (Linux) and BSD (macOS) runners have the same layout, and so a
// rebuild of an unchanged binary yields the same bytes. That matters for
// release reruns: an asset already on a draft release is compared, never
// overwritten (.github/workflows/release.yml).

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { CLI_ROOT, isTarget, TARGETS, type Target } from "./build.ts";

export const BINARY_NAME = "hivemind";
export const CHECKSUMS_FILE = "SHA256SUMS";

/** apps/cli's version, which build.ts embeds and Changesets bumps. */
export function cliVersion(): string {
  const { version } = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`apps/cli/package.json has no valid version: ${String(version)}`);
  }
  return version;
}

/** `bun-linux-x64` -> `{ os: "linux", arch: "x64" }`. */
export function targetParts(target: Target): { os: "linux" | "darwin"; arch: "x64" | "arm64" } {
  const [, os, arch] = target.split("-") as [string, "linux" | "darwin", "x64" | "arm64"];
  return { os, arch };
}

export function archiveName(version: string, target: Target): string {
  const { os, arch } = targetParts(target);
  return `${BINARY_NAME}-${version}-${os}-${arch}.tar.gz`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- tar (ustar), single regular file -------------------------------------

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** A gzipped ustar archive holding one regular file. Deterministic for equal inputs. */
export function tarGz(name: string, data: Uint8Array, mode: number, mtime: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(octal(mode, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii"); // uid
  header.write(octal(0, 8), 116, "ascii"); // gid
  header.write(octal(data.length, 12), 124, "ascii");
  header.write(octal(mtime, 12), 136, "ascii");
  header.write("        ", 148, "ascii"); // checksum placeholder: eight spaces
  header.write("0", 156, "ascii"); // regular file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  const tar = Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
  return gzipSync(tar, { level: 9 });
}

export interface TarEntry {
  name: string;
  mode: number;
  type: string;
  data: Buffer;
}

/** Reads every entry of a gzipped tar. Only what verify needs: no long names or pax. */
export function readTarGz(archive: Uint8Array): TarEntry[] {
  const tar = gunzipSync(archive);
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "")
        .trim();
    const size = Number.parseInt(field(124, 12), 8);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    entries.push({
      name,
      mode: Number.parseInt(field(100, 8), 8),
      type: field(156, 1) || "0",
      data: tar.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// --- binary format checks --------------------------------------------------

const ELF_MACHINE: Record<string, number> = { x64: 0x3e, arm64: 0xb7 };
const MACHO_CPU: Record<string, number> = { x64: 0x01000007, arm64: 0x0100000c };
const LC_CODE_SIGNATURE = 0x1d;

function machoLoadCommands(binary: Buffer): number[] {
  const count = binary.readUInt32LE(16);
  const commands: number[] = [];
  let offset = 32;
  for (let i = 0; i < count && offset + 8 <= binary.length; i++) {
    commands.push(binary.readUInt32LE(offset));
    offset += binary.readUInt32LE(offset + 4);
  }
  return commands;
}

/**
 * Problems with a compiled binary for `target`, empty if none: wrong
 * executable format or CPU, a missing code signature on macOS, the generic
 * napi-rs loader (it honors NAPI_RS_NATIVE_LIBRARY_PATH, an arbitrary dlopen
 * via the environment), and, when `addon` is given, a Keychain addon that was
 * not embedded byte for byte.
 */
export function inspectBinary(binary: Buffer, target: Target, addon?: Buffer): string[] {
  const { os, arch } = targetParts(target);
  const problems: string[] = [];
  if (os === "linux") {
    if (binary.readUInt32BE(0) !== 0x7f454c46) problems.push("not an ELF file");
    else if (binary[4] !== 2 || binary[5] !== 1) problems.push("not a 64-bit little-endian ELF");
    else if (binary.readUInt16LE(18) !== ELF_MACHINE[arch]) {
      problems.push(`ELF machine 0x${binary.readUInt16LE(18).toString(16)} is not ${arch}`);
    }
  } else {
    if (binary.readUInt32LE(0) !== 0xfeedfacf) problems.push("not a 64-bit Mach-O file");
    else {
      if (binary.readUInt32LE(4) !== MACHO_CPU[arch]) problems.push(`Mach-O CPU is not ${arch}`);
      // build.ts signs Darwin binaries ad hoc; Apple silicon refuses to run
      // unsigned code. Validity is checked by codesign in scripts/smoke.ts.
      if (!machoLoadCommands(binary).includes(LC_CODE_SIGNATURE)) {
        problems.push("no LC_CODE_SIGNATURE load command");
      }
    }
  }
  if (binary.includes("NAPI_RS_NATIVE_LIBRARY_PATH")) {
    problems.push("bundles the generic napi-rs loader (NAPI_RS_NATIVE_LIBRARY_PATH)");
  }
  if (addon !== undefined && !binary.includes(addon)) {
    problems.push("does not embed its Keychain addon");
  }
  return problems;
}

// --- commands ----------------------------------------------------------------

/** Writes the archive for one binary and returns its path. */
export function writeArchive(options: {
  binary: string;
  target: Target;
  outDir: string;
  version?: string;
  mtime?: number;
}): string {
  const version = options.version ?? cliVersion();
  const bytes = readFileSync(options.binary);
  const problems = inspectBinary(bytes, options.target);
  if (problems.length > 0) {
    throw new Error(`${options.binary} is not a ${options.target} binary: ${problems.join("; ")}`);
  }
  mkdirSync(options.outDir, { recursive: true });
  const path = join(options.outDir, archiveName(version, options.target));
  writeFileSync(path, tarGz(BINARY_NAME, bytes, 0o755, options.mtime ?? 0));
  return path;
}

function archivesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${BINARY_NAME}-`) && name.endsWith(".tar.gz"))
    .sort();
}

export function checksumsText(dir: string): string {
  return archivesIn(dir)
    .map((name) => `${sha256(readFileSync(join(dir, name)))}  ${name}\n`)
    .join("");
}

export function writeChecksums(dir: string): string {
  const path = join(dir, CHECKSUMS_FILE);
  writeFileSync(path, checksumsText(dir));
  return path;
}

/** Problems with a complete release asset directory, empty if none. */
export function verifyAssets(dir: string, version: string = cliVersion()): string[] {
  const problems: string[] = [];
  const expected = TARGETS.map((target) => archiveName(version, target)).sort();
  const present = readdirSync(dir).sort();
  const wanted = [...expected, CHECKSUMS_FILE].sort();
  if (JSON.stringify(present) !== JSON.stringify(wanted)) {
    problems.push(
      `expected exactly ${wanted.join(", ")}; found ${present.join(", ") || "nothing"}`,
    );
    return problems;
  }
  const sums = readFileSync(join(dir, CHECKSUMS_FILE), "utf8");
  if (sums !== checksumsText(dir)) problems.push(`${CHECKSUMS_FILE} does not match the archives`);
  for (const target of TARGETS) {
    const name = archiveName(version, target);
    let entries: TarEntry[];
    try {
      entries = readTarGz(readFileSync(join(dir, name)));
    } catch (error) {
      problems.push(`${name}: unreadable (${(error as Error).message})`);
      continue;
    }
    const [entry] = entries;
    if (entries.length !== 1 || entry?.name !== BINARY_NAME || entry.type !== "0") {
      problems.push(`${name}: must hold only a regular file named ${BINARY_NAME}`);
      continue;
    }
    if (entry.mode !== 0o755) problems.push(`${name}: mode is ${entry.mode.toString(8)}, not 755`);
    for (const problem of inspectBinary(entry.data, target)) problems.push(`${name}: ${problem}`);
  }
  return problems;
}

function runFromCommandLine(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      binary: { type: "string" },
      target: { type: "string" },
      "out-dir": { type: "string" },
      dir: { type: "string" },
      version: { type: "string" },
      mtime: { type: "string" },
    },
    strict: true,
  });
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (value === undefined) throw new Error(`${command} needs --${name}`);
    return value;
  };
  switch (command) {
    case "archive": {
      const target = required("target");
      if (!isTarget(target)) throw new Error(`unknown --target ${target}`);
      const mtime = values.mtime === undefined ? 0 : Number(values.mtime);
      if (!Number.isInteger(mtime) || mtime < 0) throw new Error("--mtime must be epoch seconds");
      const path = writeArchive({
        binary: resolve(required("binary")),
        target,
        outDir: resolve(required("out-dir")),
        version: values.version,
        mtime,
      });
      process.stdout.write(`${path}\n`);
      return;
    }
    case "checksums":
      process.stdout.write(`${writeChecksums(resolve(required("dir")))}\n`);
      return;
    case "verify": {
      const dir = resolve(required("dir"));
      const problems = verifyAssets(dir, values.version ?? cliVersion());
      if (problems.length > 0)
        throw new Error(`release assets in ${dir}:\n  ${problems.join("\n  ")}`);
      process.stdout.write(`verified ${dir}\n`);
      return;
    }
    default:
      throw new Error("usage: release-assets.ts archive|checksums|verify [options]");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runFromCommandLine();
  } catch (error) {
    process.stderr.write(`release-assets: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
