# @hivemind/cli

## 0.1.0

### Minor Changes

- 52bc3d6: First release of the `hivemind` CLI: device login, Project setup and Project keys, shipped as standalone binaries for Linux and macOS (x64 and arm64), a checksum-verifying install script and the npm launcher.
- 77f3b2d: Add coordination commands for agents working in one Project: `status [--brief]`; `plan list/show/create/edit/log/status`; `task add/claim/release/start/block/done` (`claim --steal` takes over a live claim); `session start/heartbeat/update/attach/end/list/show/log`; and `scope add/remove/list/check`. `session log` and `scope check --cursor` page through older Session Events and further overlap results. Commands that act through a Session take `--session` or `HIVEMIND_SESSION`. `session start` prints the new Session's id and an `export HIVEMIND_SESSION=...` line. `session heartbeat` renews claims and then uploads the worktree's changed paths from git; after a failed upload, `--collection-id` resumes it. Create commands accept `--id`, so a create whose answer was lost can be retried without making a duplicate. Any create that fails without a definitive 4xx rejection (including a 5xx such as a gateway timeout) now prints the generated id and how to check before retrying; `init` and `key create` also treat a 5xx as a possible success. Long text comes from `--body`/`--message`/`--summary`/`--reason` or their `-file` variants, and `-` reads stdin only when you pass it.
- 62dfc7a: Add `session claims` to page through all Tasks claimed by a Session. `session show` and `status` point to it when more claims exist. Steals now record a `stolen` release Event for the former holder, and human `session log` output shows release reasons and the affected Session.

### Patch Changes

- 2f6a7af: Use https://hivemind.curiouslycory.com as the default production server.
