---
status: proposed
date: 2026-09-29
---

# CLI as bun build --compile binaries, released via Changesets and GitHub Actions

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) specifies a TypeScript CLI, `hivemind`, compiled to standalone binaries with `bun build --compile`: it shares the contract package with the server, starts fast, needs no Node install, and cross-compiles to linux/darwin × x64/arm64. Releases use Changesets, and GitHub Actions builds the binaries on tag. Install paths are a `curl | sh` script that downloads from GitHub Releases, an npm package for `npx hivemind`, and later a Homebrew tap. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) assigns `apps/cli`, Changesets and the release workflow to M1. M0 builds none of it, so this ADR is proposed.

## Decision

Proposed, owned by M1:

- `apps/cli` is TypeScript, compiled with `bun build --compile` into binaries for linux-x64, linux-arm64, darwin-x64 and darwin-arm64. The binary is named `hivemind`, not `hive`, which collides with Apache Hive's CLI.
- Changesets manages versions and changelogs. A GitHub Actions workflow builds the binaries on a release tag and uploads them to GitHub Releases.
- The CLI's npm package name is unresolved. The `@hive-mind` npm org belongs to a third party that publishes `@hive-mind/cli`, and unscoped `hivemind` is taken. M1 decides, for example by claiming the `@hivemind` scope.

## Consequences

- Bun enters the toolchain only to build the CLI; the rest of the repo stays on Node 24 and pnpm (ADR-0002). M1 must pin the Bun version and decide whether CLI tests run under Vitest on Node or under Bun.
- The auth base path `/api/auth` and cookie prefix `hivemind` (ADR-0006) and the `/api/v1` contract (ADR-0009) become compatibility promises once binaries are released.
- M1 must decide:
  - the npm package name;
  - whether the credential store (macOS Keychain or libsecret, with a file fallback) works inside a compiled Bun binary;
  - how the npm package delivers the platform binary;
  - signing or checksums for the install script's downloads.
- Windows is out of scope for v1 (#1).
- M1 accepts this ADR, amends it, or supersedes it.
