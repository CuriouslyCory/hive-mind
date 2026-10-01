import {
  initialPlanStatusSchema,
  PLAN_STATUSES,
  planTitleSchema,
  TASK_STATUSES,
  targetPlanStatusSchema,
} from "@hivemind/contract";
import type { ApiPlan } from "../client.ts";
import type { CommandDefinition, OptionSpec } from "../command.ts";
import { usageError } from "../errors.ts";
import { readTextFlags } from "../text-input.ts";
import {
  CURSOR_OPTION,
  choiceOf,
  createWithRecovery,
  creationId,
  eventLine,
  idOption,
  LIMIT_OPTION,
  optionalSessionOf,
  PROJECT_OPTION,
  pageLines,
  pageOf,
  planLine,
  planRefOf,
  projectOf,
  SESSION_OPTION,
  stringOption,
  taskLine,
} from "./coordination.ts";

/**
 * Plans: a Project's units of coordinated work, named `PLAN-<n>` within the
 * Project or by UUID. Writes accept `--session` (or HIVEMIND_SESSION) only to
 * attribute their Event to one of the caller's Sessions.
 */

const PLAN_ARG = {
  name: "plan",
  description: "Plan key (PLAN-12) or id",
  required: true,
} as const;

const ATTRIBUTION_OPTION = {
  ...SESSION_OPTION,
  description: "Attribute the change to this Session (default: HIVEMIND_SESSION, if set)",
} as const satisfies OptionSpec;

const BODY_OPTIONS = {
  body: { type: "string", valueName: "markdown", description: "Plan body (at most 8 KiB)" },
  "body-file": {
    type: "string",
    valueName: "path",
    description: "Read the body from a file, or from stdin with -",
  },
} as const satisfies Record<string, OptionSpec>;

function titleOf(value: string | undefined, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw usageError("--title is required: 1 to 120 characters.");
    return undefined;
  }
  if (!planTitleSchema.safeParse(value).success) {
    throw usageError("--title must be 1 to 120 characters, without control characters.");
  }
  return value;
}

function planLines(plan: ApiPlan): string[] {
  return [
    `${plan.key}  ${plan.title}`,
    `id ${plan.id}  status ${plan.status}  ${plan.progress.done}/${plan.progress.total} Tasks done (${plan.progress.inProgress} in progress, ${plan.progress.blocked} blocked, ${plan.progress.todo} to do)`,
    ...(plan.body === null ? [] : ["", ...plan.body.replace(/\n$/, "").split("\n")]),
  ];
}

export const planList: CommandDefinition = {
  name: "plan list",
  summary: "List a Project's Plans, newest first (one page)",
  options: {
    status: {
      type: "string",
      valueName: "status",
      description: `Only Plans in this status: ${PLAN_STATUSES.join(", ")}`,
    },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    project: PROJECT_OPTION,
  },
  examples: ["hivemind plan list --status active", "hivemind plan list --limit 100 --json"],
  async run(context) {
    const status = stringOption(context, "status");
    const input = {
      ...pageOf(context),
      ...(status === undefined ? {} : { status: choiceOf(status, PLAN_STATUSES, "--status") }),
    };
    const projectId = await projectOf(context);
    const page = await (await context.api()).listPlans(projectId, input);
    return { data: page, human: pageLines(page, planLine, "No Plans.") };
  },
};

