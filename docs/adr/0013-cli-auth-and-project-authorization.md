---
status: accepted
date: 2026-10-01
---

# CLI login by device authorization, and Project keys bound to one Project

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) chooses better-auth partly because it covers device authorization for CLI login and API keys for headless use. ADR-0006 left adding those plugins to M1, and ADR-0007 requires every `/api/v1` route to authorize through Project → organization membership. The M1 plan ([#3](https://github.com/CuriouslyCory/hive-mind/issues/3), "Authentication and authorization") set the constraints: no separate OAuth provider and no client secret inside binaries, cookies never accepted as a fallback for a bad bearer, a principal union on `/api/v1`, and keys bound to a Project by the application rather than by plugin metadata. M1 implemented it in [PR #9](https://github.com/CuriouslyCory/hive-mind/pull/9). The pinned better-auth is 1.7.6 with `@better-auth/api-key` 1.7.6.

## Decision

- **CLI login uses better-auth's device authorization plugin with `bearer()`.** The CLI identifies itself with the public client id `hivemind-cli`, which is on an allowlist and is never treated as proof of identity. A code lasts 10 minutes, with a 5-second polling interval. The token the CLI receives is a login session token, used as `Authorization: Bearer` (`bearer({ requireSignature: false })`, because the device endpoint returns the unsigned token). There is no OAuth provider, JWT, refresh token or client secret. A client-supplied `user_id` on the device code request is rejected.
- **Approval happens only on the `/device` page.** The page requires the browser's cookie login session. Viewing a code binds it to the viewer; only a POST of the page's Approve or Deny server action decides. That action ignores any `Authorization` header and requires a same-origin request (`Origin` equal to the host, https except on loopback). The plugin's HTTP routes `/device/approve` and `/device/deny` are disabled: they accepted a bearer token, so a CLI login could have approved further device codes.
- **A device-code race guard.** In better-auth 1.7.6 with the Drizzle adapter on Postgres, binding a code and recording the approve/deny decision were not atomic: two Users opening one code could both bind it, and a concurrent Approve and Deny could both succeed. `apps/web/src/server/device-code-guard.ts` wraps the adapter so each of those writes is one conditional `UPDATE` that Postgres re-checks. Redeeming the code was already atomic (`DELETE … RETURNING`).
- **Project keys are organization-owned API keys.** The API-key plugin has one configuration with `references: "organization"`, hashing on, the `hm_` prefix (a hint for dispatch, never proof), no session mocking (`enableSessionForAPIKeys: false`), no metadata and no per-key rate limit. Every raw `/api-key/*` HTTP route is disabled through `disabledPaths`, and the auth catch-all also rejects any path with a segment starting `api-key`, so a plugin upgrade cannot add an unreviewed route. Only server code calls the plugin's create and verify methods.
- **`project_api_key` binds each key to one Project.** It has one row per key (`key_id` is the primary key) and composite foreign keys that make the key's organization equal the Project's organization in the database. Issuance authorizes first, creates the key, then inserts the binding; if the binding fails, the key is deleted and the secret is never returned. A key without a binding, with non-default configuration or with plugin permissions is rejected with 401. A token the server cannot check (a database failure, for a login token or a Project key) gets a 500, never a 401, so a client is not told that a valid credential is invalid. For keys this needs an extra read: better-auth 1.7.6 answers `INVALID_API_KEY` both for an unknown key and for an internal failure, so after that answer `/api/v1` looks the key up by its hash and answers 500 if the lookup fails or finds a live key.
- **`/api/v1` resolves a principal union** from the bearer token: `user` (a valid login session; memberships read from the database on each request) or `projectKey` (`keyId`, `organizationId`, `projectId`, `permissions: ["project:read"]`). A key never becomes a login session. `activeOrganizationId` is never an input.
- **Authorization rules:**

  | Operation | User principal | Project-key principal |
  |---|---|---|
  | `GET /me` | yes | yes |
  | List organizations | own memberships | 403 |
  | List and create Projects | any Member of the organization | 403 |
  | Read a Project | Members of its organization | its own Project only |
  | Create, list and revoke keys | organization `owner` only | 403 |

  A Project or organization the caller cannot access gets the same 404 as an absent one.
- **Keys survive their creator.** A key belongs to the organization, so it keeps working after the User who created it leaves, until it is revoked or expires. A User's own access ends with their membership. Revoking deletes the key row and its binding; there is no history of revoked keys. Expiry is optional (1–365 days), with no default.
- **Login and logout revoke.** Logout calls better-auth's `/api/auth/sign-out` with the bearer token, which deletes the login session. Logging in again revokes the replaced login the same way, after the new one is stored; if that revocation fails, `login` warns and still succeeds. A new token that cannot be stored is revoked.
- **Without a terminal, the CLI never opens an OS credential store**, because the Keychain and Secret Service can prompt. If the stored login for the origin is kept in one of them, `login` and `logout` fail with `TERMINAL_REQUIRED` and change nothing. The pointer in the credentials file stays, so a later `logout` in a terminal can still revoke and delete the token. `login` checks this before it contacts the server.

## Consequences

- The race guard depends on how better-auth 1.7.6 issues these writes. If a later version runs them inside `adapter.transaction`, the wrapper no longer applies and the concurrency tests in `apps/web/test/device-auth.test.ts` fail; upgrades must keep those tests green. The race should be reported upstream.
- A better-auth upgrade must re-check `disabledPaths` against the plugin's routes; the catch-all rejection covers new `/api-key*` routes in the meantime.
- A CLI login carries the User's full access in all their organizations; there are no scoped user tokens. Headless agents and CI should use Project keys.
- A CLI login uses better-auth's default login session lifetime: 7 days, extended on use. `/api/v1` does not disable the refresh, so any request at least a day after the last extension moves the expiry to 7 days after that request, and a login used at least every 6 days never expires. A fixed lifetime would need `disableRefresh` in `resolveLoginSession`.
- Revocation on re-login and logout is best effort. A token the CLI could not read or revoke stays valid until it expires, and the CLI says so.
- Expired `device_code` rows are never deleted, and the `/device` page bypasses the plugin's per-IP rate limit. Guessing a live code is bounded by its 40 bits and 10 minutes. Both are for M7.
- `/me` lists only the first 50 organizations.
- `/api/v1` accepts no cookies. If the dashboard (M3) calls it, it needs cookie support with CSRF and Origin checks.
- **M3's dashboard stays off `/api/v1`** (clarified 2026-10-01 for [#11](https://github.com/CuriouslyCory/hive-mind/issues/11)). Its live updates use `GET /api/dashboard/projects/[projectId]/events/stream`, a GET-only, read-only adapter that resolves a principal only from the login session cookie (read from the database with the cookie cache off) and ignores `Authorization` and `X-API-Key`, so a bearer token or Project key cannot stand in for a missing cookie there, and a cookie still never works on `/api/v1`. It serves the same Event stream and payload schemas, and checks the credential and Project → organization membership again before every poll, as the bearer route does with its principal (ADR-0010, docs/dashboard.md).
- Only owners manage keys. Since M0 every User is the owner of exactly one personal organization, so this matters once invitations exist. M3 did not add them; they are deferred follow-up work (ADR-0007).
- **M2 must decide** how a Project-key principal maps to a Session's User (`agent_session.user_id`) and to Event actor attribution. M1 creates no synthetic User for keys. M2 also decides which coordination permissions keys get beyond `project:read`, and tests each one per endpoint.
- Tests cover the device flow (denial, expiry, cross-user approval, concurrent approve/deny, concurrent redemption on separate connections, origin checks), every authorization rule above, expired, revoked and unbound keys, a 500 when a key cannot be verified, a key outliving its creator's membership, raw plugin route rejection, and key cleanup when binding fails.

## Alternatives considered

- **A separate OAuth provider or JWT access tokens:** more infrastructure, and a public CLI cannot keep a client secret.
- **User-owned API keys:** a key would act as the User, with all their access, and would depend on that User staying in the organization. An organization key bound to one Project limits it to that Project.
- **The Project id in the key's plugin metadata:** the plugin manages that field and does not tie it to the organization. An application-owned table with foreign keys is enforced by the database.
- **Accepting cookies on `/api/v1`:** a CSRF surface with no M1 caller, and better-auth falls back from a bad bearer to the cookie.
- **Replacing the device protocol to avoid the races:** #3 allows either a supported upgrade or a narrow, reviewed adapter change, and rules out replacing the protocol. M1 stayed on the pinned 1.7.6 and took the adapter change.
