import { z } from "zod";
import { actorSchema } from "./auth.ts";
import {
  countSchema,
  idSchema,
  markdownSchema,
  pageSchema,
  paginationInputShape,
  textSchema,
  timestampSchema,
  trimmedTextSchema,
} from "./common.ts";

export const MAX_PLAN_TITLE_LENGTH = 120;

/**
 * Plan lifecycle. Allowed transitions: `draft -> active | abandoned`,
 * `active -> paused | done | abandoned`, `paused -> active | done | abandoned`.
 * `done` and `abandoned` are terminal. Tasks are claimed and started only in
 * an `active` Plan.
 */
export const PLAN_STATUSES = ["draft", "active", "paused", "done", "abandoned"] as const;

export const planStatusSchema = z.enum(PLAN_STATUSES);

export type PlanStatus = z.infer<typeof planStatusSchema>;

/** Statuses a Plan can be created in; the default is `draft`. */
export const initialPlanStatusSchema = z.enum(["draft", "active"]);

/** Target statuses of `POST .../status`; a Plan never returns to `draft`. */
export const targetPlanStatusSchema = z.enum(["active", "paused", "done", "abandoned"]);

/**
 * A Plan's Project-local key, `PLAN-` and its number (from 1, no leading
 * zeros). The server allocates numbers; they are never reused in a Project.
 */
export const planKeySchema = z
  .string()
  .max(14)
  .regex(/^PLAN-[1-9][0-9]{0,8}$/, "Must be a Plan key such as PLAN-12.");

/**
 * How a path names a Plan: its Project-local key (`PLAN-12`) or its UUID. The
 * server resolves a key within the path's Project before using the UUID, so a
 * key never reaches another Project's Plan.
 */
export const planRefSchema = z.union([idSchema, planKeySchema]);

export type PlanRef = z.infer<typeof planRefSchema>;

export const planTitleSchema = textSchema(MAX_PLAN_TITLE_LENGTH);

export const planBodySchema = markdownSchema();

export const MAX_DECISION_TEXT_LENGTH = 500;

/**
 * A decision recorded against a Plan, such as "Retry with jittered backoff,
 * capped at 30 seconds.": one line of plain text, never markdown, trimmed.
 */
export const decisionTextSchema = trimmedTextSchema(MAX_DECISION_TEXT_LENGTH);

/** Task counts of a Plan by status, computed when the Plan is read. */
export const planProgressSchema = z.strictObject({
  total: countSchema,
  todo: countSchema,
  inProgress: countSchema,
  blocked: countSchema,
  done: countSchema,
});

export type PlanProgress = z.infer<typeof planProgressSchema>;

const planSummaryShape = {
  id: idSchema,
  projectId: idSchema,
  key: planKeySchema,
  title: planTitleSchema,
  status: planStatusSchema,
  /** The creating User; null for a Plan a Project key created. */
  ownerUserId: idSchema.nullable(),
  createdBy: actorSchema,
  progress: planProgressSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

/** A Plan without its body, as lists and Project status show it. */
export const planSummarySchema = z.strictObject(planSummaryShape);

export type PlanSummary = z.infer<typeof planSummarySchema>;

/**
 * A Plan with its body. It never embeds Tasks or Events: those come from the
 * paged `GET .../tasks` and `GET .../log` routes.
 */
export const planSchema = z.strictObject({
  ...planSummaryShape,
  body: planBodySchema.nullable(),
});

export type Plan = z.infer<typeof planSchema>;

/**
 * Optional on Project-level coordination writes: attributes the change's Event
 * to one of the caller's own Sessions in this Project. Another principal's
 * Session of this Project is FORBIDDEN (it is visible, but not the caller's);
 * another Project's or an absent one is NOT_FOUND; an ended or abandoned
 * Session is CONFLICT.
 */
export const actorSessionInputShape = {
  sessionId: idSchema.optional(),
};

/**
 * `POST /projects/{id}/plans`. `planId` is generated once by the client. A
 * retry with the same `planId`, input and principal returns the Plan as it is
 * now with `created: false` and writes no Event; the same `planId` with other
 * input or another principal is CONFLICT, and one used in another Project is
 * NOT_FOUND.
 */
export const createPlanInputSchema = z.strictObject({
  id: idSchema,
  planId: idSchema,
  title: planTitleSchema,
  body: planBodySchema.optional(),
  status: initialPlanStatusSchema.optional(),
  ...actorSessionInputShape,
});

export type CreatePlanInput = z.input<typeof createPlanInputSchema>;

export const createPlanOutputSchema = z.strictObject({
  plan: planSchema,
  created: z.boolean(),
});

export type CreatePlanOutput = z.infer<typeof createPlanOutputSchema>;

/** `GET /projects/{id}/plans`: newest Plan (highest number) first. */
export const listPlansInputSchema = z.strictObject({
  id: idSchema,
  status: planStatusSchema.optional(),
  ...paginationInputShape,
});

export type ListPlansInput = z.input<typeof listPlansInputSchema>;

export const planPageSchema = pageSchema(planSummarySchema);

export type PlanPage = z.infer<typeof planPageSchema>;

/** `GET /projects/{id}/plans/{planRef}`. */
export const getPlanInputSchema = z.strictObject({
  id: idSchema,
  planRef: planRefSchema,
});

export type GetPlanInput = z.input<typeof getPlanInputSchema>;

/**
 * `PATCH /projects/{id}/plans/{planRef}`: change the title and/or body
 * (`body: null` clears it) of a Plan that is not done or abandoned. Values
 * equal to the current ones are a no-op (`changed: false`, no Event).
 */
export const updatePlanInputSchema = z
  .strictObject({
    id: idSchema,
    planRef: planRefSchema,
    title: planTitleSchema.optional(),
    body: planBodySchema.nullable().optional(),
    ...actorSessionInputShape,
  })
  .refine(
    (input) => input.title !== undefined || input.body !== undefined,
    "Provide a title or a body.",
  );

export type UpdatePlanInput = z.input<typeof updatePlanInputSchema>;

export const updatePlanOutputSchema = z.strictObject({
  plan: planSchema,
  changed: z.boolean(),
});

export type UpdatePlanOutput = z.infer<typeof updatePlanOutputSchema>;

/**
 * `POST /projects/{id}/plans/{planRef}/status`: one lifecycle transition (see
 * `PLAN_STATUSES`). The current status is a no-op; any other disallowed
 * transition, or `done` while a Task is not done or still claimed, is
 * CONFLICT. `abandoned` releases the Plan's remaining claims.
 */
export const setPlanStatusInputSchema = z.strictObject({
  id: idSchema,
  planRef: planRefSchema,
  status: targetPlanStatusSchema,
  ...actorSessionInputShape,
});

export type SetPlanStatusInput = z.input<typeof setPlanStatusInputSchema>;

export const setPlanStatusOutputSchema = z.strictObject({
  plan: planSchema,
  changed: z.boolean(),
  releasedClaimCount: countSchema,
});

export type SetPlanStatusOutput = z.infer<typeof setPlanStatusOutputSchema>;
