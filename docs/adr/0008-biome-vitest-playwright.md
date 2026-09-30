---
status: accepted
date: 2026-09-29
---

# Biome and Vitest now; Playwright for M3

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) lists Biome, Vitest and Playwright (dashboard smoke tests) for lint, format and test. M0 ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) needs lint and tests for three workspaces, and M2's claim-race tests will need a database that accepts concurrent connections. Next 16 removed `next lint`. M0 has no dashboard beyond a placeholder page, so browser tests have nothing to cover yet. The tooling landed in [PR #4](https://github.com/CuriouslyCory/hive-mind/pull/4), and the database harness in [PR #6](https://github.com/CuriouslyCory/hive-mind/pull/6).

## Decision

- **Biome 2.5 for lint and format, no ESLint.** One root `biome.json` (`root: true`, `linter.rules.preset: "recommended"`); workspace configs contain `"extends": "//"` and only add exceptions. Biome runs once, as the root task `lint:root`.
- **Vitest 5.** The root `vitest.config.ts` lists workspaces in `test.projects` for local runs and editors; `pnpm test` runs each workspace through Turborepo. Workspaces build their config with `defineProjectConfig` from `@hivemind/config/vitest/base`.
- **Real Postgres in tests.** `pgvector/pgvector:pg18` as a CI service container and in the root `compose.yaml`. The harness in `@hivemind/db/testing` creates and migrates a fresh database per test file. `describeDb` skips database tests locally when `TEST_DATABASE_URL` is unset and fails them in CI. No PGlite.
- **Break-it evidence.** Each new test is shown to catch its failure: break the code, confirm the test fails, restore it, and record the case in the PR description.
- **Playwright for M3** dashboard smoke tests. It is not installed in M0.

## Consequences

- **Biome 2.5 deprecates `rules.recommended`,** so the config uses `rules.preset: "recommended"`.
- Workspaces define no `lint` script. A new workspace adds a `biome.json` with `"extends": "//"`, and `packages/db/biome.json` excludes the generated migrations.
- Biome uses the git ignore file and ignores file types it doesn't know.
- **Vitest 5 needs `vite` as a peer** (ADR-0002) and defaults `clearMocks` to `true`, so the base config doesn't set it.
- **Database tests need Docker locally** (`docker compose up -d`). Without `TEST_DATABASE_URL` they are skipped with a message, not silently. In CI (`CI=true`) a missing URL fails the run, so a misconfigured job cannot pass by skipping every database test.
- The CI image already contains pgvector, so M5 only adds a `CREATE EXTENSION` migration and doesn't change CI.
- **Break-it evidence from M0:** replacing a migration's SQL, making a journal `when` older, changing a column to plain `timestamp`, removing `oAuthProxy`, removing the organization plugin or either auth hook, dropping `session.ipAddress` from the schema, removing the migration lock, and making `BETTER_AUTH_SECRET` optional each made the matching test fail. Adding a column without generating a migration made the CI drift-check step exit 1, reporting the new untracked SQL file and snapshot as well as the journal change; this was run locally with the same commands as the CI step.
- Real Postgres makes the suite slower than an in-process database; the base config sets 30-second test and hook timeouts.
- M3 adds Playwright and decides how it gets a signed-in User and a database.

## Alternatives considered

- **ESLint with a Next.js config:** `next lint` is gone in Next 16, and Biome covers both linting and formatting with one tool and one config.
- **PGlite:** runs in-process with a single connection, so it cannot exercise M2's concurrent claim races.
- **A shared Biome presets package:** unnecessary, because Biome 2 resolves `extends: "//"` to the root config.
