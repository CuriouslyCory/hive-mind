# hive-mind

hive-mind gives coding agents that work on the same codebase from different machines a shared, live view of project state: what is planned, who is working on what, what has been decided, and what happened recently. Agents use it through a CLI (`hivemind`) and bundled agent skills; people watch it through a web dashboard. The goal is fewer merge conflicts, less duplicated work, and less rediscovery of past decisions.

Production runs at [https://hivemind.curiouslycory.com](https://hivemind.curiouslycory.com). The CLI uses this URL by default.

## Status

M0 (foundations) is done: the monorepo, CI, Neon Postgres with Drizzle migrations, GitHub sign-in with better-auth, and personal organizations.

M1 (CLI and CLI auth) adds the `hivemind` CLI, browser-approved CLI login, Projects, Project keys and the first `/api/v1` routes. The CLI can log in, bind a repository to a Project and manage Project keys; see [docs/cli.md](docs/cli.md). Its first public release waits on the owner's setup in [docs/setup.md](docs/setup.md#h7-cli-releases).

Next come M2 (plans, tasks and Sessions), M3 (dashboard), M4 (ADRs), M5 (search), M6 (agent skills and hooks) and M7 (hardening). The full plan is in [#1](https://github.com/CuriouslyCory/hive-mind/issues/1); M0's plan is in [#2](https://github.com/CuriouslyCory/hive-mind/issues/2) and M1's in [#3](https://github.com/CuriouslyCory/hive-mind/issues/3).

## Workspaces

| Path | Package | What it is |
|---|---|---|
| `apps/web` | `@hivemind/web` | Next.js 16 app on Vercel: the web UI, the auth API (`/api/auth`), the device approval page and the `/api/v1` API |
| `apps/cli` | `@hivemind/cli` | The `hivemind` CLI, compiled with Bun into standalone binaries, plus its installer and npm launcher |
| `packages/contract` | `@hivemind/contract` | Zod schemas and the oRPC contract for `/api/v1`, error codes, `.hivemind.json` and the CLI's JSON output |
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

## CLI development

`pnpm build` also compiles the CLI for your own platform to `apps/cli/dist/hivemind`. Bun 1.4.2 comes from `apps/cli`'s devDependencies, so you don't need Bun installed. Don't run `node_modules/.bin/bun`: its postinstall is disabled and it only prints an error. To rebuild just the CLI:

```bash
pnpm --filter @hivemind/cli build
```

Run it against the local app (step 5 above) with `--server`:

```bash
apps/cli/dist/hivemind --server http://localhost:3000 login
apps/cli/dist/hivemind --server http://localhost:3000 whoami
```

`login` prints a URL and a code; approve them in the browser at http://localhost:3000/device. The local login is stored for `http://localhost:3000` only. [docs/cli.md](docs/cli.md) describes every command.

`node apps/cli/scripts/build.ts --target <target>` builds one of `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64` and `bun-darwin-arm64`, but only the one matching your machine: the other targets' packages are not installed. The release workflow builds each target on its own runner.

Tests beyond the four checks below:

- **CLI tests** run as part of `pnpm test`. They need no database; many of them build and run the compiled binary.
- **Browser tests** (Playwright: the device approval page, and the CLI flow from `login` to `logout` against `next dev`):

  ```bash
  pnpm --filter @hivemind/web exec playwright install chromium   # once
  TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test:e2e
  ```

  They need port 3000 free, because `localhost:3000` is the only local host the app trusts. They build the CLI first and create and drop their own database on the `TEST_DATABASE_URL` server.
- **Installer tests** for `scripts/install.sh`: `pnpm test:install`. They run `install.sh` with `sh`; prefix `SH=bash` to run it with another shell.

A change to the CLI that users will notice needs a changeset: run `pnpm changeset` and commit the file it writes in `.changeset/`.

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

CI also runs the installer tests and the browser tests on every PR. A PR that touches `apps/cli`, `packages/contract` or the installer also builds and smoke-tests the CLI on Linux and macOS, x64 and arm64 (`.github/workflows/cli-native.yml`).

## More

- [docs/cli.md](docs/cli.md): installing and using the `hivemind` CLI.
- [docs/setup.md](docs/setup.md): one-time Vercel, Neon, GitHub OAuth and release setup, and the post-deploy checklist.
- [docs/adr/](docs/adr/): architecture decision records.
- [CONTEXT.md](CONTEXT.md): the domain glossary and naming rules.
- [AGENTS.md](AGENTS.md): rules for coding agents working in this repo.
