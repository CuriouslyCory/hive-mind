import { hostname } from "node:os";
import {
  agentNameSchema,
  HEARTBEAT_INTERVAL_SECONDS,
  hostnameSchema,
  liveSessionStatusSchema,
  MAX_COLLECTION_PATHS,
  SESSION_STATUSES,
  sessionIntentSchema,
  sessionListFilterSchema,
} from "@hivemind/contract";
import type { ApiCollectionState, ApiHeartbeat, ApiSession } from "../client.ts";
import { buildManifest, uploadCollection } from "../collection.ts";
import type { CommandContext, CommandDefinition } from "../command.ts";
import { CLI_ERROR_CODES, CliError, usageError } from "../errors.ts";
import { collectTouchedPaths, gitMetadata } from "../git.ts";
import { readTextFlags } from "../text-input.ts";
import {
  CURSOR_OPTION,
  choiceOf,
  createWithRecovery,
  creationId,
  eventLine,
  idOption,
  LIMIT_OPTION,
  PROJECT_OPTION,
  pageLines,
  pageOf,
  planRefOf,
  projectOf,
  requireUuid,
  SESSION_ENV,
  SESSION_OPTION,
  scopeLine,
  sessionLine,
  sessionOf,
  stringOption,
  taskLine,
} from "./coordination.ts";

/**
 * Sessions: one agent run in one Project, owned by the login or Project key
 * that started it. A child process cannot set its caller's environment, so
 * `session start` prints the id and an `export HIVEMIND_SESSION=...` line for
 * the caller to run; later commands take `--session` or that variable.
 */

const STATUS_OPTION = {
  type: "string",
  valueName: "status",
  description: "active or idle",
} as const;

function sessionLines(session: ApiSession): string[] {
  const git =
    session.gitBranch !== null || session.gitCommit !== null
      ? `  git ${session.gitBranch ?? "(detached)"} ${session.gitCommit ?? "(no commit)"}`
      : "";
  const attached =
    session.attachedPlanKey !== null
      ? `  attached to ${session.attachedPlanKey}${session.attachedTaskId ? ` Task ${session.attachedTaskId}` : ""}`
      : "";
  return [
    sessionLine(session),
    `started ${session.startedAt}${session.endedAt ? `  ended ${session.endedAt}` : ""}  host ${session.hostname ?? "(unknown)"}${git}${attached}`,
    ...(session.summary === null
      ? []
      : ["Summary:", ...session.summary.replace(/\n$/, "").split("\n")]),
  ];
}

/** The machine's hostname when it is valid to send, else undefined (never guessed). */
function machineName(): string | undefined {
  const name = hostname();
  return hostnameSchema.safeParse(name).success ? name : undefined;
}

