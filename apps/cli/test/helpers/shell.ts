import { PassThrough, Readable } from "node:stream";
import { type CliRuntime, runCli } from "../../src/cli.ts";
import type { CommandDefinition } from "../../src/command.ts";
import { TEST_COMMANDS } from "../fixtures/test-commands.ts";

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

function collector(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

/**
 * Runs the shell in-process with captured streams. Defaults: non-interactive,
 * an empty environment (no HIVEMIND_* from the developer's shell), the test
 * commands, and cwd = process.cwd().
 */
export async function runShell(
  argv: readonly string[],
  options: Partial<Omit<CliRuntime, "argv" | "stdout" | "stderr">> & {
    commands?: readonly CommandDefinition[];
  } = {},
): Promise<ShellResult> {
  const stdout = collector();
  const stderr = collector();
  const code = await runCli(
    {
      argv,
      env: options.env ?? {},
      cwd: options.cwd ?? process.cwd(),
      platform: options.platform ?? process.platform,
      stdin: options.stdin ?? Readable.from([]),
      stdout: stdout.stream,
      stderr: stderr.stream,
      interactive: options.interactive ?? false,
      signal: options.signal,
      fetch: options.fetch,
      credentialOptions: options.credentialOptions,
      clock: options.clock,
      openUrl: options.openUrl,
    },
    options.commands ?? TEST_COMMANDS,
  );
  // Let the PassThrough deliver what was written.
  await new Promise((resolve) => setImmediate(resolve));
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** Parses stdout as exactly one JSON line. */
export function onlyJsonLine(stdout: string): unknown {
  const lines = stdout.split("\n");
  if (lines.length !== 2 || lines[1] !== "" || !lines[0])
    throw new Error(`expected one JSON line, got: ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}
