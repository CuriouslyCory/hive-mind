/** Helpers shared by the command modules. */

import type { CommandContext } from "../command.ts";
import type { ResolvedCredential } from "../credentials/manager.ts";
import { isCliError } from "../errors.ts";

/** better-auth's sign-out route; with a bearer token it deletes that login session. */
export const SIGN_OUT_PATH = "/api/auth/sign-out";

export const STORE_DESCRIPTIONS = {
  keychain: "the macOS Keychain",
  libsecret: "the Secret Service (libsecret)",
  file: "the private credentials file",
  env: "HIVEMIND_TOKEN",
} as const;

/** Whether HIVEMIND_TOKEN is set to something (an empty value counts as unset, as in credential resolution). */
export function hivemindTokenSet(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env.HIVEMIND_TOKEN ?? "") !== "";
}

/**
 * Asks the server to revoke a login token (delete its login session). Returns
 * null once the server no longer accepts the token, otherwise why it may
 * still be valid. Never throws, so callers decide how much a failure matters:
 * `logout` fails, `login` replacing an older login only warns.
 */
export async function revokeLoginToken(
  context: Pick<CommandContext, "originFetch">,
  credential: ResolvedCredential,
): Promise<string | null> {
  try {
    const fetch = await context.originFetch({ credential });
    const response = await fetch(SIGN_OUT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await response.body?.cancel();
    // 401: the server no longer accepts the token, which is the goal.
    if (response.ok || response.status === 401) return null;
    return `HTTP ${response.status}`;
  } catch (error) {
    return isCliError(error) ? error.message : String(error);
  }
}
