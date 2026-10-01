import type { ApiClientOptions, HivemindApi, OriginFetch } from "./client.ts";
import type { Clock } from "./clock.ts";
import type { CredentialManager, ResolvedCredential } from "./credentials/manager.ts";
import type { ResolvedOrigin } from "./origin.ts";
import type { Reporter } from "./output.ts";
import type { Prompter } from "./prompt.ts";

/**
 * The interface between the shell (cli.ts) and commands. A command declares
 * its name, help text, options and positional arguments, and implements
 * `run`, which returns data (the `--json` envelope's `data`) plus the human
 * lines to print, or throws a `CliError`. The shell owns parsing, `--help`,
 * output mode, escaping, redaction and exit codes, so commands never write to
 * stdout themselves.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export type OptionSpec =
  | { type: "string"; description: string; valueName?: string; short?: string }
  | { type: "boolean"; description: string; short?: string };

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
}

export type OptionValues = Readonly<Record<string, string | boolean | undefined>>;

export interface CommandResult<T = unknown> {
  /** The `data` of the `--json` success envelope. Must never contain a login token. */
  data: T;
  /**
   * Human-mode stdout, one entry per line. Each line is printed with terminal
   * control characters (including newlines) escaped, so server or repository
   * strings can be interpolated directly.
   */
  human: readonly string[];
}

export interface ApiRequestOptions {
  /**
   * `required` (default): resolve a credential or fail with UNAUTHORIZED (exit 3).
   * `none`: send no Authorization header.
   */
  auth?: "required" | "none";
  /**
   * Use this credential instead of resolving one (`login` checks the token it
   * just received). Takes precedence over `auth`.
   */
  credential?: ResolvedCredential;
  timeoutMs?: ApiClientOptions["timeoutMs"];
}

export interface OriginFetchOptions {
  /** Sent as the bearer token; null sends no Authorization header. */
  credential: ResolvedCredential | null;
  timeoutMs?: number;
}

export interface CommandContext {
  /** The command path, e.g. `key create`; also the envelope's `command`. */
  readonly command: string;
  /** Parsed options of this command (globals are not included). */
  readonly options: OptionValues;
  /** Positional arguments after the command words. */
  readonly args: readonly string[];
  /** `--json` was given: progress goes to stderr, the shell prints the envelope. */
  readonly json: boolean;
  /** stdin and stderr are TTYs. When false, never prompt and never open a browser. */
  readonly interactive: boolean;
  readonly cwd: string;
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  /** Aborted on SIGINT/SIGTERM. Pass it to long waits (device polling). */
  readonly signal: AbortSignal;
  /** Progress and instructions on stderr (escaped, redacted). */
  readonly report: Reporter;
  /** Interactive questions; throws a USAGE_ERROR when not interactive. */
  readonly prompt: Prompter;
  /**
   * Reads stdin to its end, at most `maxBytes` bytes; null when it holds more.
   * Only for an explicit `-` argument: a command never reads stdin otherwise,
   * so a non-TTY run with an open stdin never waits. Throws CANCELLED on
   * SIGINT/SIGTERM.
   */
  readStdin(maxBytes: number): Promise<Uint8Array | null>;
  /** `--server`, then HIVEMIND_URL, then the build default. Throws INVALID_SERVER. */
  origin(): ResolvedOrigin;
  /** The credential stores for this platform and terminal state. */
  credentials(): CredentialManager;
  /** The credential for `origin()`; throws UNAUTHORIZED when there is none. */
  credential(): Promise<ResolvedCredential>;
  /** An API client for `origin()`, authenticated unless `auth: "none"`. */
  api(options?: ApiRequestOptions): Promise<HivemindApi>;
  /**
   * The guarded fetch (same origin only, no redirects, timeout, cancel on
   * SIGINT) for routes outside the `/api/v1` contract, such as better-auth's
   * device flow and sign-out.
   */
  originFetch(options: OriginFetchOptions): Promise<OriginFetch>;
  /** Time and waiting; a fake in tests. */
  readonly clock: Clock;
  /**
   * Opens a URL in the user's browser. Resolves false when no browser could be
   * launched. Only call it when `interactive` is true.
   */
  openUrl(url: string): Promise<boolean>;
}

export interface CommandDefinition {
  /** Space-separated lowercase words, e.g. `whoami` or `key create`. */
  readonly name: string;
  /** One line for the command list. */
  readonly summary: string;
  /** Extra paragraphs for `hivemind <command> --help`. */
  readonly description?: string;
  readonly args?: readonly ArgSpec[];
  /** Option names are long names without dashes. They must not reuse a global flag. */
  readonly options?: Readonly<Record<string, OptionSpec>>;
  /** Full command lines shown under "Examples". */
  readonly examples?: readonly string[];
  run(context: CommandContext): Promise<CommandResult>;
}
