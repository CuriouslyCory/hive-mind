import type { CommandDefinition } from "../command.ts";
import { CLI_ERROR_CODES, CliError } from "../errors.ts";
import { hivemindTokenSet, revokeLoginToken } from "./shared.ts";

export interface LogoutData {
  origin: string;
  /** A stored login existed for this server and every local copy was removed. */
  removed: boolean;
  /** The server revoked the token (or already considered it invalid). Null when there was nothing to revoke. */
  revoked: boolean | null;
  /** HIVEMIND_TOKEN is set; logout never touches it, so commands keep using it. */
  hivemindTokenSet: boolean;
}

export const logout: CommandDefinition = {
  name: "logout",
  summary: "Revoke the stored login on the server and delete it locally",
  description: [
    "Deletes every local copy of the login for this server (OS store and",
    "credentials file), then asks the server to revoke it.",
    "",
    "If the server cannot be reached or refuses, the local copies are still",
    "deleted, and the command fails with REVOCATION_FAILED (exit 1) because",
    "the token may stay valid on the server until it expires.",
    "",
    "HIVEMIND_TOKEN is never changed or revoked by logout; unset it yourself.",
    "To revoke a Project key, use 'hivemind key revoke'.",
  ].join("\n"),
  examples: ["hivemind logout", "hivemind logout --json"],
  async run(context) {
    const { origin } = context.origin();
    const tokenSet = hivemindTokenSet(context.env);
    // Local first: whatever happens on the network, this machine stops using the login.
    const removal = await context.credentials().remove(origin);
    for (const warning of removal.warnings) context.report.warn(warning);

    const human: string[] = [];
    let revoked: boolean | null = null;
    if (removal.token !== null) {
      const failure = await revokeLoginToken(context, {
        origin,
        token: removal.token,
        source: "file",
      });
      if (failure !== null) {
        throw new CliError(
          CLI_ERROR_CODES.revocationFailed,
          `Deleted the stored login for ${origin}, but the server did not revoke it (${failure}).`,
          {
            hint: "It stays valid on the server until it expires. Nothing is left to delete locally.",
          },
        );
      }
      revoked = true;
      human.push(`Logged out of ${origin}: the login was revoked and deleted.`);
    } else if (removal.removed) {
      // The index pointed at an OS store this run could not read (no TTY).
      const where =
        removal.skipped.length > 0 ? " (it is in an OS store, which needs a terminal)" : "";
      throw new CliError(
        CLI_ERROR_CODES.revocationFailed,
        `Deleted the reference to the stored login for ${origin}, but could not read it to revoke it${where}.`,
        {
          hint: "It is no longer used by hivemind, and stays valid on the server until it expires.",
        },
      );
    } else {
      human.push(`Not logged in to ${origin}; nothing to do.`);
    }
    if (tokenSet) {
      human.push("HIVEMIND_TOKEN is set and was not changed; commands keep using it.");
    }
    const data: LogoutData = {
      origin,
      removed: removal.removed,
      revoked,
      hivemindTokenSet: tokenSet,
    };
    return { data, human };
  },
};
