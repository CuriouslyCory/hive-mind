---
status: accepted
date: 2026-10-01
---

# Shared Zod contract exposed via oRPC

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) chooses Zod schemas in a shared package, exposed via oRPC, so the CLI and server share types and other clients can use a generated OpenAPI spec. The API is served from `/api/v1/*` route handlers in `apps/web`. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) assigned `packages/contract` and the `/api/v1` routes to M2. The M1 plan ([#3](https://github.com/CuriouslyCory/hive-mind/issues/3)) moved the contract and a minimal Project into M1, with the owner's approval, because the first CLI binaries need an API to call. M1 implemented it in [PR #9](https://github.com/CuriouslyCory/hive-mind/pull/9).

## Decision

- **`packages/contract`** (`@hivemind/contract`) holds the Zod 4 schemas and the oRPC contract router for every `/api/v1` route, the error codes, the `.hivemind.json` v1 format and the CLI's `--json` envelope. It depends only on `@orpc/contract` and `zod`; a test fails if it imports `@hivemind/db`, better-auth, Next or `apps/*`. As ADR-0002 requires, it is a private workspace that exports TypeScript source.
- **oRPC 1.15.4, pinned exactly.** All `@orpc/*` packages depend on each other at exact versions, so every one of them is in the pnpm catalog at the same exact version. 2.0 was beta only and is not used.
- **The prefix is one constant.** Contract paths exclude `/api/v1`; `API_BASE_PATH = "/api/v1"` is the single source for the server handler's prefix, the CLI client's base URL and the OpenAPI `servers` entry.
- **Plain HTTP and JSON.** `apps/web` serves the router with oRPC's `OpenAPIHandler` in `src/app/api/v1/[...path]/route.ts`. The CLI calls it with oRPC's `OpenAPILink` client. `/api/auth` stays better-auth's own protocol, outside the contract.
- **Bearer only.** `/api/v1` accepts `Authorization: Bearer <token>` (a login token or a Project key) and nothing else. Cookies are stripped before any lookup, and a request without credentials gets a JSON 401 before routing. A token the server cannot check, for example during a database failure, gets a 500, not a 401. How the token becomes a principal is ADR-0013.
- **Errors** use oRPC's error body `{ defined, code, status, message, data? }`. Each code has one HTTP status and one CLI exit code:

  | Code | HTTP | CLI exit |
  |---|---|---|
  | `BAD_REQUEST` | 400 | 1 |
  | `UNAUTHORIZED` | 401 | 3 |
  | `FORBIDDEN` | 403 | 3 |
  | `NOT_FOUND` | 404 | 4 |
  | `CONFLICT` | 409 | 2 |
  | `PAYLOAD_TOO_LARGE` | 413 | 1 |
  | `INTERNAL_SERVER_ERROR` | 500 | 1 |

  Codes follow oRPC's built-in names. CLI-local codes (network, usage, configuration, credential store) all exit 1. An inaccessible Project gets the same 404 as an absent one.
- **Strict schemas, lenient client.** Inputs and outputs are strict objects: an unknown input field is a 400, and a response with an undeclared field fails the server's output validation with a 500 instead of being sent. The CLI does not validate responses against the strict schemas; it reads only the fields it uses, so a field added to a response does not break installed CLIs. It reads at most 4 MiB of a response and treats a larger one as an invalid response.
- **Limits are part of the contract:** management bodies up to 16 KiB (413, checked before authentication), Project names and key names up to 120 characters, slugs up to 63, repository URLs up to 2048, pages up to 100 items (50 by default) with opaque keyset cursors.
- **OpenAPI is generated, served and not committed.** `GET /api/v1/openapi.json` returns the document generated from the contract, without authentication. No copy is checked in.
- **Golden v1 fixtures are the compatibility check.** `packages/contract/test/fixtures/v1/` pins the route table (method, path, success status), the error table, the `/me` principals, a Project, key output, `.hivemind.json` and the CLI's JSON envelopes for `whoami`, `login`, `logout`, `init`, the three `key` commands and two errors. Tests compare the generated OpenAPI document and the live handler's statuses with the route fixture. A CLI test runs the compiled binary through `login`, `init`, the `key` commands and `logout` and requires each fixture field with the same JSON type (an added field passes), and the release smoke test compares the compiled CLI's `whoami --json` output with its fixture byte for byte.

## Consequences

- `/api/*` is excluded from the proxy (ADR-0003), so the `/api/v1` handler authenticates every request itself, and authorizes through Project → organization membership (ADR-0007, ADR-0013).
- The contract is a compatibility promise from the first CLI release: old binaries keep calling it. A change that requires editing a v1 fixture breaks released CLIs, and review sees it as a fixture diff. M1 did not decide how an incompatible change would ship.
- Upgrading oRPC means moving all six `@orpc/*` catalog entries together.
- Output validation is what keeps key secrets out of key list and revoke responses: a server change that leaked a field would fail with a 500. Contract tests check that the key metadata and list schemas reject secret fields.
- `POST /projects` is create-or-reuse and returns 200 with `{ project, created }` in both cases, since oRPC's success status is static. `DELETE /projects/{id}/keys/{keyId}` returns 200 with JSON so the CLI has a result to print; repeating it is a 404.
- Without a committed OpenAPI file, drift shows up as failing tests rather than as a diff. Other clients fetch the document from a deployment.
- If the dashboard (M3) calls `/api/v1`, it needs cookie support with CSRF and Origin checks for mutations; M1 has no browser caller.
- M2 adds its routes to this contract, with fixtures, and writes Events in its mutations. M1's routes write no Events.

## Alternatives considered

- **Committing the generated OpenAPI document** and diffing it in CI: a second copy of what the contract and fixtures already define. The route fixture plus the document and live-status tests catch the same drift.
- **oRPC's RPC protocol (`RPCLink`)** instead of the OpenAPI handler: the issue asks for standard HTTP endpoints that other clients can call from the OpenAPI document.
