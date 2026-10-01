import { isDeclaredScopePattern, SCOPE_SOURCES } from "@hivemind/contract";
import type { ApiOverlap } from "../client.ts";
import type { CommandDefinition } from "../command.ts";
import { usageError } from "../errors.ts";
import {
  CURSOR_OPTION,
  choiceOf,
  LIMIT_OPTION,
  overlapLine,
  PROJECT_OPTION,
  pageLines,
  pageOf,
  projectOf,
  requireUuid,
  SESSION_OPTION,
  scopeLine,
  sessionOf,
  stringOption,
} from "./coordination.ts";

/**
 * Scopes: what a Session says it works on (declared globs, `scope add`) and
 * what git shows it changed (touched paths, uploaded by `session heartbeat`).
 * `scope check` compares a Session's Scopes with the other live Sessions'.
 * Overlaps are warnings; they never block a claim.
 */

/** Pages `scope check` follows before it stops and reports `nextCursor`. */
const MAX_CHECK_PAGES = 20;

const SESSION_OPTIONS = { session: SESSION_OPTION, project: PROJECT_OPTION } as const;

export const scopeAdd: CommandDefinition = {
  name: "scope add",
  summary: "Declare a path glob your Session works on",
  description: [
    "One glob per run, relative to the repository root, quoted so the shell",
    "does not expand it: literal segments, * and ? within one segment, and **",
    "as a whole segment for any depth. No leading /, . or .. segments,",
    "backslashes, braces, character classes or negation; at most 256 bytes.",
    "Declaring an existing glob again is a no-op. At most 32 per Session.",
  ].join("\n"),
  args: [{ name: "pattern", description: "The glob, e.g. 'packages/db/**'", required: true }],
  options: SESSION_OPTIONS,
  examples: ["hivemind scope add 'packages/db/**'", "hivemind scope add 'apps/web/src/*.ts'"],
  async run(context) {
    const pattern = context.args[0] as string;
    const sessionId = sessionOf(context);
    if (!isDeclaredScopePattern(pattern)) {
      throw usageError(
        "<pattern> is not a supported glob.",
        "Use a repository-relative path with *, ? and ** only, e.g. 'packages/db/**'.",
      );
    }
    const projectId = await projectOf(context);
    const result = await (await context.api()).addSessionScope(projectId, { sessionId, pattern });
    return {
      data: result,
      human: [`${result.created ? "Declared" : "Already declared"}: ${scopeLine(result.scope)}`],
    };
  },
};

export const scopeRemove: CommandDefinition = {
  name: "scope remove",
  summary: "Remove one of your Session's declared Scopes",
  description: [
    "Removes a declared Scope by id (see 'hivemind scope list'). An id the",
    "Session does not have is a no-op; a touched path stays for the Session's",
    "life and is CONFLICT (exit 2).",
  ].join("\n"),
  args: [{ name: "scopeId", description: "The Scope's id", required: true }],
  options: SESSION_OPTIONS,
  examples: ["hivemind scope remove 1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a"],
  async run(context) {
    const scopeId = requireUuid(
      context.args[0] as string,
      "<scopeId>",
      "Run 'hivemind scope list' to see Scope ids.",
    );
    const sessionId = sessionOf(context);
    const projectId = await projectOf(context);
    const result = await (await context.api()).removeSessionScope(projectId, {
      sessionId,
      scopeId,
    });
    return {
      data: result,
      human: [result.removed ? `Removed Scope ${scopeId}.` : `Session has no Scope ${scopeId}.`],
    };
  },
};

export const scopeList: CommandDefinition = {
  name: "scope list",
  summary: "List a Session's Scopes, oldest first (one page)",
  options: {
    source: {
      type: "string",
      valueName: "source",
      description: `Only ${SCOPE_SOURCES.join(" or ")} Scopes`,
    },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    ...SESSION_OPTIONS,
  },
  examples: ["hivemind scope list", "hivemind scope list --source declared --json"],
  async run(context) {
    const sessionId = sessionOf(context);
    const source = stringOption(context, "source");
    const input = {
      ...pageOf(context),
      ...(source === undefined ? {} : { source: choiceOf(source, SCOPE_SOURCES, "--source") }),
    };
    const projectId = await projectOf(context);
    const page = await (await context.api()).listSessionScopes(projectId, sessionId, input);
    return { data: page, human: pageLines(page, scopeLine, "No Scopes.") };
  },
};

export const scopeCheck: CommandDefinition = {
  name: "scope check",
  summary: "Compare your Session's Scopes with other live Sessions'",
  description: [
    "Lists each overlap with a path both Scopes match, or a possible overlap",
    "when the comparison ran out of budget. complete is false whenever an",
    "overlap could be missing (budget, too many candidates, or a Session whose",
    "touched-path coverage is incomplete), so no output is a false all-clear.",
    "Overlaps are warnings: the exit code is 0 either way.",
  ].join("\n"),
  options: SESSION_OPTIONS,
  examples: ["hivemind scope check", "hivemind scope check --json"],
  async run(context) {
    const sessionId = sessionOf(context);
    const projectId = await projectOf(context);
    const api = await context.api();
    const items: ApiOverlap[] = [];
    const incomplete = new Set<string>();
    let complete = true;
    let cursor: string | undefined;
    let nextCursor: string | null = null;
    for (let page = 0; page < MAX_CHECK_PAGES; page++) {
      const result = await api.checkSessionOverlaps(projectId, sessionId, { limit: 100, cursor });
      items.push(...result.items);
      for (const id of result.incompleteSessionIds) incomplete.add(id);
      complete &&= result.complete;
      nextCursor = result.nextCursor;
      if (nextCursor === null) break;
      cursor = nextCursor;
    }
    if (nextCursor !== null) complete = false;
    const human = items.map(overlapLine);
    if (items.length === 0) human.push(complete ? "No overlaps." : "No overlaps found so far.");
    if (!complete) {
      const sessions =
        incomplete.size > 0 ? ` Incomplete coverage: ${[...incomplete].join(", ")}.` : "";
      human.push(`The check is incomplete: an overlap may be missing.${sessions}`);
    }
    return {
      data: {
        sessionId,
        items,
        nextCursor,
        complete,
        incompleteSessionIds: [...incomplete],
      },
      human,
    };
  },
};
