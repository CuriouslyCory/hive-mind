import { defineProjectConfig } from "@hivemind/config/vitest/base";

export default defineProjectConfig({
  test: {
    name: "@hivemind/cli",
    globalSetup: ["test/global-setup.ts"],
  },
});
