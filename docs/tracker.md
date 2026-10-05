# The dev tracker

`/tracker` is a page for the people developing this repository, not part of the product. It holds three things: a changelog of user-facing changes tied to PRs, ideas for announcement posts, and the GitHub issue backlog with a copyable prompt for each step of each issue. Two agent skills keep it current: `/tracker-git-scan` and `/tracker-backlog-review` (`.agents/skills/`). The rules live in one package, `@hivemind/tracker` (`packages/tracker`), which both the page and the tracker CLI call.

## Opening the page

Run `pnpm dev`, sign in at http://localhost:3000 and open http://localhost:3000/tracker.

The page and its server action respond only when all of these hold (`trackerPageEnabled` in `packages/tracker/src/gate.ts`, checked by `apps/web/src/server/tracker-access.ts`):

- `NODE_ENV` is `development`, which means `next dev`;
- `VERCEL_ENV` is unset or `development`;
- the request's host is `localhost`, `127.0.0.1` or `[::1]`, on any port.

Everywhere else the route is a 404 for a signed-in User: production, preview deployments, `next start` (including the browser tests' `E2E_SERVER=start`), and `next dev` reached through any other host name. Without a login session cookie, the proxy (`apps/web/src/proxy.ts`) redirects to `/sign-in` first, as it does for every page. Any signed-in User can use it. Sign-in works only on `localhost:3000` (see `README.md` → Local development), so use that host. The page tells search engines not to index it.

## Where the data lives

The tracker is the `tracker_*` tables (`tracker_scan`, `tracker_changelog_entry`, `tracker_blog_idea`, `tracker_backlog_phase`, `tracker_backlog_issue`, `tracker_backlog_step`; schema in `packages/db/src/schema/tracker.ts`) in whatever database `DATABASE_URL` in `apps/web/.env.local` points at. Migration `0005_dev_tracker` creates them; apply it as in `README.md` → Local development, step 4.

- With local Postgres, the tracker is yours alone.
- With the Neon Development database branch (`vercel env pull`), every developer using that database branch shares one tracker, including progress.

The migration runs in every environment like any other, so Production and Preview databases have the tables too, empty; nothing outside `next dev` reads or writes them. Tracker rows are not Project data, and writing them records no Event. The tracker starts empty: there is no seed. See [Backfilling](#backfilling).

## The page

The page has three tabs. The selected tab is in the URL: `?tab=backlog` (the default), `?tab=changelog` or `?tab=blog`. The rules below are enforced by `@hivemind/tracker`, so they apply to the page and the CLI alike.

### Backlog

Phases in order, each holding GitHub issues in order, each holding ordered steps. An issue shows its number (linked to GitHub), title, note and state (`open` or `closed`). A step shows its label, its prompt with a copy button, and when it was completed.

- Each prompt is written to be pasted as the first message of a fresh Claude Code conversation. Copying a step's prompt marks the step complete.
- **Up next**, at the top of the tab, shows the first unfinished step of the first open issue, in phase order and then issue order, with its copy button.
- A new issue gets two steps by default, `plan` and `implement` (`defaultBacklogSteps` in `packages/tracker/src/backlog-steps.ts`); `/tracker-backlog-review` rewrites them for the issue.
- Deleting an issue deletes its steps. A phase can be deleted only when it has no issues.
- Each issue number appears at most once, and a step's key is unique within its issue.

### Changelog

User-facing changes grouped by UTC merge date, newest first. Each entry has a category, a title, a summary and the PR numbers it rests on, linked to GitHub. The categories are defined in `/tracker-git-scan`.

### Blog

Ideas for announcement posts, ordered by `sortOrder`, each with a title, a pitch, optional notes, the PR numbers it announces, and a status: `idea`, `draft` or `published`.

- An idea that becomes `published` without a date is given the current time as its publication date. Only a published idea has a publication date and URL.
- A published idea is locked: only its publication date, URL and order can change. It can never return to `idea` or `draft`, and it can never be deleted.
- Changing or deleting a blog idea requires the `updatedAt` it was read at.

### Concurrent edits

Every update and delete can carry the row's `updatedAt` as it was read; the page always sends it. If the row has changed since then, the write is refused with "changed since you read it; refresh", and nothing is written.

### Scan cards

Two cards record when an agent last ran each skill, and how far it read:

| Card | Skill | Cursor |
|---|---|---|
| Git history scan | `/tracker-git-scan` | The newest `mergedAt` among the PRs it reviewed, and the exact `origin/main` SHA it reviewed |
| Backlog review | `/tracker-backlog-review` | The newest GitHub `updatedAt` among the issues it reviewed |

Each card shows the completion time, the cursor, the agent's note and the skill command to copy. Run the command in a fresh Claude Code conversation; it takes no arguments, because the skill reads its cursor with the CLI. To change what a scan does, edit its skill.

Cursors are inclusive: each skill reads its cursor's date again on the next run and deduplicates by PR or issue number, so nothing at the boundary is skipped. The completion time is stored separately and is never the cursor. A Git history scan must carry a 40-character SHA, a Backlog review must not carry one, and no cursor may be more than 5 minutes in the future.

## The tracker CLI

Agents read and write the tracker through a JSON CLI, never through SQL or one-off scripts. From the repo root:

```bash
pnpm tracker help
```

The root `tracker` script runs `node --env-file-if-exists=apps/web/.env.local packages/tracker/src/cli.ts`, so it uses the same `DATABASE_URL` as `pnpm dev`; a `DATABASE_URL` already set in the shell takes precedence. `.env.local` is not committed, so a linked git worktree starts without one and the CLI exits with `DATABASE_URL is not set`; copy `apps/web/.env.local` from the main checkout (the first path `git worktree list` prints) or export `DATABASE_URL`. pnpm prints its script header and any failure line to stderr, so stdout holds only the JSON; on failure, the error is the stderr line that starts with `{"error"`. The CLI refuses to run when `VERCEL_ENV` is `production` or `preview`.

### Reading

| Command | Prints |
|---|---|
| `snapshot` | Everything the page shows: `readAt`, `gitScan`, `backlogScan`, `changelog`, `blogIdeas`, `backlog` (phases with their issues and steps) and `nextStep` (Up next). Every row carries its `id` and `updatedAt`. |
| `cursor git_history` | The newest Git history scan, or `null` |
| `cursor backlog` | The newest Backlog review, or `null` |

For example, `pnpm tracker snapshot | jq '.blogIdeas[] | {id, updatedAt, status, title}'`.

### Writing

Each write command reads one JSON object from stdin and prints its result:

```bash
pnpm tracker save-phase <<'JSON'
{ "title": "M4: ADRs", "description": null, "sortOrder": 0 }
JSON
```

Omit `id` to create a row; pass `id` to update it. `updatedAt` is optional except where noted; when given, a row that changed since then is refused. Each save takes the full row, and an unknown field is an `input` error rather than being ignored.

| Command | Input | Result |
|---|---|---|
| `save-changelog-entry` | `{ id?, updatedAt?, date, category, title, summary, prNumbers }` | `{ id }` |
| `delete-changelog-entry` | `{ id, updatedAt? }` | `{ id }` |
| `save-blog-idea` | `{ id?, updatedAt?, title, pitch, notes, prNumbers, status, publishedAt, publishedUrl, sortOrder }`; `updatedAt` is required with `id` | `{ id }` |
| `delete-blog-idea` | `{ id, updatedAt }` | `{ id }` |
| `save-phase` | `{ id?, updatedAt?, title, description, sortOrder }` | `{ id }` |
| `delete-phase` | `{ id, updatedAt? }`; refused while the phase has issues | `{ id }` |
| `save-issue` | `{ mode, issueNumber, updatedAt?, title, note, phaseId, sortOrder, state, githubUpdatedAt, steps? }`; `mode` is `create` (refused for a tracked issue) or `update` (refused for an untracked one); `updatedAt` only on update; `steps` (`[{ key, label, prompt, sortOrder }]`, unique keys, at most 50) only on create, defaulting to `defaultBacklogSteps` | `{ id }` |
| `delete-issue` | `{ issueNumber, updatedAt? }`; deletes its steps | `{ issueNumber }` |
| `save-step` | `{ id?, updatedAt?, issueNumber, key, label, prompt, sortOrder }`; an `id` must belong to that issue | `{ id }` |
| `delete-step` | `{ id, updatedAt? }` | `{ id }` |
| `set-step-complete` | `{ id, complete }` | `{ id, completedAt }` |
| `record-scan` | `{ kind, throughAt, throughSha, note }`; `kind` is `git_history` or `backlog` | `{ id }` |

Input formats: ids are UUIDs; `updatedAt`, `throughAt` and `githubUpdatedAt` are ISO 8601 date-times with an offset or `Z`; `date` and `publishedAt` are `YYYY-MM-DD` (`publishedAt` is `null` while unpublished, and `null` on a published idea keeps its stored date); `prNumbers` are positive integers (at most 100, duplicates removed); `sortOrder` is 0 to 10000; `throughSha` is 40 lowercase hex characters or `null`; `publishedUrl` is an http(s) URL, or `null` or an empty string for none. Titles, categories, keys and labels are 1 to 250 characters; summaries and pitches 1 to 20,000; optional text (`notes`, `note`, `description`, `prompt`) is up to 20,000 characters or `null`, and an empty string is stored as `null`. Text is trimmed.

### Batch

`batch` reads a JSON array of `{ "command", "input" }` and runs every command in one transaction:

```bash
pnpm tracker batch <<'JSON'
[
  { "command": "save-changelog-entry", "input": { "date": "2026-10-02", "category": "Dashboard", "title": "…", "summary": "…", "prNumbers": [18] } },
  { "command": "record-scan", "input": { "kind": "git_history", "throughAt": "2026-10-02T04:44:37Z", "throughSha": "7fe14ac9e617aaec1577fc1711571685f2c1b190", "note": "PR #18" } }
]
JSON
```

It prints the results in the same order. If any command fails, nothing is written, and the error names the failing index. A command cannot use an id created earlier in the same batch, so create phases in one call and add their issues in the next.

### Exit codes and errors

| Exit code | Meaning |
|---|---|
| 0 | Success; the result is JSON on stdout |
| 1 | The command failed; `{"error": {"kind", "message"}}` is on stderr, with `kind` one of `input`, `conflict`, `not_found`, `rule` or `internal` |
| 2 | Usage error (`kind` `usage`): an unknown command, a missing argument, or a refused `VERCEL_ENV` |

`input` lists the invalid fields by path. `conflict` means a row changed since the `updatedAt` you sent: read a new snapshot and retry. `rule` means the write breaks a tracker rule, such as changing a published blog idea or deleting a phase that has issues.

## Backfilling

On an empty tracker, run `/tracker-git-scan`, then `/tracker-backlog-review`, each in its own fresh Claude Code conversation in this repo. With no saved cursor, the Git history scan reviews the whole history of `main` and every merged PR, and the Backlog review reviews every open issue. Later runs read only what changed since their cursor.
