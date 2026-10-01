import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, hostTarget, TARGETS } from "../scripts/build.ts";
import {
  buildNpmPackages,
  launcherName,
  type PackedPackage,
  platformPackageName,
} from "../scripts/npm-packages.ts";
import { cliVersion, readTarGz } from "../scripts/release-assets.ts";
import { startServer } from "./helpers/api-server.ts";
import { shippedBinary } from "./helpers/binaries.ts";

// The npm launcher as users get it: packed with `npm pack`, installed globally
// into a temp prefix from the tarballs (offline, no registry), and run through
// the `hivemind` bin npm links. One install uses the real binary from
// `pnpm build`; another uses a compiled fixture whose exit and signal
// behavior the tests control.

const root = mkdtempSync(join(tmpdir(), "hivemind-npm-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function npm(args: string[]) {
  // From a temp cwd: npm in the repository would read the root package.json,
  // whose devEngines asks for pnpm.
  const result = spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      npm_config_cache: join(root, "npm-cache"),
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

/** Packs the launcher plus the host package around `binary` and installs them globally. */
function install(name: string, binary: string, extra: string[] = []) {
  const outDir = join(root, name, "packed");
  mkdirSync(outDir, { recursive: true });
  const packed = buildNpmPackages({ binaries: { [hostTarget()]: binary }, outDir });
  const prefix = join(root, name, "prefix");
  const tarballs = packed
    .filter((entry) => !extra.includes("--omit=optional") || entry.name === launcherName())
    .map((entry) => join(outDir, entry.file));
  npm(["install", "--global", "--offline", "--prefix", prefix, ...extra, ...tarballs]);
  return { packed, outDir, bin: join(prefix, "bin", "hivemind"), prefix };
}

function launcherScript(prefix: string): string {
  return join(prefix, "lib", "node_modules", launcherName(), "bin", "hivemind.js");
}

function start(bin: string, args: string[]): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) resolve();
    });
    child.on("exit", () => reject(new Error("exited before ready")));
  });
  return { child, ready };
}

function finished(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null; stdout: string }> {
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, stdout }));
  });
}

describe("npm launcher with the real binary", () => {
  let installed: ReturnType<typeof install>;
  beforeAll(() => {
    installed = install("real", shippedBinary());
  });

  it("packs a launcher at the CLI version that depends on all four platform packages", () => {
    const version = cliVersion();
    const launcher = installed.packed.find(
      (entry) => entry.name === launcherName(),
    ) as PackedPackage;
    expect(launcher.version).toBe(version);
    const files = readTarGz(readFileSync(join(installed.outDir, launcher.file)));
    expect(files.map((file) => file.name).sort()).toEqual([
      "package/README.md",
      "package/bin/hivemind.js",
      "package/package.json",
    ]);
    const manifest = JSON.parse(
      String(files.find((file) => file.name === "package/package.json")?.data),
    ) as Record<string, unknown>;
    expect(manifest.bin).toEqual({ hivemind: "bin/hivemind.js" });
    expect(manifest.private).toBeUndefined();
    expect(manifest.optionalDependencies).toEqual(
      Object.fromEntries(TARGETS.map((target) => [platformPackageName(target), version])),
    );
  });

  it("installs a `hivemind` bin that runs this platform's binary", () => {
    const result = spawnSync(installed.bin, ["--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(`^hivemind ${cliVersion()} \\(.*, ${hostTarget()}\\)\\n$`),
    );
  });

  it("forwards a non-zero exit code", () => {
    expect(spawnSync(installed.bin, ["--no-such-flag"], { encoding: "utf8" }).status).toBe(1);
  });

  // A terminal's Ctrl+C signals the whole foreground process group, so under
  // the launcher the binary gets SIGINT twice: from the terminal and forwarded
  // by the launcher. That must still be one clean cancel, exactly as when the
  // binary runs on its own: exit 1 with the CANCELLED envelope, not exit 130.
  // `detached` makes the spawned process lead a new group, as a shell does
  // for a foreground job; the signal goes to the whole group.
  it.each([
    { via: "launcher", signal: "SIGINT", stall: "no answer" },
    { via: "launcher", signal: "SIGTERM", stall: "no answer" },
    { via: "binary", signal: "SIGINT", stall: "no answer" },
    { via: "launcher", signal: "SIGINT", stall: "body" },
  ] as const)(
    "a $signal to the process group ($via, $stall) ends with one CANCELLED result",
    async ({ via, signal, stall }) => {
      let received!: () => void;
      const requested = new Promise<void>((resolve) => {
        received = resolve;
      });
      const server = await startServer((_request, response) => {
        if (stall === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"kind":');
        }
        received();
      });
      try {
        const child = spawn(
          via === "launcher" ? installed.bin : shippedBinary(),
          ["whoami", "--json"],
          {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH,
              HOME: root,
              XDG_CONFIG_HOME: join(root, "group-signal-config"),
              HIVEMIND_URL: server.origin,
              HIVEMIND_TOKEN: "hm_group_signal_token_0123456789abcdef",
            },
          },
        );
        const done = finished(child);
        await requested;
        process.kill(-(child.pid as number), signal);
        const result = await done;
        expect(result).toMatchObject({ code: 1, signal: null });
        expect(JSON.parse(result.stdout)).toEqual({
          schemaVersion: 1,
          command: "whoami",
          ok: false,
          error: { code: "CANCELLED", message: "Cancelled." },
        });
      } finally {
        await server.close();
      }
    },
  );
});

