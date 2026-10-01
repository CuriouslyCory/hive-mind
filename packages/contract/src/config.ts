import { z } from "zod";
import { idSchema } from "./common.ts";

/**
 * `.hivemind.json`: the committed file that links a repository to a Project.
 * It holds only the Project ID. An API origin, command or credential in a
 * repository file would let a cloned repo redirect or impersonate, so the
 * schema is strict and has no room for them.
 */
export const CONFIG_FILENAME = ".hivemind.json";

/** Larger files are rejected before parsing. */
export const MAX_CONFIG_BYTES = 16 * 1024;

export const CONFIG_VERSION = 1;

export const hivemindConfigSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  projectId: idSchema,
});

export type HivemindConfig = z.infer<typeof hivemindConfigSchema>;

/**
 * Why a config file was rejected. These are CLI-local error codes (exit 1).
 * CONFIG_UNSUPPORTED_VERSION is separate so the CLI can tell the user to
 * upgrade instead of reporting a corrupt file.
 */
export const CONFIG_ERROR_CODES = [
  "CONFIG_TOO_LARGE",
  "CONFIG_INVALID_JSON",
  "CONFIG_UNSUPPORTED_VERSION",
  "CONFIG_INVALID",
] as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];

export type ConfigParseResult =
  | { ok: true; config: HivemindConfig }
  | { ok: false; error: { code: ConfigErrorCode; message: string } };

function failure(code: ConfigErrorCode, message: string): ConfigParseResult {
  return { ok: false, error: { code, message } };
}

/**
 * Parses the contents of a `.hivemind.json` file. Never throws. Bytes are
 * decoded as UTF-8; the size limit is checked on the encoded size.
 */
export function parseHivemindConfig(contents: string | Uint8Array): ConfigParseResult {
  const size =
    typeof contents === "string"
      ? new TextEncoder().encode(contents).byteLength
      : contents.byteLength;
  if (size > MAX_CONFIG_BYTES) {
    return failure(
      "CONFIG_TOO_LARGE",
      `${CONFIG_FILENAME} is larger than ${MAX_CONFIG_BYTES} bytes.`,
    );
  }

  let value: unknown;
  try {
    const text =
      typeof contents === "string"
        ? contents
        : new TextDecoder("utf-8", { fatal: true }).decode(contents);
    value = JSON.parse(text);
  } catch {
    return failure("CONFIG_INVALID_JSON", `${CONFIG_FILENAME} is not valid UTF-8 JSON.`);
  }

  // Only an integer version other than 1 means "written by a newer CLI". A
  // missing or non-integer version is a malformed file.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const version: unknown = (value as Record<string, unknown>).version;
    if (Number.isInteger(version) && version !== CONFIG_VERSION) {
      return failure(
        "CONFIG_UNSUPPORTED_VERSION",
        `${CONFIG_FILENAME} has version ${String(version)}; this CLI supports version ${CONFIG_VERSION}. Upgrade the CLI.`,
      );
    }
  }

  const parsed = hivemindConfigSchema.safeParse(value);
  if (!parsed.success) {
    return failure(
      "CONFIG_INVALID",
      `${CONFIG_FILENAME} must be exactly { "version": 1, "projectId": "<uuid>" }.`,
    );
  }
  return { ok: true, config: parsed.data };
}

/** The canonical file contents: two-space indented JSON with a trailing newline. */
export function serializeHivemindConfig(config: HivemindConfig): string {
  const checked = hivemindConfigSchema.parse(config);
  return `${JSON.stringify({ version: checked.version, projectId: checked.projectId }, null, 2)}\n`;
}
