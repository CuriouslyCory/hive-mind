import type { ApiProjectStatus } from "../client.ts";
import type { CommandDefinition } from "../command.ts";
import {
  firstLine,
  optionalSessionOf,
  overlapLine,
  PROJECT_OPTION,
  planLine,
  projectOf,
  SESSION_ENV,
  SESSION_OPTION,
  sessionLine,
  taskLine,
} from "./coordination.ts";

/**
 * `status`: one bounded overview of the Project from the server, computed at
 * one database time. A Session is selected only by `--session` or
 * HIVEMIND_SESSION; without one `myClaims` is empty and no live Session is
 * picked on the caller's behalf. `--brief` changes the human format only.
 */

function more(complete: boolean, where: string): string[] {
  return complete ? [] : [`  (more: ${where})`];
}

function fullLines(status: ApiProjectStatus): string[] {
  const lines = [`Project ${status.projectId} at ${status.asOf}`, "", "Active Plans:"];
  if (status.activePlans.length === 0) lines.push("  None.");
  lines.push(...status.activePlans.map((plan) => `  ${planLine(plan)}`));
  lines.push(...more(status.complete.activePlans, "hivemind plan list --status active"));

  lines.push("", "Live Sessions:");
  if (status.liveSessions.length === 0) lines.push("  None.");
  for (const entry of status.liveSessions) {
    const mine = entry.session.id === status.selectedSessionId ? " (selected)" : "";
    lines.push(`  ${sessionLine(entry.session)}${mine}`);
    lines.push(
      `    ${entry.claimCount} claims, ${entry.touchedScopeCount} touched paths, declared: ${entry.declaredScopes.map((scope) => scope.value).join(", ") || "none"}`,
    );
  }
  lines.push(...more(status.complete.liveSessions, "hivemind session list --status live"));

  lines.push("", "My claims:");
  if (status.selectedSessionId === null) {
    lines.push(`  No Session selected (--session or ${SESSION_ENV}).`);
  } else {
    if (status.myClaims.length === 0) lines.push("  None.");
    lines.push(...status.myClaims.map((task) => `  ${taskLine(task)}`));
    lines.push(...more(status.complete.myClaims, "hivemind session claims"));
  }

  lines.push("", "Recently ended Sessions:");
  if (status.recentTerminalSessions.length === 0) lines.push("  None.");
  lines.push(...status.recentTerminalSessions.map((session) => `  ${sessionLine(session)}`));
  lines.push(
    ...more(status.complete.recentTerminalSessions, "hivemind session list --status terminal"),
  );

  lines.push("", "Overlaps:");
  if (status.overlaps.length === 0)
    lines.push(status.complete.overlaps ? "  None." : "  None found.");
  lines.push(...status.overlaps.map((overlap) => `  ${overlapLine(overlap)}`));
  if (!status.complete.overlaps) {
    lines.push("  Incomplete: an overlap may be missing ('hivemind scope check' for details).");
  }
  return lines;
}

function briefLines(status: ApiProjectStatus): string[] {
  const plus = (complete: boolean) => (complete ? "" : "+");
  const lines = [
    `${status.activePlans.length}${plus(status.complete.activePlans)} active Plans, ${status.liveSessions.length}${plus(status.complete.liveSessions)} live Sessions, ${status.overlaps.length}${plus(status.complete.overlaps)} overlaps${status.complete.overlaps ? "" : " (incomplete)"}`,
  ];
  for (const plan of status.activePlans) lines.push(planLine(plan));
  for (const entry of status.liveSessions) {
    lines.push(
      `${entry.session.id}  ${entry.session.status}  ${entry.session.agent}  ${firstLine(entry.session.intent)}`,
    );
  }
  if (status.selectedSessionId !== null) {
    for (const task of status.myClaims)
      lines.push(`mine: ${task.id}  ${task.status}  ${task.title}`);
  }
  for (const overlap of status.overlaps) lines.push(overlapLine(overlap));
  return lines;
}

export const status: CommandDefinition = {
  name: "status",
  summary: "Show the Project's active Plans, live Sessions, claims and overlaps",
  description: [
    "One overview from the server: active Plans with progress, live Sessions",
    "with their declared Scopes, your Session's claims, recently ended",
    "Sessions, and Scope overlaps. Each section holds at most 20 entries;",
    "data.complete says which have more. Your Session comes from --session or",
    `${SESSION_ENV}; without one, myClaims is empty and none is chosen for you.`,
    "--brief shortens the human output; --json output is the same either way.",
  ].join("\n"),
  options: {
    brief: { type: "boolean", description: "Compact human output (no effect on --json)" },
    session: SESSION_OPTION,
    project: PROJECT_OPTION,
  },
  examples: ["hivemind status", "hivemind status --brief", "hivemind status --json"],
  async run(context) {
    const sessionId = optionalSessionOf(context);
    const projectId = await projectOf(context);
    const result = await (await context.api()).getProjectStatus(projectId, sessionId);
    return {
      data: result,
      human: context.options.brief === true ? briefLines(result) : fullLines(result),
    };
  },
};
