# hive-mind

hive-mind gives coding agents that work on the same codebase from different machines a shared, live view of project state: what is planned, who is working on what, what has been decided, and what happened recently. Agents use it through the `hivemind` CLI and agent skills; people watch it through a web dashboard.

## Language

### Agent work

**Session**:
One agent run, recorded from start to end: which agent, for which User, on which machine, branch and worktree, with its intent, heartbeat and end summary. Sessions are the central concept of hive-mind: every agent run leaves one as its record, linked to a plan when there is one.
_Avoid_: agent session, run, login session

### Identity and access

**User**:
A person who signs in to hive-mind with GitHub. Agents act on behalf of a User, so every Session belongs to one.
_Avoid_: account (better-auth's `account` table holds the linked GitHub credentials), GitHub user

**Login session**:
A User's signed-in state in the web app: one row of better-auth's `session` table. It carries the User's active Organization. It has nothing to do with a Session.
_Avoid_: session (bare), auth session

**Organization**:
A hive-mind organization: the group that Projects belong to and that has Members. A User's first sign-in creates a personal organization with that User as `owner`.
_Avoid_: GitHub org (a different thing), team, workspace

**Member**:
A User's membership in an Organization, with a role such as `owner`. A User can be a Member of more than one Organization.
_Avoid_: collaborator, seat

### Decisions

**ADR**:
An architecture decision record: one numbered decision with a status (`proposed`, `accepted`, `superseded` or `deprecated`), stored as `docs/adr/NNNN-slug.md`. The repo file is the source of truth. An ADR can supersede earlier ADRs.
_Avoid_: decision doc, design doc, RFC

Plan, Task, Scope, Event and Project will be added in M2.

## Naming rules

A bare word means the domain concept. Infrastructure meanings of the same word always get a qualifier:

- "login session" (identifiers like `loginSession`), not Session.
- "hive-mind organization" whenever GitHub orgs are also mentioned.
- "Vercel project" or "Neon project", not Project.
- "database branch" for a Neon branch; a bare "branch" is a git branch.
- "OAuth scope", not Scope.

One exception is forced by better-auth, which owns the `session` table name: that table holds login sessions, so the table for Sessions is `agent_session` (`agentSession` in code). Outside table and column names, write Session.

In prose the product is "hive-mind". `hivemind` appears only in identifiers (the CLI binary, `@hivemind/*` packages, `.hivemind.json`).

Server environment variables never use the `HIVEMIND_` prefix; it is reserved for the CLI.
