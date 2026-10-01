import {
  API_BASE_PATH,
  API_ERROR_CODES,
  API_ERRORS,
  type ApiContract,
  apiContract,
  isApiErrorCode,
} from "@hivemind/contract";
import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { z } from "zod";
import { BUILD_VERSION } from "./build-info.ts";
import type { CredentialSource, ResolvedCredential } from "./credentials/manager.ts";
import { CLI_ERROR_CODES, CliError } from "./errors.ts";

/**
 * Typed client for `/api/v1` (packages/contract), built on oRPC's OpenAPILink.
 *
 * Transport rules:
 * - The bearer token is attached by our own fetch wrapper, only to requests
 *   whose URL is on the resolved origin. Redirects are never followed
 *   (`redirect: "manual"`; any 3xx is an error), so the token cannot be
 *   forwarded to another origin, and an API request never lands on a sign-in
 *   page.
 * - Every request has a timeout and honors the caller's abort signal.
 * - Nothing is retried automatically. Creation is not idempotent (a key
 *   created twice is two keys), so after a timeout on a write the error says
 *   the server may have completed it.
 *
 * Responses are NOT validated with the contract's output schemas. Those are
 * strict (unknown fields are a server error, which is the server's
 * secret-free guarantee), so validating with them here would make every
 * additive server change break installed CLIs. Instead each method parses the
 * fields this CLI uses with a lenient schema that accepts extra fields.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Lenient response shapes: the fields the CLI reads, extra fields allowed.

const organization = z.looseObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
});
const userPrincipal = z.looseObject({
  kind: z.literal("user"),
  user: z.looseObject({ id: z.string(), name: z.string(), email: z.string() }),
  organizations: z.array(organization).optional(),
});
const projectKeyPrincipal = z.looseObject({
  kind: z.literal("projectKey"),
  keyId: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  permissions: z.array(z.string()),
});
const principal = z.discriminatedUnion("kind", [userPrincipal, projectKeyPrincipal]);
const project = z.looseObject({
  id: z.string(),
  organizationId: z.string(),
  slug: z.string(),
  name: z.string(),
  repoUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const projectKey = z.looseObject({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
const page = <T extends z.ZodType>(item: T) =>
  z.looseObject({ items: z.array(item), nextCursor: z.string().nullable() });
const createdProject = z.looseObject({ project, created: z.boolean() });
const createdKey = z.looseObject({ projectKey, secret: z.string().min(1) });
const revokedKey = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  revoked: z.literal(true),
});

export const lenientSchemas = {
  organization,
  principal,
  project,
  projectKey,
  organizationPage: page(organization),
  projectPage: page(project),
  projectKeyPage: page(projectKey),
  createdProject,
  createdKey,
  revokedKey,
} as const;

export type ApiOrganization = z.infer<typeof organization>;
export type ApiPrincipal = z.infer<typeof principal>;
export type ApiProject = z.infer<typeof project>;
export type ApiProjectKey = z.infer<typeof projectKey>;
export interface ApiPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageInput {
  limit?: number;
  cursor?: string;
}

export interface HivemindApi {
  readonly origin: string;
  readonly credentialSource: CredentialSource | null;
  me(): Promise<ApiPrincipal>;
  listOrganizations(input?: PageInput): Promise<ApiPage<ApiOrganization>>;
  listProjects(input?: PageInput & { organizationId?: string }): Promise<ApiPage<ApiProject>>;
  createProject(input: {
    organizationId: string;
    name: string;
    slug: string;
    repoUrl?: string;
  }): Promise<{ project: ApiProject; created: boolean }>;
  getProject(id: string): Promise<ApiProject>;
  listProjectKeys(projectId: string, input?: PageInput): Promise<ApiPage<ApiProjectKey>>;
  /** Not idempotent and never retried: each successful call mints a new key. */
  createProjectKey(
    projectId: string,
    input: { name: string; expiresInDays?: number },
  ): Promise<{ projectKey: ApiProjectKey; secret: string }>;
  revokeProjectKey(
    projectId: string,
    keyId: string,
  ): Promise<{ id: string; projectId: string; revoked: true }>;
  /** The raw typed oRPC client, for routes added after this file. Outputs are unvalidated. */
  readonly orpc: ContractRouterClient<ApiContract>;
}

