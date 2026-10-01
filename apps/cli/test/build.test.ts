import { describe, expect, it } from "vitest";
import {
  bunExecutable,
  hostTarget,
  missingTargetPackages,
  pinnedBunVersion,
  planBuild,
  TARGETS,
  validateOrigin,
} from "../scripts/build.ts";
import { PRODUCTION_ORIGIN } from "../src/build-info.ts";

describe("hostTarget", () => {
  it("maps supported hosts to bun targets", () => {
    expect(hostTarget("linux", "x64")).toBe("bun-linux-x64");
    expect(hostTarget("linux", "arm64")).toBe("bun-linux-arm64");
    expect(hostTarget("darwin", "x64")).toBe("bun-darwin-x64");
    expect(hostTarget("darwin", "arm64")).toBe("bun-darwin-arm64");
  });

  it("rejects unsupported hosts with the supported list", () => {
    expect(() => hostTarget("win32", "x64")).toThrow(/does not support win32\/x64.*bun-linux-x64/);
  });
});

describe("validateOrigin", () => {
  it("accepts https and loopback http origins", () => {
    expect(validateOrigin("https://example.com")).toBe("https://example.com");
    expect(validateOrigin("https://example.com:443/")).toBe("https://example.com");
    expect(validateOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(validateOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it.each([
    "http://example.com",
    "https://example.com/api",
    "https://user:pass@example.com",
    "https://example.com?x=1",
    "not a url",
  ])("rejects %s", (origin) => {
    expect(() => validateOrigin(origin)).toThrow(/--default-origin/);
  });
});

describe("planBuild", () => {
  it("pins Bun to an exact version", () => {
    expect(pinnedBunVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("builds the host target from its lockfile-pinned runtime", () => {
    const target = hostTarget();
    expect(missingTargetPackages(target)).toEqual([]);
    const plan = planBuild({ target, commit: "abc123" });
    expect(plan.args).toContain(`--target=${target}`);
    expect(plan.args).toContain(`--compile-executable-path=${bunExecutable(target)}`);
    expect(plan.outfile.endsWith(`dist/${target}/hivemind`)).toBe(true);
    expect(plan.defines.HIVEMIND_BUILD_TARGET).toBe(JSON.stringify(target));
  });

  // pnpm installs only the host's platform packages (STATE.md D11), so another
  // target either has them (a deliberately wider install) or must fail up
  // front, naming them, rather than deep inside bun build.
  it.each(TARGETS)("plans %s only when its platform packages are installed", (target) => {
    const missing = missingTargetPackages(target);
    if (missing.length === 0) {
      expect(planBuild({ target }).args).toContain(`--target=${target}`);
    } else {
      expect(() => planBuild({ target })).toThrow(
        new RegExp(`cannot build ${target} here: ${missing.join(", ")} not installed.*native`),
      );
    }
  });

  it("disables every runtime autoload and build-time env inlining", () => {
    const { args } = planBuild();
    for (const flag of [
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--no-env-file",
      "--env=disable",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args.some((arg) => /^--compile-autoload|^--env=(?!disable)/.test(arg))).toBe(false);
  });

  it("embeds version, commit, target and the production origin by default", () => {
    const plan = planBuild({ commit: "0123abc" });
    expect(plan.outfile.endsWith("dist/hivemind")).toBe(true);
    expect(plan.defines).toEqual({
      HIVEMIND_BUILD_VERSION: JSON.stringify("0.0.0"),
      HIVEMIND_BUILD_COMMIT: JSON.stringify("0123abc"),
      HIVEMIND_BUILD_TARGET: JSON.stringify(hostTarget()),
      HIVEMIND_DEFAULT_ORIGIN: JSON.stringify(PRODUCTION_ORIGIN),
    });
  });

  it("takes the commit from HIVEMIND_BUILD_COMMIT and never from git", ({ onTestFinished }) => {
    const previous = process.env.HIVEMIND_BUILD_COMMIT;
    onTestFinished(() => {
      if (previous === undefined) delete process.env.HIVEMIND_BUILD_COMMIT;
      else process.env.HIVEMIND_BUILD_COMMIT = previous;
    });
    process.env.HIVEMIND_BUILD_COMMIT = "fromenv1";
    expect(planBuild().defines.HIVEMIND_BUILD_COMMIT).toBe('"fromenv1"');
    delete process.env.HIVEMIND_BUILD_COMMIT;
    expect(planBuild().defines.HIVEMIND_BUILD_COMMIT).toBe('"unknown"');
  });

  it("rejects a commit that could inject into the define expression", () => {
    expect(() => planBuild({ commit: '"; process.exit(1); "' })).toThrow(/--commit/);
  });

  it("validates --default-origin", () => {
    expect(
      planBuild({ defaultOrigin: "http://localhost:3000" }).defines.HIVEMIND_DEFAULT_ORIGIN,
    ).toBe('"http://localhost:3000"');
    expect(() => planBuild({ defaultOrigin: "http://evil.example" })).toThrow(/https/);
  });
});