export const sessionStart: CommandDefinition = {
  name: "session start",
  summary: "Start a Session and print its id",
  description: [
    "Records an agent run in the Project, with the hostname and, inside a git",
    "worktree, its branch and commit (left empty outside git). Prints the new",
    "Session's id on stdout (data.session.id with --json) and, on stderr, the",
    `'export ${SESSION_ENV}=<id>' line that makes later commands use it.`,
    `Heartbeat at least every ${HEARTBEAT_INTERVAL_SECONDS} s: a Session is stale after 5`,
    "minutes and abandoned after 30 without one.",
    "",
    "The id is generated once per run. If the answer is lost, check",
    "'hivemind session list' and retry only with --id <id>.",
  ].join("\n"),
  options: {
    agent: {
      type: "string",
      valueName: "name",
      description: "Who is working, e.g. claude-code (required)",
    },
    intent: { type: "string", valueName: "text", description: "What the run is for (required)" },
    id: idOption("Session"),
    project: PROJECT_OPTION,
  },
  examples: [
    'hivemind session start --agent claude-code --intent "Implement the parser"',
    `export ${SESSION_ENV}=$(hivemind session start --agent ci --intent "Nightly checks")`,
  ],
  async run(context) {
    const agent = stringOption(context, "agent");
    if (agent === undefined || !agentNameSchema.safeParse(agent).success) {
      throw usageError("--agent is required: 1 to 120 characters, without control characters.");
    }
    const intent = stringOption(context, "intent");
    if (intent === undefined || !sessionIntentSchema.safeParse(intent).success) {
      throw usageError(
        "--intent is required: 1 to 2048 characters on one line, without control characters.",
      );
    }
    const sessionId = creationId(context);
    const projectId = await projectOf(context);
    const git = await gitMetadata(context.cwd, context.env);
    const api = await context.api();
    const result = await createWithRecovery(
      context,
      { what: "Session", id: sessionId, inspect: `hivemind session show ${sessionId}` },
      () =>
        api.startSession(projectId, {
          sessionId,
          agent,
          intent,
          hostname: machineName(),
          gitBranch: git.branch ?? undefined,
          gitCommit: git.commit ?? undefined,
        }),
    );
    const id = result.session.id;
    context.report.info(`${result.created ? "Started" : "Found existing"} Session ${id}.`);
    if (git.root === null) {
      context.report.info("Not in a git worktree: no branch or commit recorded.");
    }
    context.report.info(`Use it in this shell: export ${SESSION_ENV}=${id}`);
    return { data: result, human: [id] };
  },
};

interface HeartbeatData {
  /** The heartbeat's answer; null with --collection-id, which sends none. */
  heartbeat: ApiHeartbeat | null;
  collection: ApiCollectionState | null;
  touchedPathsAvailable: boolean;
  /** Whether this run renewed the Session and its claims. */
  leaseRenewed: boolean;
  collectionId: string;
  pathCount: number | null;
  omittedPathCount: number | null;
  overCapacityPathCount: number;
  collectionError: { step: string; code: string; message: string } | null;
}

function heartbeatLines(data: HeartbeatData, sessionId: string): string[] {
  const lines: string[] = [];
  const beat = data.heartbeat;
  if (beat) {
    const renewed = beat.renewedClaims.items.length;
    lines.push(
      `Heartbeat: Session ${sessionId} is ${beat.session.status}; renewed ${renewed}${beat.renewedClaims.complete ? "" : "+"} claims${beat.leaseExpiresAt ? ` until ${beat.leaseExpiresAt}` : ""}.`,
    );
  } else lines.push(`Resumed collection ${data.collectionId} of Session ${sessionId}.`);
  if (!data.touchedPathsAvailable) {
    lines.push("Touched paths: unavailable (not a git worktree).");
  } else if (data.collectionError === null && data.collection) {
    lines.push(
      `Touched paths: ${data.pathCount ?? 0} uploaded${data.omittedPathCount ? `, ${data.omittedPathCount} omitted` : ""}; collection ${data.collection.collectionComplete ? "complete" : "incomplete"}.`,
    );
  } else lines.push(`Touched paths: upload unfinished (collection ${data.collectionId}).`);
  const complete = data.collection?.scopeComplete ?? false;
  lines.push(`Scope coverage: ${complete ? "complete" : "incomplete"}.`);
  return lines;
}

