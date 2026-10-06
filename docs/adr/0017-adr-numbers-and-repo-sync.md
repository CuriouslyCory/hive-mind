---
status: accepted
date: 2026-10-05
---

# ADR numbers and repo sync

## Context

Under ADR-0001, a new ADR takes the next free number on `main`, so two open PRs can pick the same number and the second to merge must renumber. Agents in different worktrees write ADRs at the same time, so this happens. [#1](https://github.com/CuriouslyCory/hive-mind/issues/1) recommends keeping ADRs as repo files with hive-mind handing out their numbers and showing their content. [#19](https://github.com/CuriouslyCory/hive-mind/issues/19), the M4 plan, builds both. The PR that closes #19 implements and accepts it.

The constraints:

- hive-mind has no GitHub access. It sees only what the CLI sends.
- ADR-0001 fixes the file format and makes the repo file the source of truth. M4 adds no frontmatter key and no status value.
- `/api/v1` limits every request body to 16 KiB (ADR-0009), and ADR-0014 is more than 17 KiB.
- Project keys get a fixed permission list (ADR-0014). An ADR sync from CI authenticates with a Project key.
- ADR-0015 is deployed: a build that does not know an Event type returns such Events as `event.unavailable` instead of failing.

## Decision

### What hive-mind owns

- hive-mind owns `(Project, number)` reservations and each Project's next ADR number. Everything else it shows about an ADR (path, slug, title, status, date, supersedes and content) is a read-only copy from one synced commit. Only ADR sync changes the copy, and hive-mind never edits the repository.
- `supersedes` is copied as a list of numbers with no foreign key, since ADR-0001 allows a list. "Superseded by" is computed when read. This replaces the single `supersedes_id` in #1's data model.
- Where a number stands is a separate `state`: `reserved` (handed out, no file synced yet), `published` (the synced commit has the file) or `removed` (a later synced commit no longer has it). `state` is never shown as an ADR status.
- The ADR directory is `docs/adr/` in the directory that holds `.hivemind.json`. It is not configurable in v1.
- One dependency-free parser in `@hivemind/contract` reads ADR files for both the CLI and the server.

### Reservation

- `hivemind adr new --title <title>` reserves a number with `POST /projects/{id}/adrs`, then writes ADR-0001's template with `status: proposed` and today's date. The reservation records the title, slug, git branch, the reserving principal and, when one is set, the Session.
- Numbers run from 1 to 9999 and come from a Project-local counter incremented under the Project lock (ADR-0014), as Plan keys do. Past 9999 the server answers `CONFLICT`. A number is never handed out twice. Reservations never expire and cannot be released, so a reservation whose ADR is never merged leaves a gap.
- **Floor.** The CLI sends the highest number in the local `docs/adr/` and in the default branch's tree. The next number becomes the greatest of the counter, the floor + 1 and the highest number hive-mind knows + 1. A floor that would move the counter up by more than 100 is refused with `CONFLICT`, and the message says to run `hivemind adr sync`: sync, not the floor, brings in a large existing set. The `adr.reserved` Event records the floor.
- **Replay.** Reservation uses ADR-0014's creation replay. The same `--id`, input and principal return the same number and change nothing.
- **Reserve, then write.** The CLI creates the file only if it does not exist. An identical existing file (a rerun) is success. A different one is left untouched and the command exits 2. If hive-mind cannot be reached the command fails; it never falls back to a local number.
- `hivemind adr status` and `hivemind adr supersede` change local files only and make no server call. hive-mind learns of the change once it is merged and synced.

### ADR sync

- `hivemind adr sync` reads the tree of one commit through git, never the working tree, so unmerged branches and uncommitted edits are never synced. The default commit is the remote default branch, `origin/HEAD`. `--ref <rev>` names another, such as `HEAD` in a CI job that runs on a push to the default branch.
- **Phase 1, content.** `POST /projects/{id}/adrs/contents` takes a batch of files addressed by sha256: at most 64 KiB per file and 256 KiB per request. The server parses every file itself and never trusts fields parsed by the client. It stores each valid file once per hash and reports problems per file. The CLI uploads only content hive-mind does not have.
- **Phase 2, manifest.** `POST /projects/{id}/adrs/sync` sends the commit, the commit the CLI expects hive-mind to have synced last, the ADR directory, and the file name and hash of every ADR file in the tree, at most 1000, so the manifest fits the 256 KiB limit. One transaction under the Project lock:
  1. compares hive-mind's last synced commit with the expected one, and answers `CONFLICT` if they differ;
  2. checks that every hash was uploaded and is valid;
  3. updates the copies, and marks ADRs absent from the commit `removed` without deleting them;
  4. raises the counter above the highest synced number;
  5. writes one `adr.synced` Event and stores the new commit.

  An interrupted sync applies nothing. Uploaded content stays, so a rerun uploads only what is missing.
- **Commit order.** Before uploading, the CLI checks that hive-mind's last synced commit is an ancestor of the new one. `--force` skips the check, for example after a force-push, and the Event records it. If hive-mind's commit already descends from the requested one, as when two CI jobs finish out of order, the command exits 0 with "already synced past this commit". The check needs history, so CI checkouts need `fetch-depth: 0`.
- **Refusals and warnings.** A sync is all-or-nothing, and a refusal names the problems in its message (the first 20, then how many more). It is refused with `BAD_REQUEST` when a file cannot be stored (a bad file name, bad frontmatter or an unknown key, an invalid status or date, no H1, a control character, non-UTF-8, more than 64 KiB) or a hash was not uploaded, and with `CONFLICT` (exit 2) when two files have the same number. Only existing API error codes are used, and no error carries `data`. The CLI parses the commit's files before it sends anything, so it reports an invalid file itself with its local code `ADR_INVALID` (exit 1). Missing or out-of-order sections, a `supersedes` entry naming a missing ADR, `superseded` with no superseding ADR, an unreserved number and a slug that differs from its reservation are warnings: the file is stored and the warning reported. A Project's first sync reports no unreserved numbers, since a repository that already has ADRs reserved none of them.
- **A file that takes a reserved number** without `adr new` wins. hive-mind decides that a file took the number when both its slug and its title differ from the reservation; a file that differs only in slug is the reservation's own file, with the slug warning above. The ADR keeps the reservation's title, slug and principal as history, and both the sync output and the dashboard say that the reserved ADR needs a new number.
- `hivemind adr sync --check` validates the local `docs/adr/` with the same parser and no server call, for checks on PRs.

### Events

- `adr.reserved` names the ADR, its number, title, slug and the floor. `adr.synced` names the commit and the previous one, whether the sync was forced, how many ADRs were added, updated and removed, and at most 100 changes (number, kind of change, status before and after), with a flag when the list was cut. Neither carries ADR content, and `adr.synced` carries no titles. Each is written in the transaction of its change; a replayed reservation writes none.
- **Rollback.** Every production deployment from commit `d063742` (the merge of [PR #22](https://github.com/CuriouslyCory/hive-mind/pull/22)) on contains ADR-0015's reader and returns `adr.*` Events as `event.unavailable`. Once `adr.*` Events exist, a rollback target must contain that reader, checked as `docs/setup.md` H9 describes; an older build without it is never promoted. Undoing M4 without a rollback means reverting its writer commits. The Event catalog entries land in a commit before any code that writes `adr.*`, so every build that writes these Events also reads them in full.

### Access and limits

- Project keys get `adr:read` (list and show) and `adr:write` (reserve, upload and sync). This extends ADR-0014's fixed list; it is not a per-key choice, so every Project key gets both, including keys issued before M4. A User needs current membership of the Project's organization, as for Plans.
- **Body limits are per route.** `POST /projects/{id}/adrs/contents` and `POST /projects/{id}/adrs/sync` accept up to 256 KiB. Every other `/api/v1` route keeps 16 KiB, checked before authentication. This reopens ADR-0009's single body limit as implemented. The general audit of payload limits stays with M7.
- An ADR title is at most 200 characters. ADR content never appears in an Event or a list response.
- M4 adds no search columns. M5 decides how it indexes ADR content (ADR-0011), using the stored content hash and the `adr.*` Events.

## Consequences

- Concurrent `adr new` calls get distinct numbers. The first reservation in a repository with existing ADRs never reuses a number, because the floor or an earlier sync has moved the counter past them.
- ADR-0001's renumbering rule now applies only to files that bypass `adr new`, and to this repository until it is bound to a Project (amended in ADR-0001). This ADR took its number that way.
- hive-mind's copy is only as current as the last sync. The CLI and the dashboard name the commit it came from and when it was synced, and the dashboard also names who synced it.
- hive-mind trusts the commit and content that a Member or Project key reports. That is the trust already given to Plan writes, and every sync is attributed in an Event. Checking commits against GitHub is future work.
- Removed ADRs keep their rows, and uploaded content that no sync uses is kept. Cleaning it up is retention work for M7.
- The schema change is expand-only, so a deployment from before M4 that has the reader still runs on the new schema.
- Verified by tests: five concurrent reservations get distinct consecutive numbers; a reservation racing a first sync gets a number past the synced files in either order; of two syncs on one base exactly one applies; a refused sync changes no row, Event, counter or commit pointer; every ADR in `docs/adr/` uploads and syncs, ADR-0014 included, while a 17 KiB Plan body still gets 413; and a seeded property test requires every file the parser accepts to upload and read back without an error (`apps/web/test/adr-parser-consistency.test.ts`). Removing the Project lock, moving the number out of the replay check or skipping the compare-and-set each fails these tests.

## Alternatives considered

- **One sync request carrying every file:** its size grows with the repository (this repository's ADRs already total over 100 KiB), and an interrupted request has to resend everything. Two phases keep every request bounded and make a retry upload only what is missing.
- **Changing an ADR's status on the server:** the default branch would disagree, and the next sync would silently undo the change.
- **Taking the local highest number + 1 when hive-mind is unreachable:** it brings back the collisions this ADR exists to prevent.
- **A configurable ADR directory:** `.hivemind.json` is a strict schema pinned by a v1 fixture (ADR-0009), so a new key would break released CLIs.
