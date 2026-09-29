import { defineConfig } from "vitest/config";

// Runs every workspace's tests in one Vitest process, for local use and editor
// integration. `pnpm test` goes through Turborepo instead, one workspace at a time.
export default defineConfig({
  test: {
    projects: ["apps/*/vitest.config.ts", "packages/*/vitest.config.ts"],
  },
});