async function heartbeatRun(context: CommandContext) {
  const sessionId = sessionOf(context);
  const resumeId = stringOption(context, "collection-id");
  const statusFlag = stringOption(context, "status");
  if (resumeId !== undefined) {
    requireUuid(resumeId, "--collection-id");
    if (statusFlag !== undefined) {
      throw usageError("--status cannot be used with --collection-id, which sends no heartbeat.");
    }
  }
  const status =
    statusFlag === undefined
      ? undefined
      : choiceOf(statusFlag, liveSessionStatusSchema.options, "--status");
  const projectId = await projectOf(context);
  const api = await context.api();

  // Renew first, before any git work: the server opens the collection and
  // records its coverage as incomplete until finalize.
  let heartbeat: ApiHeartbeat | null = null;
  if (resumeId === undefined) {
    heartbeat = await api.heartbeatSession(projectId, { sessionId, status });
    if (heartbeat.releasedClaims.items.length > 0) {
      context.report.warn(
        `Released ${heartbeat.releasedClaims.items.length} expired claims: ${heartbeat.releasedClaims.items.join(", ")}. Claim them again to keep working on them.`,
      );
    }
  }
  const collectionId = (resumeId ?? heartbeat?.collectionId) as string;
  const data: HeartbeatData = {
    heartbeat,
    collection: null,
    touchedPathsAvailable: false,
    leaseRenewed: heartbeat !== null,
    collectionId,
    pathCount: null,
    omittedPathCount: null,
    overCapacityPathCount: 0,
    collectionError: null,
  };
  const resume = `hivemind session heartbeat --session ${sessionId} --collection-id ${collectionId}`;
  const renewal = heartbeat
    ? "The heartbeat itself succeeded (leases renewed)."
    : "No heartbeat was sent.";
  // The next heartbeat replaces an unfinished collection, which marks the
  // Session's Scope history incomplete for good (docs/cli.md, "Resuming an
  // upload"), so the only safe remedy is a resume before then.
  const resumeFirst = `Resume with '${resume}' before the next heartbeat (pause any heartbeat loop first), while the worktree is unchanged. A new heartbeat instead of a resume leaves this Session's Scope coverage incomplete until it ends; only a new Session resets it.`;

  const touched = await collectTouchedPaths(context.cwd, context.env);
  if (!touched.available) {
    if (resumeId !== undefined) {
      throw usageError("--collection-id needs a git worktree to collect touched paths from.");
    }
    context.report.warn(
      "Not a git worktree: touched paths cannot be collected, so this Session's Scope coverage stays incomplete. Declare what you work on with 'hivemind scope add'.",
    );
    return { data, human: heartbeatLines(data, sessionId) };
  }
  data.touchedPathsAvailable = true;
  if ("failure" in touched) {
    data.collectionError = { step: "collect", code: CLI_ERROR_CODES.io, message: touched.failure };
    if (resumeId !== undefined) {
      throw new CliError(CLI_ERROR_CODES.io, `Cannot collect touched paths: ${touched.failure}.`);
    }
    context.report.warn(
      `Cannot collect touched paths: ${touched.failure}. ${renewal} ${resumeFirst}`,
    );
    return { data, human: heartbeatLines(data, sessionId) };
  }

  const manifest = await buildManifest(touched.selection);
  data.pathCount = manifest.pathCount;
  data.omittedPathCount = manifest.omittedPathCount;
  if (manifest.omittedPathCount > 0) {
    context.report.warn(
      `${manifest.omittedPathCount} changed paths cannot be sent (not UTF-8, longer than 256 bytes, or beyond the first ${MAX_COLLECTION_PATHS.toLocaleString("en-US")} paths); this Session's Scope coverage is incomplete from now on.`,
    );
  }
  const upload = await uploadCollection(api, { projectId, sessionId, collectionId }, manifest);
  data.collection = upload.collection;
  data.overCapacityPathCount = upload.overCapacityPathCount;
  if (upload.overCapacityPathCount > 0) {
    context.report.warn(
      `${upload.overCapacityPathCount} paths were not stored: the Session holds the most touched Scopes it can. Its coverage is incomplete from now on; start a new Session to reset it.`,
    );
  }
  if (upload.error) {
    data.collectionError = upload.error;
    const failed = `Touched-path upload failed at ${upload.error.step} (${upload.error.code}): ${upload.error.message}`;
    if (resumeId !== undefined || upload.error.code === CLI_ERROR_CODES.cancelled) {
      throw new CliError(upload.error.code, failed, {
        hint: `${renewal} ${resumeFirst}`,
      });
    }
    context.report.warn(`${failed}. ${renewal} ${resumeFirst}`);
  }
  return { data, human: heartbeatLines(data, sessionId) };
}

