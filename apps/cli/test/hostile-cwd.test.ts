import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_ROOT, planBuild } from "../scripts/build.ts";
import { PRODUCTION_ORIGIN } from "../src/build-info.ts";
import { json, PROBE_BINARY, run, shippedBinary } from "./helpers/binaries.ts";

// A repository the user cds into must not be able to change the binary's
// endpoint, identity or code (issue #3 step 9). Bun-compiled executables read
// .env and bunfig.toml from the working directory unless built with
// --no-compile-autoload-dotenv/--no-compile-autoload-bunfig.

const root = mkdtempSync(join(tmpdir(), "hivemind-hostile-"));
const hostile = join(root, "hostile");
const clean = join(root, "clean");
const marker = join(root, "preload-ran");

beforeAll(() => {
  mkdirSync(hostile);
  mkdirSync(clean);
  writeFileSync(
    join(hostile, ".env"),
    "HIVEMIND_URL=https://evil.example\nHIVEMIND_TOKEN=hm_evil_token\n",
  );
  writeFileSync(join(hostile, "bunfig.toml"), 'preload = ["./evil.js"]\n');
  writeFileSync(
    join(hostile, "evil.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("compiled binary in a hostile working directory", () => {
  it("prints the same --version and --help as in a clean directory", () => {
    for (const args of [["--version"], ["--help"]]) {
      const inClean = run(shippedBinary(), args, { cwd: clean });
      const inHostile = run(shippedBinary(), args, { cwd: hostile });
      expect(inHostile).toEqual(inClean);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("does not load .env or run a bunfig.toml preload", () => {
    const info = json(run(PROBE_BINARY, ["info"], { cwd: hostile }));
    expect(info).toMatchObject({
      defaultOrigin: PRODUCTION_ORIGIN,
      env: { HIVEMIND_URL: null, HIVEMIND_TOKEN: null },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("control: a binary built with autoload left on is affected by the same directory", () => {
    // Proves the fixture is hostile, so the passing tests above are not vacuous.
    const plan = planBuild({ entry: "test/native/probe.ts", outfile: join(root, "unsafe-probe") });
    const args = plan.args.filter((arg) => !arg.startsWith("--no-compile-autoload-"));
    const built = spawnSync(plan.bun, args, { cwd: CLI_ROOT, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);

    const info = json(run(plan.outfile, ["info"], { cwd: hostile }));
    expect(info).toMatchObject({
      env: { HIVEMIND_URL: "https://evil.example", HIVEMIND_TOKEN: "set" },
    });
    expect(existsSync(marker)).toBe(true);
  });
});
