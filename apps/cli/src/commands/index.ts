import type { CommandDefinition } from "../command.ts";

/**
 * Every command the shipped binary knows, in the order `--help` lists them.
 * cli-commands adds login, logout, whoami, init and key create/list/revoke
 * here; each lives in its own module under src/commands/.
 */
export const COMMANDS: readonly CommandDefinition[] = [];
