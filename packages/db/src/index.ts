import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema/index.ts";

/**
 * Creates the Drizzle client for a `pg` pool. The pool owns the connections;
 * the caller creates it (with the pooled `DATABASE_URL` at runtime) and ends it.
 *
 * node-postgres supports interactive transactions:
 * `db.transaction(async (tx) => { ... })` runs on one connection checked out of
 * the pool and rolls back if the callback throws.
 */
export function createDb(pool: pg.Pool) {
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;

export {
  type CreateOrReuseProjectResult,
  createOrReuseProject,
  type DbOrTransaction,
  type ProjectInput,
} from "./project.ts";
export type { Project } from "./schema/project.ts";
export type { ProjectApiKey } from "./schema/project-api-key.ts";
export { schema };
