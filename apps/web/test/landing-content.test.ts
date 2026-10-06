import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fullCommand,
  INSTALL_COMMAND,
  TYPICAL_RUN,
} from "../src/app/(marketing)/welcome/_components/content";

// The landing page shows the install command and a typical run. Both are
// copied from docs/cli.md, which is the reference; these checks fail when the
// doc changes and the page does not.

const cliDoc = readFileSync(new URL("../../../docs/cli.md", import.meta.url), "utf8");

/** The first fenced code block after `heading`, as lines. */
function codeBlockAfter(heading: string): string[] {
  const start = cliDoc.indexOf(heading);
  if (start === -1) throw new Error(`docs/cli.md has no "${heading}" heading.`);
  const block = /```[a-z]*\n([\s\S]*?)```/.exec(cliDoc.slice(start));
  if (!block?.[1]) throw new Error(`docs/cli.md has no code block after "${heading}".`);
  return block[1].split("\n").filter((line) => line.trim() !== "");
}

/** A shell line without its trailing comment, with runs of spaces collapsed. */
function normalize(line: string): string {
  return line
    .replace(/\s+#.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("landing page commands", () => {
  it("installs with the command in docs/cli.md", () => {
    expect(codeBlockAfter("### Install script")[0]).toBe(INSTALL_COMMAND);
  });

  it("shows the typical run from docs/cli.md, in its order", () => {
    const documented = codeBlockAfter("### A typical run").map(normalize);
    const shown = TYPICAL_RUN.flatMap((line) =>
      line.kind === "command" ? [normalize(fullCommand(line))] : [],
    );
    expect(shown).toEqual(documented);
  });
});
