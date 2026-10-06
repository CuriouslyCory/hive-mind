import type { CommandDefinition } from "../command.ts";
import { adrList, adrNew, adrShow, adrStatus, adrSupersede, adrSync } from "./adr.ts";
import { init } from "./init.ts";
import { keyCreate, keyList, keyRevoke } from "./key.ts";
import { login } from "./login.ts";
import { logout } from "./logout.ts";
import { planCreate, planEdit, planList, planLog, planShow, planStatus } from "./plan.ts";
import { scopeAdd, scopeCheck, scopeList, scopeRemove } from "./scope.ts";
import {
  sessionAttach,
  sessionClaims,
  sessionEnd,
  sessionHeartbeat,
  sessionList,
  sessionLog,
  sessionShow,
  sessionStart,
  sessionUpdate,
} from "./session.ts";
import { status } from "./status.ts";
import { taskAdd, taskBlock, taskClaim, taskDone, taskRelease, taskStart } from "./task.ts";
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
  status,
  planList,
  planShow,
  planCreate,
  planEdit,
  planLog,
  planStatus,
  taskAdd,
  taskClaim,
  taskRelease,
  taskStart,
  taskBlock,
  taskDone,
  sessionStart,
  sessionHeartbeat,
  sessionUpdate,
  sessionAttach,
  sessionEnd,
  sessionList,
  sessionShow,
  sessionClaims,
  sessionLog,
  scopeAdd,
  scopeRemove,
  scopeList,
  scopeCheck,
  adrNew,
  adrList,
  adrShow,
  adrStatus,
  adrSupersede,
  adrSync,
];
