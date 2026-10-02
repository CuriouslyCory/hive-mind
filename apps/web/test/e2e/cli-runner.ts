import { execFileSync, spawn } from "node:child_process";
import { expect } from "@playwright/test";

// Runs the compiled CLI without a TTY (pipes on all three streams) and keeps
// a transcript of everything it printed, so a spec can check it for secrets.

export interface CliResult {
  argv: string[];
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CliCall {
  cwd: string;
  /** Added to the runner's base environment. */
  env?: Record<string, string | undefined>;
  /** The `--server` origin. */
  server: string;
}

export function cliRunner(binary: string, baseEnv: NodeJS.ProcessEnv) {
  const transcript: CliResult[] = [];

  function start(argv: string[], call: CliCall) {
    const fullArgv = [...argv, "--server", call.server];
    const child = spawn(binary, fullArgv, {
      cwd: call.cwd,
      env: { ...baseEnv, ...call.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result: CliResult = { argv: fullArgv, status: null, stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => {
      result.stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      result.stderr += chunk;
    });
    const done = new Promise<CliResult>((resolve) =>
      child.on("close", (status) => {
        result.status = status;
        transcript.push(result);
        resolve(result);
      }),
    );
    return { child, result, done };
  }

  /** Runs to completion with stdin closed at once. */
  function run(argv: string[], call: CliCall): Promise<CliResult> {
    const { child, done } = start(argv, call);
    child.stdin.end();
    return done;
  }

  return { start, run, transcript };
}

export interface Envelope<T = Record<string, unknown>> {
  schemaVersion: number;
  command: string;
  ok: boolean;
  data: T;
  error?: { code: string; message: string };
}

/** The single JSON envelope on stdout. */
export function envelope<T = Record<string, unknown>>(result: CliResult): Envelope<T> {
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines, describe(result)).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Envelope<T>;
}

/** The successful envelope's data; fails with the CLI's output otherwise. */
export function okData<T = Record<string, unknown>>(result: CliResult): T {
  expect(result.status, describe(result)).toBe(0);
  const parsed = envelope<T>(result);
  expect(parsed.ok, describe(result)).toBe(true);
  return parsed.data;
}

/** The failed envelope's error, after checking the exit code. */
export function failure(result: CliResult, exitCode: number): { code: string; message: string } {
  expect(result.status, describe(result)).toBe(exitCode);
  const parsed = envelope(result);
  expect(parsed.ok, describe(result)).toBe(false);
  return parsed.error as { code: string; message: string };
}

export function describe(result: CliResult): string {
  return `hivemind ${result.argv.join(" ")}\nexit: ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
}

export function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}
