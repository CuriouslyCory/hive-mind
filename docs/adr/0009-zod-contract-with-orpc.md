---
status: proposed
date: 2026-09-29
---

# Shared Zod contract exposed via oRPC

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) chooses Zod schemas in a shared package, exposed via oRPC, so the CLI and server share types and other clients can use a generated OpenAPI spec. The API is served from `/api/v1/*` route handlers in `apps/web`. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) assigns `packages/contract` and the `/api/v1` routes to M2. M0 builds none of it, so this ADR is proposed.

## Decision

Proposed, owned by M2:

- `packages/contract` holds the Zod schemas and the oRPC router contract. `apps/web` implements the router under `/api/v1`; the CLI (M1 onward) uses the typed oRPC client; an OpenAPI spec is generated from the contract.
- `contract` must not import `@hivemind/db`. The same dependency rules as ADR-0002 apply: it is a private `@hivemind/*` workspace that exports TypeScript source.

## Consequences

- `/api/*` is excluded from the proxy (ADR-0003), so every `/api/v1` handler must authenticate the caller itself and answer 401, and must authorize through project → organization membership (ADR-0007).
- The contract becomes a compatibility promise once M1 ships CLI binaries, because old binaries keep calling it.
- M2 must decide:
  - the oRPC version, and confirm it works with Zod 4, which `apps/web` already uses;
  - how bearer auth from M1 (API keys, device-flow tokens) reaches oRPC handlers;
  - the error shape, and how it maps to the CLI's exit codes in #1 (`1` error, `2` conflict, `3` auth, `4` not found);
  - whether the generated OpenAPI spec is committed, and how `/api/v1` changes are versioned.
- M2 accepts this ADR, amends it, or supersedes it.