export const planShow: CommandDefinition = {
  name: "plan show",
  summary: "Show a Plan with one page of its Tasks",
  description: [
    "Prints the Plan and the first page of its Tasks (by position). Follow",
    "tasks.nextCursor with --cursor for more; 'hivemind plan log' shows the",
    "Plan's activity.",
  ].join("\n"),
  args: [PLAN_ARG],
  options: {
    "task-status": {
      type: "string",
      valueName: "status",
      description: `Only Tasks in this status: ${TASK_STATUSES.join(", ")}`,
    },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    project: PROJECT_OPTION,
  },
  examples: ["hivemind plan show PLAN-3", "hivemind plan show PLAN-3 --task-status todo --json"],
  async run(context) {
    const planRef = planRefOf(context.args[0] as string);
    const taskStatus = stringOption(context, "task-status");
    const input = {
      ...pageOf(context),
      ...(taskStatus === undefined
        ? {}
        : { status: choiceOf(taskStatus, TASK_STATUSES, "--task-status") }),
    };
    const projectId = await projectOf(context);
    const api = await context.api();
    const plan = await api.getPlan(projectId, planRef);
    const tasks = await api.listPlanTasks(projectId, plan.id, input);
    return {
      data: { plan, tasks },
      human: [...planLines(plan), "", "Tasks:", ...pageLines(tasks, taskLine, "No Tasks.")],
    };
  },
};

