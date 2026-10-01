// Build-time constants. scripts/build.ts replaces these identifiers with
// literals through `bun build --define`, so a compiled binary carries its own
// version, commit, target and default origin and never reads them from the
// environment or the working directory at runtime. Under Vitest on Node the
// identifiers are undeclared, and the `typeof` guards fall back to dev values.
declare const HIVEMIND_BUILD_VERSION: string;
declare const HIVEMIND_BUILD_COMMIT: string;
declare const HIVEMIND_BUILD_TARGET: string;
declare const HIVEMIND_DEFAULT_ORIGIN: string;

/**
 * The production backend (STATE.md D3, docs/setup.md). The build script embeds
 * this unless `--default-origin` overrides it for a non-production build.
 */
export const PRODUCTION_ORIGIN = "https://hive-mind-web-mu.vercel.app";

export const BUILD_VERSION: string =
  typeof HIVEMIND_BUILD_VERSION === "string" ? HIVEMIND_BUILD_VERSION : "0.0.0-dev";

export const BUILD_COMMIT: string =
  typeof HIVEMIND_BUILD_COMMIT === "string" ? HIVEMIND_BUILD_COMMIT : "unknown";

/** The `bun build --target` the binary was compiled for, or "node" under Vitest. */
export const BUILD_TARGET: string =
  typeof HIVEMIND_BUILD_TARGET === "string" ? HIVEMIND_BUILD_TARGET : "node";

export const DEFAULT_ORIGIN: string =
  typeof HIVEMIND_DEFAULT_ORIGIN === "string" ? HIVEMIND_DEFAULT_ORIGIN : PRODUCTION_ORIGIN;
