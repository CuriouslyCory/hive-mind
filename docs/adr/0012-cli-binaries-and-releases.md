---
status: accepted
date: 2026-10-01
---

# CLI as bun build --compile binaries, released via Changesets and GitHub Actions

## Context

[#1](https://github.com/CuriouslyCory/hive-mind/issues/1) specifies a TypeScript CLI, `hivemind`, compiled to standalone binaries with `bun build --compile`: it shares the contract package with the server, starts fast, needs no Node install, and cross-compiles to linux/darwin × x64/arm64. Releases use Changesets, and GitHub Actions builds the binaries. Install paths are a `curl | sh` script that downloads from GitHub Releases, an npm package for `npx hivemind`, and later a Homebrew tap. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2)) assigned `apps/cli`, Changesets and the release workflow to M1. M1 ([#3](https://github.com/CuriouslyCory/hive-mind/issues/3)) implemented them in [PR #9](https://github.com/CuriouslyCory/hive-mind/pull/9). No release has been published yet; the owner-only prerequisites are in `docs/setup.md` (H7).

## Decision

- **Binary.** `apps/cli` is TypeScript, compiled with `bun build --compile` into binaries for linux-x64, linux-arm64, darwin-x64 and darwin-arm64. The binary is named `hivemind`, not `hive`, which collides with Apache Hive's CLI.
- **Bun 1.4.2 is an exact devDependency** of `apps/cli` (the npm `bun` package, with its postinstall disabled). `scripts/build.ts` runs the lockfile-pinned `@oven/bun-<os>-<arch>` runtime directly, so `pnpm build` works without a global Bun and CI needs no `setup-bun`.
- **Per-target native builds.** Root `pnpm build` compiles only the host target. `.github/workflows/cli-native.yml` builds each target on its own runner (`ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15-intel`, `macos-15`) and smoke-tests the binary there, with no Node or Bun on `PATH`. The release workflow reuses it.
- **Build hardening.** The binaries never auto-load `.env`, `bunfig.toml`, `tsconfig.json` or `package.json` from the working directory. The build gets no runtime environment; the version, commit and default origin are build-time constants, and the commit is passed explicitly, never read from git.
- **Minimum platforms**, measured from the pinned runtimes: macOS 13, glibc 2.17, and AVX2 on Linux x64 (no baseline build). No musl and no Windows.
- **Credential stores inside the binary.** The macOS Keychain is reached through `@napi-rs/keyring`'s Node-API addon, embedded per Darwin target and extracted to a private directory. Linux uses Secret Service through the `secret-tool` subprocess. Both fall back to a 0600 file, and a run without a TTY uses only the file. `docs/cli.md` has the details.
- **Versions and releases.** Changesets versions the private `@hivemind/cli` package (`privatePackages: { version: true, tag: true }`); a human runs `pnpm version-packages` and merges the result. A push to `main` that changes `apps/cli/package.json` starts `.github/workflows/release.yml`: it builds the four targets, drafts a GitHub release with four `.tar.gz` archives, `SHA256SUMS` and `install.sh`, and then a publish job in the `release` environment publishes the draft (which creates the `v<version>` tag) and the npm packages. The publish job refuses to run unless the environment has required reviewers. A manual run defaults to a rehearsal that drafts a prerelease and publishes nothing.
- **Installer checksums.** `scripts/install.sh` downloads the archive and `SHA256SUMS` from the same release, verifies the SHA-256, runs the new binary to check its version, and only then replaces the installed one atomically.
- **No code signing yet.** Darwin binaries carry only Bun's ad-hoc signature. There is no Developer ID signing, no notarization and no signature over `SHA256SUMS`.
- **npm: per-platform optional packages.** The launcher package `@curiouslycory/hivemind` is a small Node script that runs the binary from one of four optional per-platform packages (`<name>-linux-x64` and so on), forwarding arguments, signals and the exit code. No install script runs and nothing is downloaded on first run. The name is defined only in `apps/cli/npm/package.template.json` and is pending the owner's confirmation of the `@curiouslycory` scope. Publishing uses npm trusted publishing, with provenance once the repository is public.

## Consequences

- Bun enters the toolchain only to build the CLI; the rest of the repo stays on Node 24 and pnpm (ADR-0002). CLI logic tests run under Vitest on Node, and runtime behavior is tested by running the compiled binary from Vitest.
- The auth base path `/api/auth` and cookie prefix `hivemind` (ADR-0006) and the `/api/v1` contract (ADR-0009) are compatibility promises from the first release.
- A binary is 63–81 MB. A rebuild of the same commit produces byte-identical archives, so a rerun of the release workflow compares existing assets and npm versions instead of replacing them.
- `SHA256SUMS` comes from the same release as the archives, so it detects corrupted or partial downloads, not a compromised release or GitHub account.
- Without Developer ID signing, the Keychain's access list is bound to each build's ad-hoc signature, so an upgraded binary may ask for Keychain access again in a terminal. Revisit signing if an install path quarantines the binary.
- Every release publishes five npm packages, each needing its own trusted publisher. npm's integrity check covers the binary, and the npm path works while the GitHub repository is private.
- The repository is private: the arm64 Linux and macOS runners need the owner to confirm availability and billing, and the curl installer only works for other people once the releases are public.
- The CLI's Vitest suite runs on Linux only; macOS and arm64 runners run the smoke test.
- Users on Linux x64 without AVX2 cannot run the CLI. Revisit a baseline build if anyone reports it.
- Windows is out of scope for v1 (#1). Homebrew remains a later install path.

## Alternatives considered

- **Cross-compiling every target on one runner:** it needed workspace-wide `supportedArchitectures`, which made every install (CI included) about 1.7 GB, and the binaries would still need native runners to be tested.
- **A launcher that downloads the binary on first run or in a postinstall script:** it bypasses npm's integrity check, fails offline and behind mirrors, needs public GitHub releases, and package managers may block install scripts.
- **A baseline (non-AVX2) Linux x64 build:** it would add about 95 MB to every Linux x64 install.
- **The Node-API keyring addon on Linux too:** its Secret Service path can hang without a way to cancel it, and its default store silently falls back to the non-persistent kernel keyring.
- **Building on a tag push:** a tag pushed by the workflow's `GITHUB_TOKEN` does not start another workflow, so the release runs in one workflow and creates the tag when it publishes the draft.
