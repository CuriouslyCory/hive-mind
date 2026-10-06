// Landing page copy that must stay in step with docs/cli.md.
// apps/web/test/landing-content.test.ts checks both against the doc.

export const REPOSITORY_URL = "https://github.com/CuriouslyCory/hive-mind";
export const CLI_DOCS_URL = `${REPOSITORY_URL}/blob/main/docs/cli.md`;
export const DASHBOARD_DOCS_URL = `${REPOSITORY_URL}/blob/main/docs/dashboard.md`;
export const DECISIONS_URL = `${REPOSITORY_URL}/tree/main/docs/adr`;
export const ROADMAP_URL = `${REPOSITORY_URL}/issues/1`;

/** docs/cli.md → Install → Install script. */
export const INSTALL_COMMAND =
  "curl -fsSL https://github.com/CuriouslyCory/hive-mind/releases/latest/download/install.sh | sh";

export type TerminalLine =
  | { kind: "comment"; text: string }
  | { kind: "blank" }
  | {
      kind: "command";
      text: string;
      /** A second line after a trailing ` \`, indented under the first. */
      continuation?: string;
      /** A trailing `# …` comment. */
      note?: string;
    };

const TASK_ID = "7a2e3d4c-5b6a-4f90-8b1c-2d3e4f5a6b7c";

/** docs/cli.md → Coordination → A typical run, with explanatory comment lines. */
export const TYPICAL_RUN: readonly TerminalLine[] = [
  { kind: "comment", text: "# one Session per agent run" },
  {
    kind: "command",
    text: 'export HIVEMIND_SESSION="$(hivemind session start \\',
    continuation: "--agent claude-code --intent 'Fix parser error positions')\"",
  },
  { kind: "command", text: "hivemind status" },
  { kind: "blank" },
  { kind: "comment", text: "# say where you will work, see who else is there" },
  { kind: "command", text: "hivemind scope add 'packages/parser/**'" },
  { kind: "command", text: "hivemind scope check" },
  { kind: "blank" },
  { kind: "comment", text: "# hold the Task, keep the lease alive, hand it back" },
  { kind: "command", text: `hivemind task claim ${TASK_ID}` },
  { kind: "command", text: `hivemind task start ${TASK_ID}` },
  { kind: "command", text: "hivemind session heartbeat", note: "# every 60 seconds" },
  {
    kind: "command",
    text: "hivemind plan log PLAN-3 --message 'Error positions now count code points.'",
  },
  { kind: "command", text: `hivemind task done ${TASK_ID}` },
  { kind: "blank" },
  {
    kind: "command",
    text: "hivemind session end --summary 'Fixed error positions. PLAN-3 has one open Task.'",
  },
  { kind: "command", text: "unset HIVEMIND_SESSION" },
];

/** A command line as one shell command: the continuation joined, the note dropped. */
export function fullCommand(line: Extract<TerminalLine, { kind: "command" }>): string {
  if (!line.continuation) return line.text;
  return `${line.text.replace(/\s*\\$/, "")} ${line.continuation}`;
}
