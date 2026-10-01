import { runCli } from "./cli.ts";
import { COMMANDS } from "./commands/index.ts";

// Entrypoint of the compiled `hivemind` binary. Everything testable lives in
// cli.ts; this file only wires the real process to it.

// A closed pipe (`hivemind ... | head -1`) is not an error worth a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

// First SIGINT/SIGTERM asks the running command to stop (device polling,
// prompts and requests watch this signal); a second one exits at once.
const interrupt = new AbortController();
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => {
    if (interrupt.signal.aborted) process.exit(130);
    interrupt.abort(new Error(`received ${name}`));
  });
}

process.exitCode = await runCli(
  {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signal: interrupt.signal,
  },
  COMMANDS,
);
