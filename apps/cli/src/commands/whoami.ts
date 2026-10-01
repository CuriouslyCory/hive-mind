import type { ApiPrincipal } from "../client.ts";
import type { CommandDefinition } from "../command.ts";
import { isCliError } from "../errors.ts";
import { findProjectConfig } from "../project-resolution.ts";
import { STORE_DESCRIPTIONS } from "./shared.ts";

/**
 * `whoami --json` data is the `/me` principal exactly as the server sends it,
 * pinned by the contract fixtures `cli.whoami.*.json` and the native smoke
 * test. A script tells the two identities apart by `kind` ("user" or
 * "projectKey"). The server, credential source and bound Project are shown in
 * human output only, so the JSON stays the versioned principal shape.
 */
export type WhoamiData = ApiPrincipal;

export const whoami: CommandDefinition = {
  name: "whoami",
  summary: "Show who the current credential belongs to (a user login or a Project key)",
  description: [
    "Calls the server with the current credential: HIVEMIND_TOKEN when it is set",
    "to a non-empty value (an empty one counts as unset), otherwise the stored",
    "login for the server. Shows whether it is a user login or a Project key, the",
    "server, and the Project bound to this directory.",
    "The token is never printed.",
  ].join("\n"),
  examples: ["hivemind whoami", "hivemind whoami --json", "HIVEMIND_TOKEN=... hivemind whoami"],
  async run(context) {
    const api = await context.api();
    const principal = await api.me();
    const source = api.credentialSource ?? "env";

    let binding: { projectId: string; path: string } | null = null;
    try {
      const found = await findProjectConfig({ cwd: context.cwd });
      if (found) binding = { projectId: found.config.projectId, path: found.path };
    } catch (error) {
      // An unreadable binding does not change who you are; say so and go on.
      if (!isCliError(error)) throw error;
      context.report.warn(`Ignoring the Project binding: ${error.message}`);
    }

    const data: WhoamiData = principal;
    const human: string[] = [];
    if (principal.kind === "user") {
      human.push(
        `User login: ${principal.user.name} <${principal.user.email}>`,
        `Server: ${api.origin}`,
        `Credential: ${STORE_DESCRIPTIONS[source]}`,
      );
      const organizations = principal.organizations ?? [];
      if (organizations.length > 0) {
        human.push("Organizations:");
        for (const org of organizations) {
          human.push(`  ${org.slug}  ${org.name} (${org.role})  ${org.id}`);
        }
      }
    } else {
      human.push(
        `Project key: ${principal.keyId}`,
        `Server: ${api.origin}`,
        `Credential: ${STORE_DESCRIPTIONS[source]}`,
        `Project: ${principal.projectId}`,
        `Organization: ${principal.organizationId}`,
        `Permissions: ${principal.permissions.join(", ") || "(none)"}`,
      );
      if (binding && binding.projectId !== principal.projectId) {
        context.report.warn(
          `This directory is bound to Project ${binding.projectId}, but the key belongs to ${principal.projectId}.`,
        );
      }
    }
    human.push(
      binding
        ? `Bound Project: ${binding.projectId} (${binding.path})`
        : "Bound Project: none (no .hivemind.json; run 'hivemind init')",
    );
    return { data, human };
  },
};
