---
status: accepted
date: 2026-09-29
---

# Database conventions: uuid keys, timestamptz, snake_case, singular tables

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1)'s data model adds many tables in M2 (`project`, `plan`, `task`, `agent_session`, `event` and others) with foreign keys to better-auth's tables. Key types, timestamp types and naming are expensive to change once those foreign keys exist, so the M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) fixes them now. better-auth's defaults differ: `auth generate` emits plain `timestamp` columns and text ids. The conventions landed with the auth schema in [PR #6](https://github.com/CuriouslyCory/hive-mind/pull/6).

## Decision

- **Primary keys are uuids.** `id()` in `packages/db/src/columns.ts` is `uuid().primaryKey().defaultRandom()`, so Postgres generates one with `gen_random_uuid()` when an insert omits it. better-auth generates its own with `advanced.database.generateId: "uuid"`. Foreign keys to these tables are `uuid` columns.
- **Every timestamp is `timestamptz`**, through the `timestamptz()`, `createdAt()` and `updatedAt()` helpers. `updatedAt` is set by Drizzle on every `update()`.
- **Column names are snake_case**, derived from camelCase property keys by Drizzle's `casing: "snake_case"`. The same setting is used in `createDb`, the migrator and `drizzle.config.ts`, so schema files don't repeat column names.
- **Table names are singular** (`user`, `account`, `organization`, `member`). better-auth owns the `session` table, which holds login sessions; the table for Sessions will be `agent_session` (see CONTEXT.md).
- **Generated auth schema is edited by hand.** `auth generate` output goes into `packages/db/src/schema/auth.ts` and is then changed to use the helpers, timestamptz and uuid foreign keys.

## Consequences

- **Tests enforce the rules.** `packages/db/test/conventions.test.ts` checks every table in the Drizzle schema, and the tables of a freshly migrated database: every primary key is uuid and every timestamp is timestamptz. Changing one column to plain `timestamp` made it fail at both levels.
- **Hand edits are checked against better-auth.** `apps/web/test/auth-schema.test.ts` compares `auth.ts` with better-auth's `getAuthTables` for the configured plugins. Dropping `session.ipAddress` made it fail. When M1 adds a plugin (device authorization, API keys), it must add that plugin's tables, edited the same way, or this test fails.
- One of the hand edits made `session.active_organization_id` a uuid foreign key to `organization` with `on delete set null`.
- `updatedAt` is only maintained by Drizzle. Updates written in raw SQL must set it themselves.
- `user` is a reserved word in Postgres, so raw SQL must quote the table name (`"user"`).
- Random uuids are not time-ordered. Tables that need ordering, such as M2's `event`, need their own ordered column (#1 specifies a `bigserial` `seq`).
