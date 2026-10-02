# The hivemind CLI

`hivemind` is the command-line client for hive-mind. It logs in to a hive-mind server, binds a repository to a Project and manages Project keys (M1), and records Plans, Tasks, Sessions and Scopes for the agents working in that Project (M2, see [Coordination](#coordination-plans-tasks-sessions-and-scopes)).

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

The first public release has not been published yet. Until it is, neither install path below works. The curl installer also needs the GitHub repository's releases to be public.

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

The npm package name is `@curiouslycory/hivemind`. This name is pending the owner's confirmation and is not published yet.

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

A Project key is an organization credential bound to one Project, for CI and headless agents. It can identify itself (`whoami`), read and link its own Project, and use every coordination command in that Project: each key holds all coordination permissions, including keys created before M2 (ADR-0014). It cannot list organizations, create Projects or manage keys. A key belongs to the organization, not to the User who created it: it keeps working after that User leaves the organization, until it is revoked or expires.

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
- **Optional attribution** on `plan create`, `plan edit`, `plan status`, `plan log --message` and `task add`: when a Session is set, the Event names it as the actor Session. It must then be one of your Sessions and not ended or abandoned, so unset `HIVEMIND_SESSION` after `session end`; otherwise these commands fail with `CONFLICT` (exit 2).
- `status` uses the Session only to fill `myClaims`. `session show` and `session log` take the Session as an argument or from these two sources.

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
- In a `done` or `abandoned` Plan, `plan log --message` still works; `plan edit` and `task add` are `CONFLICT`.
- `plan log <plan>` without `--message` lists the Plan's Events, log entries included, newest first. A Session attached to the Plan when it ends adds its `session end` summary there too.

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

- **`--steal`** takes over a claim that another live Session holds. Use it only when you know the holder has stopped working on the Task, for example after asking its owner. A holder that stopped heartbeating does not need it: its claim becomes claimable when the lease expires or the Session goes stale. The takeover is recorded as a `task.claimed` Event naming the former holder, `data.stolenFromSessionId` is set, and stderr says `Took the claim over from Session <id>`. From then on the former holder's heartbeats, releases, starts, blocks and dones cannot change the new claim.

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
| `session list [--status <s>]` | newest Session first; `<s>` is `live`, `terminal`, `active`, `idle`, `stale`, `ended` or `abandoned` |
| `scope list` | oldest Scope first |

`session show` and `status` return only the first page or the first 20 entries of each section; `nextCursor` and `complete` say whether more exist. Page through a Session's older Events with `session log <sessionId> --cursor <events.nextCursor>` and its Scopes with `scope list --session <sessionId> --cursor <scopes.nextCursor>`; `session show` prints these commands when more exist.

### Text input

- Markdown and reasons come from a flag or a file: `--body`/`--body-file`, `--message`/`--message-file`, `--summary`/`--summary-file`, `--reason`/`--reason-file`. Giving both flags of a pair is `USAGE_ERROR`.
- `--<name>-file -` reads stdin. stdin is read only then; no command opens an editor or prompts. `--body -` is the literal text `-`.
- The text must be valid UTF-8, not blank, at most 8 KiB (8,192 bytes), with no control characters other than tab, CR and LF. Anything else is `USAGE_ERROR` before any request. A file that cannot be read is `IO_ERROR` (exit 1); the message does not repeat the path.
- Titles and agent names are at most 120 characters; an intent is one line of at most 2,048 characters. A request body over 16 KiB is `PAYLOAD_TOO_LARGE` (exit 1).

### Lost answers and retries

The CLI never retries a write. `plan create`, `plan log --message`, `task add` and `session start` generate the new record's UUID once per run. Unless the server rejected the request with a documented 4xx code (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`) or the CLI stopped before sending it, the record may exist anyway. That covers a timeout, a lost connection, a cancel, an unreadable answer and any 5xx: a gateway timeout or a failed output check can come after the server committed. The error says so and names the generated id (on stderr in `--json` mode too):

```text
The Plan may have been created anyway with id 6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b. Check with 'hivemind plan show 6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b' before retrying, and retry only with --id 6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b.
```

- Inspect first, with the command the message names.
- If the record is missing, rerun the same command with `--id <id>`. If the first request did arrive, the server returns that record with `created: false` and writes no second Event, even if the record was edited since.
- `--id` with different input is `CONFLICT`. For `session start` the input includes the hostname and the git branch and commit, so retry from the same worktree before committing.

The other writes are safe to repeat once you have checked the state: a repeat of `task claim`, `start`, `block` (same reason), `done` or `release`, `scope add`, `plan status` or `session end` (same summary) is a no-op.

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
| `session log [sessionId]` | `--limit`, `--cursor` | `{ items, nextCursor }` of the Session's Events |
| `scope add <pattern>` | Session | `{ scope, created }` |
| `scope remove <scopeId>` | Session | `{ id, sessionId, removed }` |
| `scope list` | `--source declared\|touched`, `--limit`, `--cursor`, Session | `{ items, nextCursor }` of Scopes |
| `scope check` | `--cursor`, Session | `{ sessionId, items, nextCursor, complete, incompleteSessionIds }` |

The schemas of these `data` objects are the `/api/v1` output schemas in `packages/contract/src/` (`plan.ts`, `task.ts`, `session.ts`, `scope.ts`, `event.ts`, `status.ts`), with golden examples in `packages/contract/test/fixtures/v1/cli.*.json`. A Session's `status` is always its effective status at the time of the request. Event types and payloads are listed in `eventSchema` (`packages/contract/src/event.ts`).

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

The coordination commands are listed in [Coordination commands](#coordination-commands).

`whoami` also shows the origin, where the credential came from and the bound Project, in human output only. `key list` fetches up to 2,000 keys; `nextCursor` is non-null if there are more.

Environment variables: `HIVEMIND_URL` (backend origin), `HIVEMIND_TOKEN` (credential; an empty value counts as unset), `HIVEMIND_SESSION` (the Session coordination commands act through; an empty value counts as unset), `HIVEMIND_DEBUG=1` (print the redacted stack of an internal error).

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
| 1 | any other failure | `BAD_REQUEST`, `PAYLOAD_TOO_LARGE`, `INTERNAL_SERVER_ERROR`, `USAGE_ERROR`, `INVALID_SERVER`, `NETWORK_ERROR`, `TIMEOUT`, `UNEXPECTED_REDIRECT`, `INVALID_RESPONSE`, `CREDENTIAL_STORE_ERROR`, `IO_ERROR`, `CANCELLED`, `INTERNAL_ERROR`, `LOGIN_EXPIRED`, `LOGIN_FAILED`, `REVOCATION_FAILED`, `TERMINAL_REQUIRED`, `CONFIG_TOO_LARGE`, `CONFIG_INVALID_JSON`, `CONFIG_UNSUPPORTED_VERSION`, `CONFIG_INVALID` |
| 2 | conflict | `CONFLICT` |
| 3 | not authenticated or not allowed | `UNAUTHORIZED`, `FORBIDDEN` |
| 4 | not found | `NOT_FOUND` |
| 130 | a second interrupt while a command is stopping | none: the process exits at once and prints no envelope |

The exit code always follows from `error.code`, and any code not listed here also exits 1. The first Ctrl+C (SIGINT) or SIGTERM cancels the command, which ends with `CANCELLED`. A second signal while the command is stopping exits 130 immediately. A repeat of the same signal within 500 ms of the first counts as the first one, because the npm launcher forwards the signal the terminal already sent to the binary; to force an exit, press Ctrl+C again after that.

### Timeouts and retries

- Each request to the server times out after 30 seconds (`TIMEOUT`). During `login`, the device-code request and each poll time out after 15 seconds.
- The CLI reads at most 4 MiB of a response. A larger answer fails with `INVALID_RESPONSE`.
- Only device-login polling is retried. After a timeout, a network error, a 429 or a 5xx answer, `login` prints a warning, waits (the polling interval doubled for each failure in a row, up to 60 seconds) and polls again until the code expires.
- No other request is retried. Creating a Project or a key is not idempotent, so a write that times out, loses its connection, is cancelled or gets an unreadable answer fails with a message saying that the server may still have completed it, and how to check. Coordination creates can be repeated safely with `--id`; see [Lost answers and retries](#lost-answers-and-retries).

## The API

The CLI calls the `/api/v1` HTTP API with `Authorization: Bearer <token>`. The API accepts only bearer tokens (a login token or a Project key), never cookies. Its OpenAPI document is served without authentication at `/api/v1/openapi.json`. Login and logout use better-auth's own routes under `/api/auth`. ADR-0009 and ADR-0013 record the design.
