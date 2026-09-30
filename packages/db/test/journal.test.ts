import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.ts";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Drizzle 0.x applies a migration only if its `when` is later than the last
 * applied migration's, so a migration that sorts before one already deployed is
 * silently skipped. This happens when two branches each generate a migration
 * and the journal is merged by hand instead of regenerated after a rebase.
 */
function journalOrderErrors(entries: JournalEntry[]): string[] {
  const errors: string[] = [];
  for (const [i, entry] of entries.entries()) {
    const previous = entries[i - 1];
    if (!previous) continue;
    if (entry.idx <= previous.idx) {
      errors.push(`${entry.tag}: idx ${entry.idx} is not after ${previous.tag}'s ${previous.idx}`);
    }
    if (entry.when <= previous.when) {
      errors.push(
        `${entry.tag}: when ${entry.when} is not after ${previous.tag}'s ${previous.when}`,
      );
    }
  }
  return errors;
}

const journal = JSON.parse(
  readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { dialect: string; entries: JournalEntry[] };

describe("migrations journal", () => {
  it("is a postgresql journal", () => {
    expect(journal.dialect).toBe("postgresql");
  });

  it("has strictly increasing idx and when", () => {
    expect(journalOrderErrors(journal.entries)).toEqual([]);
  });

  it("lists only migrations whose SQL file exists", () => {
    for (const entry of journal.entries) {
      expect(() => readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`))).not.toThrow();
    }
  });
});

describe("journalOrderErrors", () => {
  const first = { idx: 0, when: 1_000, tag: "0000_first" };

  it("accepts increasing entries", () => {
    expect(journalOrderErrors([first, { idx: 1, when: 2_000, tag: "0001_second" }])).toEqual([]);
  });

  it("rejects a migration generated before the one it follows", () => {
    expect(journalOrderErrors([first, { idx: 1, when: 500, tag: "0001_rebased" }])).toEqual([
      "0001_rebased: when 500 is not after 0000_first's 1000",
    ]);
  });

  it("rejects a repeated idx and an equal when", () => {
    expect(journalOrderErrors([first, { idx: 0, when: 1_000, tag: "0000_duplicate" }])).toEqual([
      "0000_duplicate: idx 0 is not after 0000_first's 0",
      "0000_duplicate: when 1000 is not after 0000_first's 1000",
    ]);
  });
});
