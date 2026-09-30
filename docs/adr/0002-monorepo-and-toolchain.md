---
status: accepted
date: 2026-09-29
---

# Turborepo and pnpm monorepo: workspace layout, dependency rules, toolchain pins

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) requires a Turborepo + pnpm monorepo that will eventually hold the web app, the CLI and several shared packages. M0 ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) sets up the layout and pins the toolchain. The plan's weakest assumption was that pnpm 12 installs on Vercel, which Vercel documents only up to pnpm 10; step 4 was a deploy spike with two fallbacks. The root tooling landed in [PR #4](https://github.com/CuriouslyCory/hive-mind/pull/4), the web skeleton and spike in [PR #5](https://github.com/CuriouslyCory/hive-mind/pull/5), and the database and auth packages in [PR #6](https://github.com/CuriouslyCory/hive-mind/pull/6).

## Decision

- **Workspaces:** only `apps/web` (`@hivemind/web`), `packages/db` (`@hivemind/db`) and `packages/config` (`@hivemind/config`). Each milestone creates its own workspaces; there are no stubs. All are `private: true` and linked with `workspace:*`. The root package is `hive-mind`. The `@hive-mind` npm scope belongs to a third party, so internal names use `@hivemind/*` to avoid a dependency-confusion path.
- **Dependency rules:** `packages/db` depends only on `drizzle-orm` and `pg` (plus `vitest` as an optional peer for its `./testing` export). It never imports `next`, better-auth or `apps/*`. pnpm's isolated `node_modules` (no hoisting) makes an undeclared import fail to resolve. No cross-package tsconfig `paths`. Packages export TypeScript source with no build step.
- **Pins:** Node 24 (`.nvmrc`; `devEngines.runtime` `^24.0.0` with `onFail: error`). pnpm 12.8.1 (`packageManager` and `devEngines.packageManager`). turbo `~2.11.5`, Biome `2.5.14`, TypeScript `~6.0.3`, Vitest `^5.0.2` with vite `^8.3.1`, Next `~16.3.6`, React `~19.3.0`, drizzle-orm `~0.45.3`, drizzle-kit `~0.31.11`, better-auth, `@better-auth/drizzle-adapter` and the `auth` CLI at exactly `1.7.6`.
- **Catalog:** versions shared by more than one workspace live in the `pnpm-workspace.yaml` catalog; a dependency used by one workspace is pinned there.
- **Build scripts:** `allowBuilds` lists every dependency with an install script (`strictDepBuilds` fails the install otherwise); `dangerouslyAllowAllBuilds` is never set.
- **Turborepo env:** `VERCEL_ENV` is a global env var; server secrets and `VERCEL_*` are in `build.passThroughEnv`; `CI` and `TEST_DATABASE_URL` are in the test task's hashed `env`; `db:generate` and `db:migrate` are uncached.

## Consequences

- **pnpm on Vercel works without a fallback.** pnpm 12.8.1 installed on Vercel's production build of `main` with no `installCommand` override and no downgrade. Vercel reads `devEngines.packageManager`, and the leading document that pnpm 12 writes at the top of `pnpm-lock.yaml` did not cause problems. The Vercel project also sets `ENABLE_EXPERIMENTAL_COREPACK=1` (setup step H1); whether that is still needed was not tested.
- **TypeScript is pinned to `~6.0.3`** because npm `latest` is now 7, and with TypeScript 7 `next build` needs an experimental flag. Upgrade when `next build` supports TypeScript 7 without flags.
- **Vitest 5 needs `vite` as a peer**, so `vite` is in the catalog and declared next to `vitest` in every workspace that runs tests.
- **Next is pinned to `~16.3.6`, not 16.3.7.** pnpm 12's minimum-release-age check blocked 16.3.7, which was less than a day old. The check was not weakened; later patch releases arrive once they are old enough.
- **`allowBuilds`** has two entries, both `false`: `fsevents` (macOS-only optional dependency of vite; it ships a prebuilt binary and no `binding.gyp`, so its `node-gyp rebuild` script cannot succeed) and `esbuild` (pulled in by drizzle-kit; its script only verifies the platform binary that pnpm already installs from the matching `@esbuild/*` package). sharp 0.35 and `@next/swc-*` have no install scripts.
- **Override `"drizzle-orm>kysely": "-"`.** drizzle-orm has an optional peer on kysely, which better-auth brings into `apps/web`. That produced a second drizzle-orm copy whose types didn't match `@hivemind/db`'s tables. Nothing uses `drizzle-orm/kysely`, so the peer is dropped and one copy remains. Revisit when upgrading better-auth or drizzle-orm.
- **Lint runs once.** Biome runs as the root task `lint:root` (`turbo run lint lint:root`); workspaces define no `lint` script. See ADR-0008.
- **Test cache:** because `TEST_DATABASE_URL` and `CI` are hashed, a local run that skipped database tests cannot be served from cache to CI.
- turbo 2.11 writes a managed agent-guidance block into `AGENTS.md` whenever it detects an agent; the block is committed so agent runs don't leave a dirty tree.
- **Drizzle 0.45 / drizzle-kit 0.31** stay until Drizzle 1.0 is stable (it was a release candidate when M0 was planned). See ADR-0004 for why the upgrade matters.
- A workspace that imports another must declare it with `workspace:*`; there is no shortcut through hoisting or `paths`.
