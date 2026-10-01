import { type SpawnSyncOptions, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLI_ROOT } from "../../scripts/build.ts";

/** The binary `pnpm build` produces for the host; Turborepo builds it before `test`. */
export const SHIPPED_BINARY = join(CLI_ROOT, "dist", "hivemind");

/** The test/native/probe.ts harness, compiled for the host by test/global-setup.ts. */
export const PROBE_BINARY = join(CLI_ROOT, "dist", "test", "probe");

export function shippedBinary(): string {
  if (!existsSync(SHIPPED_BINARY)) {
    throw new Error(
      `${SHIPPED_BINARY} is missing. Run 'pnpm --filter @hivemind/cli build' (pnpm test does this).`,
    );
  }
  return SHIPPED_BINARY;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a compiled binary with a minimal environment (no Node or Bun on PATH
 * is needed; /usr/bin and /bin stay for the fake secret-tool's shell).
 */
export function run(
  binary: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string; timeout?: number } = {},
): RunResult {
  const spawnOptions: SpawnSyncOptions = {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout ?? 20_000,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, ...options.env },
  };
  const result = spawnSync(binary, args, spawnOptions);
  if (result.error) throw result.error;
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

/**
 * Async variant of `run`, for tests whose fixtures (an HTTP server) live in the
 * test process and would be starved by spawnSync blocking the event loop.
 */
export function runAsync(
  binary: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 20_000,
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

/** Parses the single JSON line a probe command prints. */
export function json(result: RunResult): unknown {
  const lines = result.stdout.trim().split("\n");
  if (lines.length !== 1 || !lines[0]) {
    throw new Error(`expected one JSON line, got:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(lines[0]);
}
