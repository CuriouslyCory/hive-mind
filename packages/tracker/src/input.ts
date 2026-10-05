import {
  TRACKER_BLOG_STATUSES,
  TRACKER_ISSUE_STATES,
  TRACKER_SCAN_KINDS,
} from "@hivemind/db/schema";
import { z } from "zod";

// The input of every tracker command. The page's server action and the CLI
// pass raw values through these schemas, so both get the same limits. Objects
// are strict: an unknown key (a misspelled field in an agent's JSON) is an
// error, not silently dropped.

const shortText = z.string().trim().min(1).max(250);
const longText = z.string().trim().min(1).max(20_000);
/** Optional prose: null, or trimmed text. An empty string is stored as null. */
const optionalText = z
  .string()
  .trim()
  .max(20_000)
  .nullable()
  .transform((value) => value || null);
const prNumbers = z
  .array(z.number().int().positive())
  .max(100)
  .transform((numbers) => [...new Set(numbers)]);
const sortOrder = z.number().int().min(0).max(10_000);
const rowId = z.uuid();
/** The row's `updatedAt` as it was read; the write is refused if the row changed since. */
const updatedAt = z.iso.datetime({ offset: true });
const dateOnly = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const issueNumber = z.number().int().positive();
const publishedUrl = z
  .union([z.httpUrl(), z.literal("")])
  .nullable()
  .transform((value) => value || null);
const commitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "Expected a full 40-character lowercase commit SHA")
  .nullable();

const stepFields = {
  key: shortText,
  label: shortText,
  prompt: optionalText,
  sortOrder,
};

export const saveChangelogEntryInput = z.strictObject({
  id: rowId.optional(),
  updatedAt: updatedAt.optional(),
  date: dateOnly,
  category: shortText,
  title: shortText,
  summary: longText,
  prNumbers,
});

export const deleteChangelogEntryInput = z.strictObject({
  id: rowId,
  updatedAt: updatedAt.optional(),
});

export const saveBlogIdeaInput = z
  .strictObject({
    id: rowId.optional(),
    // Required with id: blog ideas are never overwritten blind.
    updatedAt: updatedAt.optional(),
    title: shortText,
    pitch: longText,
    notes: optionalText,
    prNumbers,
    status: z.enum(TRACKER_BLOG_STATUSES),
    // The publication date; null while unpublished, or to keep the stored one.
    publishedAt: dateOnly.nullable(),
    publishedUrl,
    sortOrder,
  })
  .refine((input) => input.id === undefined || input.updatedAt !== undefined, {
    path: ["updatedAt"],
    message: "Required when id is given",
  });

export const deleteBlogIdeaInput = z.strictObject({
  id: rowId,
  updatedAt,
});

export const savePhaseInput = z.strictObject({
  id: rowId.optional(),
  updatedAt: updatedAt.optional(),
  title: shortText,
  description: optionalText,
  sortOrder,
});

export const deletePhaseInput = z.strictObject({
  id: rowId,
  updatedAt: updatedAt.optional(),
});

export const saveIssueInput = z
  .strictObject({
    mode: z.enum(["create", "update"]),
    issueNumber,
    updatedAt: updatedAt.optional(),
    title: shortText,
    note: optionalText,
    phaseId: rowId,
    sortOrder,
    state: z.enum(TRACKER_ISSUE_STATES),
    githubUpdatedAt: dateTime.nullable(),
    // Create only. Omitted, the issue gets defaultBacklogSteps.
    steps: z.array(z.strictObject(stepFields)).max(50).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.mode === "update" && input.steps !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Only allowed with mode create; use save-step to change steps",
      });
    }
    if (input.mode === "create" && input.updatedAt !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Only allowed with mode update",
      });
    }
    const keys = input.steps?.map((step) => step.key) ?? [];
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "Step keys must be unique" });
    }
  });

export const deleteIssueInput = z.strictObject({
  issueNumber,
  updatedAt: updatedAt.optional(),
});

export const saveStepInput = z.strictObject({
  id: rowId.optional(),
  updatedAt: updatedAt.optional(),
  issueNumber,
  ...stepFields,
});

export const deleteStepInput = z.strictObject({
  id: rowId,
  updatedAt: updatedAt.optional(),
});

export const setStepCompleteInput = z.strictObject({
  id: rowId,
  complete: z.boolean(),
});

export const recordScanInput = z.strictObject({
  kind: z.enum(TRACKER_SCAN_KINDS),
  // Inclusive source cursor, not the completion time.
  throughAt: dateTime,
  throughSha: commitSha,
  note: optionalText,
});

export const trackerInputSchemas = {
  "save-changelog-entry": saveChangelogEntryInput,
  "delete-changelog-entry": deleteChangelogEntryInput,
  "save-blog-idea": saveBlogIdeaInput,
  "delete-blog-idea": deleteBlogIdeaInput,
  "save-phase": savePhaseInput,
  "delete-phase": deletePhaseInput,
  "save-issue": saveIssueInput,
  "delete-issue": deleteIssueInput,
  "save-step": saveStepInput,
  "delete-step": deleteStepInput,
  "set-step-complete": setStepCompleteInput,
  "record-scan": recordScanInput,
} as const;

export const TRACKER_COMMAND_NAMES = [
  "save-changelog-entry",
  "delete-changelog-entry",
  "save-blog-idea",
  "delete-blog-idea",
  "save-phase",
  "delete-phase",
  "save-issue",
  "delete-issue",
  "save-step",
  "delete-step",
  "set-step-complete",
  "record-scan",
] as const satisfies readonly (keyof typeof trackerInputSchemas)[];
export type TrackerCommandName = (typeof TRACKER_COMMAND_NAMES)[number];

export function isTrackerCommandName(value: unknown): value is TrackerCommandName {
  return (TRACKER_COMMAND_NAMES as readonly unknown[]).includes(value);
}

/** What a caller sends for a command (before trimming and defaults). */
export type TrackerCommandInput<N extends TrackerCommandName> = z.input<
  (typeof trackerInputSchemas)[N]
>;

/** The input of `batch`: the commands to run, in order, in one transaction. */
export const batchInput = z
  .array(z.strictObject({ command: z.enum(TRACKER_COMMAND_NAMES), input: z.unknown() }))
  .min(1)
  .max(500);
/** One command of a `batch`, typed by its name. */
export type TrackerBatchCommand = {
  [N in TrackerCommandName]: { command: N; input: TrackerCommandInput<N> };
}[TrackerCommandName];
