# hive-mind

hive-mind gives coding agents that work on the same codebase from different machines a shared, live view of project state: what is planned, who is working on what, what has been decided, and what happened recently. Agents use it through a CLI (`hivemind`) and bundled agent skills; people watch it through a web dashboard. The goal is fewer merge conflicts, less duplicated work, and less rediscovery of past decisions.

## Status

M0 (foundations) is done: the monorepo, CI, Neon Postgres with Drizzle migrations, GitHub sign-in with better-auth, and personal organizations. The web app has a sign-in page and a placeholder home page, and nothing else yet.

Next come M1 (CLI and CLI auth), M2 (plans, tasks and Sessions), M3 (dashboard), M4 (ADRs), M5 (search), M6 (agent skills and hooks) and M7 (hardening). The full plan is in [#1](https://github.com/CuriouslyCory/hive-mind/issues/1); M0's plan is in [#2](https://github.com/CuriouslyCory/hive-mind/issues/2).

## Workspaces

| Path | Package | What it is |
|---|---|---|
| `apps/web` | `@hivemind/web` | Next.js 16 app on Vercel: the web UI, the auth API and, from M2, the `/api/v1` API |
| `packages/db` | `@hivemind/db` | Drizzle schema, committed SQL migrations, the migrator and a Postgres test harness |
| `packages/config` | `@hivemind/config` | Shared tsconfig bases and Vitest defaults |

## Local development

You need Node 24 and pnpm 12. `package.json` pins pnpm 12.8.1 in `packageManager` and `devEngines`; with Corepack (`corepack enable`) that version is used automatically. You also need Docker or Podman for Postgres.

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create `apps/web/.env.local`. Either copy the example and fill in the empty values (see the comments in the file, and [docs/setup.md](docs/setup.md) for the dev GitHub OAuth app):

   ```bash
   cp apps/web/.env.example apps/web/.env.local
   ```

   or pull the Vercel project's Development variables (run `vercel link` at the repo root first). These point `DATABASE_URL` at the Neon Development database branch instead of local Postgres:

   ```bash
   vercel env pull apps/web/.env.local
   ```

3. Start Postgres 18 (the `pgvector/pgvector:pg18` image, the same one CI uses) on `127.0.0.1:5432`:

   ```bash
   docker compose up -d
   ```

   `podman compose up -d` also works; it needs the `podman.socket` user service running.

4. Apply the migrations. `pnpm db:migrate` does not read `.env.local`, so pass the direct connection URL:

   ```bash
   DATABASE_URL_UNPOOLED=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm db:migrate
   ```

   To migrate whatever database `.env.local` points at, use `node --env-file=apps/web/.env.local packages/db/src/migrate.ts`.

5. Start the app:

   ```bash
   pnpm dev
   ```

   Next reads `apps/web/.env.local`. Open http://localhost:3000. Sign-in works only on port 3000: the dev OAuth app's callback and the app's trusted host are both `localhost:3000`. If `next dev` picks another port because 3000 is taken, auth requests fail with `Host "localhost:3001" is not in the allowed hosts list`.

## Checks

These are the checks CI runs. All four must pass:

```bash
pnpm lint
pnpm typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test
pnpm build
```

- `pnpm test` needs `TEST_DATABASE_URL` in the environment (it is not read from `.env.local`). Without it, database tests are skipped locally; in CI they fail. Each test file gets its own freshly migrated database on that server.
- `pnpm build` needs no env vars: `next build` does not validate the environment or connect to the database. It never runs migrations; only the Vercel build does (`apps/web/vercel.json`).
- `pnpm format` applies Biome's formatting and safe fixes.

## More

- [docs/setup.md](docs/setup.md): one-time Vercel, Neon and GitHub OAuth setup, and the post-deploy checklist.
- [docs/adr/](docs/adr/): architecture decision records.
- [CONTEXT.md](CONTEXT.md): the domain glossary and naming rules.
- [AGENTS.md](AGENTS.md): rules for coding agents working in this repo.
