/** Helpers shared by the command modules. */

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
