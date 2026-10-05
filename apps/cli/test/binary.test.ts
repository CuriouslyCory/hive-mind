import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { build, hostTarget } from "../scripts/build.ts";
import { cliVersion } from "../scripts/release-assets.ts";
import { PRODUCTION_ORIGIN } from "../src/build-info.ts";
import { json, run, shippedBinary } from "./helpers/binaries.ts";

// An empty PATH proves the binary needs no Node or Bun at runtime.
const NO_RUNTIME = { PATH: "" };

describe("shipped binary (dist/hivemind)", () => {
  it("prints version, commit and target", () => {
    const result = run(shippedBinary(), ["--version"], { env: NO_RUNTIME });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      new RegExp(`^hivemind ${cliVersion()} \\([0-9A-Za-z._-]+, ${hostTarget()}\\)\\n$`),
    );
  });

  it("prints help with the embedded default origin", () => {
    for (const args of [["--help"], ["-h"], []]) {
      const result = run(shippedBinary(), args, { env: NO_RUNTIME });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain(`Default server: ${PRODUCTION_ORIGIN}`);
    }
  });

  it("rejects unknown arguments on stderr without echoing them", () => {
    const result = run(shippedBinary(), ["--token", "hm_secret_value"], { env: NO_RUNTIME });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("hivemind --help");
    expect(result.stderr).not.toContain("hm_secret_value");
  });
});

describe("build-time secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "hivemind-build-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("never inlines environment values such as HIVEMIND_TOKEN", () => {
    const sentinel = `hm_sentinel_${Date.now()}`;
    vi.stubEnv("HIVEMIND_TOKEN", sentinel);
    vi.stubEnv("HIVEMIND_URL", `https://${sentinel}.example`);
    // The probe reads process.env.HIVEMIND_TOKEN and HIVEMIND_URL, so inlining
    // would replace those reads with the sentinel.
    const binary = build({ entry: "test/native/probe.ts", outfile: join(dir, "probe") });
    expect(readFileSync(binary).includes(sentinel)).toBe(false);
    const info = json(run(binary, ["info"], { env: NO_RUNTIME }));
    expect(info).toMatchObject({ env: { HIVEMIND_URL: null, HIVEMIND_TOKEN: null } });
  });
});
