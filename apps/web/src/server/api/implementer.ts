import { apiContract } from "@hivemind/contract";
import { implement } from "@orpc/server";
import type { StreamLifecycle } from "../realtime/event-stream";
import type { ApiDeps, ApiPrincipal } from "./principal";

/**
 * What every `/api/v1` procedure receives: the resolved caller (requests
 * without one are answered 401 before oRPC runs) and the server's
 * dependencies, passed in so tests can use their own database.
 */
export interface ApiContext extends ApiDeps {
  principal: ApiPrincipal;
  /** The request's headers without credentials, for `auth.api` calls. */
  serverHeaders: Headers;
  /**
   * The response lifecycle of an Event stream request, which its adapter
   * (`serveEventStream` in router.ts) creates; absent on every other route.
   */
  eventStream?: StreamLifecycle;
}

/** The contract, ready to be implemented procedure by procedure. */
export const api = implement(apiContract).$context<ApiContext>();
