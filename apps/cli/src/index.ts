import { BUILD_COMMIT, BUILD_TARGET, BUILD_VERSION, DEFAULT_ORIGIN } from "./build-info.ts";

// Placeholder entrypoint from the M1 spike: only --version and --help. The
// command shell (login, whoami, init, key, JSON output, exit codes) replaces
// this file in cli-core; keep it free of logic worth preserving.

const HELP = `hivemind - command-line client for Hive Mind

Usage:
  hivemind [--version | --help]

Options:
  --version   Print the version, build commit and target
  -h, --help  Show this help

Default server: ${DEFAULT_ORIGIN}
`;

export function main(argv: readonly string[]): number {
  const [arg, ...rest] = argv;
  if (rest.length === 0 && arg === "--version") {
    process.stdout.write(`hivemind ${BUILD_VERSION} (${BUILD_COMMIT}, ${BUILD_TARGET})\n`);
    return 0;
  }
  if (arg === undefined || (rest.length === 0 && (arg === "--help" || arg === "-h"))) {
    process.stdout.write(HELP);
    return 0;
  }
  // Arguments are not echoed back: a mistyped command line may contain a token.
  process.stderr.write("hivemind: unknown command or option. Run 'hivemind --help'.\n");
  return 1;
}

process.exitCode = main(process.argv.slice(2));
