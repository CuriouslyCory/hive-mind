---
status: accepted
date: 2026-09-29
---

# Next.js 16 on Vercel as the single deployable

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) puts the dashboard, the `/api/v1` API and auth in one Next.js 16 app on Vercel, so v1 has one deployable and one database. #1's stack table says "`proxy.ts` for auth gating", and its dashboard section says every page is gated via `proxy.ts`.

The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) found two problems with gating in the proxy. Next 16's own guidance is to treat the proxy as an optimistic check and enforce access next to the data. And API clients (the CLI from M1 on) need a 401, not a 307 redirect to a login page. The app landed in [PR #5](https://github.com/CuriouslyCory/hive-mind/pull/5) and gating in [PR #6](https://github.com/CuriouslyCory/hive-mind/pull/6).

## Decision

`apps/web` is the only deployable: Next.js 16.3 with the App Router on Vercel (Fluid compute), with `typedRoutes` and `cacheComponents` on.

- **The proxy redirects; the data-access layer enforces.** `src/proxy.ts` only checks that a login session cookie exists (`getSessionCookie` with the `hivemind` prefix) and redirects to `/sign-in` when it doesn't. Its matcher excludes `/api/*`, `_next/`, files with an extension, and `/sign-in`.
- **`requireLoginSession()`** (`src/server/login-session.ts`) is the access check. Every page, layout data read, Server Action and route handler that needs a User calls it (or `getLoginSession()`, for route handlers that answer 401 themselves). The M0 plan calls it `requireSession()`; it was renamed to follow CONTEXT.md's naming rules, where a bare Session is an agent run, and M3 picks it up under the new name.
- **Cache Components** are on. Login session reads happen inside a `<Suspense>` boundary and never in the root layout.
- **Lazy server singletons.** `env`, the database pool and the better-auth instance are created on first use, not at import, so `next build` needs no secrets.

> _Contradicts #1's stack decision "proxy.ts for auth gating" — but worth reopening because a matcher change silently removes coverage from every route it stops matching, and API routes must answer 401 rather than redirect. The proxy stays, as a redirect for convenience only._

## Consequences

- **Every data read carries its own check.** Forgetting `requireLoginSession()` in a new page exposes it even though the proxy still redirects cookieless requests. M3 reviewers should look for it on every new page and Server Action.
- **A bogus cookie gets a 200, then a streamed redirect.** The proxy sees a cookie and lets the request through; the page's shell renders with status 200; `requireLoginSession()` inside `<Suspense>` then redirects in the stream. A request with no cookie gets a 307 from the proxy. Tests that check gating must account for both.
- **`/api/*` is never redirected.** M1's bearer-auth routes and M2's `/api/v1` routes must return 401 themselves.
- `apps/web/test/proxy.test.ts` uses `unstable_doesMiddlewareMatch` from `next/experimental/testing/server`: Next 16.3 documents `unstable_doesProxyMatch` but doesn't export it.
- **`jsx: "react-jsx"` is required** by Next 16.3 (not `preserve`), so `packages/config/tsconfig/nextjs.json` sets it. Next won't adjust a `tsconfig.json` that uses `extends`, so `apps/web/tsconfig.json` declares its own `include`.
- **No `transpilePackages`.** The plan expected it; Turbopack in Next 16.3 resolves `@hivemind/db` and its `.ts` imports without it.
- **`next-env.d.ts` is gitignored**, as Next's docs recommend. The `typecheck` script is `next typegen && tsc --noEmit`, which regenerates it and the typed-route types before `tsc`.
- **`next build` needs no secrets.** CI builds with placeholder values because env validation is never skipped; a missing variable at runtime fails the first request with an error naming it.
- Next 16.3 generates `apps/web/AGENTS.md` and `CLAUDE.md` on `next dev`; they are committed unchanged.
- One deployable means the API, dashboard and auth share Vercel's function limits and scale together. Splitting them out later would need a new ADR.
