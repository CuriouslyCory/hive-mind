---
status: proposed
date: 2026-09-29
---

# Realtime over SSE tailing the event table

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) wants the dashboard and `hivemind watch` to update live without adding a vendor. Every mutation writes an `event` row (with a `bigserial` `seq`) in the same transaction, so the `event` table is already a feed of every change. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) assigns SSE to M3; the `event` table itself is M2. M0 builds none of it, so this ADR is proposed.

## Decision

Proposed, owned by M3:

- `GET /api/v1/projects/:id/events/stream` is a Server-Sent Events endpoint. On the server it polls `event` about once per second for events after the client's cursor.
- It sends the cursor as each event's SSE `id`, supports `Last-Event-ID`, and closes before the function's maximum duration, so the client reconnects from its cursor.
- The cursor must never skip a committed event. `seq` alone does not guarantee that (see Consequences); M3 chooses how the cursor does.
- The dashboard subscribes per Project; plan and Session pages filter the stream on the client.
- If polling load on Neon becomes a problem, add pub/sub (Upstash Redis or Ably) to wake the stream. The SSE protocol and cursor semantics stay the same.

## Consequences

- Postgres `LISTEN/NOTIFY` is not a drop-in wake-up: the runtime `DATABASE_URL` goes through PgBouncer in transaction mode, which doesn't support `LISTEN` (ADR-0004).
- **`seq > cursor` can lose events.** A `bigserial` value is allocated when the row is inserted, not when its transaction commits. If transaction A takes `seq` 10, transaction B takes 11 and commits, and a poll runs before A commits, the poll returns 11 and moves the cursor past 10, so event 10 is never sent. M3 must choose one of:
  - Emit only events from transactions older than every in-flight one: store the inserting transaction's id in an `xid8` column (`pg_current_xact_id()`), return only rows whose id is below `pg_snapshot_xmin(pg_current_snapshot())`, and order and cursor by (xid, `seq`).
  - Serialize event inserts per Project with a transaction-level lock, so `seq` order equals commit order. This limits write throughput per Project.
  - Re-read a trailing window below the cursor on every poll and drop events already sent, by id. This is lossless only while no transaction stays open longer than the window.
- Each open stream holds a function instance and makes a query per second, so load grows with the number of viewers. The cursor query needs an index that matches the chosen cursor, such as (`project_id`, `seq`).
- The endpoint is under `/api`, so it authenticates and authorizes itself (ADR-0003, ADR-0007).
- M3 must decide:
  - the polling interval and the stream's maximum duration on Vercel;
  - how streams share the database pool;
  - how the dashboard combines the stream with Cache Components (the stream is per-request and dynamic).
- Event retention is M7's.
- M3 accepts this ADR, amends it, or supersedes it.
