import type { CommandDefinition } from "../command.ts";
import { init } from "./init.ts";
import { keyCreate, keyList, keyRevoke } from "./key.ts";
import { login } from "./login.ts";
import { logout } from "./logout.ts";
import { whoami } from "./whoami.ts";

/**
 * Every command the shipped binary knows, in the order `--help` lists them.
 * Each lives in its own module under src/commands/.
 */
export const COMMANDS: readonly CommandDefinition[] = [
  login,
  logout,
  whoami,
  init,
  keyCreate,
  keyList,
  keyRevoke,
];