export const planCreate: CommandDefinition = {
  name: "plan create",
  summary: "Create a Plan",
  description: [
    "Creates a Plan in draft (or --status active) and prints its key. The",
    "Plan's id is generated once per run. If the answer is lost, the Plan may",
    "exist anyway: check 'hivemind plan show <id>' and retry only with --id <id>,",
    "which returns the existing Plan instead of creating a second one.",
  ].join("\n"),
  options: {
    title: { type: "string", valueName: "title", description: "Plan title (required)" },
    ...BODY_OPTIONS,
    status: {
      type: "string",
      valueName: "status",
      description: "Initial status: draft (default) or active",
    },
    id: idOption("Plan"),
    session: ATTRIBUTION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: [
    'hivemind plan create --title "M2 coordination" --body-file plan.md --status active',
    "cat plan.md | hivemind plan create --title Refactor --body-file -",
  ],
  async run(context) {
    const title = titleOf(stringOption(context, "title"), true) as string;
    const status = stringOption(context, "status");
    const initial =
      status === undefined
        ? undefined
        : choiceOf(status, initialPlanStatusSchema.options, "--status");
    const planId = creationId(context);
    const sessionId = optionalSessionOf(context);
    const body = await readTextFlags(context, { text: "body", file: "body-file" });
    const projectId = await projectOf(context);
    const api = await context.api();
    const result = await createWithRecovery(
      context,
      { what: "Plan", id: planId, inspect: `hivemind plan show ${planId}` },
      () => api.createPlan(projectId, { planId, title, body, status: initial, sessionId }),
    );
    const verb = result.created ? "Created" : "Found existing";
    context.report.info(`${verb} ${result.plan.key} (${result.plan.id}), ${result.plan.status}.`);
    return { data: result, human: [result.plan.key] };
  },
};

export const planEdit: CommandDefinition = {
  name: "plan edit",
  summary: "Change a Plan's title or body",
  args: [PLAN_ARG],
  options: {
    title: { type: "string", valueName: "title", description: "New title" },
    ...BODY_OPTIONS,
    "clear-body": { type: "boolean", description: "Remove the body" },
    session: ATTRIBUTION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: [
    "hivemind plan edit PLAN-3 --body-file plan.md",
    "hivemind plan edit PLAN-3 --clear-body",
  ],
  async run(context) {
    const planRef = planRefOf(context.args[0] as string);
    const title = titleOf(stringOption(context, "title"), false);
    const clear = context.options["clear-body"] === true;
    const sessionId = optionalSessionOf(context);
    const text = await readTextFlags(context, { text: "body", file: "body-file" });
    if (clear && text !== undefined) {
      throw usageError("--clear-body cannot be used with --body or --body-file.");
    }
    const body = clear ? null : text;
    if (title === undefined && body === undefined) {
      throw usageError("Nothing to change: pass --title, --body, --body-file or --clear-body.");
    }
    const projectId = await projectOf(context);
    const result = await (await context.api()).updatePlan(projectId, {
      planRef,
      title,
      body,
      sessionId,
    });
    return {
      data: result,
      human: [
        result.changed ? `Updated ${result.plan.key}.` : `${result.plan.key} already matched.`,
      ],
    };
  },
};

export const planLog: CommandDefinition = {
  name: "plan log",
  summary: "Show a Plan's activity, or append a log entry",
  description: [
    "Without --message or --message-file, lists the Plan's Events (its",
    "activity, log entries included), newest first, one page at a time.",
    "With one of them, appends a markdown entry (at most 8 KiB), allowed in",
    "any Plan status. The entry's id is generated once per run; after a lost",
    "answer, check 'hivemind plan log <plan>' and retry only with --id <id>.",
  ].join("\n"),
  args: [PLAN_ARG],
  options: {
    message: { type: "string", valueName: "markdown", description: "Append this entry" },
    "message-file": {
      type: "string",
      valueName: "path",
      description: "Append the entry in a file, or stdin with -",
    },
    id: idOption("log entry"),
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    session: ATTRIBUTION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: [
    "hivemind plan log PLAN-3",
    'hivemind plan log PLAN-3 --message "Split the parser work into two Tasks."',
  ],
  async run(context) {
    const planRef = planRefOf(context.args[0] as string);
    const appending =
      context.options.message !== undefined || context.options["message-file"] !== undefined;
    if (!appending) {
      if (context.options.id !== undefined) {
        throw usageError("--id applies only when appending with --message or --message-file.");
      }
      const page = pageOf(context);
      const projectId = await projectOf(context);
      const events = await (await context.api()).listPlanLog(projectId, planRef, page);
      return { data: events, human: pageLines(events, eventLine, "No activity.") };
    }
    if (context.options.limit !== undefined || context.options.cursor !== undefined) {
      throw usageError("--limit and --cursor apply only when reading the log.");
    }
    const eventId = creationId(context);
    const sessionId = optionalSessionOf(context);
    const message = (await readTextFlags(context, {
      text: "message",
      file: "message-file",
    })) as string;
    const projectId = await projectOf(context);
    const api = await context.api();
    const result = await createWithRecovery(
      context,
      { what: "log entry", id: eventId, inspect: `hivemind plan log ${planRef}` },
      () => api.appendPlanLog(projectId, { planRef, eventId, message, sessionId }),
    );
    return {
      data: result,
      human: [result.created ? `Logged ${result.event.id}.` : `Already logged ${result.event.id}.`],
    };
  },
};

export const planStatus: CommandDefinition = {
  name: "plan status",
  summary: "Move a Plan to another status",
  description: [
    "Targets: active, paused, done, abandoned. Allowed: draft to active or",
    "abandoned; active to paused, done or abandoned; paused to active, done or",
    "abandoned. done needs every Task done and unclaimed; abandoned releases the",
    "remaining claims. The current status is a no-op; any other move is CONFLICT",
    "(exit 2).",
  ].join("\n"),
  args: [PLAN_ARG, { name: "status", description: "Target status", required: true }],
  options: { session: ATTRIBUTION_OPTION, project: PROJECT_OPTION },
  examples: ["hivemind plan status PLAN-3 active", "hivemind plan status PLAN-3 done --json"],
  async run(context) {
    const planRef = planRefOf(context.args[0] as string);
    const status = choiceOf(context.args[1] as string, targetPlanStatusSchema.options, "<status>");
    const sessionId = optionalSessionOf(context);
    const projectId = await projectOf(context);
    const result = await (await context.api()).setPlanStatus(projectId, {
      planRef,
      status,
      sessionId,
    });
    const released =
      result.releasedClaimCount > 0 ? ` Released ${result.releasedClaimCount} claims.` : "";
    return {
      data: result,
      human: [
        result.changed
          ? `${result.plan.key} is now ${result.plan.status}.${released}`
          : `${result.plan.key} is already ${result.plan.status}.`,
      ],
    };
  },
};
