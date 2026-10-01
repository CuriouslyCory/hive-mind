import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { expect } from "vitest";
import { migrationsFolder } from "../../src/migrate.ts";

interface JournalEntry {
  tag: string;
}

export const journal = JSON.parse(
  readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { entries: JournalEntry[] };

/**
 * A copy of the migrations folder whose journal lists only `tags`, so Drizzle
 * applies just those. Remove it with `rmSync(folder, { recursive: true })`.
 */
export function migrationsFolderWith(tags: string[]): string {
  const folder = mkdtempSync(path.join(tmpdir(), "hivemind-migrations-"));
  cpSync(migrationsFolder, folder, { recursive: true });
  const entries = journal.entries.filter((entry) => tags.includes(entry.tag));
  expect(entries.map((entry) => entry.tag)).toEqual(tags);
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return folder;
}

/** Applies the migrations in `folder` to the database at `url`, without the migrator's lock. */
export async function migrateFrom(url: string, folder: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle({ client, casing: "snake_case" }), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}
