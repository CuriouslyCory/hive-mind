import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema/index.ts";

/**
 * Creates the Drizzle client for a `pg` pool. The pool owns the connections;
 * the caller creates it (with `createPool`, on the pooled `DATABASE_URL` at
 * runtime) and ends it.
 *
 * node-postgres supports interactive transactions:
 * `db.transaction(async (tx) => { ... })` runs on one connection checked out of
 * the pool and rolls back if the callback throws.
 */
export function createDb(pool: pg.Pool) {
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;

export { createClient, createPool, describeConnectionError } from "./connection.ts";
export {
  type CreateOrReuseProjectResult,
  createOrReuseProject,
  type DbOrTransaction,
  type ProjectInput,
} from "./project.ts";
export type { Project } from "./schema/project.ts";
export type { ProjectApiKey } from "./schema/project-api-key.ts";
export {
  type DeclaredPatternInvalidReason,
  type DeclaredPatternResult,
  displayScopeValue,
  findScopeOverlaps,
  normalizeDeclaredPattern,
  normalizeTouchedPath,
  SCOPE_COMPARISON_BUDGET,
  SCOPE_PAIR_STATE_BUDGET,
  SCOPE_VALUE_MAX_BYTES,
  type ScopeComparison,
  type ScopeEntry,
  type ScopeIncompleteReason,
  ScopeMatchContext,
  type ScopeOverlap,
  type ScopeOverlapReport,
  type ScopeSource,
  type ScopeValue,
  type TouchedPathResult,
} from "./scope.ts";
export { schema };
