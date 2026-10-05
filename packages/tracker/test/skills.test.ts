import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TRACKER_SCAN_SKILLS } from "../src/constants.ts";

// The scan cards name these skills, so each must exist as a project skill.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("tracker scan skills", () => {
  it.each(Object.values(TRACKER_SCAN_SKILLS))("%s has a SKILL.md with its name", (name) => {
    const skill = readFileSync(`${repoRoot}.agents/skills/${name}/SKILL.md`, "utf8");
    expect(skill.startsWith(`---\nname: ${name}\n`)).toBe(true);
  });
});
