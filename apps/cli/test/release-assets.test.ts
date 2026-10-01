import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TARGETS, type Target } from "../scripts/build.ts";
import { buildNpmPackages, verifyNpmPackages } from "../scripts/npm-packages.ts";
import {
  archiveName,
  CHECKSUMS_FILE,
  inspectBinary,
  readTarGz,
  tarGz,
  verifyAssets,
  writeArchive,
  writeChecksums,
} from "../scripts/release-assets.ts";

// The release directory a release run assembles from the four native jobs,
// built here from minimal ELF and Mach-O headers (a host builds only its own
// target), then broken one way at a time.

const root = mkdtempSync(join(tmpdir(), "hivemind-assets-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Just enough of an executable header for inspectBinary, plus a body marker. */
function fakeBinary(target: Target, marker: string = target): Buffer {
  const body = Buffer.from(`fake ${marker}`);
  if (target.startsWith("bun-linux")) {
    const header = Buffer.alloc(64);
    header.writeUInt32BE(0x7f454c46, 0);
    header[4] = 2; // 64-bit
    header[5] = 1; // little-endian
    header.writeUInt16LE(target.endsWith("x64") ? 0x3e : 0xb7, 18);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(48);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(target.endsWith("x64") ? 0x01000007 : 0x0100000c, 4);
  header.writeUInt32LE(1, 16); // one load command
  header.writeUInt32LE(0x1d, 32); // LC_CODE_SIGNATURE
  header.writeUInt32LE(16, 36);
  return Buffer.concat([header, body]);
}

function releaseDir(name: string, version = "1.2.3"): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const assets = join(dir, "assets");
  for (const target of TARGETS) {
    const binary = join(dir, "bin", target);
    writeFileSync(binary, fakeBinary(target));
    writeArchive({ binary, target, outDir: assets, version, mtime: 1_700_000_000 });
  }
  writeChecksums(assets);
  return assets;
}

describe("release archives", () => {
  it("are named per target and hold a single 0755 hivemind entry", () => {
    const assets = releaseDir("names");
    expect(archiveName("1.2.3", "bun-darwin-arm64")).toBe("hivemind-1.2.3-darwin-arm64.tar.gz");
    const entries = readTarGz(readFileSync(join(assets, "hivemind-1.2.3-linux-x64.tar.gz")));
    expect(entries.map(({ name, mode, type }) => ({ name, mode, type }))).toEqual([
      { name: "hivemind", mode: 0o755, type: "0" },
    ]);
  });

  it("extract with the system tar", () => {
    const assets = releaseDir("tar");
    const out = join(root, "tar", "out");
    mkdirSync(out);
    const archive = join(assets, "hivemind-1.2.3-darwin-x64.tar.gz");
    expect(spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout).toBe("hivemind\n");
    expect(spawnSync("tar", ["-xzf", archive, "-C", out]).status).toBe(0);
    expect(readFileSync(join(out, "hivemind"))).toEqual(fakeBinary("bun-darwin-x64"));
  });

  it("are byte-for-byte reproducible", () => {
    const data = fakeBinary("bun-linux-arm64");
    expect(tarGz("hivemind", data, 0o755, 1)).toEqual(tarGz("hivemind", data, 0o755, 1));
  });

  it("refuse a binary for another target", () => {
    const binary = join(root, "wrong-arch");
    writeFileSync(binary, fakeBinary("bun-linux-x64"));
    expect(() =>
      writeArchive({
        binary,
        target: "bun-linux-arm64",
        outDir: join(root, "x"),
        version: "1.0.0",
      }),
    ).toThrow(/not a bun-linux-arm64 binary: ELF machine 0x3e is not arm64/);
  });
});

describe("inspectBinary", () => {
  it("accepts each target's own format only", () => {
    for (const target of TARGETS) {
      expect(inspectBinary(fakeBinary(target), target)).toEqual([]);
      for (const other of TARGETS.filter((candidate) => candidate !== target)) {
        expect(inspectBinary(fakeBinary(target), other)).not.toEqual([]);
      }
    }
  });

  it("flags an unsigned Mach-O, the napi-rs loader and a missing addon", () => {
    const unsigned = fakeBinary("bun-darwin-arm64");
    unsigned.writeUInt32LE(0x19, 32); // LC_SEGMENT_64 instead of LC_CODE_SIGNATURE
    expect(inspectBinary(unsigned, "bun-darwin-arm64")).toEqual([
      "no LC_CODE_SIGNATURE load command",
    ]);
    const loader = Buffer.concat([
      fakeBinary("bun-linux-x64"),
      Buffer.from("NAPI_RS_NATIVE_LIBRARY_PATH"),
    ]);
    expect(inspectBinary(loader, "bun-linux-x64")[0]).toMatch(/napi-rs loader/);
    expect(
      inspectBinary(fakeBinary("bun-darwin-x64"), "bun-darwin-x64", Buffer.from("addon")),
    ).toEqual(["does not embed its Keychain addon"]);
  });
});

describe("verifyAssets", () => {
  it("accepts a complete release", () => {
    expect(verifyAssets(releaseDir("complete"), "1.2.3")).toEqual([]);
  });

  it("requires all four archives at one version", () => {
    const assets = releaseDir("missing");
    rmSync(join(assets, "hivemind-1.2.3-linux-arm64.tar.gz"));
    expect(verifyAssets(assets, "1.2.3")[0]).toMatch(/expected exactly/);
    expect(verifyAssets(releaseDir("other-version"), "1.2.4")[0]).toMatch(/expected exactly/);
  });

  it("detects a SHA256SUMS that does not match", () => {
    const assets = releaseDir("tampered");
    const archive = join(assets, "hivemind-1.2.3-darwin-arm64.tar.gz");
    writeFileSync(
      archive,
      tarGz("hivemind", fakeBinary("bun-darwin-arm64", "tampered"), 0o755, 1_700_000_000),
    );
    expect(verifyAssets(assets, "1.2.3")).toEqual([
      `${CHECKSUMS_FILE} does not match the archives`,
    ]);
  });

  it("detects an archive with the wrong binary or extra entries", () => {
    const assets = releaseDir("wrong");
    writeFileSync(
      join(assets, "hivemind-1.2.3-linux-arm64.tar.gz"),
      tarGz("hivemind", fakeBinary("bun-linux-x64"), 0o755, 0),
    );
    writeFileSync(
      join(assets, "hivemind-1.2.3-darwin-x64.tar.gz"),
      tarGz("evil", Buffer.from("x"), 0o755, 0),
    );
    writeChecksums(assets);
    expect(verifyAssets(assets, "1.2.3")).toEqual([
      "hivemind-1.2.3-linux-arm64.tar.gz: ELF machine 0x3e is not arm64",
      "hivemind-1.2.3-darwin-x64.tar.gz: must hold only a regular file named hivemind",
    ]);
  });
});

describe("npm packages from the release archives", () => {
  it("verify against the same archives and reject different binaries", () => {
    const assets = releaseDir("npm");
    const binaries = Object.fromEntries(
      TARGETS.map((target) => [target, join(root, "npm", "bin", target)]),
    );
    const outDir = join(root, "npm", "packed");
    buildNpmPackages({ binaries, outDir, version: "1.2.3" });
    expect(verifyNpmPackages(outDir, "1.2.3", assets)).toEqual([]);
    expect(verifyNpmPackages(outDir, "1.2.4")).toEqual(
      expect.arrayContaining([expect.stringMatching(/is 1\.2\.3, not 1\.2\.4/)]),
    );

    const other = releaseDir("npm-other");
    writeFileSync(
      join(other, "hivemind-1.2.3-linux-x64.tar.gz"),
      tarGz("hivemind", fakeBinary("bun-linux-x64", "rebuilt"), 0o755, 0),
    );
    expect(verifyNpmPackages(outDir, "1.2.3", other)).toEqual([
      expect.stringMatching(/linux-x64: binary differs from hivemind-1\.2\.3-linux-x64\.tar\.gz/),
    ]);
  });
});
