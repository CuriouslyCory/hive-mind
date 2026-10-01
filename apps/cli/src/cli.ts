import { parseArgs } from "node:util";
import { EXIT_CODES, type ExitCode } from "@hivemind/contract";
import { BUILD_COMMIT, BUILD_TARGET, BUILD_VERSION, DEFAULT_ORIGIN } from "./build-info.ts";
import type { CommandContext, CommandDefinition, Env, OptionSpec } from "./command.ts";
import { isInteractive } from "./credentials/index.ts";
import {
  type CredentialManager,
  type CredentialManagerOptions,
  createCredentialManager,
} from "./credentials/manager.ts";
import { CLI_ERROR_CODES, CliError, isCliError, usageError } from "./errors.ts";
import { type ResolvedOrigin, resolveOrigin } from "./origin.ts";
import { createReporter, type OutputStream, writeError, writeSuccess } from "./output.ts";
import { createPrompter } from "./prompt.ts";
import { redact } from "./redact.ts";

/**
 * The command shell: global flags, command lookup, option parsing, help,
 * output mode and exit codes.
 *
 * Parsing uses `node:util`'s `parseArgs` (built into Node and Bun, so nothing
 * extra is bundled and startup stays fast) with a small dispatcher on top:
 * the leading non-option words select the command (`key create`), then the
 * remaining arguments are parsed strictly against the global flags plus that
 * command's options. Global flags may appear anywhere.
 *
 * User-supplied argument text is never echoed in errors unless it looks like
 * a command or option name: a mistyped command line can contain a token.
 */

export interface CliRuntime {
  argv: readonly string[];
  env: Env;
  cwd: string;
  platform: NodeJS.Platform;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: OutputStream;
  stderr: OutputStream & NodeJS.WritableStream;
  /** Aborted on SIGINT/SIGTERM by index.ts. */
  signal?: AbortSignal;
  /** Overrides TTY detection (tests). */
  interactive?: boolean;
  /** Test seams. */
  fetch?: typeof globalThis.fetch;
  credentialOptions?: CredentialManagerOptions;
}

const GLOBAL_OPTIONS = {
  json: {
    type: "boolean",
    description: "Print exactly one JSON object (schemaVersion 1) on stdout",
  },
  server: {
    type: "string",
    valueName: "origin",
    description: "Backend origin (default: HIVEMIND_URL, then the built-in server)",
  },
  help: { type: "boolean", short: "h", description: "Show help for hivemind or a command" },
  version: { type: "boolean", description: "Print the version, build commit and target" },
} as const satisfies Record<string, OptionSpec>;

