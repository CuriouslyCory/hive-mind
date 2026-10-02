---
status: accepted
date: 2026-10-01
---

# Realtime over SSE tailing the event table

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) wants the dashboard and `hivemind watch` to update live without adding a vendor. Every mutation writes an `event` row in the same transaction (ADR-0014), so the `event` table is already a feed of every change. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) assigned SSE to M3; this ADR was proposed until M3's plan, [#11](https://github.com/CuriouslyCory/hive-mind/issues/11), chose how the feed's cursor avoids losing Events.

`seq` alone cannot be the cursor. A `bigserial` value is allocated when the row is inserted, not when its transaction commits: if transaction A takes `seq` 10, B takes 11 and commits, and a poll runs before A commits, `seq > cursor` moves past 10 and Event 10 is never sent.

M2 gives every Event `writer_xid xid8 NOT NULL DEFAULT pg_current_xact_id()`, the inserting transaction's ID, with an index on `(project_id, writer_xid, seq)`. No client supplies either value.

## Decision

**Safe horizon by transaction ID.**

- The feed's position is `(writer_xid, seq)`. A poll returns the Project's Events strictly after the client's position, ordered by `(writer_xid, seq)`, and only those with `writer_xid < pg_snapshot_xmin(pg_current_snapshot())`. Every transaction below that boundary has committed or rolled back, so no Event can still appear before it. The boundary and the rows come from the same statement or short consistent snapshot. See PostgreSQL's [transaction information functions](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-SNAPSHOT).
- The cursor advances only through Events the stream has yielded, never past an undrained batch. Events of one transaction keep their relative order by `seq`.
- Cursors are opaque, versioned and bound to the Project, with both integers as decimal strings, never JavaScript numbers, within the contract's 512-character cursor limit (`packages/contract/src/event-stream.ts`). The server rejects a malformed cursor, one from another version or Project, numbers outside `xid8` and `bigint`, and transaction IDs the database has not allocated yet, with the existing BAD_REQUEST 400. It never silently jumps to the latest Event.
- **Snapshot handoff.** A dashboard page reads boundary `H = pg_snapshot_xmin(pg_current_snapshot())`, authorizes, and builds its bounded projection in one short `READ ONLY REPEATABLE READ` transaction, then ends it and hands the browser the fence `(H, 0)`. Normal `seq` values start at 1. Events of transactions below H are in the page's snapshot ([repeatable read](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-REPEATABLE-READ)); those at or above H are delivered once they are safe, including a transaction that commits between rendering and subscribing. A fence is valid even if the Project has no Events. Integration tests must prove this.
- **Start position.** `Last-Event-ID` takes precedence over the `cursor` query parameter. Without either, the stream tails from the current safe boundary. The origin cursor `(0, 0)` (`feedOriginCursor`) replays the whole retained history, since every transaction ID that writes a row is at least 3.
- **Delivery is at least once, and cursor order is not commit order.** Clients apply Events idempotently.

**Transport.**

- `GET /api/v1/projects/{id}/events/stream` is a typed contract route using oRPC 1.15.4's `eventIterator`, bearer-only like the rest of `/api/v1` (ADR-0009, ADR-0013). oRPC passes the `Last-Event-ID` header to the handler as `lastEventId`. A specific Next route applies the stream's duration settings and reuses `createApiHandler`.
- The browser uses a separate GET-only cookie adapter at `/api/dashboard/projects/[projectId]/events/stream`. It mounts only the feed, shares the engine and frame schemas, ignores bearer and key headers, and exposes no login-session token to JavaScript.
- Authorization and cursor validation run before the stream opens, so those failures are HTTP 401, 404 and 400 rather than an open 200 stream. Both adapters check the credential and Project access again before every poll, with no cached result. When a check fails, the stream sends a terminal `access_lost` frame without moving the cursor and closes; the browser clears the Project's data and stops retrying. A database failure is a server error, not an authentication verdict.
- The dashboard subscribes once per Project; Plan and Session pages filter by the Event's affected records, and an unknown Event type refreshes the whole Project.
- Frames are a discriminated union on `type`. `event` frames carry the contract Event and its cursor as the SSE `id` (oRPC `withEventMeta`). `heartbeat` (with server time and whether delivery is withheld) and `access_lost` carry no `id` and move no cursor.

**Lifecycle and bounds** (constants in `packages/contract/src/event-stream.ts`):

- Poll every 1 s with short queries on the existing attached pool; no connection or transaction is held for the stream's lifetime.
- At most 100 Events and a 512 KiB byte budget per batch, sized from the 64 KiB maximum encoded Event; at most 1 MiB of in-flight plus queued Event bytes. A consumer that falls behind is disconnected and resumes from its cursor.
- oRPC's timer-based keepalive is disabled; the engine sends heartbeats every 15 s.
- The route exports `maxDuration = 60` ([Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration)) and the stream ends itself after 50 s, cleaning up on every exit path, including a request abort while the generator is paused. Clients reconnect, after a planned end too, with jittered exponential backoff from 1 s to 30 s.
- No in-memory publisher is a source of truth. A future wake-up mechanism (such as Upstash Redis or Ably) may only trigger polls; the protocol and cursor semantics stay the same.

## Consequences

- **An old open transaction delays delivery, but never causes a skip.** Any transaction with an assigned ID, in any Project or none, holds the boundary below it, so Events after it wait until it ends. Heartbeats report this as `withheld`, and the dashboard shows freshness. Mutations and snapshots must stay short. If this is common in deployed use, reopen this ADR; never fall back to a lossy cursor or a timeout that crosses the boundary.
- Postgres `LISTEN/NOTIFY` is not a wake-up option: the runtime `DATABASE_URL` goes through PgBouncer in transaction mode (ADR-0004).
- Each open stream holds a function instance and makes one query per second, so load grows with viewers. Batches, queues and pool use are bounded and tested.
- Event retention is M7's. Before M7 prunes Events that a cursor could still replay, it needs an expired-cursor protocol (an explicit error that sends the client back to a fresh snapshot).

## Alternatives considered

- **Serializing Event inserts per Project** so `seq` order is commit order: limits write throughput and couples M3 to M2's lock ordering. M2's Project lock happens to order Events today (ADR-0014), but the feed does not rely on it.
- **Re-reading a trailing window below the cursor** and dropping Events already sent: lossless only while no transaction stays open longer than the window.
- **A `seq`-only cursor or a timeout that bypasses the boundary**: loses Events, as described in the Context.
