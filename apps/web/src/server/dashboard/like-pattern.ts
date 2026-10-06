/**
 * `q` as a case-insensitive substring pattern, `%q%`, with `\`, `%` and `_`
 * in `q` matched literally. Backslash is Postgres's default LIKE escape
 * character, so the pattern works with Drizzle's `ilike` and with an explicit
 * `ilike … escape '\'`.
 */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}
