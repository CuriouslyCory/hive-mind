import { defineProject, mergeConfig, type UserWorkspaceConfig } from "vitest/config";

/**
 * Defaults shared by every workspace's Vitest project. The root
 * `vitest.config.ts` lists the workspaces in `test.projects`; each workspace's
 * own `vitest.config.ts` calls `defineProjectConfig`.
 *
 * `clearMocks` is not set because Vitest 5 defaults it to `true`.
 */
export const baseConfig = defineProject({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    // Database tests create and migrate a fresh Postgres database per file.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

/**
 * Merges workspace-specific settings over `baseConfig`.
 *
 * `mergeConfig` concatenates arrays, so a `test.include` passed here is added
 * to the base pattern rather than replacing it.
 */
export function defineProjectConfig(overrides: UserWorkspaceConfig): UserWorkspaceConfig {
  return mergeConfig(baseConfig, defineProject(overrides));
}
