#!/usr/bin/env node
// npm entry point for the hivemind CLI. The binary itself ships in one
// optional dependency per platform, `<this package's name>-<os>-<arch>`, which
// npm installs only where its os/cpu/libc fields match. This file finds that
// package, runs its binary with the same arguments and stdio, forwards
// termination signals to it, and ends the same way it did: the same exit code,
// or the same signal.
//
// Plain JavaScript with no dependencies so it runs on any supported Node
// without a build step. scripts/npm-packages.ts copies it into the package.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";

const SUPPORTED = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];

function fail(message) {
  process.stderr.write(`hivemind: ${message}\n`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const platform = `${process.platform}-${process.arch}`;
if (!SUPPORTED.includes(platform)) {
  fail(`no binary for ${platform}. Supported platforms: ${SUPPORTED.join(", ")}.`);
}

const platformPackage = `${manifest.name}-${platform}`;
let binary;
try {
  const platformManifestPath = createRequire(import.meta.url).resolve(
    `${platformPackage}/package.json`,
  );
  const platformManifest = JSON.parse(readFileSync(platformManifestPath, "utf8"));
  if (platformManifest.version !== manifest.version) {
    fail(
      `${platformPackage} is ${platformManifest.version} but ${manifest.name} is ${manifest.version}. Reinstall ${manifest.name}.`,
    );
  }
  binary = join(dirname(platformManifestPath), "bin", "hivemind");
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
  fail(
    `${platformPackage} is not installed. It is an optional dependency of ${manifest.name}: ` +
      "reinstall without --omit=optional or --no-optional, and do not reuse a lockfile made " +
      "without it. Linux builds need glibc; musl (Alpine) is not supported.",
  );
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// A terminal's Ctrl-C reaches both processes already; forwarding covers a
// signal sent to this process alone, such as `kill <pid>` from a supervisor.
const forward = (signal) => {
  child.kill(signal);
};
for (const signal of FORWARDED) process.on(signal, forward);

child.on("error", (error) => {
  fail(`could not run ${binary}: ${error.message}`);
});

child.on("exit", (code, signal) => {
  for (const name of FORWARDED) process.off(name, forward);
  if (signal === null) {
    process.exit(code ?? 1);
  }
  if (signal === "SIGILL" && platform === "linux-x64") {
    process.stderr.write("hivemind: the binary needs a CPU with AVX2 (x86-64-v3).\n");
  }
  // Re-raise so the caller sees the same signal; the exit code is the shell
  // convention in case the signal does not terminate this process.
  process.exitCode = 128 + (constants.signals[signal] ?? 0);
  process.kill(process.pid, signal);
});
