import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_ROOT } from "../scripts/build.ts";

// `release.sh npm-publish` against a fake npm on PATH. Like the real one, the
// fake takes the nearest directory above its working directory that has a
// package.json as the project and fails if that manifest has devEngines, as
// the repository root's does (EBADDEVENGINES). The tarballs sit in dist/npm
// under such a root, where the release workflow downloads them.

const RELEASE_SH = join(CLI_ROOT, "scripts", "release.sh");

const FAKE_NPM = `#!/usr/bin/env bash
set -euo pipefail
dir="$PWD"
while [ "$dir" != / ]; do
  if [ -f "$dir/package.json" ]; then
    if grep -q devEngines "$dir/package.json"; then
      echo "npm error code EBADDEVENGINES ($dir/package.json)" >&2
      exit 1
    fi
    break
  fi
  dir="$(dirname "$dir")"
done
echo "$*" >>"$FAKE_NPM_LOG"
case "$1" in
  view)
    line="$(grep -F "$2 " "$FAKE_NPM_REGISTRY" || true)"
    if [ -z "$line" ]; then echo "npm error code E404" >&2; exit 1; fi
    echo "\${line#* }"
    ;;
  publish)
    [ -f "$2" ] || { echo "no such tarball: $2" >&2; exit 1; }
    ;;
esac
`;

let root: string;
let distNpm: string;
let registry: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hivemind-release-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), FAKE_NPM);
  chmodSync(join(bin, "npm"), 0o755);

  const repo = join(root, "repo");
  distNpm = join(repo, "dist", "npm");
  mkdirSync(distNpm, { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"devEngines":{"packageManager":{"name":"pnpm"}}}');
  const packages = [
    { name: "@scope/pkg-linux-x64", file: "scope-pkg-linux-x64-1.2.3.tgz", integrity: "sha512-a" },
    { name: "@scope/pkg", file: "scope-pkg-1.2.3.tgz", integrity: "sha512-b" },
  ].map((pkg) => ({ ...pkg, version: "1.2.3" }));
  for (const { file } of packages) writeFileSync(join(distNpm, file), "tarball");
  writeFileSync(join(distNpm, "npm-packages.json"), JSON.stringify(packages));

  registry = join(root, "registry");
  log = join(root, "npm.log");
  writeFileSync(registry, "");
  writeFileSync(log, "");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function npmPublish(cwd: string) {
  return spawnSync("bash", [RELEASE_SH, "npm-publish", distNpm], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "owner/repo",
      FAKE_NPM_LOG: log,
      FAKE_NPM_REGISTRY: registry,
    },
  });
}

describe("release.sh npm-publish", () => {
  it("runs npm outside the repository and publishes by absolute path, launcher last", () => {
    // Started inside the repository, as from a step without working-directory.
    const result = npmPublish(distNpm);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "view @scope/pkg-linux-x64@1.2.3 dist.integrity",
      `publish ${distNpm}/scope-pkg-linux-x64-1.2.3.tgz --access public`,
      "view @scope/pkg@1.2.3 dist.integrity",
      `publish ${distNpm}/scope-pkg-1.2.3.tgz --access public`,
    ]);
  });

  it("skips an identical version and refuses a different one", () => {
    writeFileSync(registry, "@scope/pkg-linux-x64@1.2.3 sha512-a\n@scope/pkg@1.2.3 sha512-other\n");
    const result = npmPublish(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("@scope/pkg-linux-x64@1.2.3: already published, identical");
    expect(result.stderr).toContain(
      "@scope/pkg@1.2.3 is already on the registry with different contents",
    );
    expect(readFileSync(log, "utf8")).not.toContain("publish ");
  });
});
