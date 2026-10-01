---
status: accepted
date: 2026-09-29
---

# Self-hosted better-auth with GitHub-only login, oAuthProxy for previews, not Neon Auth

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) chooses better-auth because one library covers GitHub OAuth for the web, device authorization for CLI login, API keys for headless use, and organizations. #1's open question 3 asks whether GitHub-only login is acceptable for v1.

Preview deployments complicate OAuth: a GitHub OAuth app allows one callback URL, and each preview has its own host. Neon's Vercel Marketplace integration also offers Neon Auth, a second auth system that could be switched on by accident. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) originally trusted a host pattern for previews; [PR #6](https://github.com/CuriouslyCory/hive-mind/pull/6) replaced it with exact hosts during review.

## Decision

- **better-auth 1.7.6, self-hosted in `apps/web`,** with GitHub as the only social provider. This answers #1's open question 3 with yes, as #1 recommends. Neon Auth stays off.
- **Placement:** `src/server/auth.ts` exports a `createAuth(opts)` factory and a lazily created `auth` instance; there is no `packages/auth`. `src/server/login-session.ts` exports `getLoginSession` and `requireLoginSession` (the M0 plan's `requireSession()`, renamed per CONTEXT.md's naming rules).
- **Plugins:** `organization` (restricted in M0; see ADR-0007), `oAuthProxy`, and `nextCookies` (last).
- **Settings:** base path `/api/auth`; `advanced.cookiePrefix: "hivemind"`; `account.encryptOAuthTokens: true`; `advanced.database.generateId: "uuid"`; `advanced.disableOriginCheck: false`.
- **Trusted hosts are exact.** `baseURL.allowedHosts` (which also defines the trusted origins) has no wildcards:
  - Production: its own host only (`BETTER_AUTH_URL`, else `VERCEL_PROJECT_PRODUCTION_URL`).
  - Preview: its own `VERCEL_URL` and `VERCEL_BRANCH_URL`.
  - Local: `localhost:3000`.
- **Preview login goes through production** with oAuthProxy. `OAUTH_PROXY_SECRET` is the same in Production and Preview; `BETTER_AUTH_SECRET` differs per environment. Local development uses a separate dev OAuth app with a localhost callback.
- **`user.github_login`** stores the GitHub login at sign-up, as a label for the personal organization's slug (ADR-0007), never as an identity.

## Consequences

- **Production does not trust preview hosts.** A test runs the full oAuthProxy round trip (preview → production → preview) on two databases with GitHub's endpoints mocked. Production's instance trusts no preview host, the User and login session land in the preview's database, and production's database stays empty. Production returns the result to the preview named in the encrypted state, not to a URL from the request.
- **A foreign callback host is rejected.** A `callbackURL` on `hive-mind-x-evil-curiouslycorys-projects.vercel.app` gets a 403 `INVALID_CALLBACK_URL` on both instances. Re-adding a wildcard fails 7 tests.
- **Origin checks are forced on** because better-auth skips origin and callback URL checks when `NODE_ENV=test`; without the setting, the negative tests could not fail.
- **Previews need the production URL too.** Without it, oAuthProxy treats a preview as production and skips itself, so `VERCEL_PROJECT_PRODUCTION_URL` is used as the fallback on previews as well as in Production.
- **Preview-created Users have no `githubLogin`.** oAuthProxy doesn't forward fields added by `mapProfileToUser`, so their personal organization's slug comes from their display name.
- **`github_login` cannot be changed through `/update-user`.** It must accept input so the profile mapping can set it, so a `user.update.before` hook rejects any update that includes it.
- **`account (provider_id, account_id)` is unique** (migration `0001`), so concurrent link callbacks cannot create duplicate linked accounts.
- A request to a host outside `allowedHosts` gets a 500 from better-auth, not a 4xx.
- Empty Vercel host variables (for example `VERCEL_BRANCH_URL` on a deployment made without git) are treated as unset, so they don't fail env validation.
- **The base path and cookie prefix become contracts** once M1 ships CLI binaries (`src/lib/auth-config.ts`).
- **Production domain:** currently the Vercel alias `hive-mind-web-mu.vercel.app`. Adding a custom domain means updating the production OAuth app's callback URL and `BETTER_AUTH_URL`.
- **Preview sign-in cannot work until production runs the same plugin**, so it is verified after merge (setup step H6), along with production sign-in.
- M1 adds the device-authorization and API-key plugins to `createAuth`, with their tables (ADR-0005). See ADR-0013.

## Alternatives considered

- **Host pattern `hive-mind-*-curiouslycorys-projects.vercel.app`:** it also matched deployments of other Vercel teams whose slug ends in `-curiouslycorys-projects`, making their sites trusted redirect targets.
- **Neon Auth:** a second auth system alongside the better-auth plugins M1 needs.
- **One GitHub OAuth app per preview:** not possible; a GitHub OAuth app allows one callback URL.
