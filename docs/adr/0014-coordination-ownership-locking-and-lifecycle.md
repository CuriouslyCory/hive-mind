---
status: accepted
date: 2026-10-01
---

# Coordination: Session ownership, per-Project locking, Events and lifecycle

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1)'s M2 lets several agents on different machines share Plans, Tasks, Sessions and Scopes in one Project. Its plan, [#12](https://github.com/CuriouslyCory/hive-mind/issues/12), needs these decisions before the schema, contract and handlers are built:

- ADR-0013 leaves two questions to M2: how a Project-key principal maps to a Session's owner and to Event attribution, and which coordination permissions Project keys get beyond `project:read`. M1 created no synthetic User for keys.
- `CONTEXT.md` said every Session belongs to a User. A headless agent that authenticates with a Project key has no User.
- Two Sessions can try to claim one Task at the same moment, a heartbeat can race the sweep that expires its claims, and one change can touch several records. Without serialization each pair of these needs its own row-lock order.
- ADR-0010 (proposed, owned by M3) needs Event ordering metadata. [#11](https://github.com/CuriouslyCory/hive-mind/issues/11), the M3 plan, chose a `(writer_xid, seq)` safe horizon and asked M2 for the schema.
- Expiry has to work without a background job, and the Vercel tier limits how often a Cron job can run.

## Decision

### Session ownership

- A Session has an immutable `owner_kind` (`user` or `key`) and exactly one of `user_id` or `key_id`. A Project key acts as itself: the server never impersonates the key's creator and never creates a synthetic User.
- `key_id` is the key's UUID kept as history, with no foreign key to the deletable `apikey` or `project_api_key` rows. Coordination records never store a raw key or its hash. Revoking a key deletes nothing in coordination history.
- A revoked key cannot continue its Session: its requests fail authentication with 401. The Session's history stays readable to any authorized caller in the Project, and the sweep ends its liveness like any other Session's.
- A Plan created by a key has no `owner_user_id`. Creation and mutation attribution name the real principal.
- This replaces `CONTEXT.md`'s statement that every Session belongs to a User, under ADR-0013's delegation to M2. ADR-0013 stays accepted; this ADR fills in what it left to M2.

### Authorization

Every new endpoint resolves Project access first, then nested resources, then capability, then Session ownership.

| Operation | User principal | Project-key principal |
|---|---|---|
| Read Plans, Tasks, Sessions, Scopes, Events and status | Current Member of the Project's organization | Bound Project and the matching read permission |
| Create, edit, change status of or log to a Plan; add a Task | Current Member | Bound Project and `plan:write` or `task:write` |
| Start a Session | As itself | As itself, with `session:write` |
| Heartbeat, update, attach or end a Session; add or remove its Scopes | Own Session | Own Session and the matching write permission |
| Claim, release, start, block or finish a Task | Own live Session, plus the current-holder rules | Own live Session, `task:write`, plus the current-holder rules |
| `--steal` takeover | Own live Session in this Project | Own live Session, bound Project and `task:write` |
| Organization and Project listing, Project creation, key management | ADR-0013 | ADR-0013 |

- An inaccessible Project, or an identifier that belongs to another Project, gets the same 404 as an absent resource. Insufficient capability on a visible resource is 403. Authentication failures stay 401, and a verifier or database failure stays 500 (ADR-0013).
- Cookies and `activeOrganizationId` are never authorization inputs (ADR-0007, ADR-0009).
- The fixed permission constant (`PROJECT_KEY_PERMISSIONS` in `packages/contract/src/auth.ts`) is `project:read`, `plan:read`, `plan:write`, `task:read`, `task:write`, `session:read`, `session:write`, `scope:read`, `scope:write` and `event:read`. Status requires the read permission of every record kind it includes. Permissions come from the server, never from request fields or plugin metadata. Key management stays owner-only.

### Per-Project transaction lock

- Every coordination mutation runs through one `@hivemind/db` transaction helper. It first takes a transaction-level advisory lock for the Project: the two-key form `pg_advisory_xact_lock(<namespace>, hashtext(project_id::text))`, where `<namespace>` is a fixed 32-bit constant defined next to the helper that must never change.
- After the lock it reads `clock_timestamp()` once and uses that value as "now" for every eligibility check and timestamp in the transaction. It then rechecks access and ownership, updates state, inserts Events and commits.
- No network, git, embedding or auth-plugin call happens while the lock is held. Request hashing and validation happen before the lock is taken.
- A claim is a single conditional `UPDATE … RETURNING` whose `WHERE` clause repeats the eligibility rules. It is never a read followed by an unconditional write.
- Plan keys (`PLAN-N`) come from a Project-local counter, `next_plan_number` (default 1), incremented under the same lock.

### Events

- Every domain mutation inserts its Event in the same transaction, so a failed write, conflict or rollback leaves neither state nor Event. A successful no-op, such as a replayed creation, a repeated claim by its holder or an idempotent Scope change, writes no Event. Heartbeats are durable changes and write Events. Plan log entries are Events with bounded markdown, not a separate table.
- Operational metadata (creation fingerprints, upload receipts, sweep progress) is stored with its operation and is not an Event.
- The server derives the actor: kind `user`, `project_key` or `system`, plus the actor Session when there is one. Callers cannot supply attribution. Sweep transitions use `system`, never a fabricated User or Session. Payloads are typed and versioned, and name the affected Plan, Task and Session separately from the actor Session.
- `event` has a UUID primary key and a unique `bigserial` `seq`. The API exposes `seq` as a decimal string, never a JavaScript number. Gaps in `seq` are normal and never mean a missing Event.
- For #11, every Event has `writer_xid xid8 NOT NULL DEFAULT pg_current_xact_id()`, generated by the database and exposed as a decimal string. Indexes cover `(project_id, seq)` and `(project_id, writer_xid, seq)`. No caller supplies `seq` or `writer_xid`.
- The encoded Event DTO is at most 64 KiB, so #11 can derive frame and batch sizes. Events never contain credentials or whole unrelated requests.

### Creation replay

- Plan, Task and Session creation and Plan log appends accept a UUID generated once by the CLI (with an `--id` recovery option). The server stores a bounded fingerprint of the canonical creation input and the authenticated principal. Neither is taken from the request.
- Lookup is scoped by Project, entity or action, and UUID. The same UUID, input and actor returns the existing record with `created: false` and no new Event, even if the record was edited since; the comparison uses the stored fingerprint, not current fields. A different input or actor in the same Project is a generic 409. A UUID used in another Project gets the generic 404, disclosing nothing about that record.
- The CLI never retries a mutation blindly after a network failure. It prints the generated ID and how to inspect before retrying.

### Lifecycle and leases

- Database time decides all eligibility. The recommended heartbeat interval is 60 seconds. A Session is effectively stale from `last_heartbeat_at + 5 minutes` and abandoned from `+ 30 minutes`; both boundaries are inclusive. A claim lease expires 5 minutes after its last renewal, also inclusive.
- Reads compute effective liveness and usable claims from one database timestamp, whatever the stored status says, and perform no writes. Mutations reconcile expired state under the lock and write its Events, recording `effectiveAt` separately from the Event's write time. Expiry therefore never waits for the sweep.
- Only `active` and `idle` Sessions hold claims. Stale, ended and abandoned Sessions are left out of live overlap checks.
- A claim succeeds only on a Task that is not done, in an active Plan, when the Task is unclaimed, its lease has expired, or its holder is stale or terminal. A live competing claim is 409 with the holder's Session UUID and bounded intent in the message. A holder repeating its valid claim is a no-op that does not extend the lease.
- A heartbeat renews only that Session's unexpired claims. A stale Session that heartbeats loses its expired claims (with Events) before it becomes live again, and must reclaim. A Session past 30 minutes cannot be revived, even if its stored row still says `active`.
- `--steal` moves a live claim to the caller's live Session under the lock and writes an Event naming the former and new holders. Any later heartbeat, release, start, block or done from the former holder cannot change the new claim. Any authorized Session can steal, so headless recovery works without an owner; conflicts keep the existing `{ code, message }` error contract.
- Start, block and done require the caller's current unexpired claim. Release clears only the caller's claim; release of an unclaimed Task is a no-op, and release of another Session's claim is 409. Ending a Session releases all its claims and keeps Task progress. The first final summary's fingerprint is kept: an identical repeat is a no-op and a different one is 409, including on an abandoned Session, which can still accept its first summary and stays abandoned.
- Plan transitions: `draft → active | abandoned`, `active → paused | done | abandoned`, `paused → active | done | abandoned`. Done requires every Task done and no claims left. Abandon releases remaining claims with Events. Done and abandoned are terminal. A paused Plan lets existing holders heartbeat, block, finish or release, but allows no new claim or start. Log appends work on terminal Plans; edits and new Tasks do not.

### Sweep

- `apps/web/vercel.json` schedules `GET /api/cron/coordination` every minute (`* * * * *`); the team is on Vercel Pro, so no upgrade was needed.
- The route is outside the `/api/v1` bearer contract. It reads `CRON_SECRET` when a request arrives, not at build time, and rejects every request when the secret is unset or the `Authorization: Bearer` value differs. Responses are uncached, bounded JSON.
- Each invocation pages through candidate Projects ordered by `coordination_swept_at` (nulls first), then UUID. For each it opens a transaction and calls `pg_try_advisory_xact_lock` with the same key as the helper; a busy Project is skipped and stays eligible. Under the lock it rechecks timestamps, marks stale and abandoned Sessions, releases expired claims, writes `system` Events for those transitions and advances `coordination_swept_at`, even if work remains. One transaction never holds more than one Project lock.
- Repeated, overlapping or late sweeps are safe: every transition is conditional on current state, so a second run finds nothing to change and writes no duplicate Event. Progress is kept only in the database, never in memory or in a returned cursor.

### Not decided here

ADR-0010 stays proposed. #11 owns the stream, cursors, snapshots and the safe-horizon queries, and accepts, amends or supersedes ADR-0010. M2 supplies only the `writer_xid` and `seq` columns, their indexes and paginated reads.

## Consequences

- **Existing Project keys gain coordination access.** The server grants the full permission list to every Project key, including keys issued under M1. A key that could read only its Project's metadata can now create Plans, start Sessions and claim Tasks in that Project. Owners who do not want that must revoke the key. Per-key permission choices would need a new ADR.
- **Writes in one Project are serialized.** Coordination mutations in a Project run one at a time, so throughput per Project is bounded by transaction latency. That is acceptable for a handful of agents per Project during dogfooding. Projects do not block each other, except that two Project UUIDs with the same 32-bit `hashtext` share a lock key and serialize each other. A collision costs only throughput: every rule is still checked inside the transaction.
- **Facts the lock relies on** ([PostgreSQL advisory lock functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)): a transaction-level advisory lock is released automatically at commit or rollback and cannot be released early, so an error path cannot leak it. It works through Neon's pooler in transaction mode, where session-level locks do not (ADR-0004). `pg_try_advisory_xact_lock` returns false at once instead of waiting. The two-key and single-`bigint` key spaces do not overlap, so these locks never contend with the migrator's lock (ADR-0004) or the personal-organization lock (ADR-0007).
- **The lock also orders Events within a Project**, which matches ADR-0010's second option. #11 does not rely on that and uses `writer_xid` instead, so this lock can change later without breaking M3.
- **Facts about Vercel Cron** ([usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), [managing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)): Hobby allows one run a day with up to 59 minutes of drift; Pro allows one a minute, invoked within the scheduled minute. Delivery is best effort: a run can be skipped or delivered twice, a failed run is not retried, and a run longer than the interval can overlap the next. Runs happen only on Production deployments, and when `CRON_SECRET` is set Vercel sends it as a bearer token. The design tolerates all of these because eligibility never depends on the sweep and every transition is conditional. On Hobby, stored status changes and their Events would lag by up to a day, while computed liveness and claim eligibility would not.
- **`CRON_SECRET` must be set in the Vercel project** before the sweep can run in Production. Until then the route rejects every call and expiry still works through request-time reconciliation.
- **Concurrency tests use separate connections**: concurrent claims, claim against sweep, heartbeat against sweep, concurrent Plan key allocation and a sweep over more Projects than one invocation processes, with one Project locked by another transaction.
- Revoking a key leaves its Sessions in place; they become stale and abandoned on schedule.

## Alternatives considered

- **A synthetic User per Project key, or attributing key actions to the key's creator:** the creator may leave the organization while the key keeps working (ADR-0013), and attribution would name someone who did not act.
- **Row locks per record (`SELECT … FOR UPDATE`) instead of a Project lock:** claim, heartbeat, Session end, Plan status and sweep touch different sets of rows, and each pair would need a consistent lock order to avoid deadlocks. One Project lock is simpler to get right; it can be narrowed later if throughput requires it.
- **`SERIALIZABLE` isolation with retries:** every handler would need a retry loop, and retrying a transaction that already wrote an Event must not produce a second one.
- **Owner-only takeover:** a headless agent with a Project key could never recover a Task from a dead Session. `--steal` is allowed and audited instead.
- **Returning the holder as structured conflict data:** this would extend the error envelope with no requirement in #1. The holder appears in the message instead.
- **Storing status transitions only when the sweep runs:** on a missed or late sweep, a dead Session would block its Tasks. Request paths compute eligibility from database time.
