# The dashboard

The dashboard is the read-only web view of coordination state. A signed-in User starts on the home page, which summarizes every Project of every Organization they are a Member of, opens a Project, follows a Plan or a Session, and sees changes arrive without reloading. It edits nothing: Plans, Tasks, claims and Sessions change only through the CLI and `/api/v1` (ADR-0014), and ADRs change only in the repository (ADR-0017).

The design is in [#11](https://github.com/CuriouslyCory/hive-mind/issues/11) and ADR-0010; the home page's is in [ADR-0018](adr/0018-home-dashboard.md). This page describes what the code does.

## Pages

| Route | Shows |
|---|---|
| `/` | Signed out: the public landing page (`/welcome`), which `apps/web/src/proxy.ts` serves at `/` by a rewrite; a `/` that names a home-page state (below) redirects to `/sign-in` and returns to it. Signed in: the home page (see [Home page](#home-page)): a rail of the User's Projects, summary cells, overlap warnings, Needs attention, Sessions and Plans tables, Throughput, Agents, recent Activity, Decisions and Hot paths, across every readable Project or within one. Its list views show the Plans or the Sessions alone. All its state is in the URL: `project` (a Project id), `q` (the filter), `view` (`plans` or `sessions`), `sessions` (`active`, `ended`, `overlap`, `all`), `plans` (`all`, `active`, `paused`, `done`) and `range` (`24h`, `7d`, `30d`). A User with no Projects sees how to create one with `hivemind init` ([docs/cli.md](cli.md)). |
| `/projects/[projectId]` | Active Plans with Task progress (20 per page); overlap warnings (advisory, up to 20); live Sessions (up to 20) with agent, status, owner, machine and branch, focus (Plan or Task), last heartbeat and declared Scope; recent ended or abandoned Sessions (20 per page); recent ADRs (the 5 published ADRs a sync changed most recently) and a link to the ADR list. |
| `/projects/[projectId]/plans/[planKey]` | The Plan's status, progress, creator and owner; its body as sanitized markdown; its Tasks in order with their claim holders (20 per page); the Sessions attached to it; its activity (Events, 50 per page). `planKey` is the Plan's key, such as `PLAN-3`. |
| `/projects/[projectId]/sessions/[sessionId]` | The Session's agent, intent, status, owner, machine, branch and commit, focus, start, last heartbeat and end; its end summary as sanitized markdown; its declared and touched Scope; its Event timeline (newest first, 50 per page). |
| `/projects/[projectId]/adrs` | The ADR list: published ADRs with number (`ADR-0003`), title and status, highest number first (20 per page), filtered by `?status=`; numbers reserved with `hivemind adr new` and not in a synced commit yet, under "Reserved, not merged yet" (20 per page); ADRs a later sync no longer found, under "Removed from the repository" (shown only when there are some). |
| `/projects/[projectId]/adrs/[number]` | One ADR: its status, date, file path, the commit its copy came from, and its reservation, if it was reserved; a note when a hand-numbered file took a number reserved for another ADR, which then needs a new number; the ADRs it supersedes and the ones that supersede it, each followed up to 10 links, with a number that has no synced file marked "not found"; the file after its frontmatter as sanitized markdown. `number` is `3`, `0003` or `ADR-0003`. |

Every ADR page starts with what the copy is as of: "Copied from `docs/adr/` at commit `<sha7>`, synced `<time>` by `<User or Project key>`. The files in the repository are the source of truth." Before the first sync it says: "No ADRs synced yet. Run `hivemind adr sync` on the default branch." The ADR list's status filter is a row of plain links (All, Proposed, Accepted, Superseded, Deprecated) that set `?status=`; a value that is not an ADR status shows every status. Reservations have no status, so they are listed under any filter. An ADR's state (reserved, published, removed) is never shown as a status.

A Session or Event started with a Project key is attributed to the key, never to the key's creator. Task progress, usable claims, effective Session status and overlaps come from M2's read functions in `@hivemind/db`, judged at the database time of the page's snapshot; the dashboard does not recompute them from timestamps. The Project pages' lists are keyset-paged with opaque cursors in the URL's search parameters; a cursor that does not decode shows the first page. The home page has no cursors: its lists are bounded instead.

## Home page

`/` signed in is `apps/web/src/app/(app)/page.tsx`, built from `_home/` on the design system ([docs/design-system.md](design-system.md)). Its data is `loadHomeDashboard` in `apps/web/src/server/dashboard/home.ts`; the read model and its limits are in `home-types.ts`, the analytics in `home-analytics.ts` and the decisions in `home-decisions.ts`.

**State.** `parseHomeParams` (`home-params.ts`) reads the search parameters listed under Pages; an unknown or malformed value falls back to the default (all Projects, no filter, the home view, the `active` Sessions tab, the `all` Plans tab, `7d`), and `homeHref` leaves defaults out of the URL. Every control is a link to another state, and the filter replaces the URL 300 ms after typing stops (at once on Enter), so a filtered view can be shared and a refresh re-reads exactly what is on screen. A `project` the User cannot read is treated as none.

**The read.** One `runDashboardSnapshot` transaction, like a Project page. It reads the Projects of the Organizations the User is a current Member of, and limits every other query to them, or to the selected one. Lists are set-based across those Projects; only M2's overlap summary runs per Project, for Projects with at least two live Sessions. `q` is a case-insensitive substring, matched in SQL with its wildcards escaped, against the fields each section shows: intents, agents, owners, machines, branches, Plan keys and titles, Project names, Task titles and block reasons, decision text, paths. Needs attention also matches each kind's label as the page shows it (`ATTENTION_LABELS`), so `lapsed` lists every lapsed claim. Events are described before they can be matched, so the Activity list filters the newest 200 Events in scope (`HOME_EVENT_WINDOW`) in memory.

**Bounds** (`home-types.ts` and `home.ts`):

| What | Bound |
|---|---|
| Projects in the rail | 50 (`HOME_PROJECT_LIMIT`), with a "Showing 50 of N" note |
| Sessions and Plans tables | 5 rows on the home view (`HOME_TABLE_ROWS`), with "See all" to the list view; 100 on the list views (`LIST_TABLE_ROWS`) |
| Needs attention | 10 items (`HOME_ATTENTION_LIMIT`); each kind is one bounded query that also counts all its matches |
| Overlap warnings | 5 (`HOME_OVERLAP_LIMIT`), from at most 100 live Sessions and 100 overlaps per Project |
| Activity | 7 Events (`HOME_EVENT_LIMIT`) out of the newest 200 |
| Decisions | 4 (`HOME_DECISION_LIMIT`) |
| Hot paths | 6 (`HOME_HOT_PATH_LIMIT`) |
| Agents | 10 (`HOME_AGENT_LIMIT`) |

The list views (`view=plans`, `view=sessions`) read only the rail, their table and its tab counts; Needs attention, Activity, Decisions and the analytics come back empty.

**Summary cells.** Active Plans (status `active`); Buzzing (Sessions effectively `active`); Open Tasks (not `done`, in Plans that are not `done` or `abandoned`); Tasks done (`task.done` Events in the range); Blocked Tasks (status `blocked`, in open Plans); Overlaps (current overlap pairs between live Sessions). Each links to the list view and tab that shows them.

**Needs attention.** Advisory: nothing is blocked by these items. Most urgent kind first, then:

| Kind | An item when | Order within the kind |
|---|---|---|
| Lease ending | A usable claim's lease ends within 120 s (`LEASE_ENDING_SECONDS`). | Soonest first |
| Claim lapsed | Within the last hour (`LAPSED_CLAIM_WINDOW_SECONDS`), a claim stopped being usable (its lease expired or its holder is no longer live) and nothing has reconciled it yet, or the Task's latest claim change was a time-driven `task.released` (`lease_expired`, `session_stale`, `session_abandoned`) and the Task is still unclaimed and not done. The Task's Plan is open. | Most recent first |
| Blocked Task | A Task has status `blocked` in an open Plan. Shows its reason and `task.blocked_at`. | Most recently blocked first |
| Unclaimed Plan | An `active` Plan with open Tasks has no usable claim, and for 24 hours (`UNCLAIMED_PLAN_SECONDS`) has had no update, no `task.claimed`, `task.released` or `task.done`, and no Task holding a usable claim. | Most recently idle first |
| Paused Plan | A `paused` Plan still has open Tasks. Shows `plan.paused_at`. | Most recently paused first |

`blocked_at` and `paused_at` are set when the status changes and cleared when it changes back. Rows that were already blocked or paused before the columns existed were backfilled from their latest matching Event; one with no such Event shows no time. Status changes made by a deployment without the columns leave them unchanged (Known limitations).

**Throughput, Agents and Hot paths** (`home-analytics.ts`). Every boundary derives from the snapshot's database time. The range `24h` is 24 hourly buckets, `7d` and `30d` are 7 or 30 UTC days; the last bucket holds now and is partial, and each figure is compared with the same elapsed time one range earlier, from the start of the range minus its length to now minus its length, so a steady rate compares as equal.

- **Throughput:** `task.done` Events per bucket; Sessions started (`session.started`); Plans finished (`plan.status_changed` to `done`); and the median minutes from a Task's latest `task.claimed` before its `task.done` to that `task.done`.
- **Agents:** grouped by the Sessions' agent name: their machines, Projects, Sessions started, `task.done` Events written through them, and active time. Active time sums the gaps between a Session's consecutive `session.started` and `session.heartbeat` Events that are shorter than 5 minutes (`ACTIVE_GAP_SECONDS`), clipped to the range; a longer gap counts as away. Most active first.
- **Hot paths:** touched paths from the Sessions' collection batches (`scope_collection_batch`) in the range, ranked by touches (the number of batches that carried the path), then by distinct Sessions. A path is marked when the Scope of a current overlap matches it. Batches outlive their Session, so the history does too.

These read existing Events and batches through two indexes added for them, `event (project_id, type, effective_at)` and `scope_collection_batch (project_id, created_at)`; there is no rollup table (ADR-0018).

**Decisions.** The newest `plan.decision_recorded` Events in scope, written by `POST /api/v1/projects/{id}/plans/{planRef}/decisions`. Each goes through the shared projection (ADR-0015); one this build cannot read is left out rather than shown as unavailable.

**Live behavior.** The home page opens no Event stream. One page spans up to every readable Project, and the stream is per Project ([The stream](#the-stream)), so live updates would need one connection per Project in every open tab, and tabs do not share streams. Instead `Freshness` (`_home/freshness.tsx`) calls `router.refresh()` every 15 seconds (`HOME_REFRESH_MS`) while the browser tab is visible and online, and at once when it becomes visible or online again. Each refresh is a new snapshot. The page says "Live" with the age of its data, or "Offline". When the page is hidden in a React Activity (Cache Components; see `AGENTS.md`), its timer stops; when Back shows it again, it refreshes at once if its data is older than the interval.

## Authorization

Every page checks access itself, at request time, inside a Suspense boundary (ADR-0003):

- **Fresh login session.** `requireFreshLoginSession()` (`apps/web/src/server/login-session.ts`) looks the login session up in the database with better-auth's cookie cache disabled, so a revoked or expired login session is refused on the next navigation or refresh. Without one, the page redirects to `/sign-in` with a return path.
- **Membership on every read.** The page's loader (`apps/web/src/server/dashboard/queries.ts`) first checks that the User is a current Member of the Project's Organization, inside the same transaction as the rest of the page's reads. `activeOrganizationId` is never consulted (ADR-0007).
- **A foreign child is an absent child.** A Plan, Session or ADR is always looked up together with its Project. A child of another Project, an absent child, a malformed Plan key, Session id or ADR number, an absent Project and a Project the User cannot read all render the same not-found page.
- No authenticated data is put in a shared cache.

## Initial render

Each page reads everything it shows in one short `READ ONLY REPEATABLE READ` transaction (`runDashboardSnapshot` in `apps/web/src/server/dashboard/snapshot.ts`, over `withFeedSnapshot` in `packages/db/src/event-feed.ts`). Its first statement reads the database time and the feed horizon `H = pg_snapshot_xmin(pg_current_snapshot())`; the authorization check and every query then run on that one database snapshot, so counts, claims and liveness agree with each other. The transaction ends before the page responds.

A Project page also gets the fence `(H, 0)`, encoded as a feed cursor for that Project. Every Event written by a transaction below H is already in the snapshot. The live-update subscription starts from the fence, so it delivers every Event at or above H once it is safe, including one from a transaction that commits after the page was rendered but before the browser subscribed. Some of those Events may already be in the snapshot; applying them again only causes an extra refresh.

## Live updates

### In the browser

The home page does not subscribe; it refreshes on a timer ([Home page](#home-page) → Live behavior). One subscription runs per open Project (`createProjectEventStream` in `apps/web/src/lib/project-event-stream.ts`, used by `ProjectLiveUpdates` in `apps/web/src/components/dashboard/project-live-updates.tsx`). It reads the cookie stream with `fetch`, so it sees HTTP statuses and can send `Last-Event-ID`. The subscription and its cursor survive page refreshes. Changing Project closes it and opens a new one from the new page's fence, so no cursor crosses Projects.

The browser never renders Event content from the stream. An Event is only an invalidation:

1. **Filter.** `apps/web/src/lib/project-event-filters.ts` decides whether the Event affects the current page. The overview counts every Event. A Plan page counts Events of the Plan, its Tasks and the Sessions it shows; `adr.*` Events change nothing on it. A Session page counts Events that affected the Session or that it acted through, and Events of its Task. It shows only its Plan's key, which never changes, so `plan.*` Events do not refresh it; an `adr.reserved` Event refreshes it only when the Session acted through it, since that Event is in its timeline. The ADR list counts every `adr.*` Event. An ADR page counts `adr.reserved` for its own number (`payload.number`) and every `adr.synced`: a sync's Event lists at most 100 changes, and an ADR added by the sync can supersede the page's ADR without the payload saying so. An Event type this build does not know, `event.unavailable` included, refreshes every page (see [Events the server cannot read](#events-the-server-cannot-read)).
2. **Deduplicate.** The ids of the last 2048 Events are remembered, and a redelivered Event is dropped.
3. **Record, then advance.** An accepted Event marks the page dirty, and only then does the cursor move to the Event's position. The cursor never moves backwards.
4. **Refresh.** Dirty marks are coalesced into `router.refresh()`, which re-reads the page from the server through the same authorization and snapshot as the initial render. At most one refresh runs at a time. A dirty-generation counter records marks that arrive while a refresh is running, and they cause exactly one more refresh after it. A refresh that has not finished after 20 seconds is treated as done.

Lease expiry and Session liveness change with time alone, without an Event, so the page also refreshes every 60 seconds while it is visible. It does not replace the stream and does not sweep anything; it re-reads M2's computed state.

The subscription reconciles (refreshes once and reconnects if it is not connected) when:

- the tab becomes visible again (refreshes are deferred while it is hidden, and the 60-second refresh stops);
- the browser comes back online (going offline closes the connection);
- the first frame arrives on a new connection after a failure or after being offline;
- the Project layout is shown again after being hidden (Next keeps a layout the User leaves in a hidden React Activity, and Back shows it with the page it rendered). Hiding the layout closes the subscription; showing it starts one from the page's fence and refreshes the page at once.

Reconnects send the last processed cursor as `Last-Event-ID`. After a planned end (the server's 50-second rotation) of a connection that delivered a frame and stayed open at least 5 seconds, the browser reconnects at once. After a failure, a quick or truncated end, or an `error` frame, it waits with jittered exponential backoff from 1 second up to 30 seconds.

An `access_lost` frame, or a 401, 403 or 404 when (re)connecting, is terminal: the provider replaces the Project's content with a message and stops retrying until the User navigates to another pathname. That navigation does not show the content yet, because Back or Forward can show a page Next kept from before the loss without a server render. It starts a new subscription from the last page shown, and the content returns, refreshed, only once the server accepts that subscription, which it does only after checking the login session and Project access. If the server refuses it, access stays lost at the new pathname. A page that registers a newer fence on the same pathname does not start a check: a `router.refresh()` that started before the loss can commit after it, and its render was authorized before the loss. The message stays while the layout is hidden and when Back shows it again.

A 400 means the server rejected the resume cursor. That can happen to a cursor it issued, for example after a Postgres crash when the cursor names a transaction ID the server has not reached again. The subscription then resnapshots once: it refreshes the page, resumes from the fence of that fresh render, and stops with an error if that fence is rejected too or the refresh brings none. It never resumes from the server's current position without a fresh snapshot, which could skip Events.

The freshness line (`apps/web/src/components/dashboard/live-status.tsx`) shows the state in words: connecting, live, updating, delayed, reconnecting, offline, stopped, or access ended, with the time the data on screen was read where it applies: the page's snapshot time, then the end of each successful refresh. Only the state's words are in the `aria-live` region, so a refresh that changes only the time is not announced.

### The stream

Both routes serve the same procedure, engine and frames (`apps/web/src/server/realtime/event-stream.ts`, contract in `packages/contract/src/event-stream.ts`):

| Route | Credential | Used by |
|---|---|---|
| `GET /api/v1/projects/{id}/events/stream` | `Authorization: Bearer` with a login token or a Project key; cookies are ignored, like the rest of `/api/v1` | the CLI and other API clients |
| `GET /api/dashboard/projects/{projectId}/events/stream` | the browser's login session cookie only; `Authorization` and `X-API-Key` are ignored, and no token reaches JavaScript | the dashboard |

The cookie route serves only GET; any other method gets a 404. It mounts no other procedure, so a cookie never authorizes a mutation.

**Where the stream starts.** The first of these that is present: the `Last-Event-ID` header, the `cursor` query parameter, else the current safe horizon (a tail: only Events that become safe after the stream opens). `feedOriginCursor(projectId)` from `@hivemind/contract` is the cursor that replays the Project's whole retained history.

**Before the stream opens,** the server authenticates, authorizes (`event:read`; a User needs membership in the Project's Organization, a Project key must be bound to the Project) and validates the cursor. A failure is an ordinary JSON error with a status, never an open 200 stream:

| Status | When |
|---|---|
| 400 `BAD_REQUEST` | The cursor is malformed, from another cursor version, issued for another Project, out of range, or names a transaction ID or `seq` the database has not issued yet. The server never substitutes another start position. |
| 401 `UNAUTHORIZED` | No valid credential. |
| 404 `NOT_FOUND` | The Project does not exist, or the caller cannot read it. |

**Frames.** Each SSE message's `data` is JSON with a `type`:

| `type` | SSE `id` | Meaning |
|---|---|---|
| `ready` | the start cursor: the one presented, or the fence `(H, 0)` of a tail | Sent once, first. A client that drops before its first Event can resume from it. |
| `event` | the Event's cursor | `{ type, event }`, where `event` is the contract Event (`eventSchema` in `packages/contract/src/event.ts`), or `event.unavailable` when the server cannot read its details. |
| `heartbeat` | none | `{ type, serverTime, withheld }`. `withheld` is true while this Project has committed Events that the horizon holds back. |
| `access_lost` | none | `{ type, code }` with `UNAUTHORIZED` or `NOT_FOUND`. The last frame; the cursor does not move. Do not reconnect until the credential or access is fixed. |

A failure after the stream opened (for example a database error) ends it with oRPC's `error` message carrying a generic `INTERNAL_SERVER_ERROR`; reconnect with the last cursor. A database failure is never reported as an authentication failure.

**Ordering.** The feed orders Events by `(writer_xid, seq)` and returns only those with `writer_xid` below the horizon, so no Event can later appear behind a position the stream has passed (ADR-0010). Delivery is at least once, and feed order is not commit order or time order: a transaction's ID is assigned at its first write, not when it commits.

### Bounds and lifecycle

The constants are in `packages/contract/src/event-stream.ts` and `DEFAULT_EVENT_STREAM_SETTINGS` in `apps/web/src/server/realtime/event-stream.ts`.

| What | Value |
|---|---|
| Poll interval | 1 s; at once after a batch of 100 Events or one the byte budget cut |
| Per poll | one short transaction on the shared pool: a fresh credential and Project access check, then the feed read |
| Batch | at most 100 Events and a 512 KiB byte budget, but always at least one Event |
| Largest Event frame | 65 KiB (the 64 KiB maximum encoded Event plus 1 KiB of framing) |
| Memory | at most 1 MiB of Event bytes read and not yet sent: the send queue, one batch in flight and up to three frames in the encoder; a consumer that keeps the queue full for 5 s is disconnected and resumes from its cursor |
| Database step | 5 s `statement_timeout`; 8 s for acquiring a connection and running a step |
| Heartbeat | every 15 s; oRPC's own keepalive comments are disabled |
| Rotation | the stream ends itself 50 s after it opened; both routes export `maxDuration = 60` |
| Withheld log | one server log line per stream after newer Events have been held back for 30 s |
| Browser reconnect | at once after a healthy planned end; otherwise jittered exponential backoff from 1 s to 30 s |
| Browser frame cap | an SSE message over 65 KiB fails the connection before it is parsed |

No connection or transaction is held between polls. The stream ends, and stops issuing queries, on rotation, request abort, body cancellation, a slow consumer or access loss, including while the generator is paused waiting for the client to read.

## Events the server cannot read

After a rollback, the database can hold Events that a newer deployment wrote, with a type, payload version or enum value this build does not know. The dashboard passes every stored Event through `projectEvent` (`apps/web/src/server/event-projection.ts`, ADR-0015), as the API and both stream routes do, so such an Event is not an error:

- **Initial render and refresh.** A Plan or Session timeline shows the Event with its time, actor and affected Plan, Task and Session, and the fixed text "Event details unavailable", rendered as plain text, not markdown. Nothing from its stored payload reaches the page.
- **Live.** The stream sends it as an `event` frame whose Event has type `event.unavailable`, an empty payload and its original cursor, and delivery continues after it. The filter does not know that type, so every page of the Project refreshes. That also covers what the withheld payload would have told it, such as the Plan a `session.attached` Session left. A browser bundle from before this change does the same, because it does not know the type either.

A corrupt Event (invalid metadata or payload version, or a stored payload over the writer's 60 KiB limit) is still a server error: the page's read fails, and the stream ends with `INTERNAL_SERVER_ERROR` without moving its cursor past the Event.

## Markdown and untrusted text

Plan bodies, Plan log entries, Session end summaries and ADR files are written by agents and Users, so they are untrusted. One server renderer, `SafeMarkdown` in `apps/web/src/server/dashboard/markdown.tsx`, renders all of them with react-markdown and remark-gfm:

- Raw HTML in the source is dropped (`skipHtml`), never parsed.
- The output is sanitized with rehype-sanitize using GitHub's schema without `img`, after every other step.
- Links keep only absolute `http:`, `https:` and `mailto:` URLs; anything else, including `javascript:`, `data:` and relative paths, renders as plain text. Every link gets `rel="noopener noreferrer nofollow"`.
- Images are never loaded; each renders as `[image: alt text]`.
- Headings are shifted down so a document's `#` does not compete with the page's headings.

An ADR page renders only the part of the file after its frontmatter (`parseAdrContent(...).adr.body` from `@hivemind/contract`); the status, date and supersedes list come from the stored copy and render as plain text. A later `---` block in the body is a rule and a heading, never metadata. Links between ADRs in the repository are relative (`[ADR-0004](0004-x.md)`), so under the rules above they render as plain text, not links; the page's supersedes and superseded-by links point to the other ADR pages instead. The ADR's title is plain text.

Labels, intents, ADR titles, recorded decisions and Event text are not markdown. They render as plain React text, and Event text is built only from known payload fields of projected Events (`apps/web/src/server/dashboard/event-text.ts`), never by spreading a payload into HTML or props.

## Known limitations

- **An old open transaction delays delivery for every Project.** The horizon is the oldest running transaction that has an ID, in any database on the same Postgres server. While such a transaction stays open, newer Events wait; they are never skipped. Heartbeats report `withheld`, the dashboard shows "delayed", and the server logs once per stream after 30 seconds. Mutations and snapshots must stay short. If this is common in deployed use, ADR-0010 is reopened; the feed does not fall back to a lossy cursor.
- **Polling cost grows with open tabs.** Each open Project tab holds one function invocation and runs one transaction per second, plus a page refresh per batch of relevant Events and every 60 seconds while visible. Tabs do not share a stream.
- **No per-caller cap on concurrent streams.** One User or Project key can open any number of streams, each holding a function instance and polling once a second until it rotates. This is an accepted risk; general rate limiting is M7's ([#1](https://github.com/CuriouslyCory/hive-mind/issues/1), [#11](https://github.com/CuriouslyCory/hive-mind/issues/11)).
- **A fence can be wrong after a Postgres crash.** A page's fence `(H, 0)` can name a transaction ID that was assigned but never made durable, and crash recovery can issue such IDs again. Resuming from that fence can then fail with 400 while the server's next ID is below H (the dashboard takes a fresh snapshot once), or, once new IDs pass H, skip Events written under reissued IDs below H. A committed Event's ID is never reused, so a cursor from a delivered Event is unaffected (ADR-0010). Fixing this is follow-up work ([#17](https://github.com/CuriouslyCory/hive-mind/issues/17)).
- **Delivery is at least once, and cursor order is not commit order.** The dashboard is unaffected because it re-reads server state; other clients must apply Events idempotently and must not treat feed order as time order.
- **The home page's refresh re-runs its aggregates.** Every 15 seconds, each visible home page tab runs the whole read again: the counts, every Needs-attention kind, the overlap summary per Project with live Sessions, and the Throughput, Agents and Hot paths aggregates over the range (up to 30 days of Events and batches). The indexes bound each statement, but the cost grows with the number of readable Projects, the range and the open tabs. Agents and Hot paths scan every `session.started` and `session.heartbeat` Event and every collection batch receipt in the range, so theirs also grows with the number of agents heartbeating. ADR-0018 says when to add a rollup.
- **Blocked and paused times can be early or missing for a while.** Migration `0007_home_dashboard` adds and backfills `task.blocked_at` and `plan.paused_at` before the new code is live. Until then, and after a rollback, the previous deployment changes statuses without touching the columns, so a Task or Plan it blocks or pauses can show no time or an earlier block's or pause's time, until its next status change through current code. A reconciliation migration in a later release fixes such rows (ADR-0018).
- **Migration `0007_home_dashboard` builds its indexes without `CONCURRENTLY`.** It blocks writes to `event` and `scope_collection_batch` while it runs, which is brief at the current sizes; on a large `event` table, build such an index concurrently in a separate step (ADR-0018).
- **Hot path touches count collection batches, not edits.** Each `hivemind session heartbeat` uploads the worktree's changed paths in batches of at most 16 ([docs/cli.md](cli.md)), and a path is in one batch per heartbeat. So a path counts once per heartbeat while it stays changed, however often it was edited, and a change committed between two heartbeats is not counted at all. A Session that heartbeats more often makes its paths look hotter.
- **Claim lapsed looks back one hour.** A claim that lapsed earlier and was never picked up again no longer shows; the Task still shows as unclaimed on its Plan.
- **No Event retention until M7.** Events are never deleted yet, so `feedOriginCursor` replays everything. Before M7 prunes Events that a cursor could still replay, it needs an expired-cursor protocol (ADR-0010).

## Tests

- `packages/db/test/event-feed.test.ts`: the horizon with concurrent writers, the snapshot fence, rollback gaps, several batches, integers above `Number.MAX_SAFE_INTEGER`, and a seq-only cursor shown to lose an Event.
- `packages/contract/test/event-stream.test.ts`: cursors, frames and bounds.
- `apps/web/test/event-stream.test.ts`: both routes' statuses, access loss during a stream, resume, withheld delivery, rotation, abort while paused, slow consumers and cleanup.
- `apps/web/test/project-event-stream.test.ts`: the browser engine's decoding, deduplication, refresh coalescing, reconnects and terminal states, and which Events refresh which page, ADR pages included.
- `apps/web/test/project-live-registry.test.ts`: one stream across a Project's pages, its cursor when the page changes (from a Plan page to the ADR pages, for example), lost access and hidden layouts.
- `apps/web/test/dashboard-queries.test.ts` and `apps/web/test/markdown.test.ts`: page reads, cross-Project children, attribution and hostile markdown. For ADRs: membership, malformed and foreign numbers, the status filter, reservations and removed ADRs listed apart, a taken reservation, supersedes chains with missing targets, cycles and the depth bound, the banner's last sync by a User or a Project key, the overview's recent ADRs, and ADR bodies with their frontmatter removed, hostile HTML dropped and relative links shown as text.
- `apps/web/test/home-dashboard.test.ts`, `home-analytics.test.ts`, `home-decisions.test.ts`, `home-params.test.ts` and `home-page.test.ts`: the home page's read across Organizations, its filter, each attention kind, the analytics boundaries, decisions, the URL state and the rendered sections. `apps/web/test/proxy.test.ts` checks that the proxy and `parseHomeParams` agree on which `/` queries are signed-in links.
- `apps/web/test/e2e/home.spec.ts` (Playwright): the home page with real data, scoping, the filter, the list views, a decision reaching an open page on its next refresh, the layout with a long Project name, and the signed-out redirect.
- `apps/web/test/event-projection.test.ts`: the shared projection, with a pinned reader from before #14's `stolen` reason, unreadable details, corrupt rows and sanitized errors. The stream, page and browser tests above also cover Events a newer deployment wrote (ADR-0015).
