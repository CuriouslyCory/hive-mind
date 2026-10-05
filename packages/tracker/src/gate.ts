// Where the tracker may run (docs/tracker.md). The page is for local
// development only; the CLI writes to whatever DATABASE_URL names, so it
// refuses to run inside a Vercel production or preview environment.

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/**
 * True only under `next dev` (NODE_ENV development), outside a deployed Vercel
 * environment, for a request whose Host header is a loopback address.
 */
export function trackerPageEnabled(
  nodeEnv: string | undefined,
  host: string | null | undefined,
  vercelEnv: string | undefined,
): boolean {
  return (
    nodeEnv === "development" &&
    (vercelEnv === undefined || vercelEnv === "development") &&
    typeof host === "string" &&
    LOCAL_HOST.test(host)
  );
}

/** False inside a Vercel production or preview environment. */
export function trackerCliAllowed(vercelEnv: string | undefined): boolean {
  return vercelEnv !== "production" && vercelEnv !== "preview";
}
