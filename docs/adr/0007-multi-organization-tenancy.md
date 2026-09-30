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
- **Personal organization on first sign-in.** `databaseHooks.user.create.after` creates an organization with the User as `owner`. Its slug is the GitHub login, lowercased; on a collision a random suffix is added.
- **Active organization.** `databaseHooks.session.create.before` sets each new login session's `activeOrganizationId` to the User's first membership, which is their personal organization.
- **Authorization rule (for M2 on):** `activeOrganizationId` is a UI default and never an authorization input. Access to a Project's data is authorized through project → organization membership.
- **Deferred to M3:** invitations, teams and the organization switcher.
- **Open sign-up:** any GitHub user can create an account (#2's open question 3); such a User gets only an empty personal organization.

## Consequences

- **Creation is retried.** If the personal organization isn't created during sign-up, the next login session's create hook finds no membership and creates it then. The organization and its `owner` membership are inserted in one transaction.
- **Slugs:** lowercase letters, digits and single hyphens, at most 39 characters. After a collision, up to four more attempts use a random 6-hex-character suffix, then sign-up fails. Two Users whose logins produce the same slug get distinct slugs (tested).
- **Users created on a preview deployment** have no GitHub login stored (ADR-0006), so their slug comes from their display name, or the local part of their email.
- A slug is set once. A later GitHub rename doesn't change it, and `github_login` is a label, never an identity.
- `session.active_organization_id` is set to null if its organization is deleted.
- **M2 must follow the authorization rule** in every `/api/v1` route and Server Action: resolve the Project, then check the caller's membership in its organization. Trusting `activeOrganizationId` would let a client choose its own tenant.
- **Open sign-up** means anyone with a GitHub account can create rows on the public deployment. Revisit in M7 alongside rate limits.
- The `invitation` table exists now because the organization plugin's schema includes it; nothing writes to it until M3.
- Tests cover personal organization creation with `owner` role, the active organization on a new login session, and slug collisions. Removing the organization plugin or either hook fails them.
