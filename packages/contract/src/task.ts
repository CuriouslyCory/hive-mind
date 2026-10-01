import { z } from "zod";
import {
  boundedListSchema,
  countSchema,
  idSchema,
  MAX_PAGE_LIMIT,
  markdownSchema,
  pageSchema,
  paginationInputShape,
  textSchema,
  timestampSchema,
} from "./common.ts";
import { actorSessionInputShape, planKeySchema, planRefSchema } from "./plan.ts";

export const MAX_TASK_TITLE_LENGTH = 120;

/**
 * Task progress. Claims are separate from progress: releasing a claim keeps
 * the status, and `done` clears the claim.
 */
export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"] as const;

export const taskStatusSchema = z.enum(TASK_STATUSES);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskTitleSchema = textSchema(MAX_TASK_TITLE_LENGTH);

export const blockReasonSchema = markdownSchema();

/**
 * A usable claim: held by a live Session (`active` or `idle`) with an
 * unexpired lease, both judged at the database time of the read. An expired
 * lease or a stale, ended or abandoned holder reads as `claim: null` even if
 * the maintenance sweep has not cleared it yet.
 */
export const taskClaimSchema = z.strictObject({
  sessionId: idSchema,
  claimedAt: timestampSchema,
  leaseExpiresAt: timestampSchema,
});

export type TaskClaim = z.infer<typeof taskClaimSchema>;

export const taskSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  planId: idSchema,
  planKey: planKeySchema,
  title: taskTitleSchema,
  status: taskStatusSchema,
  /** Ordering within the Plan only; Tasks are identified by UUID. */
  position: countSchema,
  claim: taskClaimSchema.nullable(),
  /** The reason given by the latest block; null unless `status` is `blocked`. */
  blockedReason: blockReasonSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Task = z.infer<typeof taskSchema>;

export const taskPageSchema = pageSchema(taskSchema);

export type TaskPage = z.infer<typeof taskPageSchema>;

/**
 * `POST /projects/{id}/plans/{planRef}/tasks`: add a `todo` Task at the end of
 * a Plan that is not done or abandoned. `taskId` is generated once by the
 * client; replay follows `createPlanInputSchema`.
 */
export const addTaskInputSchema = z.strictObject({
  id: idSchema,
  planRef: planRefSchema,
  taskId: idSchema,
  title: taskTitleSchema,
  ...actorSessionInputShape,
});

export type AddTaskInput = z.input<typeof addTaskInputSchema>;

export const addTaskOutputSchema = z.strictObject({
  task: taskSchema,
  created: z.boolean(),
});

export type AddTaskOutput = z.infer<typeof addTaskOutputSchema>;

/** `GET /projects/{id}/plans/{planRef}/tasks`: by position, then UUID. */
export const listPlanTasksInputSchema = z.strictObject({
  id: idSchema,
  planRef: planRefSchema,
  status: taskStatusSchema.optional(),
  ...paginationInputShape,
});

export type ListPlanTasksInput = z.input<typeof listPlanTasksInputSchema>;

/**
 * Task work actions, `POST /projects/{id}/tasks/{taskId}/<action>`. `sessionId`
 * is required: it must be the caller's own live Session in this Project
 * (another principal's is NOT_FOUND, a stale, ended or abandoned one CONFLICT).
 */
const taskActionInputShape = {
  id: idSchema,
  taskId: idSchema,
  sessionId: idSchema,
};

/**
 * `POST .../claim`. Succeeds when the Task is unclaimed, its lease expired, or
 * its holder is stale, ended or abandoned; requires an active Plan and a Task
 * that is not done. A live competing claim is CONFLICT unless `steal` is true,
 * which takes it over and records the former holder. Repeating a valid claim
 * is a no-op and does not extend the lease (heartbeats do).
 */
export const claimTaskInputSchema = z.strictObject({
  ...taskActionInputShape,
  steal: z.boolean().optional(),
});

export type ClaimTaskInput = z.input<typeof claimTaskInputSchema>;

/** `POST .../release`. Releasing an unclaimed Task is a no-op; another Session's claim is CONFLICT. */
export const releaseTaskInputSchema = z.strictObject(taskActionInputShape);

export type ReleaseTaskInput = z.input<typeof releaseTaskInputSchema>;

/** `POST .../start`: `todo` or `blocked` to `in_progress`; needs the caller's unexpired claim and an active Plan. */
export const startTaskInputSchema = z.strictObject(taskActionInputShape);

export type StartTaskInput = z.input<typeof startTaskInputSchema>;

/** `POST .../block`: needs the caller's unexpired claim, which it keeps. */
export const blockTaskInputSchema = z.strictObject({
  ...taskActionInputShape,
  reason: blockReasonSchema,
});

export type BlockTaskInput = z.input<typeof blockTaskInputSchema>;

/** `POST .../done`: needs the caller's unexpired claim; marks the Task done and clears the claim. */
export const completeTaskInputSchema = z.strictObject(taskActionInputShape);

export type CompleteTaskInput = z.input<typeof completeTaskInputSchema>;

/** Release, start, block and done. `changed: false` is a no-op that wrote no Event. */
export const taskActionOutputSchema = z.strictObject({
  task: taskSchema,
  changed: z.boolean(),
});

export type TaskActionOutput = z.infer<typeof taskActionOutputSchema>;

export const claimTaskOutputSchema = z.strictObject({
  task: taskSchema,
  changed: z.boolean(),
  /** The live holder a `steal` took the claim from; null otherwise. */
  stolenFromSessionId: idSchema.nullable(),
});

export type ClaimTaskOutput = z.infer<typeof claimTaskOutputSchema>;

/** Task UUIDs whose claims an operation renewed or released. */
export const claimedTaskIdsSchema = boundedListSchema(idSchema, MAX_PAGE_LIMIT);

export type ClaimedTaskIds = z.infer<typeof claimedTaskIdsSchema>;

/** Longest part of a holder's intent quoted in a claim conflict message. */
export const MAX_CONFLICT_INTENT_LENGTH = 200;

/**
 * The CONFLICT message for a Task another live Session holds. The holder's
 * UUID and a bounded part of its intent are in the message text only: the
 * error body stays `{ code, message }`, and scripts are not promised a
 * structured holder.
 */
export function taskClaimConflictMessage(holder: { sessionId: string; intent: string }): string {
  const codePoints = [...holder.intent];
  const intent =
    codePoints.length > MAX_CONFLICT_INTENT_LENGTH
      ? `${codePoints.slice(0, MAX_CONFLICT_INTENT_LENGTH - 1).join("")}…`
      : holder.intent;
  return `The Task is claimed by Session ${holder.sessionId} (intent: ${JSON.stringify(intent)}).`;
}
