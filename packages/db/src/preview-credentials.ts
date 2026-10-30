import { createClient } from "./connection.ts";

// This file runs directly under Node (`node src/preview-credentials.ts`), as
// migrate.ts does, so it follows the same rules: it imports only packages, Node
// builtins and connection.ts, and uses only erasable TypeScript syntax.

/**
 * Removes production's credentials from a preview database branch.
 *
 * Neon's Vercel integration forks each `preview/<git-branch>` database branch
 * from production with its data, and a preview deployment runs unmerged code
 * (docs/setup.md H2, issue #8). The `bearer` plugin lets production accept a
 * raw login session token, so a copied `session` row is a working production
 * credential. Plans, Tasks, Events and other rows stay; only credentials go.
 */
export const CLEAR_PREVIEW_CREDENTIALS = [
  "delete from session",
  // OAuth state and other short-lived verification values.
  "delete from verification",
  // CLI device codes, which an approved code redeems for a login session.
  "delete from device_code",
  // Keys are stored hashed; their bindings in project_api_key cascade.
  "delete from apikey",
  // GitHub's tokens are encrypted with production's BETTER_AUTH_SECRET, but a
  // leak of that secret would make them usable. The rows stay so that a
  // GitHub sign-in on the preview finds the same user.
  `update account set
     access_token = null, refresh_token = null, id_token = null,
     access_token_expires_at = null, refresh_token_expires_at = null,
     password = null`,
];

/** Runs `CLEAR_PREVIEW_CREDENTIALS` in one transaction. Never call it on production. */
export async function clearPreviewCredentials(connectionString: string): Promise<void> {
  // A lost connection fails the run through the rejected query.
  const client = createClient({ connectionString });
  await client.connect();
  try {
    await client.query("begin");
    try {
      for (const statement of CLEAR_PREVIEW_CREDENTIALS) await client.query(statement);
      await client.query("commit");
    } catch (error) {
      // If the connection is gone, Postgres rolls back anyway; keep the original error.
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

// Called by the Vercel build after the migrations (apps/web/vercel.json), which
// runs for every environment, so anything but a preview build is a no-op.
if (import.meta.main) {
  if (process.env.VERCEL_ENV !== "preview") {
    console.log("preview credentials left alone: not a preview build");
  } else {
    const connectionString = process.env.DATABASE_URL_UNPOOLED;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL_UNPOOLED is not set; it must be a direct Postgres connection URL.",
      );
    }
    await clearPreviewCredentials(connectionString);
    console.log("preview credentials cleared");
  }
}