describe("npm launcher process handling", () => {
  let installed: ReturnType<typeof install>;
  beforeAll(() => {
    const fixture = build({
      entry: "test/native/launcher-fixture.ts",
      outfile: join(root, "fixture", "hivemind"),
    });
    installed = install("fixture", fixture);
  });

  it("passes arguments through unchanged", () => {
    const args = ["a b", "--json", "$HOME", "'quoted'", ""];
    const result = spawnSync(installed.bin, ["args", ...args], { encoding: "utf8" });
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it.each([0, 2, 3, 4, 42])("exits with the binary's exit code %i", (code) => {
    expect(spawnSync(installed.bin, ["exit", String(code)]).status).toBe(code);
  });

  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
    "forwards %s to the binary and returns its exit code",
    async (signal) => {
      const { child, ready } = start(installed.bin, ["trap"]);
      const done = finished(child);
      await ready;
      child.kill(signal);
      const result = await done;
      expect(result.stdout).toContain(`got ${signal}`);
      expect(result.code).toBe(7);
    },
  );

  it("ends with the binary's signal when the binary dies from it", async () => {
    const { child, ready } = start(installed.bin, ["wait"]);
    const done = finished(child);
    await ready;
    child.kill("SIGTERM");
    expect((await done).signal).toBe("SIGTERM");
  });

  // Platform selection, seen from the package the launcher asks for.
  // `--import` overrides process.arch before the launcher reads it.
  function runAs(arch: string) {
    return spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,Object.defineProperty(process,"arch",{value:${JSON.stringify(arch)}})`,
        launcherScript(installed.prefix),
        "--version",
      ],
      { encoding: "utf8" },
    );
  }

  it("looks up the package for the running platform", () => {
    const other = process.arch === "x64" ? "arm64" : "x64";
    const result = runAs(other);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${launcherName()}-${process.platform}-${other} is not installed`,
    );
  });

  it("rejects an unsupported platform with the supported list", () => {
    const result = runAs("ia32");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`no binary for ${process.platform}-ia32`);
    expect(result.stderr).toContain("linux-x64, linux-arm64, darwin-x64, darwin-arm64");
  });

  it("explains a missing platform package (installed with --omit=optional)", () => {
    const fixture = join(root, "fixture", "hivemind");
    const bare = install("omitted", fixture, ["--omit=optional"]);
    const result = spawnSync(bare.bin, ["--version"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${platformPackageName(hostTarget())} is not installed`);
    expect(result.stderr).toContain("--omit=optional");
  });
});