export interface ApiClientOptions {
  /** Normalized origin (see origin.ts). */
  origin: string;
  /** null sends no Authorization header. */
  credential: ResolvedCredential | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Aborts in-flight requests, e.g. on SIGINT. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Errors

function unauthorizedHint(source: CredentialSource | null): string {
  if (source === "env") {
    return "HIVEMIND_TOKEN was rejected (revoked, expired or for another server). It is not replaced with a stored login; fix or unset it.";
  }
  if (source === null) return "Run 'hivemind login', or set HIVEMIND_TOKEN.";
  return "Your stored login is invalid or expired. Run 'hivemind login' again.";
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Maps an oRPC error (server JSON, or a non-oRPC error status) to a CliError with the contract's code. */
function fromOrpcError(
  error: ORPCError<string, unknown>,
  context: { origin: string; source: CredentialSource | null },
): CliError {
  let code: string;
  if (isApiErrorCode(error.code)) code = error.code;
  else {
    // A proxy or platform error page has no oRPC code; the status still says
    // which exit category it is (401 is exit 3 whoever sent it).
    const byStatus = API_ERROR_CODES.find(
      (candidate) => API_ERRORS[candidate].status === error.status,
    );
    code = byStatus ?? (CODE_PATTERN.test(error.code) ? error.code : "INTERNAL_SERVER_ERROR");
  }
  const message =
    error.message ||
    (isApiErrorCode(code) ? API_ERRORS[code].message : `The server answered HTTP ${error.status}.`);
  let hint: string | undefined;
  if (code === "UNAUTHORIZED") hint = unauthorizedHint(context.source);
  if (code === "FORBIDDEN" && context.source === "env")
    hint =
      "HIVEMIND_TOKEN does not allow this operation (a Project key can only read its own Project).";
  return new CliError(code, `${context.origin}: ${message}`, { hint, cause: error });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  if (cause && typeof cause.code === "string") return cause.code;
  if (cause && typeof cause.message === "string") return cause.message;
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------

export function createApiClient(options: ApiClientOptions): HivemindApi {
  const { origin, credential } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const source = credential?.source ?? null;

  const guardedFetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== origin) {
      // OpenAPILink builds URLs from our base URL, so this would be a bug.
      throw new CliError(CLI_ERROR_CODES.internal, `Refusing to send a request outside ${origin}.`);
    }
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json");
    headers.set("user-agent", `hivemind/${BUILD_VERSION}`);
    if (credential) headers.set("authorization", `Bearer ${credential.token}`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [timeout, request.signal, options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const idempotent = request.method === "GET" || request.method === "HEAD";
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: request.method,
        headers,
        // Management bodies are small JSON (16 KiB cap), so buffering is fine
        // and avoids streaming-body (duplex) differences between runtimes.
        body: idempotent ? undefined : await request.arrayBuffer(),
        redirect: "manual",
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      const maybeDone = idempotent
        ? undefined
        : "The server may still have completed the request; check its state before trying again.";
      if (timeout.aborted) {
        throw new CliError(
          CLI_ERROR_CODES.timeout,
          `${origin} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
          { hint: maybeDone, cause: error },
        );
      }
      if (options.signal?.aborted || isAbortError(error)) {
        throw new CliError(CLI_ERROR_CODES.cancelled, "Cancelled.", {
          hint: maybeDone,
          cause: error,
        });
      }
      throw new CliError(
        CLI_ERROR_CODES.network,
        `Cannot reach ${origin}: ${describeNetworkError(error)}.`,
        {
          hint: "Check your network connection and the server (--server or HIVEMIND_URL).",
          cause: error,
        },
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      let target = "";
      try {
        // Only the origin is shown: a redirect URL can carry its own tokens.
        if (location) target = ` to ${new URL(location, url).origin}`;
      } catch {
        // Unparseable Location: say nothing about it.
      }
      throw new CliError(
        CLI_ERROR_CODES.redirect,
        `${origin} answered with a redirect${target}. API requests are never redirected, so hivemind does not follow it.`,
        {
          hint: "Use the backend's canonical origin with --server or HIVEMIND_URL.",
        },
      );
    }
    return response;
  };

  const link = new OpenAPILink(apiContract, {
    url: `${origin}${API_BASE_PATH}`,
    fetch: (request) => guardedFetch(request),
  });
  const orpc: ContractRouterClient<ApiContract> = createORPCClient(link);

  async function call<S extends z.ZodType>(
    operation: string,
    schema: S,
    invoke: () => Promise<unknown>,
  ): Promise<z.infer<S>> {
    let raw: unknown;
    try {
      raw = await invoke();
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof ORPCError) throw fromOrpcError(error, { origin, source });
      // Body that is not JSON, or not the OpenAPI shape oRPC expects.
      throw new CliError(
        CLI_ERROR_CODES.invalidResponse,
        `${origin} sent an unreadable response to ${operation}.`,
        {
          hint: "Check that --server or HIVEMIND_URL points at a Hive Mind backend.",
          cause: error,
        },
      );
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";
    throw new CliError(
      CLI_ERROR_CODES.invalidResponse,
      `${origin} sent an unexpected response to ${operation}${where}.`,
      {
        hint: `This CLI (${BUILD_VERSION}) may be too old or too new for the server.`,
      },
    );
  }

  return {
    origin,
    credentialSource: source,
    orpc,
    me: () => call("me", principal, () => orpc.me()),
    listOrganizations: (input = {}) =>
      call("organizations.list", lenientSchemas.organizationPage, () =>
        orpc.organizations.list(input),
      ),
    listProjects: (input = {}) =>
      call("projects.list", lenientSchemas.projectPage, () => orpc.projects.list(input)),
    createProject: (input) =>
      call("projects.create", createdProject, () => orpc.projects.create(input)),
    getProject: (id) => call("projects.get", project, () => orpc.projects.get({ id })),
    listProjectKeys: (projectId, input = {}) =>
      call("projects.keys.list", lenientSchemas.projectKeyPage, () =>
        orpc.projects.keys.list({ id: projectId, ...input }),
      ),
    createProjectKey: (projectId, input) =>
      call("projects.keys.create", createdKey, () =>
        orpc.projects.keys.create({ id: projectId, ...input }),
      ),
    revokeProjectKey: (projectId, keyId) =>
      call("projects.keys.revoke", revokedKey, () =>
        orpc.projects.keys.revoke({ id: projectId, keyId }),
      ),
  };
}
