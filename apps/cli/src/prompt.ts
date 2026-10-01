import { createInterface } from "node:readline/promises";
import { CLI_ERROR_CODES, CliError, usageError } from "./errors.ts";
import { escapeTerminal, type OutputStream } from "./output.ts";

/**
 * Interactive questions, on stderr so stdout stays clean for `--json`.
 * Without an interactive terminal every method throws a USAGE_ERROR naming
 * the flag to pass instead: a non-TTY run never waits for input.
 */

export interface Choice<T> {
  label: string;
  value: T;
}

export interface PromptOptions {
  /** Shown when there is no terminal, e.g. "Pass --org <id>." */
  nonInteractiveHint: string;
}

export interface Prompter {
  readonly available: boolean;
  select<T>(question: string, choices: readonly Choice<T>[], options: PromptOptions): Promise<T>;
  confirm(question: string, options: PromptOptions & { defaultValue?: boolean }): Promise<boolean>;
}

export interface PromptIo {
  stdin: NodeJS.ReadableStream;
  stderr: OutputStream & NodeJS.WritableStream;
  interactive: boolean;
  signal: AbortSignal;
}

export function createPrompter(io: PromptIo): Prompter {
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: true });
    try {
      return (await rl.question(question, { signal: io.signal })).trim();
    } catch (error) {
      throw new CliError(CLI_ERROR_CODES.cancelled, "Cancelled.", { cause: error });
    } finally {
      rl.close();
    }
  };

  const unavailable = (question: string, options: PromptOptions): CliError =>
    usageError(
      `${question.replace(/[?:]\s*$/, "")}: an answer is needed, but there is no interactive terminal.`,
      options.nonInteractiveHint,
    );

  return {
    available: io.interactive,
    async select(question, choices, options) {
      if (!io.interactive) throw unavailable(question, options);
      if (choices.length === 0) throw usageError(`${question}: there is nothing to choose from.`);
      io.stderr.write(`${escapeTerminal(question)}\n`);
      choices.forEach((choice, index) => {
        io.stderr.write(`  ${index + 1}) ${escapeTerminal(choice.label)}\n`);
      });
      for (;;) {
        const answer = await ask(`Choose 1-${choices.length}: `);
        const index = Number(answer);
        const choice = Number.isInteger(index) ? choices[index - 1] : undefined;
        if (choice) return choice.value;
        io.stderr.write(`Enter a number from 1 to ${choices.length}.\n`);
      }
    },
    async confirm(question, options) {
      if (!io.interactive) throw unavailable(question, options);
      const suffix =
        options.defaultValue === true
          ? " [Y/n] "
          : options.defaultValue === false
            ? " [y/N] "
            : " [y/n] ";
      for (;;) {
        const answer = (await ask(`${escapeTerminal(question)}${suffix}`)).toLowerCase();
        if (answer === "" && options.defaultValue !== undefined) return options.defaultValue;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
      }
    },
  };
}
