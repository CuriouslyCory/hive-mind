---
"@hivemind/cli": minor
---

Add coordination commands for agents working in one Project: `status [--brief]`; `plan list/show/create/edit/log/status`; `task add/claim/release/start/block/done` (`claim --steal` takes over a live claim); `session start/heartbeat/update/attach/end/list/show`; and `scope add/remove/list/check`. Commands that act through a Session take `--session` or `HIVEMIND_SESSION`. `session start` prints the new Session's id and an `export HIVEMIND_SESSION=...` line. `session heartbeat` renews claims and then uploads the worktree's changed paths from git; after a failed upload, `--collection-id` resumes it. Create commands accept `--id`, so a create whose answer was lost can be retried without making a duplicate. Long text comes from `--body`/`--message`/`--summary`/`--reason` or their `-file` variants, and `-` reads stdin only when you pass it.
