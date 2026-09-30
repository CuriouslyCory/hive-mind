import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` diffs the schema against the snapshots in
// ./migrations and never connects, so it must work with no database URL set.
// Only commands that connect (such as `studio`) need DATABASE_URL_UNPOOLED.
// Migrations are applied by src/migrate.ts, never by `drizzle-kit migrate` or
// `push`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? "",
  },
});
