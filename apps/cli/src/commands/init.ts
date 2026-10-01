import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  CONFIG_FILENAME,
  idSchema,
  isRepoUrl,
  MAX_REPO_URL_LENGTH,
  projectNameSchema,
  projectSlugSchema,
} from "@hivemind/contract";
import type { ApiPrincipal, ApiProject, HivemindApi } from "../client.ts";
import type { CommandContext, CommandDefinition } from "../command.ts";
import { type ConfigWriteResult, readConfigFile, writeProjectConfig } from "../config.ts";
import {
  CLI_ERROR_CODES,
  CliError,
  isCliError,
  UNCERTAIN_OUTCOME_CODES,
  usageError,
} from "../errors.ts";
import { bindingDirFor } from "../project-resolution.ts";

/**
 * `init`: bind the current repository to a Project by writing
 * `{ "version": 1, "projectId": "<uuid>" }` to `.hivemind.json`.
 *
 * Where: the top of the current git worktree (the nearest directory with a
 * `.git` entry, so a linked worktree gets its own file), or the current
 * directory outside git. Discovery (`findProjectConfig`) stops at the same
 * boundary, so whatever `init` writes is what later commands find from any
 * nested directory.
 *
 * Order matters for partial failure: the existing binding is read before any
 * remote call, so a conflict is reported without creating anything; the
 * remote Project is created (or reused) before the local write; if that write
 * fails, the error names the Project id so `init --project <id>` finishes the
 * job. The remote Project is never deleted.
 */

export interface InitData {
  project: ApiProject;
  /** True only when this run created the Project on the server. */
  created: boolean;
  config: { path: string; status: ConfigWriteResult["status"] };
}

const GIT_TIMEOUT_MS = 5_000;
const LIST_LIMIT = 100;

/**
 * `git remote get-url origin` in `dir`, used as data only: it is sent as the
 * Project's repo URL when it passes the contract's check (no credentials,
 * supported scheme). Never printed, since a remote URL can embed a token.
 */
export function gitOriginUrl(dir: string, env: CommandContext["env"]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["remote", "get-url", "origin"],
      {
        cwd: dir,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
        env: { PATH: env.PATH, HOME: env.HOME, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const url = String(stdout).trim();
        resolve(url === "" || url.includes("\n") ? null : url);
      },
    );
  });
}

function validRepoUrl(value: string): boolean {
  return value.length <= MAX_REPO_URL_LENGTH && isRepoUrl(value);
}

interface InitOptions {
  project: string | undefined;
  name: string | undefined;
  slug: string | undefined;
  org: string | undefined;
  repoUrl: string | undefined;
  replace: boolean;
}

function readOptions(context: CommandContext): InitOptions {
  const text = (name: string) => {
    const value = context.options[name];
    return typeof value === "string" ? value : undefined;
  };
  const options: InitOptions = {
    project: text("project"),
    name: text("name"),
    slug: text("slug"),
    org: text("org"),
    repoUrl: text("repo-url"),
    replace: context.options.replace === true,
  };
  const creating = options.name !== undefined || options.slug !== undefined;
  if (options.project !== undefined && (creating || options.org || options.repoUrl)) {
    throw usageError(
      "--project links an existing Project; it cannot be combined with --name, --slug, --org or --repo-url.",
    );
  }
  if (creating && (options.name === undefined || options.slug === undefined)) {
    throw usageError("Creating a Project needs both --name and --slug.");
  }
  if (!creating && (options.org !== undefined || options.repoUrl !== undefined)) {
    throw usageError("--org and --repo-url only apply when creating with --name and --slug.");
  }
  if (options.project !== undefined && !idSchema.safeParse(options.project).success) {
    throw usageError("--project must be a Project id (a uuid).");
  }
  if (options.org !== undefined && !idSchema.safeParse(options.org).success) {
    throw usageError("--org must be an organization id (a uuid).", "See 'hivemind whoami'.");
  }
  if (options.name !== undefined && !projectNameSchema.safeParse(options.name).success) {
    throw usageError("--name must be 1 to 120 characters without control characters.");
  }
  if (options.slug !== undefined && !projectSlugSchema.safeParse(options.slug).success) {
    throw usageError(
      "--slug must be 1 to 63 lowercase letters, digits and hyphens, not starting or ending with a hyphen.",
    );
  }
  if (options.repoUrl !== undefined && !validRepoUrl(options.repoUrl)) {
    throw usageError(
      "--repo-url must be an https, http, ssh or git URL (or user@host:path) without credentials.",
    );
  }
  return options;
}

