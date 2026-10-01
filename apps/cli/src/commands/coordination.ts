/**
 * Helpers shared by the coordination commands (plan, task, session, scope,
 * status): Project and Session resolution, creation IDs, pages, and the
 * one-line human formats.
 */

import { randomUUID } from "node:crypto";
import {
  cursorSchema,
  idSchema,
  MAX_PAGE_LIMIT,
  type PlanRef,
  planRefSchema,
} from "@hivemind/contract";
import type {
  ApiEvent,
  ApiOverlap,
  ApiPage,
  ApiPlanSummary,
  ApiScope,
  ApiSession,
  ApiTask,
  PageInput,
} from "../client.ts";
import type { CommandContext, OptionSpec } from "../command.ts";
import { CliError, isCliError, UNCERTAIN_OUTCOME_CODES, usageError } from "../errors.ts";
import { resolveProjectId } from "../project-resolution.ts";

export const PROJECT_OPTION = {
  type: "string",
  valueName: "id",
  description: "Project id (default: the Project in the nearest .hivemind.json)",
} as const satisfies OptionSpec;

/** Also the variable `session start` tells the user to export. */
export const SESSION_ENV = "HIVEMIND_SESSION";

export const SESSION_OPTION = {
  type: "string",
  valueName: "id",
  description: `Session id (default: ${SESSION_ENV})`,
} as const satisfies OptionSpec;

export const LIMIT_OPTION = {
  type: "string",
  valueName: "n",
  description: `Items per page, 1-${MAX_PAGE_LIMIT} (default: the server's, 50)`,
} as const satisfies OptionSpec;

export const CURSOR_OPTION = {
  type: "string",
  valueName: "cursor",
  description: "Continue from a previous page's nextCursor",
} as const satisfies OptionSpec;

export function idOption(what: string): OptionSpec {
  return {
    type: "string",
    valueName: "uuid",
    description: `Use this id for the new ${what} (to retry a create whose answer was lost)`,
  };
}

export function stringOption(context: Pick<CommandContext, "options">, name: string) {
  const value = context.options[name];
  return typeof value === "string" ? value : undefined;
}

export async function projectOf(context: CommandContext): Promise<string> {
  const { projectId } = await resolveProjectId({
    flag: stringOption(context, "project"),
    cwd: context.cwd,
  });
  return projectId;
}

/**
 * The Session a command acts through: `--session`, then a nonempty
 * HIVEMIND_SESSION, else undefined. Never chosen from the server's live
 * Sessions. A malformed value is a usage error, whichever source it came
 * from; ownership is the server's to check.
 */
export function optionalSessionOf(context: CommandContext): string | undefined {
  const flag = stringOption(context, "session");
  const fromEnv = context.env[SESSION_ENV] ?? "";
  const value = flag ?? (fromEnv === "" ? undefined : fromEnv);
  if (value === undefined) return undefined;
  if (!idSchema.safeParse(value).success) {
    throw usageError(
      flag !== undefined
        ? "--session must be a Session id (a uuid)."
        : `${SESSION_ENV} must be a Session id (a uuid).`,
      flag !== undefined ? undefined : `Fix or unset ${SESSION_ENV}, or pass --session <id>.`,
    );
  }
  return value;
}

export function sessionOf(context: CommandContext): string {
  const sessionId = optionalSessionOf(context);
  if (sessionId === undefined) {
    throw usageError(
      `No Session: pass --session <id> or set ${SESSION_ENV}.`,
      `Start one with 'hivemind session start --agent <name> --intent <text>'.`,
    );
  }
  return sessionId;
}

export function requireUuid(value: string, what: string, hint?: string): string {
  if (!idSchema.safeParse(value).success) throw usageError(`${what} must be a uuid.`, hint);
  return value;
}

/** `PLAN-12` (any case) or a Plan UUID. */
export function planRefOf(value: string): PlanRef {
  const normalized = /^plan-/i.test(value) ? value.toUpperCase() : value;
  if (!planRefSchema.safeParse(normalized).success) {
    throw usageError("<plan> must be a Plan key such as PLAN-12, or a Plan id (a uuid).");
  }
  return normalized;
}

/** `--id` when given (validated), else a new UUID: generated once per invocation. */
export function creationId(context: CommandContext): string {
  const given = stringOption(context, "id");
  if (given === undefined) return randomUUID();
  return requireUuid(given, "--id");
}

