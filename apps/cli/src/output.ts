import {
  type CliEnvelope,
  type CliErrorEnvelope,
  errorEnvelope,
  successEnvelope,
} from "@hivemind/contract";
import { redact } from "./redact.ts";

/**
 * Everything the CLI prints goes through here.
 *
 * - `--json`: stdout receives exactly one line, the versioned envelope from
 *   `@hivemind/contract` (success or error). Nothing else is ever written to
 *   stdout, so `hivemind whoami --json | jq` always parses.
 * - Human mode: the command's result lines go to stdout; errors, warnings and
 *   progress go to stderr.
 * - In both modes stderr carries progress and instructions (device code, URLs).
 *
 * Text that can come from a server or a repository (names, slugs, URLs, error
 * messages) is escaped before it reaches a terminal, so it cannot move the
 * cursor, change colors, set the window title or hide text. JSON output needs
 * no escaping: JSON.stringify already encodes every control character.
 */

export interface OutputStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** C0 and C1 controls, DEL, line/paragraph separators and bidi overrides (Trojan Source). */
function isUnsafe(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

const NAMED_ESCAPES: Readonly<Record<number, string>> = { 9: "\\t", 10: "\\n", 13: "\\r" };

/**
 * Replaces every terminal control character in `text` with a visible escape
 * (`\x1b`, `\n`, `‮`). Newlines are escaped too: a human output line is
 * one line, so a server string cannot forge an extra line of output.
 */
export function escapeTerminal(text: string): string {
  let result = "";
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!isUnsafe(code)) continue;
    const replacement =
      NAMED_ESCAPES[code] ??
      (code <= 0xff
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : `\\u${code.toString(16).padStart(4, "0")}`);
    result += text.slice(start, index) + replacement;
    start = index + 1;
  }
  return start === 0 ? text : result + text.slice(start);
}

/** Escaped and redacted: the form every diagnostic line is printed in. */
export function safeLine(text: string): string {
  return escapeTerminal(redact(text));
}

/** Progress and instructions for people. Always stderr, in both output modes. */
export interface Reporter {
  info(line: string): void;
  warn(line: string): void;
}

export function createReporter(stderr: OutputStream): Reporter {
  return {
    info: (line) => stderr.write(`${safeLine(line)}\n`),
    warn: (line) => stderr.write(`warning: ${safeLine(line)}\n`),
  };
}

/** Writes the single `--json` envelope line. */
export function writeEnvelope(stdout: OutputStream, envelope: CliEnvelope<unknown>): void {
  stdout.write(`${JSON.stringify(envelope)}\n`);
}

export function writeSuccess(
  stdout: OutputStream,
  options: { json: boolean; command: string; data: unknown; human: readonly string[] },
): void {
  if (options.json) {
    writeEnvelope(stdout, successEnvelope(options.command, options.data));
    return;
  }
  // Each line is escaped whole, including embedded newlines. Success output is
  // not redacted: `key create` prints its new key here on purpose.
  for (const line of options.human) stdout.write(`${escapeTerminal(line)}\n`);
}

export interface PrintableError {
  code: string;
  message: string;
  hint?: string | undefined;
}

/** The envelope for an error. The hint is appended to `message`, since the envelope has no hint field. */
export function errorEnvelopeFor(command: string, error: PrintableError): CliErrorEnvelope {
  const message = error.hint ? `${error.message} ${error.hint}` : error.message;
  // The envelope schema caps messages at 4096 characters.
  return errorEnvelope(command, { code: error.code, message: redact(message).slice(0, 4096) });
}

export function writeError(
  streams: { stdout: OutputStream; stderr: OutputStream },
  options: { json: boolean; command: string; error: PrintableError },
): void {
  if (options.json) {
    writeEnvelope(streams.stdout, errorEnvelopeFor(options.command, options.error));
    return;
  }
  streams.stderr.write(`hivemind: ${safeLine(options.error.message)}\n`);
  if (options.error.hint) streams.stderr.write(`  ${safeLine(options.error.hint)}\n`);
}
