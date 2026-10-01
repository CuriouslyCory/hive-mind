import { z } from "zod";
import { EXIT_CODES, type ExitCode, exitCodeForErrorCode } from "./errors.ts";

/**
 * The single JSON object a CLI command writes to stdout under `--json`.
 * Scripts and agents parse it, so it is versioned: a change that removes or
 * retypes a field needs a new `schemaVersion`. Adding fields to `data` is
 * allowed. Progress and device-login instructions go to stderr, never here.
 */
export const OUTPUT_SCHEMA_VERSION = 1;

/** Space-separated lowercase command path, e.g. `whoami` or `key create`. */
export const commandNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z-]*(?: [a-z][a-z-]*)*$/);

/**
 * `code` is an API code from `API_ERROR_CODES` or a CLI-local code such as
 * `CONFIG_UNSUPPORTED_VERSION`. Consumers must accept codes they do not know.
 */
export const cliErrorSchema = z.strictObject({
  code: z
    .string()
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().max(4096),
});

export type CliError = z.infer<typeof cliErrorSchema>;

export function cliSuccessEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    schemaVersion: z.literal(OUTPUT_SCHEMA_VERSION),
    command: commandNameSchema,
    ok: z.literal(true),
    data,
  });
}

export const cliErrorEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(OUTPUT_SCHEMA_VERSION),
  command: commandNameSchema,
  ok: z.literal(false),
  error: cliErrorSchema,
});

export function cliEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [cliSuccessEnvelopeSchema(data), cliErrorEnvelopeSchema]);
}

/** Any envelope, with `data` unchecked. */
export const anyCliEnvelopeSchema = cliEnvelopeSchema(z.unknown());

export type CliSuccessEnvelope<T> = {
  schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
  command: string;
  ok: true;
  data: T;
};

export type CliErrorEnvelope = z.infer<typeof cliErrorEnvelopeSchema>;

export type CliEnvelope<T> = CliSuccessEnvelope<T> | CliErrorEnvelope;

export function successEnvelope<T>(command: string, data: T): CliSuccessEnvelope<T> {
  return { schemaVersion: OUTPUT_SCHEMA_VERSION, command, ok: true, data };
}

export function errorEnvelope(command: string, error: CliError): CliErrorEnvelope {
  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    command,
    ok: false,
    error: { code: error.code, message: error.message },
  };
}

/** The process exit code that goes with an envelope. */
export function exitCodeForEnvelope(envelope: CliEnvelope<unknown>): ExitCode {
  return envelope.ok ? EXIT_CODES.ok : exitCodeForErrorCode(envelope.error.code);
}