export const sessionHeartbeat: CommandDefinition = {
  name: "session heartbeat",
  summary: "Keep a Session live and report its touched paths",
  description: [
    "First renews the Session and its unexpired claims; that answer opens a",
    "touched-path collection. Then lists the worktree's changed paths with",
    "git (modified, added, deleted, untracked, both names of renames), and",
    "uploads them in sorted batches of at most 16 paths before finalizing.",
    "Outside git the heartbeat still works; touched paths are reported as",
    "unavailable and the Session's Scope coverage stays incomplete.",
    "",
    "A failed upload after a successful renewal is a warning on stderr and",
    "data.collectionError with exit 0; data.leaseRenewed says whether the",
    "renewal happened. --collection-id <id> resumes that upload (manifest,",
    "batches, finalize) without sending a heartbeat; it only succeeds while",
    "the worktree is unchanged and no newer heartbeat replaced the collection.",
  ].join("\n"),
  options: {
    status: { ...STATUS_OPTION, description: "Also set the Session active or idle" },
    "collection-id": {
      type: "string",
      valueName: "id",
      description: "Resume uploading this collection instead of sending a heartbeat",
    },
    session: SESSION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: [
    "hivemind session heartbeat",
    "hivemind session heartbeat --status idle --json",
    "hivemind session heartbeat --collection-id 9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
  ],
  run: heartbeatRun,
};

export const sessionUpdate: CommandDefinition = {
  name: "session update",
  summary: "Change a Session's agent, intent, status or git metadata",
  description: [
    "Changes only what is given. --git rereads the branch and commit from the",
    "current worktree (cleared outside git). --status sets active or idle.",
  ].join("\n"),
  options: {
    agent: { type: "string", valueName: "name", description: "New agent name" },
    intent: { type: "string", valueName: "text", description: "New intent" },
    status: STATUS_OPTION,
    git: { type: "boolean", description: "Record the worktree's current branch and commit" },
    session: SESSION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: ['hivemind session update --intent "Now fixing the tests" --git'],
  async run(context) {
    const sessionId = sessionOf(context);
    const agent = stringOption(context, "agent");
    if (agent !== undefined && !agentNameSchema.safeParse(agent).success) {
      throw usageError("--agent must be 1 to 120 characters, without control characters.");
    }
    const intent = stringOption(context, "intent");
    if (intent !== undefined && !sessionIntentSchema.safeParse(intent).success) {
      throw usageError("--intent must be 1 to 2048 characters, without control characters.");
    }
    const statusFlag = stringOption(context, "status");
    const status =
      statusFlag === undefined
        ? undefined
        : choiceOf(statusFlag, liveSessionStatusSchema.options, "--status");
    const refreshGit = context.options.git === true;
    if (agent === undefined && intent === undefined && status === undefined && !refreshGit) {
      throw usageError("Nothing to change: pass --agent, --intent, --status or --git.");
    }
    const projectId = await projectOf(context);
    const git = refreshGit ? await gitMetadata(context.cwd, context.env) : null;
    const result = await (await context.api()).updateSession(projectId, {
      sessionId,
      agent,
      intent,
      status,
      ...(git ? { gitBranch: git.branch, gitCommit: git.commit } : {}),
    });
    return {
      data: result,
      human: [
        result.changed ? `Updated Session ${sessionId}.` : "No change.",
        ...sessionLines(result.session),
      ],
    };
  },
};

export const sessionAttach: CommandDefinition = {
  name: "session attach",
  summary: "Set the Plan or Task a Session is focused on",
  description: [
    "Context only: attaching neither claims nor releases a Task. --task needs",
    "the --plan it belongs to; --detach clears both.",
  ].join("\n"),
  options: {
    plan: { type: "string", valueName: "plan", description: "Plan key (PLAN-12) or id" },
    task: { type: "string", valueName: "taskId", description: "Task id within that Plan" },
    detach: { type: "boolean", description: "Clear the attached Plan and Task" },
    session: SESSION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: ["hivemind session attach --plan PLAN-3", "hivemind session attach --detach"],
  async run(context) {
    const sessionId = sessionOf(context);
    const plan = stringOption(context, "plan");
    const task = stringOption(context, "task");
    const detach = context.options.detach === true;
    if (detach && (plan !== undefined || task !== undefined)) {
      throw usageError("--detach cannot be used with --plan or --task.");
    }
    if (!detach && plan === undefined) {
      throw usageError(
        task === undefined
          ? "Pass --plan <plan> (and optionally --task <id>), or --detach."
          : "--task needs --plan.",
      );
    }
    const planRef = plan === undefined ? null : planRefOf(plan);
    const taskId = task === undefined ? undefined : requireUuid(task, "--task");
    const projectId = await projectOf(context);
    const result = await (await context.api()).attachSession(projectId, {
      sessionId,
      planRef,
      ...(taskId === undefined ? {} : { taskId }),
    });
    const session = result.session;
    return {
      data: result,
      human: [
        session.attachedPlanKey === null
          ? `Session ${sessionId} is not attached.`
          : `Session ${sessionId} is attached to ${session.attachedPlanKey}${session.attachedTaskId ? ` Task ${session.attachedTaskId}` : ""}.`,
      ],
    };
  },
};

export const sessionEnd: CommandDefinition = {
  name: "session end",
  summary: "End a Session with a summary",
  description: [
    "Records the summary (at most 8 KiB), ends the Session and releases its",
    "claims; Task progress is kept. Repeating the same end is a no-op; a",
    "different summary afterwards is CONFLICT (exit 2).",
  ].join("\n"),
  options: {
    summary: { type: "string", valueName: "markdown", description: "What the run did" },
    "summary-file": {
      type: "string",
      valueName: "path",
      description: "Read the summary from a file, or from stdin with -",
    },
    session: SESSION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: ['hivemind session end --summary "Parser done; tests in PLAN-3 still open."'],
  async run(context) {
    const sessionId = sessionOf(context);
    const summary = await readTextFlags(context, { text: "summary", file: "summary-file" });
    if (summary === undefined) {
      throw usageError("A summary is required: --summary or --summary-file.");
    }
    const projectId = await projectOf(context);
    const result = await (await context.api()).endSession(projectId, { sessionId, summary });
    const released = result.releasedClaims.items.length;
    return {
      data: result,
      human: [
        result.changed
          ? `Ended Session ${sessionId} (${result.session.status}); released ${released} claims.`
          : `Session ${sessionId} had already ended with this summary.`,
      ],
    };
  },
};

export const sessionList: CommandDefinition = {
  name: "session list",
  summary: "List a Project's Sessions, newest first (one page)",
  options: {
    status: {
      type: "string",
      valueName: "filter",
      description: `live, terminal, or one status: ${SESSION_STATUSES.join(", ")}`,
    },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    project: PROJECT_OPTION,
  },
  examples: [
    "hivemind session list --status live",
    "hivemind session list --status terminal --json",
  ],
  async run(context) {
    const status = stringOption(context, "status");
    const input = {
      ...pageOf(context),
      ...(status === undefined
        ? {}
        : { status: choiceOf(status, sessionListFilterSchema.options, "--status") }),
    };
    const projectId = await projectOf(context);
    const page = await (await context.api()).listSessions(projectId, input);
    return { data: page, human: pageLines(page, sessionLine, "No Sessions.") };
  },
};

/** The Session given as `<sessionId>` or by `--session`/`HIVEMIND_SESSION`. */
function shownSessionOf(context: CommandContext): string {
  const positional = context.args[0];
  if (positional !== undefined && context.options.session !== undefined) {
    throw usageError("Give the Session either as <sessionId> or with --session, not both.");
  }
  return positional === undefined ? sessionOf(context) : requireUuid(positional, "<sessionId>");
}

export const sessionShow: CommandDefinition = {
  name: "session show",
  summary: "Show a Session with its claims, Scopes and recent Events",
  description: [
    "Any Session of the Project; default: --session, then HIVEMIND_SESSION.",
    "Shows the first page of its claims, Scopes and Events. Claims are oldest",
    "first and Events newest first;",
    "each has its own nextCursor in --json output. Page through claims with",
    "'hivemind session claims', Events with 'hivemind session log', and Scopes",
    "with 'hivemind scope list'.",
  ].join("\n"),
  args: [{ name: "sessionId", description: "The Session's id" }],
  options: { limit: LIMIT_OPTION, session: SESSION_OPTION, project: PROJECT_OPTION },
  examples: ["hivemind session show", "hivemind session show 3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"],
  async run(context) {
    const sessionId = shownSessionOf(context);
    const page = pageOf(context);
    const projectId = await projectOf(context);
    const api = await context.api();
    const session = await api.getSession(projectId, sessionId);
    const [claims, scopes, events] = await Promise.all([
      api.listSessionClaims(projectId, sessionId, page),
      api.listSessionScopes(projectId, sessionId, page),
      api.listSessionEvents(projectId, sessionId, page),
    ]);
    const more = (command: string, cursor: string | null) =>
      `More: hivemind ${command} --session ${sessionId} --cursor ${cursor}`;
    return {
      data: { session, claims, scopes, events },
      human: [
        ...sessionLines(session),
        "",
        "Claims:",
        ...pageLines(claims, taskLine, "None.", more("session claims", claims.nextCursor)),
        "",
        "Scopes:",
        ...pageLines(scopes, scopeLine, "None.", more("scope list", scopes.nextCursor)),
        "",
        "Events:",
        ...pageLines(events, eventLine, "None.", more("session log", events.nextCursor)),
      ],
    };
  },
};

export const sessionLog: CommandDefinition = {
  name: "session log",
  summary: "List a Session's Events, newest first (one page)",
  description: [
    "Any Session of the Project; default: --session, then HIVEMIND_SESSION.",
    "Lists the Session's Events (heartbeats, claims, Scopes, status changes),",
    "newest first. Pass nextCursor to --cursor for older Events.",
  ].join("\n"),
  args: [{ name: "sessionId", description: "The Session's id" }],
  options: {
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    session: SESSION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: [
    "hivemind session log",
    "hivemind session log 3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f --limit 100 --json",
  ],
  async run(context) {
    const sessionId = shownSessionOf(context);
    const page = pageOf(context);
    const projectId = await projectOf(context);
    const events = await (await context.api()).listSessionEvents(projectId, sessionId, page);
    return { data: events, human: pageLines(events, eventLine, "No Events.") };
  },
};

export const sessionClaims: CommandDefinition = {
  name: "session claims",
  summary: "List the Tasks a Session holds claims on, oldest claim first (one page)",
  description: [
    "Any Session of the Project; default: --session, then HIVEMIND_SESSION.",
    "Pass nextCursor to --cursor for the next page of claims.",
    "A 400 on --cursor means the claim it pointed at has ended; start again without --cursor.",
  ].join("\n"),
  args: [{ name: "sessionId", description: "The Session's id" }],
  options: {
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    session: SESSION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: ["hivemind session claims", "hivemind session claims --limit 100 --json"],
  async run(context) {
    const sessionId = shownSessionOf(context);
    const page = pageOf(context);
    const projectId = await projectOf(context);
    const claims = await (await context.api()).listSessionClaims(projectId, sessionId, page);
    return { data: claims, human: pageLines(claims, taskLine, "No claims.") };
  },
};
