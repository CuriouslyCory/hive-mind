import {
  idSchema,
  keyNameSchema,
  MAX_KEY_EXPIRES_IN_DAYS,
  MIN_KEY_EXPIRES_IN_DAYS,
} from "@hivemind/contract";
import type { ApiProjectKey } from "../client.ts";
import type { CommandDefinition, OptionSpec } from "../command.ts";
import { CliError, isCliError, UNCERTAIN_OUTCOME_CODES, usageError } from "../errors.ts";
import { resolveProjectId } from "../project-resolution.ts";

/**
 * Project key management. Keys are minted by the server for one Project and
 * carry only that Project's read permission; only organization owners manage
 * them. `key create` is the one command that prints a secret.
 */

const PROJECT_OPTION = {
  type: "string",
  valueName: "id",
  description: "Project id (default: the Project in the nearest .hivemind.json)",
} as const satisfies OptionSpec;

/** Pages fetched by `key list` before it stops and reports `nextCursor`. */
const MAX_LIST_PAGES = 20;

function expiry(key: ApiProjectKey): string {
  return key.expiresAt ? `expires ${key.expiresAt}` : "never expires";
}

export const keyCreate: CommandDefinition = {
  name: "key create",
  summary: "Create a Project key and print its secret once",
  description: [
    "Creates a Project key: a credential for CI and agents that can only read",
    "and link its own Project. Requires a user login that owns the Project's",
    "organization.",
    "",
    "The secret is printed exactly once, on stdout (as data.secret with --json),",
    "and cannot be shown again. Store it right away, for example as HIVEMIND_TOKEN",
    "in your CI secrets. Details go to stderr, so 'hivemind key create --name ci",
    "> key.txt' writes only the secret.",
    "",
    "Creation is never retried automatically. If the command fails after the",
    "request was sent (timeout, lost connection, unreadable answer), the key may",
    "exist anyway:",
    "check 'hivemind key list' and revoke keys you cannot use.",
  ].join("\n"),
  options: {
    name: { type: "string", valueName: "name", description: "Key name, e.g. ci (required)" },
    "expires-in-days": {
      type: "string",
      valueName: "days",
      description: `Expire after ${MIN_KEY_EXPIRES_IN_DAYS}-${MAX_KEY_EXPIRES_IN_DAYS} days (default: never)`,
    },
    project: PROJECT_OPTION,
  },
  examples: [
    "hivemind key create --name ci --expires-in-days 90",
    "hivemind key create --name agent --project 9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d --json",
  ],
  async run(context) {
    const name = context.options.name;
    if (typeof name !== "string" || !keyNameSchema.safeParse(name).success) {
      throw usageError(
        "--name is required: 1 to 120 characters, no control characters.",
        "Example: hivemind key create --name ci",
      );
    }
    let expiresInDays: number | undefined;
    const rawDays = context.options["expires-in-days"];
    if (typeof rawDays === "string") {
      expiresInDays = /^[1-9][0-9]{0,2}$/.test(rawDays) ? Number(rawDays) : Number.NaN;
      if (!(expiresInDays >= MIN_KEY_EXPIRES_IN_DAYS && expiresInDays <= MAX_KEY_EXPIRES_IN_DAYS)) {
        throw usageError(
          `--expires-in-days must be a whole number from ${MIN_KEY_EXPIRES_IN_DAYS} to ${MAX_KEY_EXPIRES_IN_DAYS}.`,
        );
      }
    }
    const { projectId } = await resolveProjectId({
      flag: context.options.project as string | undefined,
      cwd: context.cwd,
    });
    const api = await context.api();
    let created: Awaited<ReturnType<typeof api.createProjectKey>>;
    try {
      created = await api.createProjectKey(projectId, { name, expiresInDays });
    } catch (error) {
      // The request may have reached the server: point at the safe follow-up
      // instead of encouraging a blind rerun that could mint a second key.
      if (isCliError(error) && UNCERTAIN_OUTCOME_CODES.has(error.code)) {
        throw new CliError(error.code, error.message, {
          hint: `The key may have been created anyway. Check 'hivemind key list --project ${projectId}' and revoke any key you did not receive.`,
          cause: error,
        });
      }
      throw error;
    }
    const key = created.projectKey;
    context.report.info(
      `Created Project key '${key.name}' (${key.id}) for Project ${key.projectId}; it ${expiry(key)}.`,
    );
    context.report.info(
      "The secret below is shown only once. Store it now; use it as HIVEMIND_TOKEN.",
    );
    return { data: { projectKey: key, secret: created.secret }, human: [created.secret] };
  },
};

export const keyList: CommandDefinition = {
  name: "key list",
  summary: "List a Project's active keys (metadata only, never secrets)",
  description: [
    "Lists the Project's keys that are enabled and not expired. Secrets cannot",
    "be listed. Requires a user login that owns the Project's organization.",
  ].join("\n"),
  options: { project: PROJECT_OPTION },
  examples: ["hivemind key list", "hivemind key list --json"],
  async run(context) {
    const { projectId } = await resolveProjectId({
      flag: context.options.project as string | undefined,
      cwd: context.cwd,
    });
    const api = await context.api();
    const items: ApiProjectKey[] = [];
    let cursor: string | undefined;
    let nextCursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await api.listProjectKeys(projectId, { limit: 100, cursor });
      items.push(...result.items);
      nextCursor = result.nextCursor;
      if (nextCursor === null) break;
      cursor = nextCursor;
    }
    const human =
      items.length === 0
        ? [`No active keys for Project ${projectId}.`]
        : items.map((key) => `${key.id}  ${key.name}  created ${key.createdAt}  ${expiry(key)}`);
    if (nextCursor !== null) {
      context.report.warn(`Showing the first ${items.length} keys only.`);
    }
    return { data: { projectId, items, nextCursor }, human };
  },
};

export const keyRevoke: CommandDefinition = {
  name: "key revoke",
  summary: "Revoke a Project key",
  description: [
    "Revokes the key at once; requests using it fail with exit 3 afterwards.",
    "An unknown or already revoked key is NOT_FOUND (exit 4). Requires a user",
    "login that owns the Project's organization.",
  ].join("\n"),
  args: [{ name: "keyId", description: "The key's id, from 'hivemind key list'", required: true }],
  options: { project: PROJECT_OPTION },
  examples: ["hivemind key revoke 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8"],
  async run(context) {
    const keyId = context.args[0] as string;
    if (!idSchema.safeParse(keyId).success) {
      throw usageError("<keyId> must be a key id (a uuid).", "Run 'hivemind key list' to see ids.");
    }
    const { projectId } = await resolveProjectId({
      flag: context.options.project as string | undefined,
      cwd: context.cwd,
    });
    const api = await context.api();
    const result = await api.revokeProjectKey(projectId, keyId);
    return {
      data: result,
      human: [`Revoked key ${result.id} of Project ${result.projectId}.`],
    };
  },
};
