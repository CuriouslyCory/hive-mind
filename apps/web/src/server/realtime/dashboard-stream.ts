import { describeFailure } from "@hivemind/db";
import { type ApiDeps, withoutCredentials } from "../api/principal";
import { type EventStreamHandlerOptions, errorResponse, serveEventStream } from "../api/router";
import { resolveCookiePrincipal } from "./stream-access";

/** Where the dashboard's cookie adapter is mounted: `<prefix>/projects/{id}/events/stream`. */
export const DASHBOARD_API_PREFIX = "/api/dashboard";

/**
 * Builds `GET /api/dashboard/projects/{projectId}/events/stream`, the
 * browser's adapter for the Event stream (ADR-0010). It mounts only the feed:
 * the same procedure, engine, frames and encoding as `/api/v1`, behind the
 * caller's cookie login session instead of a bearer token.
 *
 * - Only the cookie authenticates. `Authorization` and `X-API-Key` are
 *   ignored, and no token is handed to JavaScript.
 * - The login session is read from the database (cookie cache off); access is
 *   Project -> Organization membership, like every User read; both are
 *   checked again before every batch.
 * - GET only: cookies never authorize a coordination mutation.
 *
 * `deps` is called per request, as in `createApiHandler`.
 */
export function createDashboardEventStreamHandler(
  deps: () => ApiDeps,
  options: EventStreamHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (request.method !== "GET") return errorResponse("NOT_FOUND", "No such API route.");
      const resolved = deps();
      const principal = await resolveCookiePrincipal(resolved.auth, request);
      if (!principal) return errorResponse("UNAUTHORIZED");
      const response = await serveEventStream(
        request,
        DASHBOARD_API_PREFIX,
        { ...resolved, principal, serverHeaders: withoutCredentials(request) },
        options,
      );
      response.headers.set("cache-control", "no-store");
      return response;
    } catch (error) {
      console.error(`Dashboard Event stream request failed: ${describeFailure(error)}`);
      return errorResponse("INTERNAL_SERVER_ERROR");
    }
  };
}
