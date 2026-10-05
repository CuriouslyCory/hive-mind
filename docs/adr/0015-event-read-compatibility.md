---
status: proposed
date: 2026-10-05
---

# Reading Events written by a newer deployment

## Context

Events are immutable, and each has a `type` and a per-type `payloadVersion` (ADR-0014). Every read returned a stored Event only if it matched the reading build's contract exactly, and failed otherwise. A deployment rolled back to an older build therefore answered Project Events, Plan logs and Session logs with HTTP 500 as soon as they included an Event that the newer build wrote. [#14](https://github.com/CuriouslyCory/hive-mind/issues/14) showed this with the `task.released` reason `stolen`, which a build without that reason cannot read.

[#15](https://github.com/CuriouslyCory/hive-mind/issues/15) asks for a read and versioning rule that survives a rollback without leaking undeclared fields or credentials, and that covers the live stream of [#11](https://github.com/CuriouslyCory/hive-mind/issues/11). It does not ask for a backfill. [#1](https://github.com/CuriouslyCory/hive-mind/issues/1) is the stack issue. This ADR is proposed until the PR that closes #15 merges; that PR accepts it.

## Decision

- **One projection.** `projectEvent` in `apps/web/src/server/event-projection.ts` is the only way a stored Event reaches a reader: the `/api/v1` Project Events, Plan log and Session Events pages, the Event that a Plan log append returns (a replay included), both Event stream adapters (ADR-0010) and the dashboard's timelines.
- **Checks, in order.**
  1. The stable metadata (`id`, `projectId`, `seq`, `writerXid`, `actor`, `actorSessionId`, `planId`, `taskId`, `sessionId`, `effectiveAt`, `createdAt`) must match `eventMetadataSchema`, and `payload_version` must be a positive integer.
  2. The stored payload must be at most `MAX_EVENT_PAYLOAD_BYTES` (60 KiB), measured with `encodedJsonBytes` as `insertEvent` measures it.
  3. The Event is decoded strictly with `knownEventSchema`, the vocabulary this build writes. A match is returned unchanged.
  4. Anything that does not match becomes `event.unavailable`.
  5. The result must encode to at most `MAX_EVENT_BYTES` (64 KiB).

  A failure at step 1, 2 or 5 is corruption and throws `EventProjectionError`. The API answers it with a generic 500, and the error message names only the failure code and the Event's UUID, never a stored value.
- **The unavailable Event.** `unavailableEventSchema` in `packages/contract/src/event.ts`: the validated metadata, `type: "event.unavailable"` (`UNAVAILABLE_EVENT_TYPE`), `payloadVersion: 1` and `payload: {}`. The version describes this empty payload, not the stored one. The stored type, version and payload are never returned. The public `eventSchema` is the known Events plus this strict variant; Event pages, the Plan log append output and stream `event` frames return it.
- **Read-only type.** `EVENT_TYPES` and `EventType` list only the known types, so no writer can use `event.unavailable`. The whole `event.` type prefix is reserved for representations that reads produce.
- **What is unavailable.** An unknown type, an unsupported payload version, a value this build's enums lack (such as `stolen` in a build before #14), and a payload with extra, missing or mistyped fields. A reader cannot tell a newer writer's same-version payload from a corrupt one, so both are unavailable.
- **Versioning rule for writers.** A change to a payload's shape or meaning needs a new version of that type, and readers keep decoding the versions already stored. A value added to an enum may keep the version: an older build with this reader withholds that Event's details. No payload field may ever hold a credential, because a secret in a field that an older decoder knows, under the same type and version, passes that decoder.
- **Rollback floor.** The earliest revision that reads a later writer's Events safely is the first deployment containing commit `81efa367d9a7d93823cd6a46c9b259241679856b` ("Read Events through one projection that withholds unreadable details"). That deployment reaches production before any later change to Event types, versions or enum values, such as M4's ([#19](https://github.com/CuriouslyCory/hive-mind/issues/19)). Once Events from a later writer exist, roll back only to a deployment at or after the floor; a target before it must be rebuilt with this reader. Rollback never deletes, rewrites or backfills Events. The operator steps are in `docs/setup.md`, H9.

## Consequences

- No migration and no backfill. Stored Events, including #14's `stolen` releases, stay as written.
- A newer Event keeps its id, attribution, affected Plan, Task and Session, and feed position in an older build; only its details are hidden.
- Current writers are still checked strictly. `apps/web/test/event-catalog.test.ts` validates every Event the `@hivemind/db` helpers write against the known catalog, independently of the projection, so writer drift fails tests instead of reading as unavailable.
- Withholding a payload loses what the dashboard filters read from it, such as `session.attached`'s `previousPlanId`. A fixed type that no build lists in `EVENT_TYPES` makes every dashboard, including browser bundles older than this change, refresh all its pages for the Event (ADR-0010).
- Installed CLIs need no change: they accept any string `type` and any payload (`apps/cli/src/client.ts`), and print an unavailable Event like any other (`docs/cli.md`).
- An over-limit payload or invalid metadata is still a 500 on pages and ends a stream without moving its cursor past the row. Such an Event is never skipped.
- Instantly promoting a deployment from before the floor stays unsafe once later Events exist, including production deployments that already write #14's `stolen` reason.
- The rule covers Event reads only. Database schema rollback still depends on expand/contract migrations (`AGENTS.md`, "Schema changes").

## Alternatives considered

- **Returning the stored type and payload as opaque JSON:** an older build would pass on fields it cannot check, including a secret a newer writer stored by mistake, and strict output validation (ADR-0009) would no longer bound Event responses.
- **Keeping the stored type with an empty payload:** an older dashboard would treat a `session.attached` as known and filter it without `previousPlanId`, so the Plan page the Session left would not refresh.
- **Skipping unreadable Events:** pages and the stream would silently omit changes, and a stream cursor would move past an Event the client never saw.
- **Reverting only the writer on rollback (#14's approach):** it needs a hand-made revert for each Event change, and an instant rollback to an older deployment cannot do it.
