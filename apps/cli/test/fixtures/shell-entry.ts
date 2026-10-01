import { runCli } from "../../src/cli.ts";
import { TEST_COMMANDS } from "./test-commands.ts";

// The shipped shell (src/cli.ts) with the test commands, compiled by
// test/global-setup.ts into dist/test/shell so subprocess tests can check
// stdout/stderr/exit codes of a real binary. Mirrors src/index.ts.
const interrupt = new AbortController();
process.on("SIGINT", () => interrupt.abort());

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
  TEST_COMMANDS,
);
