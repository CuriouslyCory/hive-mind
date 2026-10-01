import { text } from "node:stream/consumers";
import type { CommandDefinition } from "../../src/command.ts";
import { writeProjectConfig } from "../../src/config.ts";
import { CliError } from "../../src/errors.ts";
import { findProjectConfig } from "../../src/project-resolution.ts";

// Commands that exercise the shell and its helpers, for in-process tests
// (runCli with fake streams) and for test/fixtures/shell-entry.ts, which is
// compiled into a binary. They are not part of the shipped CLI.

/** Control characters a hostile server or repository could send. */
export const HOSTILE = "name\u001b]0;pwned\u0007\u001b[2J\r\nforged line‮";

export const TEST_COMMANDS: readonly CommandDefinition[] = [
  {
    name: "echo",
    summary: "Print data with progress on stderr",
    args: [{ name: "text", description: "Text to print", required: true }],
    options: { shout: { type: "boolean", description: "Uppercase" } },
    examples: ["hivemind echo hello"],
    async run(context) {
      context.report.info("working...");
      const value = context.options.shout
        ? (context.args[0] ?? "").toUpperCase()
        : (context.args[0] ?? "");
      return { data: { text: value }, human: [`text: ${value}`] };
    },
  },
  {
    name: "hostile",
    summary: "Print a string full of terminal control characters",
    async run(context) {
      context.report.info(`progress ${HOSTILE}`);
      return { data: { name: HOSTILE }, human: [`Project ${HOSTILE}`] };
    },
  },
  {
    name: "fail",
    summary: "Throw a CliError with the given code",
    args: [{ name: "code", description: "Error code", required: true }],
    async run(context) {
      throw new CliError(context.args[0] ?? "X", `failed with ${context.args[0]} ${HOSTILE}`, {
        hint: "Try again.",
      });
    },
  },
  {
    name: "crash",
    summary: "Throw an unexpected error that quotes the credential",
    async run(context) {
      const credential = await context.credentials().resolve(context.origin().origin);
      throw new Error(`boom Authorization: Bearer ${credential?.token ?? "none"}`);
    },
  },
  {
    name: "ask",
    summary: "Ask a question (fails without a TTY)",
    async run(context) {
      const answer = await context.prompt.select(
        "Pick an organization",
        [{ label: "one", value: 1 }],
        {
          nonInteractiveHint: "Pass --org <id>.",
        },
      );
      return { data: { answer }, human: [String(answer)] };
    },
  },
  {
    name: "origin",
    summary: "Print the resolved backend origin",
    async run(context) {
      const resolved = context.origin();
      return { data: resolved, human: [resolved.origin] };
    },
  },
  {
    name: "me",
    summary: "Call GET /api/v1/me",
    async run(context) {
      const api = await context.api();
      const principal = await api.me();
      return { data: principal, human: [principal.kind] };
    },
  },
  {
    name: "key mint",
    summary: "Call POST /api/v1/projects/{id}/keys",
    args: [{ name: "project", description: "Project ID", required: true }],
    async run(context) {
      const api = await context.api({ timeoutMs: Number(context.env.TEST_TIMEOUT_MS ?? 30_000) });
      const created = await api.createProjectKey(context.args[0] ?? "", { name: "ci" });
      return { data: created, human: [created.secret] };
    },
  },
  {
    name: "cred save",
    summary: "Store the token read from stdin for the resolved origin",
    async run(context) {
      const token = (await text(process.stdin)).trim();
      const result = await context.credentials().save(context.origin().origin, token);
      return { data: result, human: [result.store] };
    },
  },
  {
    name: "cred source",
    summary: "Print where the credential for the resolved origin comes from",
    async run(context) {
      const credential = await context.credential();
      return { data: { source: credential.source }, human: [credential.source] };
    },
  },
  {
    name: "cred remove",
    summary: "Remove the stored login for the resolved origin",
    async run(context) {
      const result = await context.credentials().remove(context.origin().origin);
      return {
        data: { removed: result.removed, skipped: result.skipped },
        human: [String(result.removed)],
      };
    },
  },
  {
    name: "config show",
    summary: "Print the discovered .hivemind.json",
    async run(context) {
      const found = await findProjectConfig({ cwd: context.cwd });
      return { data: found, human: [found ? `${found.config.projectId} ${found.path}` : "none"] };
    },
  },
  {
    name: "config write",
    summary: "Write .hivemind.json in the current directory",
    args: [{ name: "project", description: "Project ID", required: true }],
    options: { replace: { type: "boolean", description: "Replace a different binding" } },
    async run(context) {
      const result = await writeProjectConfig({
        dir: context.cwd,
        projectId: context.args[0] ?? "",
        replace: context.options.replace === true,
      });
      return { data: { status: result.status }, human: [result.status] };
    },
  },
];
