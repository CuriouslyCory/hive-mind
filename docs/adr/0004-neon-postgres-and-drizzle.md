---
status: accepted
date: 2026-09-29
---

# Neon Postgres and Drizzle: pg Pool driver, migrations in the build, preview database branches

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) chooses Neon Postgres through the Vercel Marketplace with Drizzle ORM: relational data with transactions, pgvector and full-text search in the same database, and Neon database branches paired with Vercel preview deployments. M2's task claim needs an interactive transaction (a conditional `UPDATE` plus an event insert).

The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) had to settle three things: the driver, where migrations run, and how preview deployments get a schema. Neon injects a preview's database branch URL only into that deployment, so the deployment's build is the only place that can migrate it. Drizzle 0.45's migrator takes no lock, so concurrent builds race. The package landed in [PR #6](https://github.com/CuriouslyCory/hive-mind/pull/6).

## Decision

- **Neon:** Postgres 18, added through the Vercel Marketplace, with preview branching on and Neon Auth off (ADR-0006).
- **Driver:** a `pg` Pool with `drizzle-orm/node-postgres`, wrapped by `createDb(pool)` in `@hivemind/db`. `apps/web/src/server/db.ts` creates the pool on first use and registers it with `attachDatabasePool` from `@vercel/functions`, which is Neon's documented setup for Vercel Fluid compute.
- **URLs:** the runtime uses the pooled `DATABASE_URL`. Migrations use `DATABASE_URL_UNPOOLED`.
- **Migrations:** `drizzle-kit generate` writes SQL that is committed. `drizzle-kit push` is never used against a shared database. `packages/db/src/migrate.ts` applies them under a session-level `pg_advisory_lock` (fixed key `7264193851066320745`) on one unpooled client. It runs under plain `node` using Node 24 type stripping.
- **Where they run:** `apps/web/vercel.json` sets `buildCommand` to `cd ../.. && pnpm --filter @hivemind/db db:migrate && pnpm exec turbo run build --filter=@hivemind/web`, which runs for every Vercel environment. `pnpm build` has no side effects, so CI never migrates anything.
- **Expand/contract:** every schema change must be backward-compatible with the code currently deployed.
- **Pins:** drizzle-orm 0.45 and drizzle-kit 0.31 until Drizzle 1.0 is stable.

## Consequences

- **No `LISTEN` and no session-level advisory locks at runtime.** Neon's pooler runs PgBouncer in transaction mode. Interactive transactions work; anything that needs a session (such as `LISTEN/NOTIFY` for realtime, ADR-0010) must use the unpooled URL or another mechanism.
- **The lock is required.** With `pg_advisory_lock` removed, a test running three migrators at once on an empty database failed 20 of 20 runs. The lock is released when the connection ends, so a crashed build cannot leave it held. The key must never change.
- **An empty `meta/_journal.json` was committed** before any migration existed, because the migrator throws without one. That let the first Vercel build run the migrator before the schema was written.
- **Preview database branches migrate as intended.** On PR #6, the first preview build applied `0000_auth` and the second applied `0001_account_provider_unique` to the `preview/feat/2-m0-db-auth` database branch. The production database had 0 tables until the merge. After the merge, every Production build migrates production.
- **Migrations run before `next build` succeeds**, so a failed build can leave production migrated. Vercel's Instant Rollback rolls back the deployment, not the database. Expand/contract is the mitigation, with Neon point-in-time restore as the fallback.
- **Out-of-order migrations are skipped silently.** Drizzle 0.x skips any migration older than the last one applied, so if PR B deploys before PR A, A's migration never runs. `packages/db/test/journal.test.ts` asserts that journal `idx` and `when` values strictly increase. The rule (AGENTS.md): after a rebase, regenerate migrations; never hand-merge the journal. The plan's longer-term mitigation is moving to Drizzle 1.0 once it is stable; whether 1.0 removes the hazard, and whether its migrator still needs the external lock, must be checked then.
- **CI drift check:** after the other checks, CI runs `pnpm db:generate` and fails if `packages/db/migrations` changed or gained untracked files. The plan's `git diff --exit-code` alone would miss a new, untracked `.sql` file.
- **Migrations are excluded from Biome** (`packages/db/biome.json`), because they are generated output.
- **Preview data exposure, accepted for M0.** A preview database branch is "a copy-on-write fork of your production data" ([Neon FAQ](https://neon.com/faqs/postgres-tools-preview-deployments)); Neon's Vercel integration guides document no setting to fork from a different parent. So every preview deployment, which runs unmerged PR code, can read a copy of production's users, login sessions and OAuth tokens.
  - A copied login-session token that hasn't expired is still valid in production's `session` table. Production accepts it only in a cookie signed with production's `BETTER_AUTH_SECRET`, which previews don't have.
  - OAuth tokens are encrypted with that same secret (`encryptOAuthTokens`).
  - If production's `BETTER_AUTH_SECRET` leaks, or a plugin that accepts raw session tokens (such as `bearer`) is added, the copied tokens can be used against production.
  - #2's open question 4 accepts this for M0, while the only data is the owner's. Follow-up for M7: see issue #8.
- **Neon branch limit:** each preview creates a database branch. Setting Vercel preview retention to about 30 days limits how many exist; cleanup automation is M7.

## Alternatives considered

- **Neon's HTTP driver (`neon-http`):** cannot run interactive transactions, which M2's task claim needs.
- **Migrating from CI or a GitHub Action:** the preview database branch URL exists only inside the Vercel deployment, so nothing outside the build can reach it.
- **Migrating at runtime on first request:** every cold instance would contend for the lock, and a failed migration would surface as failed requests rather than a failed build.
- **`drizzle-kit push` or `drizzle-kit migrate`:** `push` applies schema differences without a reviewed SQL file; `migrate` would bypass the advisory lock that `migrate.ts` adds.
