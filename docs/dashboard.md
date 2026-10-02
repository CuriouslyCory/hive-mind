# The dashboard

The dashboard is the read-only web view of coordination state. A signed-in User sees the Projects of every Organization they are a Member of, opens a Project, follows a Plan or a Session, and sees changes arrive without reloading. It edits nothing: Plans, Tasks, claims and Sessions change only through the CLI and `/api/v1` (ADR-0014).

The design is in [#11](https://github.com/CuriouslyCory/hive-mind/issues/11) and ADR-0010. This page describes what the code does.

## Pages

| Route | Shows |
|---|---|
| `/` | The Projects of every Organization the User is a Member of, oldest first, 20 per page, each with its Organization's name and its slug. A User with no Projects sees how to create one with `hivemind init` ([docs/cli.md](cli.md)). |
| `/projects/[projectId]` | Active Plans with Task progress (20 per page); overlap warnings (advisory, up to 20); live Sessions (up to 20) with agent, status, owner, machine and branch, focus (Plan or Task), last heartbeat and declared Scope; recent ended or abandoned Sessions (20 per page). |
| `/projects/[projectId]/plans/[planKey]` | The Plan's status, progress, creator and owner; its body as sanitized markdown; its Tasks in order with their claim holders (20 per page); the Sessions attached to it; its activity (Events, 50 per page). `planKey` is the Plan's key, such as `PLAN-3`. |
| `/projects/[projectId]/sessions/[sessionId]` | The Session's agent, intent, status, owner, machine, branch and commit, focus, start, last heartbeat and end; its end summary as sanitized markdown; its declared and touched Scope; its Event timeline (newest first, 50 per page). |

A Session or Event started with a Project key is attributed to the key, never to the key's creator. Task progress, usable claims, effective Session status and overlaps come from M2's read functions in `@hivemind/db`, judged at the database time of the page's snapshot; the dashboard does not recompute them from timestamps. Lists are keyset-paged with opaque cursors in the URL's search parameters; a cursor that does not decode shows the first page.

## Authorization

Every page checks access itself, at request time, inside a Suspense boundary (ADR-0003):

- **Fresh login session.** `requireFreshLoginSession()` (`apps/web/src/server/login-session.ts`) looks the login session up in the database with better-auth's cookie cache disabled, so a revoked or expired login session is refused on the next navigation or refresh. Without one, the page redirects to `/sign-in` with a return path.
- **Membership on every read.** The page's loader (`apps/web/src/server/dashboard/queries.ts`) first checks that the User is a current Member of the Project's Organization, inside the same transaction as the rest of the page's reads. `activeOrganizationId` is never consulted (ADR-0007).
- **A foreign child is an absent child.** A Plan or Session is always looked up together with its Project. A child of another Project, an absent child, an absent Project and a Project the User cannot read all render the same not-found page.
- No authenticated data is put in a shared cache.

## Initial render

Each page reads everything it shows in one short `READ ONLY REPEATABLE READ` transaction (`runDashboardSnapshot` in `apps/web/src/server/dashboard/snapshot.ts`, over `withFeedSnapshot` in `packages/db/src/event-feed.ts`). Its first statement reads the database time and the feed horizon `H = pg_snapshot_xmin(pg_current_snapshot())`; the authorization check and every query then run on that one database snapshot, so counts, claims and liveness agree with each other. The transaction ends before the page responds.

A Project page also gets the fence `(H, 0)`, encoded as a feed cursor for that Project. Every Event written by a transaction below H is already in the snapshot. The live-update subscription starts from the fence, so it delivers every Event at or above H once it is safe, including one from a transaction that commits after the page was rendered but before the browser subscribed. Some of those Events may already be in the snapshot; applying them again only causes an extra refresh.

## Live updates

### In the browser

One subscription runs per open Project (`createProjectEventStream` in `apps/web/src/lib/project-event-stream.ts`, used by `ProjectLiveUpdates` in `apps/web/src/components/dashboard/project-live-updates.tsx`). It reads the cookie stream with `fetch`, so it sees HTTP statuses and can send `Last-Event-ID`. The subscription and its cursor survive page refreshes. Changing Project closes it and opens a new one from the new page's fence, so no cursor crosses Projects.

The browser never renders Event content from the stream. An Event is only an invalidation:

1. **Filter.** `apps/web/src/lib/project-event-filters.ts` decides whether the Event affects the current page. The overview counts every Event. A Plan page counts Events of the Plan, its Tasks and the Sessions it shows. A Session page counts Events that affected the Session or that it acted through, and Events of its Task. It shows only its Plan's key, which never changes, so `plan.*` Events do not refresh it. An Event type this build does not know refreshes every page.
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

An `access_lost` frame, or a 401, 403 or 404 when (re)connecting, is terminal: the provider replaces the Project's content with a message and stops retrying until the User navigates to another pathname or a page renders a newer fence from a fresh server read. The message stays while the layout is hidden and when Back shows it again.

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
| `event` | the Event's cursor | `{ type, event }`, where `event` is the contract Event (`eventSchema` in `packages/contract/src/event.ts`). |
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

## Markdown and untrusted text

Plan bodies, Plan log entries and Session end summaries are written by agents and Users, so they are untrusted. One server renderer, `SafeMarkdown` in `apps/web/src/server/dashboard/markdown.tsx`, renders all of them with react-markdown and remark-gfm:

- Raw HTML in the source is dropped (`skipHtml`), never parsed.
- The output is sanitized with rehype-sanitize using GitHub's schema without `img`, after every other step.
- Links keep only absolute `http:`, `https:` and `mailto:` URLs; anything else, including `javascript:`, `data:` and relative paths, renders as plain text. Every link gets `rel="noopener noreferrer nofollow"`.
- Images are never loaded; each renders as `[image: alt text]`.
- Headings are shifted down so a document's `#` does not compete with the page's headings.

Labels, intents and Event text are not markdown. They render as plain React text, and Event text is built only from known payload fields (`apps/web/src/server/dashboard/event-text.ts`), never by spreading a payload into HTML or props.

## Known limitations

- **An old open transaction delays delivery for every Project.** The horizon is the oldest running transaction that has an ID, in any database on the same Postgres server. While such a transaction stays open, newer Events wait; they are never skipped. Heartbeats report `withheld`, the dashboard shows "delayed", and the server logs once per stream after 30 seconds. Mutations and snapshots must stay short. If this is common in deployed use, ADR-0010 is reopened; the feed does not fall back to a lossy cursor.
- **Polling cost grows with open tabs.** Each open Project tab holds one function invocation and runs one transaction per second, plus a page refresh per batch of relevant Events and every 60 seconds while visible. Tabs do not share a stream.
- **No per-caller cap on concurrent streams.** One User or Project key can open any number of streams, each holding a function instance and polling once a second until it rotates. This is an accepted risk; general rate limiting is M7's ([#1](https://github.com/CuriouslyCory/hive-mind/issues/1), [#11](https://github.com/CuriouslyCory/hive-mind/issues/11)).
- **A fence can be wrong after a Postgres crash.** A page's fence `(H, 0)` can name a transaction ID that was assigned but never made durable, and crash recovery can issue such IDs again. Resuming from that fence can then fail with 400 while the server's next ID is below H (the dashboard takes a fresh snapshot once), or, once new IDs pass H, skip Events written under reissued IDs below H. A committed Event's ID is never reused, so a cursor from a delivered Event is unaffected (ADR-0010). Fixing this is follow-up work.
- **Delivery is at least once, and cursor order is not commit order.** The dashboard is unaffected because it re-reads server state; other clients must apply Events idempotently and must not treat feed order as time order.
- **No Event retention until M7.** Events are never deleted yet, so `feedOriginCursor` replays everything. Before M7 prunes Events that a cursor could still replay, it needs an expired-cursor protocol (ADR-0010).

## Tests

- `packages/db/test/event-feed.test.ts`: the horizon with concurrent writers, the snapshot fence, rollback gaps, several batches, integers above `Number.MAX_SAFE_INTEGER`, and a seq-only cursor shown to lose an Event.
- `packages/contract/test/event-stream.test.ts`: cursors, frames and bounds.
- `apps/web/test/event-stream.test.ts`: both routes' statuses, access loss during a stream, resume, withheld delivery, rotation, abort while paused, slow consumers and cleanup.
- `apps/web/test/project-event-stream.test.ts`: the browser engine's decoding, deduplication, refresh coalescing, reconnects and terminal states.
- `apps/web/test/dashboard-queries.test.ts` and `apps/web/test/markdown.test.ts`: page reads, cross-Project children, attribution and hostile markdown.
