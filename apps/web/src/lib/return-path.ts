// Where to send the browser after sign-in. The path travels in a query
// parameter that anyone can write into a link, so it is accepted only as a
// path on this origin: never a URL, a protocol-relative `//host`, or a path
// that browsers or URL parsers read as one (`/\host`, encoded slashes).

/** The query parameter on `/sign-in` that carries the return path. */
export const RETURN_TO_PARAM = "returnTo";

/** Longer than any page path the app links to with a user code. */
const MAX_RETURN_PATH_LENGTH = 512;

// Only used to parse relative paths; never contacted.
const PARSE_BASE = "https://return-path.invalid";

/**
 * `value` as a same-origin path plus query (no fragment), or `null` if it is
 * anything else. Paths under `/api/` and the sign-in page itself are refused:
 * the first are not pages, and the second would loop.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_RETURN_PATH_LENGTH) return null;
  // One leading slash, then not a second slash or a backslash; no control
  // characters, whitespace or backslashes anywhere (browsers strip or
  // rewrite those before resolving the URL).
  if (!/^\/(?![/\\])/.test(value) || /[\s\\\p{Cc}]/u.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE) return null;

  // An encoded slash or backslash could become `//host` after a decode.
  if (/%(?:2f|5c)/i.test(url.pathname)) return null;
  const path = url.pathname;
  if (path === "/sign-in" || path.startsWith("/sign-in/")) return null;
  if (path === "/api" || path.startsWith("/api/")) return null;
  return `${path}${url.search}`;
}

/** The sign-in page, returning to `returnPath` afterwards when it is safe. */
export function signInPath(returnPath: string): "/sign-in" | `/sign-in?${string}` {
  const safe = safeReturnPath(returnPath);
  if (!safe || safe === "/") return "/sign-in";
  return `/sign-in?${new URLSearchParams({ [RETURN_TO_PARAM]: safe })}`;
}
