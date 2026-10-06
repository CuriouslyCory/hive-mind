# Dogfooding M2 and M4

M2 ([#12](https://github.com/CuriouslyCory/hive-mind/issues/12)) is done only when this repository's own development is tracked with hive-mind: a committed Project binding, a Plan, Tasks, and Sessions with Scopes, heartbeats, progress logs and end summaries, recorded with the CLI built from `main`. This runbook produces that evidence. Commands and exit codes are in [cli.md](cli.md#coordination-plans-tasks-sessions-and-scopes). M4's ADR steps are in [section 10](#10-adrs).

## Prerequisites

- [ ] The M2 PR is merged and deployed to production, and the checks in [setup.md](setup.md) H6 and H8 pass, including `CRON_SECRET`.
- [ ] [#8](https://github.com/CuriouslyCory/hive-mind/issues/8) is resolved, or the owner has accepted its exposure for this data. Every preview database branch is still a copy of production, so the Plans, Tasks, intents, summaries, hostnames and branch names recorded here are copied into each preview deployment, which runs unmerged code.
- [ ] The owner has chosen the hive-mind organization and Project this repository binds to.

Until all three hold, the runbook is ready but the dogfooding item in #12 stays unchecked.

## Rules

- Use `apps/cli/dist/hivemind` built from the deployed `main` commit. Its default server is production.
- Never put a credential in coordination text: no tokens, Project key secrets, device codes, `CRON_SECRET` or `.env` contents in a Plan, Task, log entry, intent, summary or Scope. Most of this text is kept in Events, which cannot be edited or deleted.
- Commit only `.hivemind.json`. It holds `version` and `projectId` and nothing else. `HIVEMIND_SESSION`, logins and keys stay in the shell and the credential store.
- One Session per agent run, always ended with a summary.
- Record only work done after the binding. M2's own implementation happened before it, so it is not entered as finished Tasks; a log entry may mention it as context.

## 1. Build the CLI and log in

```bash
git switch main && git pull --ff-only
pnpm install && pnpm build
export PATH="$PWD/apps/cli/dist:$PATH"
unset HIVEMIND_URL HIVEMIND_TOKEN HIVEMIND_SESSION
hivemind --version      # the commit must match the production deployment's
hivemind login
hivemind whoami
```

A headless agent can use a Project key instead (`hivemind key create --name dogfood-agent --expires-in-days 30 > key.txt`, then `HIVEMIND_TOKEN="$(cat key.txt)"`). Its Sessions then belong to the key, not to a User.

## 2. Bind the repository

```bash
git switch -c chore/12-hivemind-binding
hivemind init --name hive-mind --slug hive-mind   # or: hivemind init --project <id>
cat .hivemind.json                                # only "version": 1 and "projectId"
git status --short                                # only ?? .hivemind.json
git add .hivemind.json
git commit -m "Bind the repository to its hive-mind Project"
```

Open a PR with only this file and get it reviewed. A linked worktree finds `.hivemind.json` only in its own checkout, so every worktree used below must be on a commit that contains the file.

## 3. Create the Plan

```bash
hivemind plan create --status active --title 'M2: dogfood coordination (#12)' --body-file - <<'MD'
Post-deploy validation of M2, tracked in this repository's own Project.

Issue: https://github.com/CuriouslyCory/hive-mind/issues/12
MD
PLAN=PLAN-1    # the key the command printed
```

## 4. Add the remaining validation as Tasks

```bash
for title in \
  'Verify the coordination sweep in production (setup.md H8)' \
  'Two worktrees: claim conflict, steal and Scope overlap' \
  'Let a Session go stale and abandoned; check its claims and Events' \
  'Merge the .hivemind.json binding' \
  'Write the M2 retrospective'; do
  hivemind task add "$PLAN" --title "$title"
done
hivemind plan show "$PLAN"     # lists the Task ids
```

Add Tasks for later development the same way, in this Plan or a new one per piece of work.

## 5. Run each agent run as a Session

```bash
export HIVEMIND_SESSION="$(hivemind session start --agent claude-code --intent 'Verify the coordination sweep in production')"
hivemind session attach --plan "$PLAN" --task <taskId>
hivemind scope add 'docs/**'
hivemind scope check
hivemind task claim <taskId>
hivemind task start <taskId>

( while sleep 60; do hivemind session heartbeat --json >/dev/null; done ) &
HEARTBEAT_PID=$!

# ... the work ...
hivemind plan log "$PLAN" --message 'H8: 401 without the secret, a 200 run each minute, status_changed to stale after 5 minutes.'
hivemind task done <taskId>

kill "$HEARTBEAT_PID"
hivemind session heartbeat    # uploads the final touched paths
hivemind session end --summary-file - <<'MD'
Verified the sweep in production; all H8 checks passed. Nothing left open.
MD
unset HIVEMIND_SESSION
```

- Run the heartbeat loop from the worktree, after `export HIVEMIND_SESSION`. If the agent's shell cannot keep a background job, run `hivemind session heartbeat` by hand at least once a minute, and note that in the transcript.
- Warnings from heartbeats (released claims, a failed upload with its `--collection-id` resume command) go to stderr. Keep them in the transcript.
- A blocked Task gets `hivemind task block <taskId> --reason '...'` and a log entry saying what it waits for.

## 6. Two Sessions at once

```bash
git worktree add -b dogfood-b ../hive-mind-dogfood-b HEAD
```

In a second shell, in `../hive-mind-dogfood-b`, start Session B with its own `HIVEMIND_SESSION`, then:

- [ ] Both Sessions declare overlapping Scopes (for example `docs/**` and `docs/cli.md`). `hivemind scope check` in each shows the overlap with a witness path, and `hivemind status` lists it.
- [ ] Both edit the same file and heartbeat. `scope check` shows a touched/touched overlap.
- [ ] B claims a Task that A holds: exit 2, with A's Session id and intent in the message.
- [ ] B claims it with `--steal`. A's `task done` on that Task then fails with exit 2, and `hivemind plan log "$PLAN"` shows the `task.claimed` Event naming the former holder. `hivemind session log <A>` also shows `task.released` with reason `stolen`.
- [ ] Both Sessions end with summaries. Remove the worktree with `git worktree remove ../hive-mind-dogfood-b`.

## 7. Check the record

```bash
hivemind plan show "$PLAN"
hivemind plan log "$PLAN"
hivemind session list --status terminal
hivemind session show <sessionId>
hivemind status
```

- [ ] Every Task has the expected status, and `plan log` shows its claims, starts, blocks, dones and the log entries.
- [ ] Each Session shows its heartbeats, Scopes and summary, and none is left live by accident.
- [ ] `status` shows no stray claims or overlaps.

## 8. Keep a redacted transcript

Record each run, for example with `script -q dogfood-$(date +%F).log` or by piping through `tee`. Before sharing it, remove:

- login codes, tokens, Project key secrets, `HIVEMIND_TOKEN` and `CRON_SECRET` values (search the file for each actual value, not only for patterns);
- email addresses from `whoami`, and hostnames if they should stay private.

Keep UUIDs, Plan keys and timestamps: they let a reader check the transcript against `plan show`, `session show` and `status`. Attach the transcript to the M2 PR or to #12. Do not commit it.

## 9. Close out

In #12, check the dogfooding item and link the binding PR, the transcript and the Plan key. If deployment or #8 is still blocking, leave the item unchecked and say which.

## 10. ADRs

M4 ([#19](https://github.com/CuriouslyCory/hive-mind/issues/19)) is done only when this repository's ADRs are synced to its Project and a later ADR number came from `hivemind adr new`. Commands and exit codes are in [cli.md](cli.md#adrs).

Prerequisites:

- [ ] The M4 PR is merged and deployed to production, and the deployment passes [setup.md](setup.md) H6.
- [ ] The repository is bound (step 2), and `.hivemind.json` is on `main`.
- [ ] The CLI is built from the deployed `main` commit and logged in (step 1).

Until all three hold, the ADR item in #19 stays unchecked.

### Sync ADR-0001 to ADR-0017

```bash
git switch main && git pull --ff-only
git fetch origin
git rev-parse origin/HEAD || git remote set-head origin --auto   # adr sync reads origin/HEAD
hivemind adr sync --check        # Checked 17 ADR files in docs/adr/: no errors, ...
hivemind adr sync --dry-run      # Dry run: would sync commit <sha7> (first sync): 17 added, ...
hivemind adr sync
hivemind adr list --limit 100
hivemind adr show ADR-0014
```

- [ ] `adr sync` prints `Synced commit <sha7> (first sync): 17 added, 0 updated, 0 removed, 0 unchanged.`, and `<sha7>` is `main`'s commit. If more ADRs have merged since this was written, the count is higher.
- [ ] `adr list` shows ADR-0001 to ADR-0017 as `published`, each with its status, and ends with `As of commit <sha7>, synced <time>.`
- [ ] `adr show ADR-0014` prints the whole file. It is larger than 16 KiB, so it also proves the larger upload limit.
- [ ] The dashboard's ADR list shows the same ADRs, with the banner naming the commit and you.
- [ ] A second `hivemind adr sync` prints `Already synced at commit <sha7>.`

### Reserve the next ADR

Do this for the next real decision, not a test ADR: the number is never handed out again.

```bash
git switch -c docs/adr-<slug>
hivemind adr new --title '<the decision>'   # prints docs/adr/0018-<slug>.md
hivemind adr list --state reserved
```

- [ ] The number is above every ADR on `main` (ADR-0018 if none has merged since ADR-0017), and `adr list --state reserved` lists it.
- [ ] Write the ADR, open a PR and merge it. Then `git fetch origin && hivemind adr sync` reports it as added, and `adr list` shows it as `published`.
- [ ] In the same PR or the next one, add a line to `AGENTS.md` telling agents to reserve ADR numbers with `hivemind adr new`, now that the repository is bound.

Once [setup.md](setup.md) H10 is done, the CI workflow runs `adr sync` on each push to `main`, and the manual sync is needed only for the first one.

### Transcript and close out

Keep a redacted transcript of these commands as in step 8. Keep commit hashes, ADR numbers and the reservation id; remove tokens and email addresses. In #19, check the ADR item and link the transcript and the PR with the reserved ADR. If deployment or the binding is still missing, leave the item unchecked and say which.