async function chooseOrganization(context: CommandContext, api: HivemindApi): Promise<string> {
  const { items } = await api.listOrganizations({ limit: LIST_LIMIT });
  if (items.length === 0) {
    throw new CliError("NOT_FOUND", "You are not a member of any organization.");
  }
  if (items.length === 1) {
    const only = items[0] as (typeof items)[number];
    context.report.info(`Using organization ${only.name} (${only.slug}).`);
    return only.id;
  }
  return context.prompt.select(
    "Which organization should own the Project?",
    items.map((org) => ({ label: `${org.name} (${org.slug}, ${org.role})`, value: org.id })),
    {
      nonInteractiveHint: `You belong to ${items.length} organizations; pass --org <id> (see 'hivemind whoami').`,
    },
  );
}

async function chooseProject(context: CommandContext, api: HivemindApi): Promise<ApiProject> {
  const { items } = await api.listProjects({ limit: LIST_LIMIT });
  if (items.length === 0) {
    throw usageError(
      "You have no Projects to link yet.",
      "Create one: hivemind init --name <name> --slug <slug>",
    );
  }
  if (items.length === 1) {
    const only = items[0] as ApiProject;
    context.report.info(`Linking the only Project you can access: ${only.name} (${only.slug}).`);
    return only;
  }
  return context.prompt.select(
    "Which Project should this repository use?",
    items.map((project) => ({ label: `${project.name} (${project.slug})`, value: project })),
    {
      nonInteractiveHint:
        "You can access several Projects; pass --project <id>, or --name and --slug to create one.",
    },
  );
}

async function resolveProject(
  context: CommandContext,
  api: HivemindApi,
  principal: ApiPrincipal,
  options: InitOptions,
  bindingDir: string,
  existing: string | null,
): Promise<{ project: ApiProject; created: boolean }> {
  if (principal.kind === "projectKey") {
    if (options.name !== undefined) {
      throw new CliError("FORBIDDEN", "A Project key cannot create Projects.", {
        hint: `It can only link its own Project: hivemind init --project ${principal.projectId}`,
      });
    }
    // The key's own Project is the only valid choice; another id is 404 (exit 4) from the server.
    return {
      project: await api.getProject(options.project ?? principal.projectId),
      created: false,
    };
  }
  if (options.project !== undefined) {
    return { project: await api.getProject(options.project), created: false };
  }
  if (options.name === undefined || options.slug === undefined) {
    return { project: await chooseProject(context, api), created: false };
  }

  const organizationId = options.org ?? (await chooseOrganization(context, api));
  if (existing !== null && !options.replace) {
    // Refuse before creating anything if the result could not be the bound
    // Project. Creating with the same org and slug reuses it, so that is fine.
    let bound: ApiProject | null = null;
    try {
      bound = await api.getProject(existing);
    } catch (error) {
      if (!isCliError(error) || error.code !== "NOT_FOUND") throw error;
    }
    if (!bound || bound.organizationId !== organizationId || bound.slug !== options.slug) {
      throw new CliError(
        "CONFLICT",
        `${join(bindingDir, CONFIG_FILENAME)} is already bound to Project ${existing}.`,
        { hint: "Pass --replace to bind this repository to a different Project." },
      );
    }
  }
  let repoUrl = options.repoUrl;
  if (repoUrl === undefined) {
    const derived = await gitOriginUrl(bindingDir, context.env);
    if (derived !== null && validRepoUrl(derived)) repoUrl = derived;
    else if (derived !== null) {
      context.report.info(
        "Not recording the 'origin' remote as the repo URL: it has credentials or an unsupported form.",
      );
    }
  }
  // Create-or-reuse is idempotent on the server (same org, slug and data), so
  // a rerun after a failure here is safe. It is still not retried automatically.
  let result: Awaited<ReturnType<HivemindApi["createProject"]>>;
  try {
    result = await api.createProject({
      organizationId,
      name: options.name,
      slug: options.slug,
      repoUrl,
    });
  } catch (error) {
    if (isCliError(error) && UNCERTAIN_OUTCOME_CODES.has(error.code)) {
      throw new CliError(error.code, error.message, {
        hint: `The Project may have been created anyway. Rerun the same command with --org ${organizationId}: it reuses that Project instead of creating a second one.`,
        cause: error,
      });
    }
    throw error;
  }
  return { project: result.project, created: result.created };
}

