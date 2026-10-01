import { DEFAULT_ORIGIN } from "./build-info.ts";
import { CLI_ERROR_CODES, CliError } from "./errors.ts";

/**
 * Backend origin resolution and normalization (docs/cli.md "Choosing the server",
 * issue #3 "CLI configuration and output").
 *
 * An origin is the only thing the CLI accepts as a backend address: scheme,
 * host and port, nothing else. It is also the key credentials are stored
 * under, so two spellings of the same server must normalize to the same
 * string, and anything that could smuggle a second address (userinfo, path,
 * query, fragment) is rejected rather than stripped. The origin never comes
 * from repository files.
 */

export type OriginSource = "flag" | "env" | "default";

export interface ResolvedOrigin {
  /** Normalized, e.g. `https://hive.example` or `http://localhost:3000`. */
  origin: string;
  source: OriginSource;
}

/** Hosts that may use plain http: loopback only, for local development. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type OriginCheck = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * Normalizes a backend origin: lowercase scheme and host (WHATWG URL parsing
 * also converts an internationalized host to punycode), default port dropped,
 * no trailing slash. https is required except for loopback hosts.
 */
export function checkOrigin(input: string): OriginCheck {
  const fail = (reason: string): OriginCheck => ({ ok: false, reason });
  // The URL parser silently strips leading/trailing spaces and removes tabs and
  // newlines anywhere, and treats "\" as "/". Reject them instead of guessing.
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || input[index] === "\\") {
      return fail("it contains whitespace, a control character or a backslash");
    }
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("it is not an absolute URL such as https://hive.example");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("only https:// (or http:// for localhost) is supported");
  }
  if (url.username !== "" || url.password !== "" || /^[a-z]+:\/\/[^/?#]*@/i.test(input)) {
    return fail("it must not contain a user name or password");
  }
  // `new URL` drops an empty "?" or "#", so look at the raw input as well.
  if (url.search !== "" || url.hash !== "" || input.includes("?") || input.includes("#")) {
    return fail("it must not contain a query or fragment");
  }
  if (url.pathname !== "/") return fail("it must not contain a path");
  if (url.hostname.endsWith(".")) return fail("its host must not end with a dot");
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return fail("plain http is only allowed for localhost, 127.0.0.1 and [::1]; use https");
  }
  // `origin` is scheme://host[:port] with the default port already omitted.
  return { ok: true, origin: url.origin };
}

export function normalizeOrigin(input: string, label = "server"): string {
  const result = checkOrigin(input);
  if (result.ok) return result.origin;
  // The rejected value is not echoed: HIVEMIND_URL or --server may have been
  // given a token or a URL with credentials in it by mistake.
  throw new CliError(
    CLI_ERROR_CODES.invalidServer,
    `The ${label} is not a valid backend origin: ${result.reason}.`,
    {
      hint: "Use an origin like https://hive.example (no path), or http://localhost:3000 for local development.",
    },
  );
}

/**
 * `--server`, then `HIVEMIND_URL`, then the origin compiled into the binary.
 * An empty `HIVEMIND_URL` counts as unset. An invalid value is an error, never
 * a reason to fall through to the next source: that would silently send
 * credentials to a different backend than the user named.
 */
export function resolveOrigin(options: {
  flag?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  defaultOrigin?: string;
}): ResolvedOrigin {
  if (options.flag !== undefined) {
    return { origin: normalizeOrigin(options.flag, "--server value"), source: "flag" };
  }
  const fromEnv = options.env.HIVEMIND_URL;
  if (fromEnv !== undefined && fromEnv !== "") {
    return { origin: normalizeOrigin(fromEnv, "HIVEMIND_URL value"), source: "env" };
  }
  return {
    origin: normalizeOrigin(options.defaultOrigin ?? DEFAULT_ORIGIN, "built-in default server"),
    source: "default",
  };
}
