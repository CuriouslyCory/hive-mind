---
status: accepted
date: 2026-09-29
---

# Multi-organization tenancy with a personal organization per user

## Context

In [#1](https://github.com/CuriouslyCory/hive-mind/issues/1), a Project belongs to an organization, and open question 4 asks whether to support multiple organizations from day one or start single-user. #1 recommends multi-org, since better-auth's organization plugin makes it cheap. M1's `hivemind init` needs an organization to put a new Project in.

The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2), open question 1) assumed #1's recommendation and marked this ADR "accepted (pending owner confirmation)". The owner accepted that default by proceeding with the plan through the merge of [PR #6](https://github.com/CuriouslyCory/hive-mind/pull/6), which implemented it. This ADR records that answer to #1's open question 4.

## Decision

- **Multi-organization from the start,** using better-auth's `organization` plugin. A User can be a Member of more than one hive-mind organization.
- **Personal organization on first sign-in.** `databaseHooks.user.create.after` creates an organization with the User as `owner`. Its slug is the GitHub login, lowercased; on a collision a random suffix is added. Creation is idempotent per User: it runs in one transaction that first takes `pg_advisory_xact_lock(hashtextextended(user_id::text, 0))` and re-checks membership, so concurrent calls for one User create one organization and the rest reuse it.
- **Active organization.** `databaseHooks.session.create.before` sets each new login session's `activeOrganizationId` to the User's first membership, which is their personal organization.
- **Authorization rule (for M2 on):** `activeOrganizationId` is a UI default and never an authorization input. Access to a Project's data is authorized through project → organization membership.
- **Deferred to M3:** invitations, teams and the organization switcher.
- **The organization API is restricted in M0** (`createAuth` in `apps/web/src/server/auth.ts`), so every User has exactly their personal organization until M3:
  - `disableOrganizationDeletion: true`: `/organization/delete` answers 404 `ORGANIZATION_DELETION_DISABLED`.
  - `allowUserToCreateOrganization: false`: `/organization/create` answers 403 `YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION`. The personal organization is inserted through Drizzle, not this endpoint, so the option does not block it.
  - better-auth's `disabledPaths` makes the invitation routes (`invite-member`, `cancel-invitation`, `accept-invitation`, `reject-invitation`, `get-invitation`, `list-invitations`, `list-user-invitations`) and the member-management routes (`remove-member`, `update-member-role`, `leave`) answer 404. Team routes do not exist because teams are off.
  - Still served: reading the organization (`get-full-organization`, which `/` uses), `list`, `set-active`, `update` and the member read routes. M3 lifts these restrictions when it builds invitations and the switcher.
- **Open sign-up:** any GitHub user can create an account (#2's open question 3); such a User gets only an empty personal organization.

## Consequences

- **A failed creation fails that sign-in, and the next one retries it.** better-auth 1.7.6 runs `user.create.after` after the transaction that inserts the `user` and `account` rows commits. If the hook throws, the callback reports `unable to create user` and that first sign-in fails, but the User and account rows stay. The next sign-in finds the existing User, and its login session's create hook finds no membership and creates the organization then. The organization and its `owner` membership are inserted in one transaction.
- **Concurrent first login sessions create one organization.** A test fires five login sessions at once for a User with no membership and gets exactly one organization with one `owner` membership; without the advisory lock it creates several.
- **Slugs:** lowercase letters, digits and single hyphens, at most 39 characters (GitHub's maximum login length). After a collision, up to four more attempts use a random 6-hex-character suffix, with the base cut to 32 characters (and trailing hyphens removed) so the result stays within 39; then sign-up fails. Two Users whose logins produce the same slug get distinct slugs (tested, including a 39-character login).
- **Users created on a preview deployment** have no GitHub login stored (ADR-0006), so their slug comes from their display name, or the local part of their email.
- A slug is set once. A later GitHub rename doesn't change it, and `github_login` is a label, never an identity.
- `session.active_organization_id` is set to null if its organization is deleted.
- **M2 must follow the authorization rule** in every `/api/v1` route and Server Action: resolve the Project, then check the caller's membership in its organization. Trusting `activeOrganizationId` would let a client choose its own tenant. See ADR-0013.
- **Open sign-up** means anyone with a GitHub account can create rows on the public deployment. Revisit in M7 alongside rate limits.
- The `invitation` table exists now because the organization plugin's schema includes it. Nothing writes to it until M3: the invitation routes are disabled, and a test checks that an invite attempt stores no row.
- Tests cover personal organization creation with `owner` role, the active organization on a new login session, slug collisions, concurrent first login sessions, and each M0 restriction on the organization API. Removing the organization plugin, either hook, the advisory lock or any of the three restrictions fails them.
- **`/` shows "Organization: none"** when the User is no longer a Member of the login session's active organization. better-auth answers `getFullOrganization` with 403 `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` and clears `activeOrganizationId`; `getActiveOrganization` in `auth.ts` turns that into `null`.