export const init: CommandDefinition = {
  name: "init",
  summary: "Bind this repository to a Project (writes .hivemind.json)",
  description: [
    "Links an existing Project (--project) or creates one (--name and --slug;",
    "an existing Project with the same organization, slug and data is reused),",
    "then writes .hivemind.json at the top of the current git worktree, or in",
    "the current directory outside git. Commit the file; it holds only the",
    "Project id, never a credential or a server address.",
    "",
    "Without flags, a terminal offers your organizations and Projects to choose",
    "from. Without a terminal, flags are required unless there is exactly one",
    "choice. --repo-url defaults to the 'origin' remote when it has no",
    "credentials in it.",
    "",
    "A matching existing .hivemind.json is left alone. A different binding is a",
    "CONFLICT (exit 2) unless --replace is given. If the Project was created but",
    "the file could not be written, the error names the Project id: rerun with",
    "--project <id>. A Project key can only link its own Project.",
  ].join("\n"),
  options: {
    project: { type: "string", valueName: "id", description: "Link this existing Project" },
    name: { type: "string", valueName: "name", description: "Name of a Project to create" },
    slug: {
      type: "string",
      valueName: "slug",
      description: "Slug of a Project to create (lowercase, digits, hyphens)",
    },
    org: {
      type: "string",
      valueName: "id",
      description: "Organization for a new Project (default: your only one, or a prompt)",
    },
    "repo-url": {
      type: "string",
      valueName: "url",
      description: "Repository URL for a new Project (default: the 'origin' remote)",
    },
    replace: {
      type: "boolean",
      description: "Replace a .hivemind.json that binds a different Project",
    },
  },
  examples: [
    "hivemind init --name 'Hive Mind' --slug hive-mind",
    "hivemind init --project 9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    "hivemind init --project 9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d --replace",
  ],
  async run(context) {
    const options = readOptions(context);
    const dir = await bindingDirFor({ cwd: context.cwd });

    // Read the current binding first: an unreadable file stops the command
    // before anything is created (unless it is being replaced).
    let existing: string | null = null;
    try {
      const current = await readConfigFile(join(dir, CONFIG_FILENAME));
      if (current.found) existing = current.config.projectId;
    } catch (error) {
      if (!options.replace) throw error;
    }

    const api = await context.api();
    const principal = await api.me();
    const { project, created } = await resolveProject(
      context,
      api,
      principal,
      options,
      dir,
      existing,
    );

    let written: ConfigWriteResult;
    try {
      written = await writeProjectConfig({ dir, projectId: project.id, replace: options.replace });
    } catch (error) {
      const state = created ? "was created on the server" : "exists on the server";
      const rerun = `hivemind init --project ${project.id}${isCliError(error) && error.code === "CONFLICT" ? " --replace" : ""}`;
      const code = isCliError(error) ? error.code : CLI_ERROR_CODES.io;
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(code, `${detail} Project ${project.id} ${state}.`, {
        hint: `Once the file can be written, run '${rerun}' to finish.`,
        cause: error,
      });
    }

    const verb = created ? "Created" : "Using";
    const human = [`${verb} Project ${project.name} (${project.slug}, ${project.id}).`];
    if (written.status === "unchanged")
      human.push(`${written.path} already binds it; nothing changed.`);
    else {
      human.push(
        `${written.status === "created" ? "Wrote" : "Replaced"} ${written.path}. Commit it so others use the same Project.`,
      );
    }
    const data: InitData = {
      project,
      created,
      config: { path: written.path, status: written.status },
    };
    return { data, human };
  },
};
