import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_MARKDOWN_BYTES, markdownSchema } from "@hivemind/contract";
import type { CommandContext } from "./command.ts";
import { CLI_ERROR_CODES, CliError, usageError } from "./errors.ts";

/**
 * Bounded multi-line text from a pair of mutually exclusive flags, such as
 * `--body <text>` and `--body-file <path>`. `--body-file -` reads stdin, and
 * only then: nothing here opens an editor or waits on stdin unasked. The text
 * is checked locally against the contract's markdown rules (at most 8 KiB of
 * UTF-8, not blank, no control characters except tabs and line breaks), so an
 * oversized or binary input is a usage error before any request is sent.
 *
 * The file path is never echoed in an error: like every argument, it may be
 * something the user did not mean to print.
 */

export interface TextFlags {
  /** Long option names without dashes, e.g. `body` and `body-file`. */
  text: string;
  file: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

async function readBoundedFile(path: string, maxBytes: number, flag: string): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new CliError(CLI_ERROR_CODES.io, `Cannot open the file given to --${flag} (${code}).`, {
      cause: error,
    });
  }
  try {
    if ((await handle.stat()).isDirectory()) {
      throw usageError(`--${flag} must name a file, not a directory.`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new CliError(CLI_ERROR_CODES.io, `Cannot read the file given to --${flag} (${code}).`, {
      cause: error,
    });
  } finally {
    await handle.close();
  }
}

/** The text of whichever flag was given, or undefined for neither. */
export async function readTextFlags(
  context: Pick<CommandContext, "options" | "cwd" | "readStdin">,
  flags: TextFlags,
  maxBytes: number = MAX_MARKDOWN_BYTES,
): Promise<string | undefined> {
  const inline = context.options[flags.text];
  const file = context.options[flags.file];
  if (typeof inline === "string" && typeof file === "string") {
    throw usageError(`--${flags.text} and --${flags.file} cannot be used together.`);
  }
  let text: string;
  if (typeof inline === "string") text = inline;
  else if (typeof file === "string") {
    const bytes =
      file === "-"
        ? await context.readStdin(maxBytes)
        : await readBoundedFile(resolve(context.cwd, file), maxBytes, flags.file);
    if (bytes === null || bytes.byteLength > maxBytes) {
      throw usageError(`--${flags.file}: the text is longer than ${maxBytes} bytes.`);
    }
    try {
      text = utf8.decode(bytes);
    } catch {
      throw usageError(`--${flags.file}: the text is not valid UTF-8.`);
    }
  } else return undefined;
  const flag = typeof inline === "string" ? flags.text : flags.file;
  const parsed = markdownSchema(maxBytes).safeParse(text);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "Invalid text.";
    throw usageError(
      `--${flag}: ${reason.replace(/\.$/, "")} (at most ${maxBytes} bytes of text).`,
    );
  }
  return text;
}
