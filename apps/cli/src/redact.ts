/**
 * Secret redaction for every path that prints diagnostics: error messages,
 * warnings, progress lines and debug stacks. Success data is not redacted,
 * because `key create` must print the one-time Project key it just minted;
 * that key is never registered here.
 *
 * Two layers:
 * - Exact values: whatever credential the process resolved (HIVEMIND_TOKEN or a
 *   stored login) is registered as soon as it is read, so an error message that
 *   happens to quote it (a library echoing a header, a URL with the token in
 *   it) prints `[REDACTED]` instead.
 * - Shapes: `Authorization: ...` and `Bearer ...` fragments, for tokens this
 *   process never registered (for example one quoted back by a server).
 */

const REDACTED = "[REDACTED]";

// Shorter values would redact ordinary words; real tokens are 32+ characters.
const MIN_SECRET_LENGTH = 8;

const secrets = new Set<string>();

export function registerSecret(secret: string): void {
  if (secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
}

/** Test seam: forget registered secrets between cases. */
export function clearRegisteredSecrets(): void {
  secrets.clear();
}

const SHAPES: readonly [RegExp, string][] = [
  [/(authorization["']?\s*[:=]\s*)(["']?)[^\s"',;]+(?:\s+[^\s"',;]+)?/gi, `$1$2${REDACTED}`],
  [/\b(bearer\s+)[^\s"',;]+/gi, `$1${REDACTED}`],
];

export function redact(text: string): string {
  let result = text;
  // Longest first, so a secret that contains another is replaced whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, REDACTED);
  }
  for (const [pattern, replacement] of SHAPES) result = result.replace(pattern, replacement);
  return result;
}