export function pageOf(context: CommandContext): PageInput {
  const page: PageInput = {};
  const limit = stringOption(context, "limit");
  if (limit !== undefined) {
    const value = /^[1-9][0-9]{0,2}$/.test(limit) ? Number(limit) : Number.NaN;
    if (!(value >= 1 && value <= MAX_PAGE_LIMIT)) {
      throw usageError(`--limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}.`);
    }
    page.limit = value;
  }
  const cursor = stringOption(context, "cursor");
  if (cursor !== undefined) {
    if (!cursorSchema.safeParse(cursor).success) {
      throw usageError("--cursor must be a nextCursor from a previous page.");
    }
    page.cursor = cursor;
  }
  return page;
}

/** One value of a fixed set, for `--status` and similar. */
export function choiceOf<T extends string>(value: string, choices: readonly T[], flag: string): T {
  if (!(choices as readonly string[]).includes(value)) {
    throw usageError(`${flag} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}

/**
 * Runs a create whose request carries the caller-generated `id`. When the
 * answer is lost (timeout, network, cancel, unreadable), the record may exist:
 * the error names the id and how to check before retrying with `--id`, and
 * the same guidance goes to stderr in `--json` mode too. Nothing is retried.
 */
export async function createWithRecovery<T>(
  context: CommandContext,
  recovery: { what: string; id: string; inspect: string },
  create: () => Promise<T>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (isCliError(error) && UNCERTAIN_OUTCOME_CODES.has(error.code)) {
      const hint = `The ${recovery.what} may have been created anyway with id ${recovery.id}. Check with '${recovery.inspect}' before retrying, and retry only with --id ${recovery.id}.`;
      if (context.json) context.report.warn(hint);
      throw new CliError(error.code, error.message, { hint, cause: error });
    }
    throw error;
  }
}

/**
 * Human lines for one page, plus how to get the next one. `more` replaces
 * the default `--cursor` hint where the command takes no cursor.
 */
export function pageLines<T>(
  page: ApiPage<T>,
  format: (item: T) => string,
  empty: string,
  more?: string,
): string[] {
  const lines = page.items.length === 0 ? [empty] : page.items.map(format);
  if (page.nextCursor !== null) lines.push(more ?? `More: --cursor ${page.nextCursor}`);
  return lines;
}

export function planLine(plan: ApiPlanSummary): string {
  const { done, total } = plan.progress;
  return `${plan.key}  ${plan.status}  ${done}/${total} done  ${plan.title}`;
}

export function claimText(task: ApiTask): string {
  return task.claim
    ? `claimed by ${task.claim.sessionId} until ${task.claim.leaseExpiresAt}`
    : "unclaimed";
}

export function taskLine(task: ApiTask): string {
  const blocked = task.blockedReason ? `  blocked: ${firstLine(task.blockedReason)}` : "";
  return `${task.id}  ${task.planKey}  ${task.status}  ${claimText(task)}  ${task.title}${blocked}`;
}

export function sessionLine(session: ApiSession): string {
  const scope = session.scopeComplete ? "" : "  scope incomplete";
  return `${session.id}  ${session.status}  ${session.agent}  last heartbeat ${session.lastHeartbeatAt}${scope}  ${firstLine(session.intent)}`;
}

export function scopeLine(scope: ApiScope): string {
  return `${scope.id}  ${scope.source}  ${scope.value}`;
}

export function eventLine(event: ApiEvent): string {
  const session = event.actorSessionId ? `  session ${event.actorSessionId}` : "";
  const payload = event.payload as { message?: unknown } | null;
  const message =
    event.type === "plan.log_appended" && typeof payload?.message === "string"
      ? `  ${firstLine(payload.message)}`
      : "";
  return `${event.createdAt}  #${event.seq}  ${event.type}${session}${message}`;
}

export function overlapLine(overlap: ApiOverlap): string {
  const between = `${overlap.sessionId} ${overlap.scope.source} '${overlap.scope.value}' and ${overlap.otherSessionId} ${overlap.otherScope.source} '${overlap.otherScope.value}'`;
  return overlap.kind === "overlap"
    ? `Overlap: ${between}, e.g. '${overlap.witness ?? ""}'`
    : `Possible overlap (not decided within budget): ${between}`;
}

/** The first line of multi-line text, marked when there is more. */
export function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return index === -1 ? text : `${text.slice(0, index)} …`;
}