const SAFE_WORD = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_OPTION = /^--?[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;

function optionColumn(name: string, spec: OptionSpec): string {
  const short = spec.short ? `-${spec.short}, ` : "";
  const value = spec.type === "string" ? ` <${spec.valueName ?? "value"}>` : "";
  return `${short}--${name}${value}`;
}

function table(rows: readonly [string, string][]): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

function globalHelp(): string[] {
  return table(
    Object.entries(GLOBAL_OPTIONS).map(([name, spec]) => [
      optionColumn(name, spec),
      spec.description,
    ]),
  );
}

export function overviewHelp(commands: readonly CommandDefinition[]): string {
  const lines = [
    "hivemind - command-line client for Hive Mind",
    "",
    "Usage:",
    "  hivemind <command> [options]",
    "",
  ];
  lines.push("Commands:");
  if (commands.length === 0) lines.push("  (none in this build)");
  else lines.push(...table(commands.map((command) => [command.name, command.summary])));
  lines.push("", "Global options:", ...globalHelp(), "");
  lines.push(
    "Environment:",
    ...table([
      ["HIVEMIND_URL", "Backend origin when --server is not given"],
      ["HIVEMIND_TOKEN", "Credential to use instead of the stored login (never falls back)"],
    ]),
    "",
    "Exit codes:",
    "  0 success, 1 error, 2 conflict, 3 authentication or permission, 4 not found",
    "",
    "Run 'hivemind <command> --help' for a command's options and examples.",
    "",
    `Default server: ${DEFAULT_ORIGIN}`,
  );
  return `${lines.join("\n")}\n`;
}

function usageLine(command: CommandDefinition): string {
  const args = (command.args ?? []).map((arg) =>
    arg.required ? `<${arg.name}>` : `[${arg.name}]`,
  );
  return ["hivemind", command.name, ...args, "[options]"].join(" ");
}

export function commandHelp(command: CommandDefinition): string {
  const lines = [`Usage: ${usageLine(command)}`, "", command.summary];
  if (command.description) lines.push("", command.description);
  if (command.args?.length) {
    lines.push("", "Arguments:", ...table(command.args.map((arg) => [arg.name, arg.description])));
  }
  const options = Object.entries(command.options ?? {});
  if (options.length > 0) {
    lines.push(
      "",
      "Options:",
      ...table(options.map(([name, spec]) => [optionColumn(name, spec), spec.description])),
    );
  }
  lines.push("", "Global options:", ...globalHelp());
  if (command.examples?.length)
    lines.push("", "Examples:", ...command.examples.map((example) => `  ${example}`));
  return `${lines.join("\n")}\n`;
}

function groupHelp(group: string, commands: readonly CommandDefinition[]): string {
  const lines = [`Usage: hivemind ${group} <command> [options]`, "", "Commands:"];
  lines.push(...table(commands.map((command) => [command.name, command.summary])));
  return `${lines.join("\n")}\n`;
}

/** Checks a registry for mistakes that would make parsing ambiguous. Run by the tests. */
export function validateRegistry(commands: readonly CommandDefinition[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const command of commands) {
    if (!/^[a-z][a-z-]*(?: [a-z][a-z-]*)*$/.test(command.name))
      problems.push(`${command.name}: invalid name`);
    if (names.has(command.name)) problems.push(`${command.name}: duplicate`);
    names.add(command.name);
    const shorts = new Set<string>(["h"]);
    for (const [name, spec] of Object.entries(command.options ?? {})) {
      if (Object.hasOwn(GLOBAL_OPTIONS, name))
        problems.push(`${command.name}: --${name} shadows a global flag`);
      if (spec.short) {
        if (shorts.has(spec.short)) problems.push(`${command.name}: -${spec.short} is used twice`);
        shorts.add(spec.short);
      }
    }
  }
  for (const name of names) {
    // "key" cannot be both a command and the group of "key create".
    if ([...names].some((other) => other.startsWith(`${name} `)))
      problems.push(`${name}: is also a command group`);
  }
  return problems;
}

interface Dispatch {
  command: CommandDefinition | null;
  /** Command words matched so far, for group help or the envelope name. */
  words: string[];
  /** argv without the command words. */
  rest: string[];
  /** The first positional that did not match a command, if any. */
  unknown: string | null;
}

/** Finds the command named by the leading positional words, skipping global flags. */
function dispatch(argv: readonly string[], commands: readonly CommandDefinition[]): Dispatch {
  const positions: number[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (token === "--") break;
    if (token === "--server") {
      index++;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      // An option before the command words ends the search: command words come first.
      if (positions.length === 0) continue;
      break;
    }
    if (positions.length > 0 && positions[positions.length - 1] !== index - 1) break;
    positions.push(index);
  }
  const words = positions.map((index) => argv[index] as string);
  let best: { command: CommandDefinition; length: number } | null = null;
  for (const command of commands) {
    const parts = command.name.split(" ");
    if (parts.length <= words.length && parts.every((part, i) => words[i] === part)) {
      if (!best || parts.length > best.length) best = { command, length: parts.length };
    }
  }
  const used = best ? best.length : 0;
  // Words that name a group prefix ("key") without a full command.
  let groupWords = 0;
  if (!best) {
    while (
      groupWords < words.length &&
      commands.some((command) =>
        command.name.startsWith(`${words.slice(0, groupWords + 1).join(" ")} `),
      )
    ) {
      groupWords++;
    }
  }
  const consumed = best ? used : groupWords;
  const drop = new Set(positions.slice(0, consumed));
  return {
    command: best?.command ?? null,
    words: words.slice(0, consumed),
    rest: argv.filter((_, index) => !drop.has(index)),
    unknown: !best && words.length > groupWords ? (words[groupWords] ?? null) : null,
  };
}

function describeParseError(error: unknown, argv: readonly string[], known: Set<string>): CliError {
  const code = (error as { code?: string }).code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const token = argv.find(
      (arg) =>
        arg.startsWith("-") &&
        arg !== "-" &&
        arg !== "--" &&
        !known.has(arg.split("=")[0] as string),
    );
    const name = token?.split("=")[0];
    return usageError(
      name && SAFE_OPTION.test(name) ? `Unknown option '${name}'.` : "Unknown option.",
      "Run 'hivemind --help' for the available options.",
    );
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const match = /'(--?[A-Za-z0-9][A-Za-z0-9-]*)/.exec((error as Error).message);
    const name = match?.[1] && SAFE_OPTION.test(match[1]) ? ` ${match[1]}` : "";
    return usageError(`Option${name} is missing its value or does not take one.`);
  }
  if (code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") return usageError("Too many arguments.");
  return usageError("Invalid arguments.");
}

/** Runs one CLI invocation and returns the exit code. Never throws. */
export async function runCli(
  runtime: CliRuntime,
  commands: readonly CommandDefinition[],
): Promise<ExitCode> {
  const { argv, stdout, stderr } = runtime;
  const dashDash = argv.indexOf("--");
  const jsonRequested = (dashDash === -1 ? argv : argv.slice(0, dashDash)).includes("--json");
  let envelopeName = "hivemind";

  const fail = (error: CliError): ExitCode => {
    writeError({ stdout, stderr }, { json: jsonRequested, command: envelopeName, error });
    return error.exitCode;
  };

  try {
    const found = dispatch(argv, commands);
    const command = found.command;
    if (command) envelopeName = command.name;
    const optionSpecs: Record<string, OptionSpec> = {
      ...GLOBAL_OPTIONS,
      ...(command?.options ?? {}),
    };
    const known = new Set<string>();
    for (const [name, spec] of Object.entries(optionSpecs)) {
      known.add(`--${name}`);
      if (spec.short) known.add(`-${spec.short}`);
    }

    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: [...found.rest],
        options: Object.fromEntries(
          Object.entries(optionSpecs).map(([name, spec]) => [
            name,
            spec.short ? { type: spec.type, short: spec.short } : { type: spec.type },
          ]),
        ),
        strict: true,
        allowPositionals: true,
      });
    } catch (error) {
      return fail(describeParseError(error, found.rest, known));
    }
    const values = parsed.values as Record<string, string | boolean | undefined>;
    const json = values.json === true;

    if (values.version === true) {
      const data = { version: BUILD_VERSION, commit: BUILD_COMMIT, target: BUILD_TARGET };
      envelopeName = "version";
      writeSuccess(stdout, {
        json,
        command: "version",
        data,
        human: [`hivemind ${BUILD_VERSION} (${BUILD_COMMIT}, ${BUILD_TARGET})`],
      });
      return EXIT_CODES.ok;
    }

    const groupCommands =
      found.words.length > 0
        ? commands.filter((candidate) => candidate.name.startsWith(`${found.words.join(" ")} `))
        : [];
    if (values.help === true || (!command && found.unknown === null && argv.length === 0)) {
      const text = command
        ? commandHelp(command)
        : groupCommands.length > 0
          ? groupHelp(found.words.join(" "), groupCommands)
          : overviewHelp(commands);
      envelopeName = "help";
      if (json) writeSuccess(stdout, { json, command: "help", data: { text }, human: [] });
      else stdout.write(text);
      return EXIT_CODES.ok;
    }

    if (!command) {
      if (found.unknown !== null) {
        const shown = SAFE_WORD.test(found.unknown)
          ? ` '${[...found.words, found.unknown].join(" ")}'`
          : "";
        return fail(
          usageError(`Unknown command${shown}.`, "Run 'hivemind --help' for the list of commands."),
        );
      }
      if (groupCommands.length > 0) {
        const names = groupCommands.map((candidate) =>
          candidate.name.split(" ").slice(found.words.length).join(" "),
        );
        return fail(
          usageError(
            `'hivemind ${found.words.join(" ")}' needs a subcommand: ${names.join(", ")}.`,
            `Run 'hivemind ${found.words.join(" ")} --help'.`,
          ),
        );
      }
      return fail(
        usageError("No command given.", "Run 'hivemind --help' for the list of commands."),
      );
    }

    const args = parsed.positionals;
    const specs = command.args ?? [];
    const required = specs.filter((arg) => arg.required).length;
    if (args.length > specs.length)
      return fail(usageError("Too many arguments.", `Usage: ${usageLine(command)}`));
    if (args.length < required) {
      const missing = specs[args.length]?.name ?? "argument";
      return fail(usageError(`Missing <${missing}>.`, `Usage: ${usageLine(command)}`));
    }

    const commandOptions = Object.fromEntries(
      Object.keys(command.options ?? {}).map((name) => [name, values[name]]),
    );
    const context = createContext(runtime, {
      command,
      options: commandOptions,
      args,
      json,
      server: values.server as string | undefined,
    });
    const result = await command.run(context);
    writeSuccess(stdout, { json, command: command.name, data: result.data, human: result.human });
    return EXIT_CODES.ok;
  } catch (error) {
    if (isCliError(error)) return fail(error);
    if (runtime.env.HIVEMIND_DEBUG === "1" && error instanceof Error && error.stack) {
      stderr.write(`${redact(error.stack)}\n`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      new CliError(CLI_ERROR_CODES.internal, `Unexpected error: ${detail}`, {
        hint: "This is a bug in hivemind. Rerun with HIVEMIND_DEBUG=1 for details and report it.",
      }),
    );
  }
}

