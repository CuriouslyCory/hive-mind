# The hivemind CLI

`hivemind` is the command-line client for hive-mind. In M1 it logs in to a hive-mind server, binds a repository to a Project, and manages Project keys. The coordination commands (plans, tasks, Sessions) come with M2.

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

`install.sh` is not listed in `SHA256SUMS`; it is the script that does the verifying. Binaries are not code-signed beyond Bun's ad-hoc macOS signature: there is no Developer ID signing or notarization yet.

### npm

The npm package name is `@curiouslycory/hivemind`. This name is pending the owner's confirmation and is not published yet.

```bash
npm install -g @curiouslycory/hivemind
hivemind --help
```

The package is a small Node launcher. The binary comes from one of five optional per-platform packages (`@curiouslycory/hivemind-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`), so npm's integrity check covers it and no install script runs. Do not install with `--omit=optional`: the launcher then reports that the platform package is missing.

### Check the install

```bash
hivemind --version
# hivemind 0.1.0 (<commit>, bun-linux-x64)
```

## Choosing the server

Every command talks to one backend origin, chosen in this order:

1. `--server <origin>`
2. `HIVEMIND_URL`
3. the built-in default, `https://hive-mind-web-mu.vercel.app`

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

- **Without a terminal** (stdin or stderr is not a TTY, as in CI or an agent's shell), `login` prints the URL and code and waits. It never reads stdin and never opens a browser.
- **Lifetime.** The login is a better-auth login session token with the server's default lifetime of 7 days. There is no refresh token: when it expires, commands exit 3 and you run `hivemind login` again.
- **Logging in again** replaces the stored login for that origin. The previous token is not revoked on the server; it stops working when it expires.
- **With `HIVEMIND_TOKEN` set**, `login` warns, stores the new login anyway, and `HIVEMIND_TOKEN` keeps taking precedence until you unset it.

## Credentials

### Which credential a command uses

1. `HIVEMIND_TOKEN`, when set and non-empty. Nothing else is read. If the server rejects it, the command exits 3; it never falls back to the stored login.
2. Otherwise, the stored login for the chosen origin.
3. Otherwise, the command exits 3 with `UNAUTHORIZED` ("not logged in").

`HIVEMIND_TOKEN` takes either a login token or a Project key. Agents and CI should use a Project key.

### Where a login is stored

| Platform | First choice | Fallback |
|---|---|---|
| macOS, in a terminal | Keychain (service `hivemind`, account = origin) | credentials file |
| Linux, in a terminal | Secret Service through `secret-tool` (Debian/Ubuntu package `libsecret-tools`), attributes `service hivemind` and `origin <origin>` | credentials file |
| Any platform, no terminal | credentials file only | none |

- **Fallback.** If the OS store is unavailable (for example no `secret-tool`, no Secret Service, no login collection or a locked collection) or `secret-tool` does not finish within 5 seconds, `login` stores the token in the credentials file and prints a warning saying so. If the OS store answers with any other error, `login` fails with `CREDENTIAL_STORE_ERROR` instead of putting the token somewhere you did not expect.
- **No terminal, file only.** Both OS stores can show an unlock or access dialog, so a run without a TTY never touches them. A login stored in the Keychain or Secret Service is therefore invisible to non-interactive runs; the error says where the login is. Use `HIVEMIND_TOKEN` in those environments.
- **The credentials file** is `$XDG_CONFIG_HOME/hivemind/credentials.json` when `XDG_CONFIG_HOME` is an absolute path, otherwise `~/.config/hivemind/credentials.json`. The directory is 0700 and the file 0600. The CLI refuses a symlinked file, a file or directory owned by another user, and (for reads) a file that group or others can read; `chmod 600` fixes the last case.
- **Layout.** The file has one entry per origin. An entry holds either the token itself or a pointer to the OS store that holds it (`{ "store": "keychain" }` or `{ "store": "libsecret" }`, no secret). Only the store the entry names is read, so a token left in another store is never used.

### Logging out

```bash
hivemind logout
```

`logout` deletes every local copy of the login for the origin (OS store and credentials file), then asks the server to revoke the token. If the server cannot be reached or refuses, the local copies are already gone and the command exits 1 with `REVOCATION_FAILED`, because the token may stay valid on the server until it expires. The same happens when a non-interactive run finds the login in an OS store it may not open: it removes the pointer and reports `REVOCATION_FAILED`. `logout` never changes or revokes `HIVEMIND_TOKEN`; to revoke a Project key, use `hivemind key revoke`.

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
hivemind init --name 'Hive Mind' --slug hive-mind     # create or reuse a Project
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

A Project key is an organization credential bound to one Project, for CI and headless agents. It can identify itself (`whoami`) and read and link its own Project. It cannot list organizations, create Projects or manage keys. A key belongs to the organization, not to the User who created it: it keeps working after that User leaves the organization, until it is revoked or expires.

Only organization owners can create, list and revoke keys, and only with a user login. The key commands act on the Project given by `--project <id>`, or else the one in the nearest `.hivemind.json`; with neither they fail with `USAGE_ERROR`.

```bash
hivemind key create --name ci --expires-in-days 90 > key.txt
hivemind key list
hivemind key revoke <keyId>
```

- **`key create`** prints the secret exactly once, on stdout (as `data.secret` with `--json`). It cannot be shown again. Details and the warning go to stderr, so redirecting stdout captures only the secret. Store it right away, for example as a `HIVEMIND_TOKEN` CI secret. `--expires-in-days` takes 1 to 365; without it the key never expires. Creation is never retried: if the command times out or loses the connection after sending the request, the key may exist anyway, so check `key list` and revoke keys you cannot use.
- **`key list`** shows the Project's enabled, unexpired keys: id, name, creation time and expiry. Secrets are never listed.
- **`key revoke <keyId>`** deletes the key at once. Requests with it then exit 3. An unknown or already revoked key is `NOT_FOUND` (exit 4).

Using a key:

```bash
HIVEMIND_TOKEN="$(cat key.txt)" hivemind whoami
```

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

`whoami` also shows the origin, where the credential came from and the bound Project, in human output only. `key list` fetches up to 2,000 keys; `nextCursor` is non-null if there are more.

Environment variables: `HIVEMIND_URL` (backend origin), `HIVEMIND_TOKEN` (credential), `HIVEMIND_DEBUG=1` (print the redacted stack of an internal error).

## Output

Results go to stdout. Progress, prompts and warnings go to stderr. Text from the server is printed with terminal control characters escaped, and known tokens are redacted from all output.

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
| 1 | any other failure | `BAD_REQUEST`, `PAYLOAD_TOO_LARGE`, `INTERNAL_SERVER_ERROR`, `USAGE_ERROR`, `INVALID_SERVER`, `NETWORK_ERROR`, `TIMEOUT`, `UNEXPECTED_REDIRECT`, `INVALID_RESPONSE`, `CREDENTIAL_STORE_ERROR`, `IO_ERROR`, `CANCELLED`, `INTERNAL_ERROR`, `LOGIN_EXPIRED`, `LOGIN_FAILED`, `REVOCATION_FAILED`, `CONFIG_*` |
| 2 | conflict | `CONFLICT` |
| 3 | not authenticated or not allowed | `UNAUTHORIZED`, `FORBIDDEN` |
| 4 | not found | `NOT_FOUND` |

The exit code always follows from `error.code`. A second Ctrl+C while a command is stopping exits 130 immediately. The CLI never retries a request on its own; a timed-out or cancelled write says that the server may still have completed it.

## The API

The CLI calls the `/api/v1` HTTP API with `Authorization: Bearer <token>`. The API accepts only bearer tokens (a login token or a Project key), never cookies. Its OpenAPI document is served without authentication at `/api/v1/openapi.json`. Login and logout use better-auth's own routes under `/api/auth`. ADR-0009 and ADR-0013 record the design.
