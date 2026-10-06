---
status: accepted
date: 2026-10-05
---

# Cross-Project home dashboard

## Context

The signed-in `/` was a paged list of the User's Projects. To see whether anything needed them, a User opened each Project in turn. A Dashboard design exported from Claude Design replaces that list with one page across every Project the User can read: a rail of Projects, summary cells, overlap warnings, items that need attention, Sessions and Plans, throughput, agents and their active time, recent activity, decisions and the paths agents touch most. The export is not in the repo; `docs/dashboard.md` → Home page describes what was built. [#1](https://github.com/CuriouslyCory/hive-mind/issues/1) is the stack issue; no milestone issue covers this work.

The existing data did not cover four of those things. Nothing recorded when a Task became blocked or a Plan was paused, short of searching Events. There was no record of a decision. Throughput, active time and hot paths had no stored figures. And the live updates of ADR-0010 are one Event stream per Project, while this page spans many Projects.

## Decision

- **One snapshot across readable Projects.** `loadHomeDashboard` (`apps/web/src/server/dashboard/home.ts`) reads the whole page in one `runDashboardSnapshot` transaction, as the Project pages do (`docs/dashboard.md` → Initial render). It reads the Organizations the User is a current Member of inside that transaction and limits every other query to their Projects, or to the selected one; an unreadable `project` is treated as none. Queries are set-based across Projects, except M2's overlap summary, which runs per Project with two or more live Sessions. Every list has a fixed bound (`home-types.ts`). All page state is in the URL's search parameters (`home-params.ts`), and the proxy uses the same parser to tell a signed-in deep link from a visit to the landing page (ADR-0016).
- **Polling, not Event streams, for `/`.** The page opens no stream. While the browser tab is visible and online it calls `router.refresh()` every 15 seconds, and once when it becomes visible or online again (`apps/web/src/app/(app)/_home/freshness.tsx`). Project, Plan and Session pages keep their streams.
- **`task.blocked_at` and `plan.paused_at` are columns.** Both are nullable and were added expand-only in migration `0006_home_dashboard`. The migration backfilled rows already blocked or paused from their latest matching Event; a row with no such Event stays null and the page shows no time. The status change sets the column in the same transaction and clears it when the status changes back.
- **A decision is an Event.** `POST /api/v1/projects/{id}/plans/{planRef}/decisions` writes a `plan.decision_recorded` Event on the Plan, whose payload is one trimmed line of plain text of at most 500 characters. The client's Event id makes a retry idempotent. There is no decisions table; the Decisions panel reads the newest such Events (`home-decisions.ts`) through the shared projection (ADR-0015).
- **Analytics come from existing records.** Throughput, Plans finished, median Task time and agents' active time are computed from Events (`task.done`, `task.claimed`, `session.started`, `session.heartbeat`, `plan.status_changed`), and hot paths from the touched-path collection batch receipts (`scope_collection_batch`), on every read (`home-analytics.ts`). Two indexes serve them: `event (project_id, type, effective_at)` and `scope_collection_batch (project_id, created_at)`. There is no rollup table.

## Consequences

- The page is at most about 15 seconds behind, where a Project page is live. Each visible home tab runs the whole read every 15 seconds, including the aggregates over the selected range (up to 30 days). That cost grows with readable Projects, range and open tabs (`docs/dashboard.md` → Known limitations).
- Revisit the rollup, as the design suggested (a daily rollup per Project), when the home page's read becomes the slowest dashboard read in deployed use, or before M7 prunes Events, since every figure here is derived from Event history and would lose what pruning deletes. A rollup is then a new table filled from the same Events, and the read model's types stay as they are.
- `plan.decision_recorded` is new Event vocabulary. An instant rollback to a deployment without the Event reader of ADR-0015 would answer Event reads with 500, so the owner gate in [#21](https://github.com/CuriouslyCory/hive-mind/issues/21) (record the deployed reader baseline) must be done before this is deployed to production.
- Decisions are immutable and append-only like every Event. Correcting one means recording another; nothing edits or deletes it.
- The backfill is a one-off. A Task or Plan blocked or paused by a path that skips the status-change functions in `@hivemind/db` would have a null time; there is no such path today.
- Hot path touches count collection batches, so a path counts once per heartbeat while it stays changed, not once per edit. Claim lapsed items look back one hour.

## Alternatives considered

- **One Event stream per Project on the home page:** one connection per readable Project in every open tab (tabs do not share streams), each a function invocation polling once a second (ADR-0010), for a page whose figures change slowly. A cross-Project stream would need a new feed cursor across Projects, which ADR-0010's per-Project fence does not provide.
- **Deriving blocked and paused times from Events on each read:** a query over each Task's or Plan's Event history for every attention read, to answer a question the status change already knows.
- **A `decision` table:** a second write path, its own read API and its own retention, for records that are append-only and belong in the Plan's history like a log entry.
- **A daily rollup from the start:** a scheduled job, a backfill and a second source of truth before the Event reads had shown they were too slow.
