import { taskClaimConflictMessage } from "@hivemind/contract";
import {
  blockTask as blockTaskRecord,
  claimTask as claimTaskRecord,
  type Db,
  doneTask,
  releaseTask as releaseTaskRecord,
  startTask as startTaskRecord,
  type TaskActionResult,
} from "@hivemind/db";
import { apiError } from "./authorize";
import { authorizeProject, lifecycleError } from "./coordination-auth";
import { toTaskDto } from "./coordination-dto";
import { api } from "./implementer";
import { missingRecord } from "./sessions";

// Task work actions (issue #12 step 6): claim (and steal), release, start,
// block and done, each through the caller's own live Session named in the
// body. Another principal's Session of the Project is 403; a Session or Task
// of another Project, or none, is 404 (`coordination-auth.ts`).

interface TaskActionRequest {
  id: string;
  taskId: string;
  sessionId: string;
}

/**
 * The outcome's Task, or the API error for its failure. A claim conflict
 * with a live holder names the holder's Session UUID and intent, worded by
 * the contract's `taskClaimConflictMessage`.
 */
async function taskResult<T extends object>(
  db: Db,
  input: TaskActionRequest,
  outcome: TaskActionResult<T>,
) {
  if (outcome.status === "ok") return outcome;
  if (outcome.status === "not_found") {
    throw await missingRecord(db, input.id, input.sessionId, "Task not found.");
  }
  if (outcome.status === "conflict" && outcome.holder) {
    throw apiError("CONFLICT", taskClaimConflictMessage(outcome.holder));
  }
  throw lifecycleError(outcome, () => apiError("NOT_FOUND"));
}

/** `POST /projects/{id}/tasks/{taskId}/claim`: claim, or with `steal` take over a live claim. */
export const claimTask = api.projects.tasks.claim.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["task:write"]);
    const outcome = await taskResult(
      db,
      input,
      await claimTaskRecord(db, {
        projectId: input.id,
        taskId: input.taskId,
        sessionId: input.sessionId,
        principal: access.principal,
        steal: input.steal,
      }),
    );
    return {
      task: toTaskDto(outcome.view),
      changed: outcome.changed,
      stolenFromSessionId: outcome.stolenFromSessionId,
    };
  },
);

/** `POST /projects/{id}/tasks/{taskId}/release`: give up the caller's claim. */
export const releaseTask = api.projects.tasks.release.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["task:write"]);
    const outcome = await taskResult(
      db,
      input,
      await releaseTaskRecord(db, { ...actionOf(input), principal: access.principal }),
    );
    return { task: toTaskDto(outcome.view), changed: outcome.changed };
  },
);

/** `POST /projects/{id}/tasks/{taskId}/start`: `todo` or `blocked` to `in_progress`. */
export const startTask = api.projects.tasks.start.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["task:write"]);
    const outcome = await taskResult(
      db,
      input,
      await startTaskRecord(db, { ...actionOf(input), principal: access.principal }),
    );
    return { task: toTaskDto(outcome.view), changed: outcome.changed };
  },
);

/** `POST /projects/{id}/tasks/{taskId}/block`: blocked with a reason; the claim stays. */
export const blockTask = api.projects.tasks.block.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["task:write"]);
    const outcome = await taskResult(
      db,
      input,
      await blockTaskRecord(db, {
        ...actionOf(input),
        principal: access.principal,
        reason: input.reason,
      }),
    );
    return { task: toTaskDto(outcome.view), changed: outcome.changed };
  },
);

/** `POST /projects/{id}/tasks/{taskId}/done`: done, and the claim is cleared. */
export const completeTask = api.projects.tasks.done.handler(
  async ({ input, context: { principal, db } }) => {
    const access = await authorizeProject(db, principal, input.id, ["task:write"]);
    const outcome = await taskResult(
      db,
      input,
      await doneTask(db, { ...actionOf(input), principal: access.principal }),
    );
    return { task: toTaskDto(outcome.view), changed: outcome.changed };
  },
);

function actionOf(input: TaskActionRequest) {
  return { projectId: input.id, taskId: input.taskId, sessionId: input.sessionId };
}
