import {
  API_BASE_PATH,
  type ApiErrorCode,
  apiContract,
  MAX_MANAGEMENT_BODY_BYTES,
} from "@hivemind/contract";
import { ProjectAccessLostError } from "@hivemind/db";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError, onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { apiError } from "./authorize";
import { accessLostError } from "./coordination-auth";
import { listProjectEvents, listSessionEvents, streamProjectEvents } from "./events";
import { listOrganizations, me } from "./identity";
import { api } from "./implementer";
import { createProjectKey, listProjectKeys, revokeProjectKey } from "./keys";
import {
  addTask,
  appendPlanLog,
  createPlan,
  getPlan,
  listPlanLog,
  listPlans,
  listPlanTasks,
  setPlanStatus,
  updatePlan,
} from "./plans";
import { type ApiDeps, bearerToken, resolvePrincipal, withoutCredentials } from "./principal";
import { getProjectStatus } from "./project-status";
import { createProject, getProject, listProjects } from "./projects";
import {
  addSessionScope,
  checkSessionOverlaps,
  finalizeCollection,
  listSessionScopes,
  registerCollectionManifest,
  removeSessionScope,
  uploadCollectionBatch,
} from "./scopes";
import {
  attachSession,
  endSession,
  getSession,
  heartbeatSession,
  listSessionClaims,
  listSessions,
  startSession,
  updateSession,
} from "./sessions";
import { blockTask, claimTask, completeTask, releaseTask, startTask } from "./tasks";

/** The `/api/v1` router: the contract, implemented. */
export const router = api.router({
  me,
  organizations: { list: listOrganizations },
  projects: {
    list: listProjects,
    create: createProject,
    get: getProject,
    keys: { list: listProjectKeys, create: createProjectKey, revoke: revokeProjectKey },
    plans: {
      list: listPlans,
      create: createPlan,
      get: getPlan,
      update: updatePlan,
      setStatus: setPlanStatus,
      log: { list: listPlanLog, append: appendPlanLog },
      tasks: { list: listPlanTasks, add: addTask },
    },
    tasks: {
      claim: claimTask,
      release: releaseTask,
      start: startTask,
      block: blockTask,
      done: completeTask,
    },
    sessions: {
      list: listSessions,
      start: startSession,
      get: getSession,
      update: updateSession,
      heartbeat: heartbeatSession,
      attach: attachSession,
      end: endSession,
      claims: listSessionClaims,
      events: listSessionEvents,
      overlaps: checkSessionOverlaps,
      scopes: { list: listSessionScopes, add: addSessionScope, remove: removeSessionScope },
      collections: {
        manifest: registerCollectionManifest,
        batch: uploadCollectionBatch,
        finalize: finalizeCollection,
      },
    },
    events: { list: listProjectEvents, stream: streamProjectEvents },
    status: getProjectStatus,
  },
});

/** Where the generated OpenAPI document is served, without credentials. */
export const OPENAPI_DOCUMENT_PATH = `${API_BASE_PATH}/openapi.json`;

/**
 * The OpenAPI 3.1 document for `/api/v1`, generated from the same contract
 * the router implements and the CLI calls, so the three cannot drift.
 */
export function generateOpenAPIDocument() {
  return new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] }).generate(
    apiContract,
    {
      info: {
        title: "hive-mind API",
        version: "1",
        description:
          "Every operation needs `Authorization: Bearer <token>`: a login session token from " +
          "the CLI's device login, or a Project key. Browser cookies are ignored.",
      },
      servers: [{ url: API_BASE_PATH }],
      components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      },
      security: [{ bearer: [] }],
    },
  );
}

let openAPIDocument: ReturnType<typeof generateOpenAPIDocument> | undefined;

const handler = new OpenAPIHandler(router, {
  clientInterceptors: [
    // A mutation whose caller lost Project access while it waited for the
    // Project lock (ADR-0014) ends with this error; answer it as the
    // request-start check now would.
    async ({ next }) => {
      try {
        return await next();
      } catch (error) {
        throw error instanceof ProjectAccessLostError ? accessLostError(error) : error;
      }
    },
  ],
  interceptors: [
    // oRPC answers 500 with a generic message for anything that is not an
    // ORPCError; log those, since the response says nothing about the cause.
    onError((error) => {
      if (!(error instanceof ORPCError) || error.status >= 500) {
        console.error("/api/v1 request failed:", error);
      }
    }),
  ],
});

/**
 * Builds the `/api/v1` request handler. `deps` is called per request, so the
 * app can pass its lazily created `auth` and database (nothing is created at
 * import, which keeps `next build` free of runtime environment variables),
 * and tests can pass their own.
 *
 * Order per request: body size limit (before anything parses the body),
 * principal (401 without one), then oRPC, which validates input, runs the
 * procedure's authorization and validates output. Every answer is JSON with
 * the contract's error shape; nothing redirects.
 */
export function createApiHandler(deps: () => ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === OPENAPI_DOCUMENT_PATH) {
        openAPIDocument ??= generateOpenAPIDocument();
        return json(await openAPIDocument, 200);
      }

      const bounded = await withBoundedBody(request, MAX_MANAGEMENT_BODY_BYTES);
      if (!bounded) return errorResponse("PAYLOAD_TOO_LARGE");

      // A request without a bearer token is answered before the database or
      // auth instance is touched.
      if (!bearerToken(bounded.headers.get("authorization"))) return unauthorized();
      const resolved = deps();
      const principal = await resolvePrincipal(resolved, bounded);
      if (!principal) return unauthorized();

      const result = await handler.handle(bounded, {
        prefix: API_BASE_PATH,
        context: { ...resolved, principal, serverHeaders: withoutCredentials(bounded) },
      });
      if (!result.matched) return errorResponse("NOT_FOUND", "No such API route.");
      result.response.headers.set("cache-control", "no-store");
      // A key revoked while its request waited for the Project lock is a
      // 401 from inside a procedure; it carries the same challenge.
      if (result.response.status === 401) {
        result.response.headers.set("www-authenticate", "Bearer");
      }
      return result.response;
    } catch (error) {
      console.error("/api/v1 request failed:", error);
      return errorResponse("INTERNAL_SERVER_ERROR");
    }
  };
}

function unauthorized(): Response {
  const response = errorResponse("UNAUTHORIZED");
  response.headers.set("www-authenticate", "Bearer");
  return response;
}

function errorResponse(code: ApiErrorCode, message?: string): Response {
  const error = apiError(code, message);
  return json(error.toJSON(), error.status);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * The request with its body read into memory, or `null` if the body is
 * larger than `limit` bytes. A declared `content-length` over the limit is
 * refused without reading; otherwise reading stops at the first byte past
 * the limit, so a chunked or lying client cannot make the server buffer more.
 */
async function withBoundedBody(request: Request, limit: number): Promise<Request | null> {
  if (!request.body) return request;
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: Buffer.concat(chunks),
    signal: request.signal,
  });
}
