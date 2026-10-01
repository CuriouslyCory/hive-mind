import { taskTitleSchema } from "@hivemind/contract";
import type { TaskAction } from "../client.ts";
import type { ArgSpec, CommandDefinition, OptionSpec } from "../command.ts";
import { usageError } from "../errors.ts";
import { readTextFlags } from "../text-input.ts";
import {
  claimText,
  createWithRecovery,
  creationId,
  idOption,
  optionalSessionOf,
  PROJECT_OPTION,
  planRefOf,
  projectOf,
  requireUuid,
  SESSION_OPTION,
  sessionOf,
  stringOption,
} from "./coordination.ts";

/**
 * Tasks: steps of a Plan, addressed by UUID. Work on a Task (claim, release,
 * start, block, done) goes through the caller's own live Session, from
 * `--session` or HIVEMIND_SESSION. A claim held by another live Session is
 * CONFLICT (exit 2); its message names the holder's Session and intent.
 */

const TASK_ARG: ArgSpec = {
  name: "taskId",
  description: "The Task's id (from 'hivemind plan show')",
  required: true,
};

const WORK_OPTIONS = {
  session: SESSION_OPTION,
  project: PROJECT_OPTION,
} as const satisfies Record<string, OptionSpec>;

function taskIdOf(value: string): string {
  return requireUuid(value, "<taskId>", "Run 'hivemind plan show <plan>' to see Task ids.");
}

export const taskAdd: CommandDefinition = {
  name: "task add",
  summary: "Add a Task to a Plan",
  description: [
    "Appends a Task (status todo) to a Plan that is not done or abandoned and",
    "prints its id. The id is generated once per run; after a lost answer,",
    "check 'hivemind plan show <plan>' and retry only with --id <id>.",
  ].join("\n"),
  args: [{ name: "plan", description: "Plan key (PLAN-12) or id", required: true }],
  options: {
    title: { type: "string", valueName: "title", description: "Task title (required)" },
    id: idOption("Task"),
    session: {
      ...SESSION_OPTION,
      description: "Attribute the change to this Session (default: HIVEMIND_SESSION, if set)",
    },
    project: PROJECT_OPTION,
  },
  examples: ['hivemind task add PLAN-3 --title "Write the parser"'],
  async run(context) {
    const planRef = planRefOf(context.args[0] as string);
    const title = stringOption(context, "title");
    if (title === undefined || !taskTitleSchema.safeParse(title).success) {
      throw usageError("--title is required: 1 to 120 characters, without control characters.");
    }
    const taskId = creationId(context);
    const sessionId = optionalSessionOf(context);
    const projectId = await projectOf(context);
    const api = await context.api();
    const result = await createWithRecovery(
      context,
      { what: "Task", id: taskId, inspect: `hivemind plan show ${planRef}` },
      () => api.addTask(projectId, { planRef, taskId, title, sessionId }),
    );
    context.report.info(
      `${result.created ? "Added" : "Found existing"} Task to ${result.task.planKey}: ${result.task.title}`,
    );
    return { data: result, human: [result.task.id] };
  },
};

export const taskClaim: CommandDefinition = {
  name: "task claim",
  summary: "Claim a Task for your Session",
  description: [
    "Claims the Task for a 5-minute lease that 'hivemind session heartbeat'",
    "renews. It succeeds when the Task is unclaimed, its lease expired or its",
    "holder is no longer live; claiming your own valid claim again is a no-op.",
    "A claim held by another live Session is CONFLICT (exit 2), unless --steal",
    "takes it over; the takeover is recorded with the former holder.",
  ].join("\n"),
  args: [TASK_ARG],
  options: {
    steal: { type: "boolean", description: "Take over a claim another live Session holds" },
    ...WORK_OPTIONS,
  },
  examples: ["hivemind task claim 7a2e3d4c-5b6a-4f90-8b1c-2d3e4f5a6b7c"],
  async run(context) {
    const taskId = taskIdOf(context.args[0] as string);
    const sessionId = sessionOf(context);
    const steal = context.options.steal === true;
    const projectId = await projectOf(context);
    const result = await (await context.api()).claimTask(projectId, {
      taskId,
      sessionId,
      ...(steal ? { steal } : {}),
    });
    if (result.stolenFromSessionId !== null) {
      context.report.warn(`Took the claim over from Session ${result.stolenFromSessionId}.`);
    }
    return {
      data: result,
      human: [
        `${result.changed ? "Claimed" : "Already claimed"} ${result.task.id} (${result.task.title}), ${claimText(result.task)}.`,
      ],
    };
  },
};

function actionCommand(
  action: TaskAction,
  summary: string,
  description: string,
  done: string,
): CommandDefinition {
  return {
    name: `task ${action}`,
    summary,
    description,
    args: [TASK_ARG],
    options: WORK_OPTIONS,
    examples: [`hivemind task ${action} 7a2e3d4c-5b6a-4f90-8b1c-2d3e4f5a6b7c`],
    async run(context) {
      const taskId = taskIdOf(context.args[0] as string);
      const sessionId = sessionOf(context);
      const projectId = await projectOf(context);
      const result = await (await context.api()).taskAction(projectId, action, {
        taskId,
        sessionId,
      });
      return {
        data: result,
        human: [
          result.changed
            ? `${done} ${result.task.id} (${result.task.title}); it is ${result.task.status}.`
            : `No change: ${result.task.id} is ${result.task.status}, ${claimText(result.task)}.`,
        ],
      };
    },
  };
}

export const taskRelease = actionCommand(
  "release",
  "Release your claim on a Task",
  "Clears your claim and keeps the Task's status. Releasing an unclaimed Task is a no-op; another Session's claim is CONFLICT (exit 2).",
  "Released",
);

export const taskStart = actionCommand(
  "start",
  "Start a Task you have claimed",
  "Moves a todo or blocked Task to in_progress. Needs your unexpired claim and an active Plan.",
  "Started",
);

export const taskDone = actionCommand(
  "done",
  "Finish a Task you have claimed",
  "Marks the Task done and clears your claim. Needs your unexpired claim.",
  "Finished",
);

export const taskBlock: CommandDefinition = {
  name: "task block",
  summary: "Mark a Task you have claimed as blocked",
  description: "Records why the Task is blocked (at most 8 KiB) and keeps your claim.",
  args: [TASK_ARG],
  options: {
    reason: { type: "string", valueName: "text", description: "Why the Task is blocked" },
    "reason-file": {
      type: "string",
      valueName: "path",
      description: "Read the reason from a file, or from stdin with -",
    },
    ...WORK_OPTIONS,
  },
  examples: [
    'hivemind task block 7a2e3d4c-5b6a-4f90-8b1c-2d3e4f5a6b7c --reason "Waits for the schema change"',
  ],
  async run(context) {
    const taskId = taskIdOf(context.args[0] as string);
    const sessionId = sessionOf(context);
    const reason = await readTextFlags(context, { text: "reason", file: "reason-file" });
    if (reason === undefined) throw usageError("A reason is required: --reason or --reason-file.");
    const projectId = await projectOf(context);
    const result = await (await context.api()).blockTask(projectId, { taskId, sessionId, reason });
    return {
      data: result,
      human: [
        result.changed
          ? `Blocked ${result.task.id} (${result.task.title}).`
          : `No change: ${result.task.id} is already blocked for that reason.`,
      ],
    };
  },
};
