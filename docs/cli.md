# The hivemind CLI

`hivemind` is the command-line client for hive-mind. It logs in to a hive-mind server, binds a repository to a Project and manages Project keys (M1), records Plans, Tasks, Sessions and Scopes for the agents working in that Project (M2, see [Coordination](#coordination-plans-tasks-sessions-and-scopes)), and reserves ADR numbers and syncs the repository's ADRs into hive-mind (M4, see [ADRs](#adrs)).

## Supported platforms

| OS | Architectures | Minimum |
|---|---|---|
| Linux with glibc | x64, arm64 | glibc 2.17. x64 needs a CPU with AVX2 (x86-64-v3). |
| macOS | x64 (Intel), arm64 (Apple silicon) | macOS 13 |

- Windows and musl-based Linux (Alpine) are not supported. The installer and the npm package refuse them.
- The minimums come from the Bun 1.4.2 runtime the binaries are built with. Bun recommends Linux kernel 5.6 or newer and runs on kernels back to 3.10.
- CI runs the binaries on Ubuntu 24.04 and macOS 15 runners. Older systems within the minimums are not tested.
- On Linux x64 without AVX2 the binary dies with SIGILL. The installer checks `/proc/cpuinfo` first, and the npm launcher prints a hint when this happens. There is no baseline (non-AVX2) build.

Each binary is standalone: it needs no Node or Bun on the machine.

## Install

The first public release, [v0.1.0](https://github.com/CuriouslyCory/hive-mind/releases/tag/v0.1.0), is published on GitHub, and the install script below installs it. The npm package is not published yet (see [npm](#npm)).

### Install script

```bash
curl -fsSL https://github.com/CuriouslyCory/hive-mind/releases/latest/download/install.sh | sh
```

The script downloads the archive for your platform and `SHA256SUMS` from the GitHub release, checks the archive's SHA-256, runs the new binary to check its version, and only then moves it into place with an atomic rename. On any failure the existing installation is left as it was. It never uses sudo and never edits shell startup files, so add the install directory to `PATH` yourself.

| Flag | Environment variable | Default |
|---|---|---|
| `--version <v>` | `HIVEMIND_VERSION` | the latest release (`0.1.0` and `v0.1.0` both work) |
| `--install-dir <dir>` | `HIVEMIND_INSTALL_DIR` | `~/.local/bin` |
| | `HIVEMIND_RELEASES_URL` | `https://github.com/CuriouslyCory/hive-mind/releases` (https only, except http on localhost and `file://` mirrors with a pinned version) |

Flags take precedence over the environment. To pass flags through the pipe, use `sh -s --`:

```bash
curl -fsSL https://github.com/CuriouslyCory/hive-mind/releases/latest/download/install.sh | sh -s -- --version 0.1.0
```

`install.sh` is not listed in `SHA256SUMS`; it is the script that does the verifying. The macOS binaries carry only an ad hoc signature, applied at build time with `codesign --sign -`: there is no Developer ID signing or notarization yet.

### npm

The npm package name is `@curiouslycory/hivemind`. The name is reserved on npm by a placeholder version, 0.0.0, that contains no CLI; the CLI itself is not published there yet, so the commands below do not work until it is.

```bash
npm install -g @curiouslycory/hivemind
hivemind --help
```

To run it without a global install:

```bash
npx @curiouslycory/hivemind --help
```

Use the scoped name. The unscoped `hivemind` package on npm belongs to someone else, so `npx hivemind` runs unrelated code.

The package is a small Node launcher and needs Node 18 or newer. The binary comes from one of four optional per-platform packages (`@curiouslycory/hivemind-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`), so npm's integrity check covers it and no install script runs. Do not install with `--omit=optional`: the launcher then reports that the platform package is missing.

### Check the install

```bash
hivemind --version
# hivemind 0.1.0 (<commit>, bun-linux-x64)
```

## Choosing the server

Every command talks to one backend origin, chosen in this order:

1. `--server <origin>`
2. `HIVEMIND_URL`
3. the built-in default, `https://hivemind.curiouslycory.com`

The value must be an origin only: `https://host[:port]` with no path, query, fragment or user info. Plain http is accepted only for `localhost`, `127.0.0.1` and `[::1]`, for local development. Logins are stored per origin, so a login for `http://localhost:3000` is never sent to production. The CLI never follows a redirect from the API. `.hivemind.json` never sets the server.

## Logging in

```bash
hivemind login
```

1. The CLI starts a device login and prints a URL (`<origin>/device`) and an 8-character code such as `ABCD-EFGH` on stderr. In a terminal it also tries to open the browser.
2. In the browser, sign in to hive-mind with GitHub if you aren't signed in. The page shows the code. Check that it matches the one in your terminal, then choose **Approve** or **Deny**.
3. The CLI polls the server until you decide, then stores the login and shows who you are logged in as. The token is never printed.

Approving gives the CLI a login session as your User, with access to all your organizations. The code is valid for 10 minutes.

| Outcome | Error code | Exit |
|---|---|---|
| You denied the request | `FORBIDDEN` | 3 |
| The code expired before you decided | `LOGIN_EXPIRED` | 1 |
| The server ended the flow for another reason | `LOGIN_FAILED` | 1 |
| Ctrl+C | `CANCELLED` | 1 |

Nothing is stored unless the login succeeds.

- **Without a terminal** (stdin or stderr is not a TTY, as in CI or an agent's shell), `login` prints the URL and code and waits. It never reads stdin and never opens a browser. If the origin's current login is kept in the Keychain or Secret Service, `login` cannot revoke or delete it without a terminal, so it fails with `TERMINAL_REQUIRED` (exit 1) before contacting the server and changes nothing. Run `hivemind logout` in a terminal first, or use `HIVEMIND_TOKEN`.
- **Lifetime.** The login is a better-auth login session token. It expires 7 days after it was last extended, and the server extends it on use: a request made at least one day after the last extension moves the expiry to 7 days after that request. A login that goes unused for 7 days therefore expires, and one used at least every 6 days does not. There is no refresh token: when the login expires, commands exit 3 and you run `hivemind login` again.
- **Logging in again** replaces the stored login for that origin. After the new login is stored, `login` asks the server to revoke the previous token. If the previous login cannot be read or revoked, `login` prints a warning and still succeeds; that token stays valid until it expires. If the new login cannot be stored, `login` revokes the new token, keeps the previous login and fails.
- **With `HIVEMIND_TOKEN` set** to a non-empty value, `login` warns, stores the new login anyway, and `HIVEMIND_TOKEN` keeps taking precedence until you unset it.

## Credentials

### Which credential a command uses

1. `HIVEMIND_TOKEN`, when set and non-empty. Nothing else is read. If the server rejects it, the command exits 3; it never falls back to the stored login. An empty `HIVEMIND_TOKEN` counts as unset.
2. Otherwise, the stored login for the chosen origin.
3. Otherwise, the command exits 3 with `UNAUTHORIZED` ("not logged in").

`HIVEMIND_TOKEN` takes either a login token or a Project key. Agents and CI should use a Project key.

If the server cannot check a token, for example because its database is unavailable, it answers 500 rather than 401, and the command exits 1 with `INTERNAL_SERVER_ERROR`. This applies to login tokens and Project keys. A token the server rejects with 401 (`UNAUTHORIZED`, exit 3) was checked and found invalid; after exit 1 the token may still be valid, so keep it and try again later.

### Where a login is stored

| Platform | First choice | Fallback |
|---|---|---|
| macOS, in a terminal | Keychain (service `hivemind`, account = origin) | credentials file |
| Linux, in a terminal | Secret Service through `secret-tool` (Debian/Ubuntu package `libsecret-tools`), attributes `service hivemind` and `origin <origin>` | credentials file |
| Any platform, no terminal | credentials file only | none |

- **Fallback.** If the OS store is unavailable (for example no `secret-tool`, no Secret Service, no login collection or a locked collection) or `secret-tool` does not finish within 5 seconds, `login` stores the token in the credentials file and prints a warning saying so. If the OS store answers with any other error, `login` fails with `CREDENTIAL_STORE_ERROR` instead of putting the token somewhere you did not expect.
- **No terminal, file only.** Both OS stores can show an unlock or access dialog, so a run without a TTY never touches them. A login stored in the Keychain or Secret Service is therefore invisible to non-interactive runs: most commands exit 3 with `UNAUTHORIZED`, and the error says where the login is. `login` and `logout` would have to revoke or delete that login, so without a terminal they fail with `TERMINAL_REQUIRED` (exit 1), change nothing and keep the stored login, so that a later `hivemind logout` in a terminal can still revoke and delete it. Use `HIVEMIND_TOKEN` in those environments.
- **The Keychain addon (macOS).** The macOS binaries reach the Keychain through `@napi-rs/keyring`'s Node-API addon, which is embedded in the binary. Before loading it, the CLI writes a copy to `~/Library/Caches/hivemind/native/keyring-<sha256>.node` and loads that copy. The directory must be owned by you with mode 0700, and the copy is checked on every load: it is reused only if it is a regular file owned by you, mode 0600, with exactly the embedded bytes; anything else is replaced. If the directory fails these checks, the Keychain is treated as unavailable and the credentials file is used. `TMPDIR` plays no part. Each new addon version adds a copy of about 0.5 MB, and old copies are not deleted.
- **The credentials file** is `$XDG_CONFIG_HOME/hivemind/credentials.json` when `XDG_CONFIG_HOME` is an absolute path, otherwise `~/.config/hivemind/credentials.json`. The directory is 0700 and the file 0600. The CLI refuses a symlinked file, a file or directory owned by another user, and (for reads) a file that group or others can read; `chmod 600` fixes the last case.
- **Layout.** The file has one entry per origin. An entry holds either the token itself or a pointer to the OS store that holds it (`{ "store": "keychain" }` or `{ "store": "libsecret" }`, no secret). Only the store the entry names is read, so a token left in another store is never used.

### Logging out

```bash
hivemind logout
```

`logout` deletes every local copy of the login for the origin (OS store and credentials file), then asks the server to revoke the token. If the server cannot be reached or refuses, the local copies are already gone and the command exits 1 with `REVOCATION_FAILED`, because the token may stay valid on the server until it expires. In a terminal, if the credentials file points to an OS store entry that is missing or cannot be read, `logout` deletes the pointer and also exits 1 with `REVOCATION_FAILED`, since it had no token to revoke.

Without a terminal, `logout` cannot open the Keychain or Secret Service. If the login is kept there, `logout` fails with `TERMINAL_REQUIRED` (exit 1) and changes nothing; run `hivemind logout` in a terminal. A login kept in the credentials file is logged out normally.

`logout` never changes or revokes `HIVEMIND_TOKEN`; to revoke a Project key, use `hivemind key revoke`.

## Binding a repository: `.hivemind.json`

`hivemind init` writes `.hivemind.json`, which binds a repository to one Project. Commit it. It contains exactly this and nothing else:

```json
{
  "version": 1,
  "projectId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
}
```

It never holds a server address or a credential. The file is limited to 16 KiB.

**Discovery.** Commands that need a Project look for `.hivemind.json` starting in the current directory (with symlinks resolved) and walking up through its parents:

- The first `.hivemind.json` found is used. If that file is malformed, the command fails; it does not fall back to a file further up.
- The walk stops after the first directory that contains a `.git` entry, so a linked git worktree or a submodule inside another checkout does not pick up the outer checkout's binding. Outside a git repository the walk goes up to `/`.
- A `.hivemind.json` that is a symlink is an error.

| Error code (exit 1) | Meaning |
|---|---|
| `CONFIG_TOO_LARGE` | larger than 16 KiB |
| `CONFIG_INVALID_JSON` | not valid UTF-8 JSON |
| `CONFIG_UNSUPPORTED_VERSION` | an integer `version` other than 1; upgrade the CLI |
| `CONFIG_INVALID` | any other shape, such as extra keys or a `projectId` that is not a uuid |

### `hivemind init`

```bash
hivemind init --name 'Web app' --slug web-app         # create or reuse a Project
hivemind init --project <id>                           # link an existing Project
hivemind init                                          # choose interactively
```

- **Where it writes.** At the top of the current git worktree (the nearest directory with a `.git` entry), or in the current directory outside git.
- **Creating.** `--name` and `--slug` create a Project in an organization. Any Member of the organization can create one. If the organization already has a Project with that slug and the same name and repository URL, it is reused; if the data differs, `init` fails with `CONFLICT` (exit 2). Names are up to 120 characters; slugs are lowercase letters, digits and hyphens, up to 63 characters.
- **Organization choice.** `--org <id>` picks the organization. Without it, `init` uses your only organization if you have one, offers a choice in a terminal if you have several, and fails with `USAGE_ERROR` without a terminal.
- **Project choice.** With no flags, `init` links your only accessible Project, offers a choice in a terminal if there are several, and fails with `USAGE_ERROR` without a terminal or when you have no Projects yet.
- **Repository URL.** `--repo-url` defaults to the `origin` git remote. A remote URL that contains credentials is dropped, never stored or printed.
- **Existing file.** A file that already binds the same Project is left alone. A file that binds a different Project is a `CONFLICT` (exit 2), checked before anything is created on the server, unless you pass `--replace`.
- **Partial failure.** If the Project was created but the file could not be written, the error gives the Project id; rerun with `hivemind init --project <id>`. The Project is not deleted.
- **As a Project key.** With no flags, `init` links the key's own Project. `--project` with another Project gets `NOT_FOUND` (exit 4), and `--name` gets `FORBIDDEN` (exit 3).

## Project keys

A Project key is an organization credential bound to one Project, for CI and headless agents. It can identify itself (`whoami`), read and link its own Project, and use every coordination and ADR command in that Project: each key holds all coordination permissions and `adr:read` and `adr:write`, including keys created before M2 or M4 (ADR-0014, ADR-0017). It cannot list organizations, create Projects or manage keys. A key belongs to the organization, not to the User who created it: it keeps working after that User leaves the organization, until it is revoked or expires.

Only organization owners can create, list and revoke keys, and only with a user login. The key commands act on the Project given by `--project <id>`, or else the one in the nearest `.hivemind.json`; with neither they fail with `USAGE_ERROR`.

```bash
hivemind key create --name ci --expires-in-days 90 > key.txt
hivemind key list
hivemind key revoke <keyId>
```

- **`key create`** prints the secret exactly once, on stdout (as `data.secret` with `--json`). It cannot be shown again. Details and the warning go to stderr, so redirecting stdout captures only the secret. Store it right away, for example as a `HIVEMIND_TOKEN` CI secret. `--expires-in-days` takes 1 to 365; without it the key never expires. Creation is never retried: if the command times out, loses the connection, gets an unreadable answer or a server error (5xx) after sending the request, the key may exist anyway, so check `key list` and revoke keys you cannot use.
- **`key list`** shows the Project's enabled, unexpired keys: id, name, creation time and expiry. Secrets are never listed.
- **`key revoke <keyId>`** deletes the key at once. Requests with it then exit 3. An unknown or already revoked key is `NOT_FOUND` (exit 4).

Using a key:

```bash
HIVEMIND_TOKEN="$(cat key.txt)" hivemind whoami
```

## Coordination: Plans, Tasks, Sessions and Scopes

These commands record what the agents working in one Project plan and do. The terms are defined in `CONTEXT.md`; the rules behind them are in ADR-0014. Every coordination command acts on the Project given by `--project <id>`, or else the one in the nearest `.hivemind.json`, and works with a user login or a Project key.

### A typical run

```bash
export HIVEMIND_SESSION="$(hivemind session start --agent claude-code --intent 'Fix parser error positions')"
hivemind status
hivemind scope add 'packages/parser/**'
hivemind scope check
hivemind task claim 7a2e3d4c-5b6a-4f90-8b1c-2d3e4f5a6b7c
hivemind task start 7a2e3d4c-5b6a-4f90-8b1c-2d3e4f5a6b7c
hivemind session heartbeat                 # every 60 seconds while working
hivemind plan log PLAN-3 --message 'Error positions now count code points.'
hivemind task done 7a2e3d4c-5b6a-4f90-8b1c-2d3e4f5a6b7c
hivemind session end --summary 'Fixed error positions. PLAN-3 has one open Task.'
unset HIVEMIND_SESSION
```

`session start` prints only the Session id on stdout, so the `export` line captures it.

### Which Session a command uses

1. `--session <id>`
2. `HIVEMIND_SESSION`, when set and non-empty. An empty value counts as unset.

The CLI never picks a Session from the server's list of live Sessions. A value that is not a UUID, from either source, is `USAGE_ERROR` (exit 1) before any request.

- **Required** by `task claim`, `release`, `start`, `block` and `done`; `session heartbeat`, `update`, `attach` and `end`; and every `scope` command. Without a Session they fail with `USAGE_ERROR`.
- **Optional attribution** on `plan create`, `plan edit`, `plan status`, `plan log --message`, `plan decide`, `task add`, `adr new` and `adr sync`: when a Session is set, the Event names it as the actor Session. It must then be one of your Sessions and not ended or abandoned, so unset `HIVEMIND_SESSION` after `session end`; otherwise these commands fail with `CONFLICT` (exit 2).
- `status` uses the Session only to fill `myClaims`. `session show`, `session claims` and `session log` take the Session as an argument or from these two sources.

Your Sessions are the ones started by the same principal: the same User (through any of that User's logins) or the same Project key. A Session started with a Project key cannot be used with a user login, and the reverse.

### Identifiers and access

- **Plan:** its Project-local key, `PLAN-N` in uppercase (numbered from 1 in creation order), or its UUID.
- **Task, Session, Scope:** UUID only. `plan show` lists Task ids, `session start` prints the Session id, `scope list` lists Scope ids.
- Any Plan, Task, Session, Scope or Event of the Project can be read.
- Changing a Session, or acting through it on a Task or a Scope, needs your own Session. A Session of this Project that someone else owns is `FORBIDDEN` (exit 3). A Session id that does not exist, or belongs to another Project, is `NOT_FOUND` (exit 4). Attribution (above) follows the same rule: someone else's Session of this Project is `FORBIDDEN`, and a missing or other-Project one is `NOT_FOUND`.
- Any id from another Project gets the same `NOT_FOUND` as an absent one.
- A state that does not allow the action is `CONFLICT` (exit 2), with the reason in the message.

### Plans

| Status | Can move to |
|---|---|
| `draft` | `active`, `abandoned` |
| `active` | `paused`, `done`, `abandoned` |
| `paused` | `active`, `done`, `abandoned` |
| `done`, `abandoned` | nothing: both are final |

- `plan create` makes a `draft` Plan, or an `active` one with `--status active`, and prints its key.
- `plan status <plan> <status>` takes `active`, `paused`, `done` or `abandoned`. The current status is a no-op (`changed: false`); a move not in the table is `CONFLICT`. `done` needs every Task done and no claims left. `abandoned` releases the remaining claims and reports how many in `releasedClaimCount`.
- Tasks can be claimed and started only in an `active` Plan. In a `paused` Plan the current holders can still heartbeat, block, finish and release.
- In a `done` or `abandoned` Plan, `plan log --message` and `plan decide` still work; `plan edit` and `task add` are `CONFLICT`.
- `plan log <plan>` without `--message` lists the Plan's Events, log entries and decisions included, newest first. A Session attached to the Plan when it ends adds its `session end` summary there too.
- `plan decide <plan> <text>` records a decision as a `plan.decision_recorded` Event. It is shown in the dashboard's Decisions panel and in the Plan's activity (`plan log`). Quote the text: it is one line, trimmed, of 1 to 500 characters, with no line breaks or other control characters; anything else is `USAGE_ERROR` (exit 1) before any request. Put longer reasoning in `plan log --message`.

### Tasks

A Task's status is `todo`, `in_progress`, `blocked` or `done`. Claiming is separate from the status: a claim does not change it.

| Command | Needs | Result |
|---|---|---|
| `task add <plan> --title <t>` | Plan not `done` or `abandoned` | a `todo` Task at the end of the Plan; prints its id |
| `task claim <taskId>` | live Session, `active` Plan, Task not `done`, and the Task unclaimed, its lease expired, or its holder no longer live | your claim, with a lease that expires 5 minutes later |
| `task start <taskId>` | your unexpired claim, `active` Plan | `todo` or `blocked` becomes `in_progress` |
| `task block <taskId> --reason <r>` | your unexpired claim, `active` or `paused` Plan | `blocked`, with the reason |
| `task done <taskId>` | your unexpired claim, `active` or `paused` Plan | `done`; the claim is cleared |
| `task release <taskId>` | live Session | your claim is cleared; the status stays |

- Repeating an action whose result is already in place is a no-op with `changed: false` and no Event: claiming a Task you validly hold (this does not extend the lease), starting an `in_progress` Task, blocking with the same reason, finishing a `done` Task, releasing an unclaimed Task.
- Starting, blocking or claiming a `done` Task is `CONFLICT`. Releasing another live Session's claim is `CONFLICT`.
- A claim held by another live Session is `CONFLICT` (exit 2), naming the holder's Session id and intent:

  ```json
  { "schemaVersion": 1, "command": "task claim", "ok": false, "error": { "code": "CONFLICT", "message": "https://hivemind.curiouslycory.com: The Task is claimed by Session 5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9 (intent: \"Run the coordination checks\")." } }
  ```

- **`--steal`** takes over a claim that another live Session holds. Use it only when you know the holder has stopped working on the Task, for example after asking its owner. A holder that stopped heartbeating does not need it: its claim becomes claimable when the lease expires or the Session goes stale. The takeover writes two Events: `task.released` with reason `stolen`, affecting the former holder, then `task.claimed` naming it in `stolenFromSessionId`. Both Sessions' `session log` show it; `data.stolenFromSessionId` is set, and stderr says `Took the claim over from Session <id>`. From then on the former holder's heartbeats, releases, starts, blocks and dones cannot change the new claim.

### Sessions and timing

A Session is `active` or `idle` while live, `stale` after 5 minutes without a heartbeat, `abandoned` after 30, and `ended` after `session end`. Each boundary is inclusive: at exactly 5 minutes the Session is stale.

| Since the last heartbeat | Status | What it can do |
|---|---|---|
| under 5 minutes | `active` or `idle` | everything; its Scopes take part in overlap checks |
| 5 to 30 minutes | `stale` | heartbeat, `session update` (except `--status`), `session attach`, `session end`. It cannot claim, work on Tasks or change Scopes, its Scopes leave overlap checks, and other Sessions can claim its Tasks |
| 30 minutes or more | `abandoned` | only `session end`, to record its first summary; it stays `abandoned` |

- **Claim leases** last 5 minutes from the claim or its last renewal. A heartbeat renews the Session's unexpired claims. An expired lease is never renewed: a heartbeat releases it, and any Session can claim the Task. A stale Session that heartbeats loses its expired claims, becomes `active` again and must claim those Tasks again.
- **Database time decides.** Every request computes these statuses and lease expiries from the database clock, whatever the stored status says. The minute sweep only writes the stored status and its Events later (`docs/setup.md`, H8).
- Heartbeat every 60 seconds. A few missed heartbeats then do not make the Session stale or let its leases expire.
- `session start --agent <name> --intent <text>` records the agent (up to 120 characters), the intent (one line, up to 2,048 characters), the hostname and, inside a git worktree, the branch and commit. Outside git, on a detached HEAD or before the first commit, the branch or commit is left empty.
- `session update` changes `--agent`, `--intent`, `--status active|idle`, or with `--git` rereads the branch and commit (and clears them outside git). A status change is not a heartbeat: on a stale Session `--status` is `CONFLICT` (exit 2), so heartbeat first, or pass `--status` to `session heartbeat`.
- `session attach --plan <plan> [--task <taskId>]` sets the Session's focus; `--detach` clears it. Attaching neither claims nor releases a Task.
- `session end --summary <markdown>` records the summary, ends the Session and releases its claims. Task statuses are kept. The same summary again is a no-op; a different one is `CONFLICT`.

### Heartbeats

M2 has no automatic heartbeat; agent hooks come with M6. Run `hivemind session heartbeat` from the worktree every 60 seconds, for example with a loop in the background of the shell that set `HIVEMIND_SESSION`:

```bash
( while sleep 60; do hivemind session heartbeat --json >/dev/null; done ) &
HEARTBEAT_PID=$!
# ... work ...
kill "$HEARTBEAT_PID"
hivemind session end --summary-file summary.md
```

One heartbeat does this:

1. It renews the Session (`--status active|idle` also sets the status; without it a stale Session becomes `active`) and its unexpired claims. Released expired claims are listed on stderr. The server opens a new touched-path collection and returns its id. If this step fails, the command fails and does nothing else.
2. It lists the worktree's changed paths with `git status`: modified, added, deleted, untracked and both names of a rename. Outside a git worktree it stops here with a warning: the heartbeat counts, but no touched paths are recorded.
3. It sorts the paths, keeps the first 1,024, and counts the rest, together with paths that are not valid UTF-8 or longer than 256 bytes, as omitted.
4. It uploads a manifest, then batches of at most 16 paths, then finalizes the collection.

If the upload fails after the renewal succeeded, the command still exits 0: the renewal is what keeps the claims. stderr names the failed step and the resume command, and `data.collectionError` is set. Resume before the next heartbeat (pause a heartbeat loop first): a new heartbeat replaces the unfinished collection and leaves the Session's coverage incomplete until it ends. The Session's Scope coverage stays incomplete until a collection is finalized.

`--json` `data` for `session heartbeat`:

| Field | Meaning |
|---|---|
| `heartbeat` | the server's answer: `session`, `previousStatus`, `renewedClaims` and `releasedClaims` (each `{ items, complete }`, at most 100 Task ids), `leaseExpiresAt`, `collectionId`, `historicalScopeComplete`. `null` when resuming |
| `collection` | the collection's state after the last successful upload step, or `null`: `pathCount`, `batchCount`, `omittedPathCount`, `receivedBatchCount`, `finalized`, `collectionComplete`, `historicalScopeComplete`, `scopeComplete` |
| `touchedPathsAvailable` | false outside a git worktree |
| `leaseRenewed` | whether this run renewed the Session |
| `collectionId` | the collection this run uploaded to |
| `pathCount`, `omittedPathCount` | paths sent and paths that could not be sent; `null` if collection did not get that far |
| `overCapacityPathCount` | paths the server did not store because the Session already has 96 touched Scopes |
| `collectionError` | `{ step: "collect" \| "manifest" \| "batch" \| "finalize", code, message }`, or `null` |

**Resuming an upload.** `hivemind session heartbeat --collection-id <id>` repeats the manifest, batches and finalize for that collection without sending a heartbeat. It works only while the worktree is unchanged and before the next heartbeat opens a newer collection. A resume that fails is an error envelope, and `--collection-id` outside git is `USAGE_ERROR`. If you cannot resume, run a normal heartbeat instead; the unfinished collection then marks the Session's coverage incomplete for good (see below).

### Scopes

A Scope is a path area a Session reports. **Declared** Scopes are globs you add with `scope add`; **touched** Scopes are the exact paths heartbeats upload. Overlaps between live Sessions are warnings and never block anything.

- `scope add <pattern>` adds one declared Scope per run. Adding an existing pattern returns it with `created: false`. A Session holds at most 32 declared Scopes.
- `scope remove <scopeId>` removes a declared Scope. Removing a touched Scope is `CONFLICT`; an id the Session does not have returns `removed: false`.
- `scope list [--source declared|touched]` lists the Session's Scopes, oldest first.
- A Session holds at most 96 touched Scopes. Further paths are not stored, and its coverage is incomplete from then on.
- Adding and removing Scopes needs a live Session.

**Declared pattern grammar.** A pattern is a repository-relative path of `/`-separated segments, at most 256 bytes of UTF-8. Quote it so the shell does not expand it, and put `--` before a pattern that starts with `-`.

- `*` matches any run of characters within one segment, including none. `?` matches exactly one character. Neither matches `/`.
- `**` as a whole segment matches zero or more segments. `packages/**` matches `packages` itself and everything below it, and `**/x` matches `x`.
- A pattern without wildcards matches only that exact path: `src` does not cover `src/a.ts`; use `src/**`.
- Dotfiles are not special: `*` matches `.env` and `**` matches inside `.git/`.
- Characters are compared exactly: case-sensitive, with no Unicode normalization.
- There is no escape, so a pattern cannot name a literal `*` or `?`. Touched paths are never globs: a `*` in a touched path is a literal character.

Rejected with `USAGE_ERROR` before any request (the server checks again): a leading `/`; an empty, `.` or `..` segment (so also `//` and a trailing `/`); a backslash; a control character; `!` at the start (negation); braces `{a,b}`; character classes `[ab]`; extglobs such as `@(a|b)`; `**` inside a segment (`a**`, `**.ts`); more than 256 bytes.

### Overlaps and completeness

`scope check` compares your Session's Scopes with those of every other live Session in the Project. Each item has a `kind`:

- `overlap`: `witness` is a path both Scopes match. For two declared Scopes it is a shortest such path, with a stand-in character at wildcard positions (`a/*/b` and `a/**/b` give `a/c/b`). When a touched Scope is involved, it is the touched path.
- `possible`: the comparison of this pair ran out of its budget (65,536 matcher states), so an overlap was not ruled out. `witness` is `null`.

`complete` is `false` whenever an overlap could be missing. Treat it as "unknown", never as "no overlap". It is false when:

- the request's comparison budget (4,096 comparisons) ran out. Two Sessions at the maximum of 32 declared and 96 touched Scopes already exceed it;
- a pair ran out of its state budget (the pair is also listed as `possible`);
- a compared Session, yours included, has `scopeComplete: false`. These Sessions are listed in `incompleteSessionIds`;
- results remain on further pages. `scope check` follows up to 20 pages of 100; if more remain, `nextCursor` is set and `complete` is false. `scope check --cursor <nextCursor>` continues from there; human output ends with `More: --cursor <cursor>`.

Human output then ends with `The check is incomplete: an overlap may be missing.` Overlaps never change the exit code: `scope check` exits 0 either way.

A Session's `scopeComplete` is true only when its latest touched-path collection was finalized with every changed path stored and none omitted, and no earlier collection lost coverage. It is false:

- from each heartbeat until that heartbeat's upload is finalized;
- outside a git worktree, where nothing is uploaded;
- for the rest of the Session once coverage was lost: a path was omitted (not UTF-8, over 256 bytes, or beyond the first 1,024), the Session reached 96 touched Scopes, or a heartbeat replaced a collection that was never finalized.

Lost coverage stays lost until the Session ends. To get a complete check again, end the Session and start a new one.

`status` includes the overlaps among all live Sessions, up to 20, with the same rule for `complete.overlaps`.

### Pages

List commands return one page: `{ items, nextCursor }`. `--limit` takes 1 to 100 (default 50). Pass a non-null `nextCursor` to `--cursor` for the next page; human output ends with `More: --cursor <cursor>`. A cursor works only for the list and filters it came from; any other use is `BAD_REQUEST` (exit 1).

| Command | Order |
|---|---|
| `plan list [--status <s>]` | newest Plan first |
| `plan show <plan> [--task-status <s>]` | the Plan, then its Tasks by position |
| `plan log <plan>` | newest Event first |
| `session log [sessionId]` | newest Event first |
| `session claims [sessionId]` | oldest claim first; the cursor stops working once its claim ends |
| `session list [--status <s>]` | newest Session first; `<s>` is `live`, `terminal`, `active`, `idle`, `stale`, `ended` or `abandoned` |
| `scope list` | oldest Scope first |
| `adr list [--status <s>] [--state <s>]` | highest ADR number first. `--status` leaves out reservations, which have no status. Each page also carries `lastSync` (see [ADRs](#adrs)) |

`session show` and `status` return only the first page or the first 20 entries of each section; `nextCursor` and `complete` say whether more exist. Page through a Session's claims with `session claims <sessionId> --cursor <claims.nextCursor>`, older Events with `session log <sessionId> --cursor <events.nextCursor>` and its Scopes with `scope list --session <sessionId> --cursor <scopes.nextCursor>`; `session show` prints these commands when more exist. If a claims cursor returns `BAD_REQUEST` because its claim was released, stolen or expired, start again without `--cursor`.

### Text input

- Markdown and reasons come from a flag or a file: `--body`/`--body-file`, `--message`/`--message-file`, `--summary`/`--summary-file`, `--reason`/`--reason-file`. Giving both flags of a pair is `USAGE_ERROR`.
- `--<name>-file -` reads stdin. stdin is read only then; no command opens an editor or prompts. `--body -` is the literal text `-`.
- The text must be valid UTF-8, not blank, at most 8 KiB (8,192 bytes), with no control characters other than tab, CR and LF. Anything else is `USAGE_ERROR` before any request. A file that cannot be read is `IO_ERROR` (exit 1); the message does not repeat the path.
- Titles and agent names are at most 120 characters; an intent is one line of at most 2,048 characters. A request body over 16 KiB is `PAYLOAD_TOO_LARGE` (exit 1).

### Lost answers and retries

The CLI never retries a write. `plan create`, `plan log --message`, `plan decide`, `task add`, `session start` and `adr new` generate the new record's UUID once per run. Unless the server rejected the request with a documented 4xx code (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`) or the CLI stopped before sending it, the record may exist anyway. That covers a timeout, a lost connection, a cancel, an unreadable answer and any 5xx: a gateway timeout or a failed output check can come after the server committed. The error says so and names the generated id (on stderr in `--json` mode too):

```text
The Plan may have been created anyway with id 6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b. Check with 'hivemind plan show 6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b' before retrying, and retry only with --id 6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b.
```

- Inspect first, with the command the message names.
- If the record is missing, rerun the same command with `--id <id>`. If the first request did arrive, the server returns that record with `created: false` and writes no second Event, even if the record was edited since.
- `--id` with different input is `CONFLICT`. For `session start` the input includes the hostname and the git branch and commit, so retry from the same worktree before committing.
- **`adr new`** names the ADR reservation's id and `hivemind adr list --state reserved` as the check. A retry with `--id` returns the same number instead of reserving another, then writes the template if the file is missing. Its input is the title, slug, git branch and Session, so retry from the same branch; the floor (see [`adr new`](#adr-new)) is not part of it. If the number was reserved but the file could not be written, the error also names `--id <id>`.

The other writes are safe to repeat once you have checked the state: a repeat of `task claim`, `start`, `block` (same reason), `done` or `release`, `scope add`, `plan status` or `session end` (same summary) is a no-op. `adr sync` needs no `--id`: after a lost answer, run it again. If the first request was applied, the rerun finds the copy at that commit and reports `Already synced at commit <sha7>.`

### Recovery examples

A lost answer on `task add`:

```bash
hivemind task add PLAN-3 --title 'Add error-position tests'
# error: TIMEOUT ... may have been created anyway with id 0d1e2f3a-...
hivemind plan show PLAN-3                       # is the Task there?
hivemind task add PLAN-3 --title 'Add error-position tests' --id 0d1e2f3a-...   # only if it is not
```

A claim conflict (exit 2):

```bash
hivemind session show 5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9   # who holds it, and is it live?
hivemind task claim 7a2e3d4c-... --steal                    # only once the holder has stopped
```

A Session that went stale (exit 2: `Session ... is stale: it sent no heartbeat for 5 minutes`):

```bash
hivemind session heartbeat          # becomes active; stderr lists released expired claims
hivemind task claim 7a2e3d4c-...    # claim them again
```

An abandoned or ended Session (exit 2: `Start a new Session`):

```bash
hivemind session end --summary 'Stopped after the parser change; tests not run.'   # abandoned: records its first summary
export HIVEMIND_SESSION="$(hivemind session start --agent claude-code --intent 'Finish the parser tests')"
```

A heartbeat whose upload failed (exit 0, warning on stderr):

```bash
hivemind session heartbeat --collection-id 9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f   # before the next heartbeat, worktree unchanged
```

### Coordination commands

All take `--project <id>`. "Session" means `--session <id>` or `HIVEMIND_SESSION`.

| Command | Options and arguments | `--json` `data` |
|---|---|---|
| `status` | `--brief` (human output only), Session optional | `{ projectId, asOf, selectedSessionId, activePlans, liveSessions, myClaims, recentTerminalSessions, overlaps, complete }`; each section at most 20 entries, `complete.<section>` false when more exist |
| `plan list` | `--status draft\|active\|paused\|done\|abandoned`, `--limit`, `--cursor` | `{ items, nextCursor }` of Plan summaries |
| `plan show <plan>` | `--task-status todo\|in_progress\|blocked\|done`, `--limit`, `--cursor` (for the Tasks) | `{ plan, tasks: { items, nextCursor } }` |
| `plan create` | `--title` (required), `--body` or `--body-file`, `--status draft\|active`, `--id`, Session optional | `{ plan, created }`; human output is the key |
| `plan edit <plan>` | `--title`, `--body` or `--body-file`, `--clear-body`, Session optional | `{ plan, changed }` |
| `plan status <plan> <status>` | Session optional | `{ plan, changed, releasedClaimCount }` |
| `plan log <plan>` | to read: `--limit`, `--cursor`. To append: `--message` or `--message-file`, `--id`, Session optional | read: `{ items, nextCursor }` of Events; append: `{ event, created }` |
| `plan decide <plan> <text>` | `--id`, Session optional | `{ event, created }` |
| `task add <plan>` | `--title` (required), `--id`, Session optional | `{ task, created }`; human output is the Task id |
| `task claim <taskId>` | `--steal`, Session | `{ task, changed, stolenFromSessionId }` |
| `task release\|start\|done <taskId>` | Session | `{ task, changed }` |
| `task block <taskId>` | `--reason` or `--reason-file` (required), Session | `{ task, changed }` |
| `session start` | `--agent` (required), `--intent` (required), `--id` | `{ session, created }`; human output is the id |
| `session heartbeat` | `--status active\|idle` or `--collection-id <id>`, Session | see [Heartbeats](#heartbeats) |
| `session update` | `--agent`, `--intent`, `--status active\|idle`, `--git`, Session | `{ session, changed }` |
| `session attach` | `--plan <plan>` [`--task <taskId>`], or `--detach`; Session | `{ session, changed }` |
| `session end` | `--summary` or `--summary-file` (required), Session | `{ session, changed, releasedClaims: { items, complete } }` |
| `session list` | `--status <s>`, `--limit`, `--cursor` | `{ items, nextCursor }` of Sessions |
| `session show [sessionId]` | `--limit` | `{ session, claims, scopes, events }`, each list a first page |
| `session claims [sessionId]` | `--limit`, `--cursor`, Session | `{ items, nextCursor }` of the Session's claims |
| `session log [sessionId]` | `--limit`, `--cursor` | `{ items, nextCursor }` of the Session's Events |
| `scope add <pattern>` | Session | `{ scope, created }` |
| `scope remove <scopeId>` | Session | `{ id, sessionId, removed }` |
| `scope list` | `--source declared\|touched`, `--limit`, `--cursor`, Session | `{ items, nextCursor }` of Scopes |
| `scope check` | `--cursor`, Session | `{ sessionId, items, nextCursor, complete, incompleteSessionIds }` |

The schemas of these `data` objects are the `/api/v1` output schemas in `packages/contract/src/` (`plan.ts`, `task.ts`, `session.ts`, `scope.ts`, `event.ts`, `status.ts`), with golden examples in `packages/contract/test/fixtures/v1/cli.*.json`. A Session's `status` is always its effective status at the time of the request. Event types and payloads are listed in `eventSchema` (`packages/contract/src/event.ts`).

**Events the server cannot read.** After a rollback, the server can hold Events that a newer deployment wrote, with a type, payload version or enum value it does not know. It returns each one with `type: "event.unavailable"`, `payloadVersion: 1` and `payload: {}`, and keeps its `id`, `seq`, `writerXid`, `actor`, `actorSessionId`, `planId`, `taskId`, `sessionId`, `effectiveAt` and `createdAt` (ADR-0015). The CLI treats it like any other Event:

- Human output prints its usual line, `<createdAt>  #<seq>  event.unavailable`, followed by the actor Session if there is one.
- `--json` passes it through unchanged wherever Events appear: `items` of `plan log` and `session log`, `events.items` of `session show`, and `event` of `plan log --message` and `plan decide`. The command succeeds with exit 0.
- Scripts must accept Event types they do not know, since later versions add types. Do not read `payloadVersion` as the stored Event's version: the stored type, version and payload are withheld.

An Event the server finds corrupt rather than newer fails the whole read with `INTERNAL_SERVER_ERROR` (exit 1).

## ADRs

An ADR is a file in the repository, `docs/adr/NNNN-slug.md`, in the format ADR-0001 fixes. The file is the source of truth. hive-mind hands out ADR numbers (an ADR reservation, `adr new`) and keeps a read-only copy of the ADR files as of one commit (ADR sync, `adr sync`), which `adr list`, `adr show` and the [dashboard](dashboard.md#pages) read. It never edits the repository. The terms are defined in `CONTEXT.md`; the design is ADR-0017.

### Recording a decision

```bash
hivemind adr new --title 'Use keyset pages for ADR lists'   # prints docs/adr/0018-use-keyset-pages-for-adr-lists.md
# write the decision in that file, open a PR, review and merge it
git fetch origin
hivemind adr sync                                           # copies the default branch's ADRs into hive-mind
hivemind adr show ADR-0018
```

`adr status` and `adr supersede` change local files the same way: commit the change, merge it, then sync. In CI, a workflow syncs on every push to the default branch (see [Syncing from CI](#syncing-from-ci)).

### Identifiers and the ADR directory

- **Identifiers.** An ADR is named by its number: `ADR-0015`, `0015` or `15` (`adr-0015` and `ADR-15` work too). Anything else is `USAGE_ERROR`. Human output prints `ADR-0015`; `--json` uses the integer `number`.
- **The ADR directory** is `docs/adr/` in the directory that holds `.hivemind.json` (see [Discovery](#binding-a-repository-hivemindjson)). It is not configurable.
- `adr new` and `adr sync` need `.hivemind.json` and act on its Project; they take no `--project`. Without one they fail with `USAGE_ERROR`.
- The local-only commands, `adr status`, `adr supersede` and `adr sync --check`, fall back to `docs/adr/` at the git worktree root when no `.hivemind.json` applies, so they also work in an unbound repository and in pull request CI. `adr show` uses the same rule to compare the local file. Outside both a binding and a git repository, the local-only commands fail with `USAGE_ERROR`.
- **ADR files** are the entries directly in the ADR directory whose names end in `.md`. Each must be a valid ADR file name (`0001` to `9999`, a hyphen, a slug of lowercase letters and digits joined by hyphens, then `.md`): ADR-0001 allows no other `.md` files there. Subdirectories and other extensions are ignored.
- **Paths.** `--json` paths are repository-relative POSIX paths, as the API returns them. Human output prints paths relative to the current directory, so they can be opened as printed.

### ADR commands

`adr list` and `adr show` take `--project <id>`. "Session" is optional attribution, as in [Which Session a command uses](#which-session-a-command-uses).

| Command | Options and arguments | `--json` `data` |
|---|---|---|
| `adr new` | `--title` (required), `--slug`, `--id`, Session optional | `{ adr, created, file: { path, status: "created" \| "unchanged" } }`; human output is the file's path |
| `adr list` | `--status proposed\|accepted\|superseded\|deprecated`, `--state reserved\|published\|removed`, `--limit`, `--cursor` | `{ items, nextCursor, lastSync }` of ADR summaries, without content |
| `adr show <adr>` | none | `{ adr, lastSync, local }`; `adr` includes `content`, `supersededBy` and `warnings` |
| `adr status <adr> <status>` | `<status>` is `proposed`, `accepted` or `deprecated` | `{ number, path, status, previousStatus, date, changed }` |
| `adr supersede <old> --by <new>` | `--by` (required) | `{ superseded: { number, path, status, previousStatus, date, changed }, superseding: { number, path, supersedes, changed }, changed }` |
| `adr sync` | `--ref <rev>`, `--force`, `--dry-run`, Session optional; or `--check` without the first three | `{ outcome, ref, commitSha, baseCommitSha, forced, fileCount, uploadedFileCount, added, updated, removed, unchanged, changes, warnings: { items, complete } }` |

- `state` says where a number is in hive-mind's copy: `reserved` (handed out by `adr new`, no file synced yet), `published` (the last synced commit has the file) or `removed` (an earlier sync found a file and a later one did not; the last copy is kept). It is never the ADR's status. A reservation's `status`, `path`, `date` and `content` are null.
- `lastSync` is `{ commitSha, syncedAt, syncedBy }` for the last ADR sync, or `null` before the first one. Human output of `adr list` and `adr show` ends with `As of commit <sha7>, synced <time>.`, or `No ADRs synced yet. Run 'hivemind adr sync' on the default branch.`
- `reservationTaken` is true when a file that bypassed `adr new` took a number reserved for another ADR. The file keeps the number; the reserved ADR needs a new one. `adr list` adds `(reserved for '<title>': needs a new number)` to that line.
- `local` compares the working tree's file with the copy: `{ match: "same" | "differs" | "missing" | "ambiguous", path }`, with `path` null for `missing` and `ambiguous` (more than one local file has the number), or `null` when no ADR directory applies. A reservation's file always `differs`, since the copy has no content for it. Human output says `The local file <path> differs from this copy.`, `No local file has ADR-NNNN.` or `More than one local file has ADR-NNNN.`
- The schemas are the `/api/v1` output schemas in `packages/contract/src/adr-api.ts`, with golden examples in `packages/contract/test/fixtures/v1/cli.adr-*.json`.

### `adr new`

`adr new --title <title>` reserves the Project's next ADR number, then writes ADR-0001's template to `docs/adr/NNNN-<slug>.md` with `status: proposed` and today's date. stdout is the path; stderr says `Reserved ADR-0018 (<id>).`, or `Found existing reservation ADR-0018 (<id>).` on a retry with `--id`.

- **Title and slug.** The title is 1 to 200 characters on one line, without leading or trailing spaces or a closing `#`. The slug defaults to the title in lowercase ASCII words joined by hyphens, cut at a word boundary to at most 60 characters. Pass `--slug` (lowercase letters and digits joined by single hyphens, at most 100 characters) when the title has no such letters or you want a shorter name.
- **Numbers.** Numbers come from a counter in hive-mind, run from 1 to 9999 and are never handed out twice, so two agents never get the same number. A reservation whose ADR is never merged leaves a gap; reservations do not expire and cannot be released.
- **The floor.** The CLI also sends the highest ADR number in the local `docs/adr/` and in `origin/HEAD`'s tree, and hive-mind reserves a number above it. A floor more than 100 past the next number hive-mind would reserve is refused with `CONFLICT`, so in a repository whose ADR numbers already go past 100, run `adr sync` before the first `adr new`.
- **No overwrite.** An identical existing file (a rerun) counts as success, with `file.status: "unchanged"`. A different file at that path, or another local file with the number, is `CONFLICT` (exit 2) and left as it is; the error names the `--id` to rerun with once it is moved aside.
- **No offline fallback.** If hive-mind cannot be reached, `adr new` fails. It never takes the local highest number + 1.
- **Symlinks.** If `docs`, `docs/adr` or another part of the ADR directory is a symbolic link that leads outside the directory holding `.hivemind.json`, `adr new` fails with `IO_ERROR` (exit 1) before it reserves a number, and writes nothing. A link that stays inside is followed.
- A lost answer is retried with `--id`; see [Lost answers and retries](#lost-answers-and-retries).

### `adr status` and `adr supersede`

Both commands edit local files only and make no server call. A change on the server would disagree with the default branch, and the next sync would undo it. hive-mind's copy changes when you commit the change, merge it to the default branch and run `adr sync`; the output says so.

- **`adr status <adr> <status>`** rewrites `status` and `date` (today) in the frontmatter and keeps the rest of the file byte for byte. The current status is a no-op (`changed: false`, date kept). `superseded` is `USAGE_ERROR`: use `adr supersede`.
- **`adr supersede <old> --by <new>`** adds `<old>` to `<new>`'s `supersedes` list (`<new>`'s date is unchanged), then sets `<old>` to `superseded` with today's date. It first parses every local ADR file. It refuses with `CONFLICT` (exit 2) when `<new>` is itself superseded, when another ADR already supersedes `<old>`, or when the change would make a supersedes cycle. Both files are written to temporary files before either is renamed, `<new>` first, so a rerun after an interruption finishes the job. Running it again when both files are already done is a no-op.
- Errors: no local file with the number is `NOT_FOUND` (exit 4); more than one is `CONFLICT`; a file the parser rejects is `ADR_INVALID` (exit 1), with each problem listed as `<path>: <CODE>: <message>`. A symlinked ADR file, or an ADR directory that a symbolic link leads outside its base directory (as for `adr new`), is `IO_ERROR` (exit 1), and nothing is written.

### `adr sync`

`adr sync` copies the ADR files of one commit into hive-mind.

- **One commit, never the working tree.** It reads the commit's tree with git, so unmerged branches and uncommitted edits are never synced. The default is `refs/remotes/origin/HEAD`, the remote's default branch as last fetched. `adr sync` never fetches: run `git fetch origin` first. `--ref <rev>` reads another commit, such as `HEAD` in a CI job on a push to the default branch. A clone without `origin/HEAD` gets `USAGE_ERROR`; run `git remote set-head origin --auto` or pass `--ref`.
- **Checked before anything is sent.** Every file in the commit is parsed first. Two files with one number are `CONFLICT` (exit 2); any invalid file is `ADR_INVALID` (exit 1). Either refuses the whole commit and lists every problem. Warnings (missing or out-of-order sections, a `supersedes` entry naming a missing ADR, `superseded` with no superseding ADR, an ADR superseded by two others, a cycle) are reported and do not stop the sync.
- **Commit order.** The CLI reads the commit hive-mind last synced and compares it with the one it read:

  | The copy's commit | Result |
  |---|---|
  | none yet, or an ancestor of the commit | sync |
  | the same commit | exit 0, `Already synced at commit <sha7>.`, nothing sent |
  | a descendant of the commit | exit 0, `Already synced past this commit: the copy is at <sha7>, which contains <sha7>.`, nothing sent. This happens when two CI jobs finish out of order |
  | not in this clone | `CONFLICT`: fetch the full history (in CI, `fetch-depth: 0`), or pass `--force` after a force-push |
  | on another line of history | `CONFLICT`: if the default branch was force-pushed, rerun with `--force` |

  `--force` skips these checks, so it can also sync an older commit; use it only after a force-push. The `adr.synced` Event records that the sync was forced.
- **Two phases.** First the CLI uploads the content of each file the copy does not have yet, in batches. Then it sends the manifest: the commit, the commit it expects hive-mind to have synced last, and each file's name and sha256. hive-mind applies the manifest in one transaction: it updates the copy, marks ADRs missing from the commit `removed` (never deleted), moves the number counter past the highest synced number and writes one `adr.synced` Event. If another sync finished in between, it answers `CONFLICT`, and the CLI reads the copy once more (it never retries the sync): a copy now at this commit with the same files is `Already synced at commit <sha7>.` and a copy at a descendant (without `--force`) is `Already synced past this commit: …`, both exit 0. Otherwise the `CONFLICT` stands (exit 2) with the hint to run `adr sync` again. If the copy already holds this commit with different files (for example synced from another ADR directory), the hint says so: neither a rerun nor `--force` replaces a synced commit, so sync a later commit. An interrupted sync applies nothing, and a rerun uploads only what is still missing.
- **A file that takes a reserved number.** If a file that bypassed `adr new` uses a number reserved for another ADR, the file keeps the number. The sync prints a warning, and `adr show` and the dashboard say the reserved ADR needs a new number: reserve one for it with `adr new`.
- **`--dry-run`** reads the copy and prints the changes the sync would make, then `Nothing was sent.` It needs a credential and runs the same checks.
- **`--check`** parses the working tree's `docs/adr/` instead of a commit, makes no server call and needs no credential or `.hivemind.json`. It cannot be combined with `--ref`, `--force` or `--dry-run`. See [Checking ADRs in pull requests](#checking-adrs-in-pull-requests).

Human output of a sync:

```text
Synced commit 3f2a9c1 (was 8e7d6c5): 1 added, 1 updated, 0 removed, 15 unchanged.
  ADR-0017 added (proposed)
  ADR-0004 updated (accepted -> superseded)
```

`(first sync)` replaces `(was …)` on the first sync, and `(forced)` follows it with `--force`. In `--json` `data`, `outcome` is `synced`, `up_to_date`, `already_synced_past`, `dry_run` or `checked`; `changes` lists `{ number, change, path, statusFrom, statusTo }` with `change` one of `added`, `updated`, `removed` and `restored` (`added` counts both `added` and `restored`); `warnings.items` lists at most 500 `{ number, path, code, message }`, and `complete` is false when there were more.

### Syncing from CI

Sync from a workflow that runs on every push to the default branch, with a Project key as `HIVEMIND_TOKEN`:

1. Commit `.hivemind.json` (`hivemind init`).
2. As an organization owner, create a Project key: `hivemind key create --name adr-sync > key.txt`. It holds `adr:read` and `adr:write`.
3. Add the key as a repository secret, for example `HIVEMIND_ADR_SYNC_TOKEN`, then delete `key.txt`.
4. Add `.github/workflows/adr-sync.yml`:

```yaml
name: ADR sync

on:
  push:
    branches: [main]          # the default branch
    paths: ["docs/adr/**"]

# One sync at a time. A newer push replaces a waiting one, and its commit
# contains the older one's.
concurrency:
  group: adr-sync
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  adr-sync:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0      # the ancestry check needs the history
          persist-credentials: false

      - name: Install hivemind
        run: |
          curl -fsSL https://github.com/CuriouslyCory/hive-mind/releases/latest/download/install.sh | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: Sync ADRs
        run: hivemind adr sync --ref HEAD
        env:
          HIVEMIND_TOKEN: ${{ secrets.HIVEMIND_ADR_SYNC_TOKEN }}
```

- `--ref HEAD` is the pushed commit. `fetch-depth: 0` fetches the full history; with a shallow checkout the copy's commit is usually missing and the sync fails with `CONFLICT`.
- `paths` skips pushes that change no ADR. Every sync writes an `adr.synced` Event, even when no ADR changed, so without the filter each push adds one. Adjust the path if `.hivemind.json` is below the repository root.
- The `adr` commands need a CLI release later than 0.1.0. Pin one with `sh -s -- --version <v>` (see [Install script](#install-script)).
- The CLI talks to `https://hivemind.curiouslycory.com` unless `HIVEMIND_URL` is set in the step's `env`.
- Run the first sync by hand (`git fetch origin && hivemind adr sync`), or let the first push that changes an ADR do it.

### Checking ADRs in pull requests

`hivemind adr sync --check` parses the ADR files in the working tree with the same parser and checks the set: it fails with `ADR_INVALID` (exit 1) for an invalid file and `CONFLICT` (exit 2) for two files with one number, and prints warnings without failing. It needs no login, no secret and no `.hivemind.json`, so it also runs on pull requests from forks and in unbound repositories:

```yaml
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      # Install hivemind as in the sync workflow, then:
      - run: hivemind adr sync --check
```

```text
Checked 17 ADR files in docs/adr/: no errors, 0 warnings.
```

### ADR limits

| Limit | Value |
|---|---|
| ADR file | 64 KiB (65,536 bytes) of UTF-8, with no C0 control characters other than tab, LF and CR, and no DEL |
| Title | 200 characters |
| Slug | 100 characters |
| ADR numbers | 1 to 9999 |
| Files per sync | 1,000 |
| Upload request (`.../adrs/contents` and `.../adrs/sync`) | 256 KiB; every other `/api/v1` request stays at 16 KiB. The CLI splits uploads into requests of at most 50 files that fit |
| `supersedes` | 64 numbers per ADR |

A file over the size limit, or with a title over 200 characters, fails the parser, so `adr sync` and `adr sync --check` report it as `ADR_INVALID`. hive-mind checks the `supersedes` limit when the content is uploaded, and `adr sync` then fails with `ADR_INVALID` before anything is synced. A commit with more than 1,000 ADR files is refused with `BAD_REQUEST` (exit 1) before anything is uploaded.

## Command reference

Global options, accepted anywhere on the command line:

| Option | Meaning |
|---|---|
| `--json` | Print exactly one JSON object on stdout (see below) |
| `--server <origin>` | Backend origin (default: `HIVEMIND_URL`, then the built-in server) |
| `-h`, `--help` | Help for `hivemind` or for a command |
| `--version` | Version, build commit and target |

| Command | Options and arguments | `--json` `data` |
|---|---|---|
| `login` | none | `{ origin, credentialStore: "keychain" \| "libsecret" \| "file", user: { id, name, email } \| null, hivemindTokenSet }` |
| `logout` | none | `{ origin, removed, revoked: true \| null, hivemindTokenSet }` |
| `whoami` | none | the `/api/v1/me` principal: `{ kind: "user", user, organizations }` or `{ kind: "projectKey", keyId, organizationId, projectId, permissions }` |
| `init` | `--project <id>`, or `--name <name> --slug <slug> [--org <id>] [--repo-url <url>]`; `--replace` | `{ project, created, config: { path, status: "created" \| "unchanged" \| "replaced" } }` |
| `key create` | `--name <name>` (required), `--expires-in-days <days>`, `--project <id>` | `{ projectKey, secret }` |
| `key list` | `--project <id>` | `{ projectId, items, nextCursor }` |
| `key revoke <keyId>` | `--project <id>` | `{ id, projectId, revoked: true }` |

The coordination commands are listed in [Coordination commands](#coordination-commands), and the ADR commands in [ADR commands](#adr-commands).

`whoami` also shows the origin, where the credential came from and the bound Project, in human output only. `key list` fetches up to 2,000 keys; `nextCursor` is non-null if there are more.

Environment variables: `HIVEMIND_URL` (backend origin), `HIVEMIND_TOKEN` (credential; an empty value counts as unset), `HIVEMIND_SESSION` (the Session coordination commands act through, and that `adr new` and `adr sync` attribute their change to; an empty value counts as unset), `HIVEMIND_DEBUG=1` (print the redacted stack of an internal error).

## Output

Results go to stdout. Progress, prompts and warnings go to stderr. Terminal control characters in text from the server (C0 and C1 controls, DEL, U+2028/U+2029, bidi overrides and isolates) are always escaped: as visible escapes such as `\x1b` in human output, and as `\uXXXX` with `--json`, which parses back to the original text. Known tokens are redacted from errors, warnings and progress lines. Success output is not redacted, since `key create` prints its new key there on purpose.

### JSON (schema version 1)

With `--json`, stdout carries exactly one JSON object, for success and failure alike:

```json
{ "schemaVersion": 1, "command": "key create", "ok": true, "data": { } }
```

```json
{ "schemaVersion": 1, "command": "whoami", "ok": false, "error": { "code": "UNAUTHORIZED", "message": "..." } }
```

- `command` is the command path, such as `whoami` or `key create`. `--version` reports `version`, `--help` reports `help` (with the text in `data.text`), and an error before a command is recognized reports `hivemind`.
- `error.code` is stable; `error.message` is for people and includes the hint shown in human output.
- The schemas are in `packages/contract/src/output.ts`, with golden examples in `packages/contract/test/fixtures/v1/`.

### Exit codes

| Exit | Meaning | Error codes |
|---|---|---|
| 0 | success | |
| 1 | any other failure | `BAD_REQUEST`, `PAYLOAD_TOO_LARGE`, `INTERNAL_SERVER_ERROR`, `USAGE_ERROR`, `INVALID_SERVER`, `NETWORK_ERROR`, `TIMEOUT`, `UNEXPECTED_REDIRECT`, `INVALID_RESPONSE`, `CREDENTIAL_STORE_ERROR`, `IO_ERROR`, `CANCELLED`, `INTERNAL_ERROR`, `LOGIN_EXPIRED`, `LOGIN_FAILED`, `REVOCATION_FAILED`, `TERMINAL_REQUIRED`, `CONFIG_TOO_LARGE`, `CONFIG_INVALID_JSON`, `CONFIG_UNSUPPORTED_VERSION`, `CONFIG_INVALID`, `ADR_INVALID` |
| 2 | conflict | `CONFLICT` |
| 3 | not authenticated or not allowed | `UNAUTHORIZED`, `FORBIDDEN` |
| 4 | not found | `NOT_FOUND` |
| 130 | a second interrupt while a command is stopping | none: the process exits at once and prints no envelope |

The exit code always follows from `error.code`, and any code not listed here also exits 1. The first Ctrl+C (SIGINT) or SIGTERM cancels the command, which ends with `CANCELLED`. A second signal while the command is stopping exits 130 immediately. A repeat of the same signal within 500 ms of the first counts as the first one, because the npm launcher forwards the signal the terminal already sent to the binary; to force an exit, press Ctrl+C again after that.

### Timeouts and retries

- Each request to the server times out after 30 seconds (`TIMEOUT`). During `login`, the device-code request and each poll time out after 15 seconds.
- The CLI reads at most 4 MiB of a response. A larger answer fails with `INVALID_RESPONSE`.
- Only device-login polling is retried. After a timeout, a network error, a 429 or a 5xx answer, `login` prints a warning, waits (the polling interval doubled for each failure in a row, up to 60 seconds) and polls again until the code expires.
- No other request is retried. Creating a Project or a key is not idempotent, so a write that times out, loses its connection, is cancelled or gets an unreadable answer fails with a message saying that the server may still have completed it, and how to check. Coordination creates and `adr new` can be repeated safely with `--id`; see [Lost answers and retries](#lost-answers-and-retries).

## The API

The CLI calls the `/api/v1` HTTP API with `Authorization: Bearer <token>`. The API accepts only bearer tokens (a login token or a Project key), never cookies. Its OpenAPI document is served without authentication at `/api/v1/openapi.json`. Login and logout use better-auth's own routes under `/api/auth`. ADR-0009 and ADR-0013 record the design.

`GET /api/v1/projects/{id}/events/stream` is a Server-Sent Events stream of a Project's Events, bearer-only like the other routes. No CLI command uses it yet. [docs/dashboard.md](dashboard.md#the-stream) describes its start cursor (`cursor` query parameter or `Last-Event-ID`; none means tail from now, `feedOriginCursor` replays), its frames (`ready`, `event`, `heartbeat`, `access_lost`) and its 400, 401 and 404 answers before the stream opens.
