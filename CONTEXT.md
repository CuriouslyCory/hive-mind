# hive-mind

hive-mind gives coding agents that work on the same codebase from different machines a shared, live view of project state: what is planned, who is working on what, what has been decided, and what happened recently. Agents use it through the `hivemind` CLI and agent skills; people watch it through a web dashboard.

## Language

### Agent work

**Project**:
A codebase that agents coordinate on, owned by one Organization and identified within it by a slug. A repository is bound to one Project.
_Avoid_: repo, workspace, Vercel project, Neon project

**Plan**:
A unit of intended work in a Project, with a markdown body, a status (`draft`, `active`, `paused`, `done` or `abandoned`), a log, and an ordered list of Tasks. Identified by a Project-local key such as `PLAN-3`, or by its UUID.
_Avoid_: epic, ticket, issue (GitHub issues are a different thing)

**Task**:
One step of a Plan, with a status (`todo`, `in_progress`, `blocked` or `done`). A Session must hold the Task's claim to start, block or finish it.
_Avoid_: subtask, todo item

**Session**:
One agent run, recorded from start to end: which agent, owned by which User or Project key, on which machine, git branch and commit, with its intent, heartbeats and end summary. Sessions are the central concept of hive-mind: every agent run leaves one as its record. A Session can attach to a Plan and Task as its current focus; attaching is not claiming. See ADR-0014.
_Avoid_: agent session, run, login session

**Claim**:
A Session's exclusive hold on a Task, with a lease that expires 5 minutes after it was last renewed. A Session can hold several claims. `--steal` moves a live claim to another Session and is recorded in the Events of both Sessions.
_Avoid_: lock, assignment

**Heartbeat**:
A Session's periodic report that it is still running (recommended every 60 seconds). It renews the Session's unexpired claims and records touched Scopes.
_Avoid_: ping, keepalive

**Stale** / **abandoned**:
A Session is stale once 5 minutes have passed since its last heartbeat, and abandoned once 30 minutes have. Both are computed from database time when read, whether or not the sweep has stored them. A stale Session loses its expired claims and can resume by heartbeating; an abandoned one cannot resume. A Session that ends normally is ended, not abandoned.
_Avoid_: dead, timed out, idle (`idle` is a live Session status)

**Scope**:
A repository path area a Session reports: either declared (a restricted glob of where it intends to work) or touched (an exact path its working tree changed). Overlapping Scopes of live Sessions produce warnings, never blocks.
_Avoid_: OAuth scope, area, lock

**Event**:
An immutable record of one change in a Project, written in the same transaction as the change, attributed to a User, a Project key or the system. Events are the Project's activity feed; a Plan's log entries are Events.
_Avoid_: activity, audit log entry, log line

### Identity and access

**User**:
A person who signs in to hive-mind with GitHub. An agent that uses the User's CLI login acts as that User, and its Sessions belong to the User. A Session started with a Project key belongs to the key, not to any User (ADR-0014).
_Avoid_: account (better-auth's `account` table holds the linked GitHub credentials), GitHub user

**Login session**:
A User's signed-in state in the web app or the CLI: one row of better-auth's `session` table. It carries the User's active Organization. It has nothing to do with a Session.
_Avoid_: session (bare), auth session

**Device login**:
How the CLI gets a login session: the CLI shows a code, and the User approves it in the web app.
_Avoid_: device auth, CLI token

**Organization**:
A hive-mind organization: the group that Projects belong to and that has Members. A User's first sign-in creates a personal organization with that User as `owner`.
_Avoid_: GitHub org (a different thing), team, workspace

**Member**:
A User's membership in an Organization, with a role such as `owner`. A User can be a Member of more than one Organization.
_Avoid_: collaborator, seat

**Project key**:
A credential that an Organization issues for one of its Projects, for CI and headless agents. It acts as itself, never as a User, and only on that Project. It can own Sessions; they stay in the record after the key is revoked.
_Avoid_: API token, service account, API key (bare)

### Decisions

**ADR**:
An architecture decision record: one numbered decision with a status (`proposed`, `accepted`, `superseded` or `deprecated`), stored as `docs/adr/NNNN-slug.md`. The repo file is the source of truth. An ADR can supersede earlier ADRs.
_Avoid_: decision doc, design doc, RFC

## Naming rules

A bare word means the domain concept. Infrastructure meanings of the same word always get a qualifier:

- "login session" (identifiers like `loginSession`), not Session.
- "hive-mind organization" whenever GitHub orgs are also mentioned.
- "Vercel project" or "Neon project", not Project.
- "database branch" for a Neon branch; a bare "branch" is a git branch.
- "OAuth scope", not Scope.
- "API key" only for better-auth's `apikey` record that backs a Project key; say Project key for the concept.

One exception is forced by better-auth, which owns the `session` table name: that table holds login sessions, so the table for Sessions is `agent_session` (`agentSession` in code). Outside table and column names, write Session.

In prose the product is "hive-mind". `hivemind` appears only in identifiers (the CLI binary, `@hivemind/*` packages, `.hivemind.json`).

Server environment variables never use the `HIVEMIND_` prefix; it is reserved for the CLI.
