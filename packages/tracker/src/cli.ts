import type { Db } from "@hivemind/db";
import * as schema from "@hivemind/db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { trackerCliAllowed } from "./gate.ts";
import { isTrackerCommandName, TRACKER_COMMAND_NAMES } from "./input.ts";
import {
  getLatestScan,
  getTrackerSnapshot,
  runTrackerBatch,
  runTrackerCommand,
  TrackerError,
  type TrackerErrorKind,
  TrackerInputError,
} from "./store.ts";

// The agent-facing tracker CLI (docs/tracker.md). The root package.json runs
// it as `pnpm tracker`; Node runs this file directly with type stripping, so it
// and everything it imports use only erasable TypeScript syntax and import
// @hivemind/db's schema entry, never its root.
//
// Success prints the result as JSON on stdout and exits 0. Failure prints
// {"error": {"kind", "message"}} on stderr and exits 1, or 2 for a usage error.

const USAGE = `Usage: pnpm tracker <command>

Reads and writes the dev tracker in the database DATABASE_URL names
(apps/web/.env.local is loaded when it exists). Mutating commands read one
JSON value from stdin. Output is JSON on stdout; errors are
{"error": {"kind", "message"}} on stderr with exit 1 (2 for usage errors).

Reads:
  snapshot                   Everything the /tracker page shows, plus nextStep.
  cursor <git_history|backlog>
                             The newest scan of that kind, or null.

Writes (JSON on stdin; dates YYYY-MM-DD, times ISO 8601 with offset; send
updatedAt as read to refuse the write if the row changed since):
  save-changelog-entry  {id?, updatedAt?, date, category, title, summary, prNumbers}
  delete-changelog-entry {id, updatedAt?}
  save-blog-idea        {id?, updatedAt? (required with id), title, pitch, notes,
                         prNumbers, status: idea|draft|published,
                         publishedAt: date|null, publishedUrl: url|null, sortOrder}
  delete-blog-idea      {id, updatedAt}
  save-phase            {id?, updatedAt?, title, description, sortOrder}
  delete-phase          {id, updatedAt?}           (only when it has no issues)
  save-issue            {mode: create|update, issueNumber, updatedAt? (update only),
                         title, note, phaseId, sortOrder, state: open|closed,
                         githubUpdatedAt: time|null,
                         steps?: [{key, label, prompt, sortOrder}] (create only;
                         default: the plan and implement steps)}
  delete-issue          {issueNumber, updatedAt?}  (deletes its steps too)
  save-step             {id?, updatedAt?, issueNumber, key, label, prompt, sortOrder}
  delete-step           {id, updatedAt?}
  set-step-complete     {id, complete: boolean}
  record-scan           {kind: git_history|backlog, throughAt, throughSha, note}
                        (git_history needs the 40-character origin/main SHA;
                         backlog sends null)
  batch                 [{command, input}, ...] in one transaction; any failure
                        writes nothing and names the failing index.

  help                       This text.
`;

type CliErrorKind = TrackerErrorKind | "usage" | "internal";

class CliUsageError extends Error {}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(kind: CliErrorKind, message: string): void {
  process.stderr.write(`${JSON.stringify({ error: { kind, message } })}\n`);
}

/**
 * The message and code of an unexpected failure and of its cause (Drizzle
 * wraps pg's error), never the objects: pg errors can carry connection
 * parameters, password included.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown failure.";
  const describe = (e: Error) => {
    const code = "code" in e && typeof e.code === "string" ? ` (${e.code})` : "";
    return `${e.message}${code}`;
  };
  return error.cause instanceof Error
    ? `${describe(error)} Cause: ${describe(error.cause)}`
    : describe(error);
}

async function readStdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) {
    throw new CliUsageError("This command reads its JSON input from stdin; pipe or redirect it.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new TrackerInputError(
      text.trim() === "" ? "Expected JSON on stdin; got nothing." : "stdin is not valid JSON.",
    );
  }
}

async function run(command: string, args: string[], db: () => Db): Promise<unknown> {
  if (command === "snapshot") {
    if (args.length > 0) throw new CliUsageError("snapshot takes no arguments.");
    return getTrackerSnapshot(db());
  }
  if (command === "cursor") {
    const [kind, ...rest] = args;
    if ((kind !== "git_history" && kind !== "backlog") || rest.length > 0) {
      throw new CliUsageError("Usage: cursor <git_history|backlog>");
    }
    return getLatestScan(db(), kind);
  }
  if (command === "batch" || isTrackerCommandName(command)) {
    if (args.length > 0) {
      throw new CliUsageError(`${command} takes no arguments; it reads JSON from stdin.`);
    }
    const input = await readStdinJson();
    return command === "batch"
      ? runTrackerBatch(db(), input)
      : runTrackerCommand(db(), command, input);
  }
  throw new CliUsageError(
    `Unknown command "${command}". Commands: snapshot, cursor, ${TRACKER_COMMAND_NAMES.join(", ")}, batch, help.`,
  );
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!trackerCliAllowed(process.env.VERCEL_ENV)) {
    writeError(
      "usage",
      `The tracker CLI does not run in a Vercel ${process.env.VERCEL_ENV} environment.`,
    );
    return 2;
  }
  if (command === undefined) {
    writeError("usage", "No command given. Run `pnpm tracker help`.");
    return 2;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    writeError("usage", "DATABASE_URL is not set (it is read from apps/web/.env.local).");
    return 2;
  }

  // Connected only when a command needs it, after its arguments are checked.
  let pool: pg.Pool | undefined;
  const db = (): Db => {
    if (!pool) {
      pool = new pg.Pool({ connectionString, max: 1 });
      // A connection the server closes while idle is reported by the next
      // query; without a listener the pool's error event would crash the CLI.
      pool.on("error", () => {});
    }
    // The same casing as createDb in @hivemind/db (ADR-0005).
    return drizzle({ client: pool, schema, casing: "snake_case" });
  };
  try {
    writeJson(await run(command, args, db));
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeError("usage", error.message);
      return 2;
    }
    if (error instanceof TrackerError) {
      writeError(error.kind, error.message);
      return 1;
    }
    writeError("internal", describeFailure(error));
    return 1;
  } finally {
    await pool?.end();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