function createContext(
  runtime: CliRuntime,
  parsed: {
    command: CommandDefinition;
    options: CommandContext["options"];
    args: readonly string[];
    json: boolean;
    server: string | undefined;
  },
): CommandContext {
  const interactive =
    runtime.interactive ?? isInteractive({ stdin: runtime.stdin, stderr: runtime.stderr });
  const signal = runtime.signal ?? new AbortController().signal;
  let origin: ResolvedOrigin | undefined;
  let manager: CredentialManager | undefined;

  const context: CommandContext = {
    command: parsed.command.name,
    options: parsed.options,
    args: parsed.args,
    json: parsed.json,
    interactive,
    cwd: runtime.cwd,
    env: runtime.env,
    platform: runtime.platform,
    signal,
    report: createReporter(runtime.stderr),
    prompt: createPrompter({ stdin: runtime.stdin, stderr: runtime.stderr, interactive, signal }),
    origin() {
      origin ??= resolveOrigin({ flag: parsed.server, env: runtime.env });
      return origin;
    },
    credentials() {
      manager ??= createCredentialManager({
        env: runtime.env,
        interactive,
        platform: runtime.platform,
        ...runtime.credentialOptions,
      });
      return manager;
    },
    credential() {
      return context.credentials().require(context.origin().origin);
    },
    async api(options = {}) {
      const target = context.origin().origin;
      const credential = options.auth === "none" ? null : await context.credential();
      // Loaded on first use so --help, --version and local-only commands do
      // not pay for the oRPC client.
      const { createApiClient } = await import("./client.ts");
      return createApiClient({
        origin: target,
        credential,
        fetch: runtime.fetch,
        timeoutMs: options.timeoutMs,
        signal,
      });
    },
  };
  return context;
}
