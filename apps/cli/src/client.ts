import {
  type AddSessionScopeInput,
  type AddTaskInput,
  API_BASE_PATH,
  API_ERROR_CODES,
  API_ERRORS,
  type ApiContract,
  type AppendPlanLogInput,
  type AttachSessionInput,
  apiContract,
  type BlockTaskInput,
  type ClaimTaskInput,
  type CreatePlanInput,
  type EndSessionInput,
  type FinalizeCollectionInput,
  type HeartbeatSessionInput,
  isApiErrorCode,
  type ListAdrsInput,
  type PlanStatus,
  type RecordPlanDecisionInput,
  type RegisterCollectionManifestInput,
  type RemoveSessionScopeInput,
  type ReserveAdrInput,
  type SessionListFilter,
  type SetPlanStatusInput,
  type StartSessionInput,
  type SyncAdrsInput,
  type TaskStatus,
  type UpdatePlanInput,
  type UpdateSessionInput,
  type UploadAdrContentsInput,
  type UploadCollectionBatchInput,
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

// Coordination (M2). Status values stay plain strings, so a status a later
// server adds is shown rather than rejected.
const nullableString = z.string().nullable();
const planProgress = z.looseObject({
  total: z.number(),
  todo: z.number(),
  inProgress: z.number(),
  blocked: z.number(),
  done: z.number(),
});
const planSummaryShape = {
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  progress: planProgress,
  createdAt: z.string(),
  updatedAt: z.string(),
};
const planSummary = z.looseObject(planSummaryShape);
const plan = z.looseObject({ ...planSummaryShape, body: nullableString });
const task = z.looseObject({
  id: z.string(),
  planId: z.string(),
  planKey: z.string(),
  title: z.string(),
  status: z.string(),
  position: z.number(),
  claim: z
    .looseObject({ sessionId: z.string(), claimedAt: z.string(), leaseExpiresAt: z.string() })
    .nullable(),
  blockedReason: nullableString,
});
const session = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  agent: z.string(),
  intent: z.string(),
  status: z.string(),
  hostname: nullableString,
  gitBranch: nullableString,
  gitCommit: nullableString,
  attachedPlanId: nullableString,
  attachedPlanKey: nullableString,
  attachedTaskId: nullableString,
  summary: nullableString,
  scopeComplete: z.boolean(),
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  endedAt: nullableString,
});
const scope = z.looseObject({
  id: z.string(),
  sessionId: z.string(),
  source: z.string(),
  value: z.string(),
  createdAt: z.string(),
});
const event = z.looseObject({
  id: z.string(),
  type: z.string(),
  seq: z.string(),
  actorSessionId: nullableString,
  createdAt: z.string(),
  payload: z.unknown(),
});
const overlapScope = z.looseObject({ id: z.string(), source: z.string(), value: z.string() });
const overlap = z.looseObject({
  sessionId: z.string(),
  otherSessionId: z.string(),
  scope: overlapScope,
  otherScope: overlapScope,
  kind: z.string(),
  witness: nullableString,
});
const overlapPage = z.looseObject({
  items: z.array(overlap),
  nextCursor: nullableString,
  complete: z.boolean(),
  incompleteSessionIds: z.array(z.string()),
});
const claimedTaskIds = z.looseObject({ items: z.array(z.string()), complete: z.boolean() });
const heartbeat = z.looseObject({
  session,
  previousStatus: z.string(),
  renewedClaims: claimedTaskIds,
  releasedClaims: claimedTaskIds,
  leaseExpiresAt: nullableString,
  collectionId: z.string(),
  historicalScopeComplete: z.boolean(),
});
const nullableCount = z.number().nullable();
const collectionState = z.looseObject({
  collectionId: z.string(),
  sessionId: z.string(),
  pathCount: nullableCount,
  batchCount: nullableCount,
  omittedPathCount: nullableCount,
  receivedBatchCount: z.number(),
  finalized: z.boolean(),
  collectionComplete: z.boolean(),
  historicalScopeComplete: z.boolean(),
  scopeComplete: z.boolean(),
});
const collectionChange = z.looseObject({ collection: collectionState, changed: z.boolean() });
const collectionBatch = z.looseObject({
  collection: collectionState,
  changed: z.boolean(),
  storedPathCount: z.number(),
  overCapacityPathCount: z.number(),
});
const liveSessionEntry = z.looseObject({
  session,
  declaredScopes: z.array(scope),
  touchedScopeCount: z.number(),
  claimCount: z.number(),
});
const projectStatus = z.looseObject({
  projectId: z.string(),
  asOf: z.string(),
  selectedSessionId: nullableString,
  activePlans: z.array(planSummary),
  liveSessions: z.array(liveSessionEntry),
  myClaims: z.array(task),
  recentTerminalSessions: z.array(session),
  overlaps: z.array(overlap),
  complete: z.looseObject({
    activePlans: z.boolean(),
    liveSessions: z.boolean(),
    myClaims: z.boolean(),
    recentTerminalSessions: z.boolean(),
    overlaps: z.boolean(),
  }),
});
// ADRs (M4, issue #19). State, status and change kinds stay plain strings for
// the same reason as Plan statuses.
const adrReservation = z.looseObject({
  title: z.string(),
  slug: z.string(),
  gitBranch: nullableString,
  sessionId: nullableString,
  reservedAt: z.string(),
});
const adrSummaryShape = {
  id: z.string(),
  projectId: z.string(),
  number: z.number(),
  state: z.string(),
  title: z.string(),
  slug: z.string(),
  path: nullableString,
  status: nullableString,
  date: nullableString,
  supersedes: z.array(z.number()),
  contentSha256: nullableString,
  commitSha: nullableString,
  syncedAt: nullableString,
  reservation: adrReservation.nullable(),
  reservationTaken: z.boolean(),
  warningCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
};
const adrProblem = z.looseObject({ code: z.string(), message: z.string() });
const adrSummary = z.looseObject(adrSummaryShape);
const adr = z.looseObject({
  ...adrSummaryShape,
  content: nullableString,
  supersededBy: z.array(z.number()),
  warnings: z.array(adrProblem),
});
const adrSyncState = z.looseObject({
  commitSha: z.string(),
  syncedAt: z.string(),
  syncedBy: z.unknown(),
});
const adrPage = z.looseObject({
  items: z.array(adrSummary),
  nextCursor: nullableString,
  lastSync: adrSyncState.nullable(),
});
const reservedAdr = z.looseObject({ adr, created: z.boolean() });
const adrWithSync = z.looseObject({ adr, lastSync: adrSyncState.nullable() });
const adrContentResult = z.looseObject({
  sha256: z.string(),
  valid: z.boolean(),
  created: z.boolean(),
  errors: z.array(adrProblem),
  warnings: z.array(adrProblem),
});
const uploadedAdrContents = z.looseObject({ files: z.array(adrContentResult) });
const adrChange = z.looseObject({
  number: z.number(),
  change: z.string(),
  path: z.string(),
  statusFrom: nullableString,
  statusTo: nullableString,
});
const adrSyncWarning = z.looseObject({
  number: z.number(),
  path: z.string(),
  code: z.string(),
  message: z.string(),
});
const adrSyncResult = z.looseObject({
  changed: z.boolean(),
  lastSync: adrSyncState,
  previousCommitSha: nullableString,
  forced: z.boolean(),
  added: z.number(),
  updated: z.number(),
  removed: z.number(),
  unchanged: z.number(),
  changes: z.array(adrChange),
  warnings: z.looseObject({ items: z.array(adrSyncWarning), complete: z.boolean() }),
});

const createdPlan = z.looseObject({ plan, created: z.boolean() });
const changedPlan = z.looseObject({ plan, changed: z.boolean() });
const planStatusChange = z.looseObject({
  plan,
  changed: z.boolean(),
  releasedClaimCount: z.number(),
});
const appendedLog = z.looseObject({ event, created: z.boolean() });
const recordedDecision = z.looseObject({ event, created: z.boolean() });
const createdTask = z.looseObject({ task, created: z.boolean() });
const taskAction = z.looseObject({ task, changed: z.boolean() });
const claimedTask = z.looseObject({
  task,
  changed: z.boolean(),
  stolenFromSessionId: nullableString,
});
const createdSession = z.looseObject({ session, created: z.boolean() });
const sessionChange = z.looseObject({ session, changed: z.boolean() });
const endedSession = z.looseObject({
  session,
  changed: z.boolean(),
  releasedClaims: claimedTaskIds,
});
const createdScope = z.looseObject({ scope, created: z.boolean() });
const removedScope = z.looseObject({
  id: z.string(),
  sessionId: z.string(),
  removed: z.boolean(),
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
  planPage: page(planSummary),
  plan,
  createdPlan,
  changedPlan,
  planStatusChange,
  eventPage: page(event),
  appendedLog,
  taskPage: page(task),
  createdTask,
  taskAction,
  claimedTask,
  sessionPage: page(session),
  session,
  createdSession,
  sessionChange,
  heartbeat,
  endedSession,
  scopePage: page(scope),
  createdScope,
  removedScope,
  overlapPage,
  collectionChange,
  collectionBatch,
  projectStatus,
  adrPage,
  reservedAdr,
  adrWithSync,
  uploadedAdrContents,
  adrSyncResult,
} as const;

export type ApiOrganization = z.infer<typeof organization>;
export type ApiPrincipal = z.infer<typeof principal>;
export type ApiProject = z.infer<typeof project>;
export type ApiProjectKey = z.infer<typeof projectKey>;
export type ApiPlanSummary = z.infer<typeof planSummary>;
export type ApiPlan = z.infer<typeof plan>;
export type ApiTask = z.infer<typeof task>;
export type ApiSession = z.infer<typeof session>;
export type ApiScope = z.infer<typeof scope>;
export type ApiEvent = z.infer<typeof event>;
export type ApiOverlap = z.infer<typeof overlap>;
export type ApiOverlapPage = z.infer<typeof overlapPage>;
export type ApiHeartbeat = z.infer<typeof heartbeat>;
export type ApiCollectionState = z.infer<typeof collectionState>;
export type ApiProjectStatus = z.infer<typeof projectStatus>;
export type ApiAdrSummary = z.infer<typeof adrSummary>;
export type ApiAdr = z.infer<typeof adr>;
export type ApiAdrPage = z.infer<typeof adrPage>;
export type ApiAdrSyncState = z.infer<typeof adrSyncState>;
export type ApiAdrChange = z.infer<typeof adrChange>;
export type ApiAdrSyncWarning = z.infer<typeof adrSyncWarning>;
export type ApiAdrContentResult = z.infer<typeof adrContentResult>;
export type ApiAdrSyncResult = z.infer<typeof adrSyncResult>;
export type TaskAction = "release" | "start" | "done";

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

  // Coordination. Creation methods take a caller-generated UUID (`planId`,
  // `taskId`, `sessionId`, `eventId`) so a lost answer can be checked and
  // replayed with the same ID; none of them is ever retried here.
  listPlans(
    projectId: string,
    input?: PageInput & { status?: PlanStatus },
  ): Promise<ApiPage<ApiPlanSummary>>;
  createPlan(
    projectId: string,
    input: Omit<CreatePlanInput, "id">,
  ): Promise<{ plan: ApiPlan; created: boolean }>;
  getPlan(projectId: string, planRef: string): Promise<ApiPlan>;
  updatePlan(
    projectId: string,
    input: Omit<UpdatePlanInput, "id">,
  ): Promise<{ plan: ApiPlan; changed: boolean }>;
  setPlanStatus(
    projectId: string,
    input: Omit<SetPlanStatusInput, "id">,
  ): Promise<{ plan: ApiPlan; changed: boolean; releasedClaimCount: number }>;
  listPlanLog(projectId: string, planRef: string, input?: PageInput): Promise<ApiPage<ApiEvent>>;
  appendPlanLog(
    projectId: string,
    input: Omit<AppendPlanLogInput, "id">,
  ): Promise<{ event: ApiEvent; created: boolean }>;
  recordPlanDecision(
    projectId: string,
    input: Omit<RecordPlanDecisionInput, "id">,
  ): Promise<{ event: ApiEvent; created: boolean }>;
  listPlanTasks(
    projectId: string,
    planRef: string,
    input?: PageInput & { status?: TaskStatus },
  ): Promise<ApiPage<ApiTask>>;
  addTask(
    projectId: string,
    input: Omit<AddTaskInput, "id">,
  ): Promise<{ task: ApiTask; created: boolean }>;
  claimTask(
    projectId: string,
    input: Omit<ClaimTaskInput, "id">,
  ): Promise<{ task: ApiTask; changed: boolean; stolenFromSessionId: string | null }>;
  taskAction(
    projectId: string,
    action: TaskAction,
    input: { taskId: string; sessionId: string },
  ): Promise<{ task: ApiTask; changed: boolean }>;
  blockTask(
    projectId: string,
    input: Omit<BlockTaskInput, "id">,
  ): Promise<{ task: ApiTask; changed: boolean }>;
  listSessions(
    projectId: string,
    input?: PageInput & { status?: SessionListFilter },
  ): Promise<ApiPage<ApiSession>>;
  startSession(
    projectId: string,
    input: Omit<StartSessionInput, "id">,
  ): Promise<{ session: ApiSession; created: boolean }>;
  getSession(projectId: string, sessionId: string): Promise<ApiSession>;
  updateSession(
    projectId: string,
    input: Omit<UpdateSessionInput, "id">,
  ): Promise<{ session: ApiSession; changed: boolean }>;
  attachSession(
    projectId: string,
    input: Omit<AttachSessionInput, "id">,
  ): Promise<{ session: ApiSession; changed: boolean }>;
  heartbeatSession(
    projectId: string,
    input: Omit<HeartbeatSessionInput, "id">,
  ): Promise<ApiHeartbeat>;
  endSession(
    projectId: string,
    input: Omit<EndSessionInput, "id">,
  ): Promise<z.infer<typeof endedSession>>;
  listSessionClaims(
    projectId: string,
    sessionId: string,
    input?: PageInput,
  ): Promise<ApiPage<ApiTask>>;
  listSessionEvents(
    projectId: string,
    sessionId: string,
    input?: PageInput,
  ): Promise<ApiPage<ApiEvent>>;
  listSessionScopes(
    projectId: string,
    sessionId: string,
    input?: PageInput,
  ): Promise<ApiPage<ApiScope>>;
  addSessionScope(
    projectId: string,
    input: Omit<AddSessionScopeInput, "id">,
  ): Promise<{ scope: ApiScope; created: boolean }>;
  removeSessionScope(
    projectId: string,
    input: Omit<RemoveSessionScopeInput, "id">,
  ): Promise<{ id: string; sessionId: string; removed: boolean }>;
  checkSessionOverlaps(
    projectId: string,
    sessionId: string,
    input?: PageInput,
  ): Promise<ApiOverlapPage>;
  registerCollectionManifest(
    projectId: string,
    input: Omit<RegisterCollectionManifestInput, "id">,
  ): Promise<{ collection: ApiCollectionState; changed: boolean }>;
  uploadCollectionBatch(
    projectId: string,
    input: Omit<UploadCollectionBatchInput, "id">,
  ): Promise<z.infer<typeof collectionBatch>>;
  finalizeCollection(
    projectId: string,
    input: Omit<FinalizeCollectionInput, "id">,
  ): Promise<{ collection: ApiCollectionState; changed: boolean }>;
  getProjectStatus(projectId: string, sessionId?: string): Promise<ApiProjectStatus>;

  // ADRs. `reserveAdr` takes a caller-generated `adrId`, like the creations
  // above. The two upload calls are safe to repeat: content is addressed by
  // its sha256, and a sync of the commit already synced with the same files
  // changes nothing.
  listAdrs(projectId: string, input?: Omit<ListAdrsInput, "id">): Promise<ApiAdrPage>;
  reserveAdr(
    projectId: string,
    input: Omit<ReserveAdrInput, "id">,
  ): Promise<{ adr: ApiAdr; created: boolean }>;
  getAdr(
    projectId: string,
    number: number,
  ): Promise<{ adr: ApiAdr; lastSync: ApiAdrSyncState | null }>;
  uploadAdrContents(
    projectId: string,
    files: UploadAdrContentsInput["files"],
  ): Promise<{ files: ApiAdrContentResult[] }>;
  syncAdrs(projectId: string, input: Omit<SyncAdrsInput, "id">): Promise<ApiAdrSyncResult>;
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
      "HIVEMIND_TOKEN does not allow this operation (a Project key works only in its own Project, and cannot manage Organizations, Projects or keys).";
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

/**
 * The guarded fetch every backend request goes through: same-origin only,
 * bearer attached here and nowhere else, `redirect: "manual"` with any 3xx
 * turned into UNEXPECTED_REDIRECT, a timeout, the caller's abort signal, and
 * transport failures mapped to TIMEOUT / CANCELLED / NETWORK_ERROR. The body
 * is read in full (size-capped) under the same timeout and mapping, and the
 * returned Response holds it in memory, so reading it cannot fail. Pass a
 * path (`/api/auth/device/code`) or a Request on the origin. Exported for
 * routes outside the oRPC contract, such as better-auth's device flow; it
 * never retries.
 */
export type OriginFetch = (input: Request | string, init?: RequestInit) => Promise<Response>;

export function createOriginFetch(options: ApiClientOptions): OriginFetch {
  const { origin, credential } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === "string" ? new Request(new URL(input, origin), init) : input;
    const url = new URL(request.url);
    if (url.origin !== origin) {
      // Only paths on the resolved origin are ever requested; anything else is a bug.
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
    const maybeDone = idempotent
      ? undefined
      : "The server may still have completed the request; check its state before trying again.";
    // One mapping for both phases: the timeout and the abort signal cover the
    // headers and the body alike, so a server that stalls mid-body fails the
    // same way as one that never answers.
    const transportError = (error: unknown, phase: "send" | "read"): CliError => {
      if (timeout.aborted) {
        return new CliError(
          CLI_ERROR_CODES.timeout,
          `${origin} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
          { hint: maybeDone, cause: error },
        );
      }
      if (options.signal?.aborted || isAbortError(error)) {
        return new CliError(CLI_ERROR_CODES.cancelled, "Cancelled.", {
          hint: maybeDone,
          cause: error,
        });
      }
      return new CliError(
        CLI_ERROR_CODES.network,
        phase === "send"
          ? `Cannot reach ${origin}: ${describeNetworkError(error)}.`
          : `The connection to ${origin} failed while reading its answer: ${describeNetworkError(error)}.`,
        {
          // Once headers arrived, the server has seen the request.
          hint:
            (phase === "read" ? maybeDone : undefined) ??
            "Check your network connection and the server (--server or HIVEMIND_URL).",
          cause: error,
        },
      );
    };
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: request.method,
        headers,
        // Request bodies are small JSON (16 KiB, 256 KiB for ADR uploads), so
        // buffering is fine and avoids streaming-body (duplex) differences
        // between runtimes.
        body: idempotent ? undefined : await request.arrayBuffer(),
        redirect: "manual",
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      throw transportError(error, "send");
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
    // The body is read here, inside the guarded section, rather than by
    // whoever parses it (oRPC, the device flow): their reads would see a raw
    // TimeoutError/AbortError and report it as an unreadable response or a bug.
    let bytes: Uint8Array<ArrayBuffer> | null;
    try {
      bytes = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw transportError(error, "read");
    }
    if (bytes === null) {
      throw new CliError(
        CLI_ERROR_CODES.invalidResponse,
        `${origin} sent a response larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MiB.`,
        {
          hint: maybeDone ?? "Check that --server or HIVEMIND_URL points at a hive-mind backend.",
        },
      );
    }
    // fetch already decoded the body, so the encoding headers no longer apply.
    const bodyHeaders = new Headers(response.headers);
    bodyHeaders.delete("content-encoding");
    bodyHeaders.delete("content-length");
    return new Response(bytes.byteLength === 0 ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: bodyHeaders,
    });
  };
}

/** Management answers are small JSON; anything this large is not a hive-mind answer. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The whole body, or null (and the stream cancelled) once it exceeds `limit` bytes. */
async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createApiClient(options: ApiClientOptions): HivemindApi {
  const { origin, credential } = options;
  const source = credential?.source ?? null;
  const guardedFetch = createOriginFetch(options);

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
          hint: "Check that --server or HIVEMIND_URL points at a hive-mind backend.",
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
    listPlans: (projectId, input = {}) =>
      call("projects.plans.list", lenientSchemas.planPage, () =>
        orpc.projects.plans.list({ id: projectId, ...input }),
      ),
    createPlan: (projectId, input) =>
      call("projects.plans.create", createdPlan, () =>
        orpc.projects.plans.create({ id: projectId, ...input }),
      ),
    getPlan: (projectId, planRef) =>
      call("projects.plans.get", plan, () => orpc.projects.plans.get({ id: projectId, planRef })),
    updatePlan: (projectId, input) =>
      call("projects.plans.update", changedPlan, () =>
        orpc.projects.plans.update({ id: projectId, ...input }),
      ),
    setPlanStatus: (projectId, input) =>
      call("projects.plans.setStatus", planStatusChange, () =>
        orpc.projects.plans.setStatus({ id: projectId, ...input }),
      ),
    listPlanLog: (projectId, planRef, input = {}) =>
      call("projects.plans.log.list", lenientSchemas.eventPage, () =>
        orpc.projects.plans.log.list({ id: projectId, planRef, ...input }),
      ),
    appendPlanLog: (projectId, input) =>
      call("projects.plans.log.append", appendedLog, () =>
        orpc.projects.plans.log.append({ id: projectId, ...input }),
      ),
    recordPlanDecision: (projectId, input) =>
      call("projects.plans.decisions.record", recordedDecision, () =>
        orpc.projects.plans.decisions.record({ id: projectId, ...input }),
      ),
    listPlanTasks: (projectId, planRef, input = {}) =>
      call("projects.plans.tasks.list", lenientSchemas.taskPage, () =>
        orpc.projects.plans.tasks.list({ id: projectId, planRef, ...input }),
      ),
    addTask: (projectId, input) =>
      call("projects.plans.tasks.add", createdTask, () =>
        orpc.projects.plans.tasks.add({ id: projectId, ...input }),
      ),
    claimTask: (projectId, input) =>
      call("projects.tasks.claim", claimedTask, () =>
        orpc.projects.tasks.claim({ id: projectId, ...input }),
      ),
    taskAction: (projectId, action, input) =>
      call(`projects.tasks.${action}`, taskAction, () =>
        orpc.projects.tasks[action]({ id: projectId, ...input }),
      ),
    blockTask: (projectId, input) =>
      call("projects.tasks.block", taskAction, () =>
        orpc.projects.tasks.block({ id: projectId, ...input }),
      ),
    listSessions: (projectId, input = {}) =>
      call("projects.sessions.list", lenientSchemas.sessionPage, () =>
        orpc.projects.sessions.list({ id: projectId, ...input }),
      ),
    startSession: (projectId, input) =>
      call("projects.sessions.start", createdSession, () =>
        orpc.projects.sessions.start({ id: projectId, ...input }),
      ),
    getSession: (projectId, sessionId) =>
      call("projects.sessions.get", session, () =>
        orpc.projects.sessions.get({ id: projectId, sessionId }),
      ),
    updateSession: (projectId, input) =>
      call("projects.sessions.update", sessionChange, () =>
        orpc.projects.sessions.update({ id: projectId, ...input }),
      ),
    attachSession: (projectId, input) =>
      call("projects.sessions.attach", sessionChange, () =>
        orpc.projects.sessions.attach({ id: projectId, ...input }),
      ),
    heartbeatSession: (projectId, input) =>
      call("projects.sessions.heartbeat", heartbeat, () =>
        orpc.projects.sessions.heartbeat({ id: projectId, ...input }),
      ),
    endSession: (projectId, input) =>
      call("projects.sessions.end", endedSession, () =>
        orpc.projects.sessions.end({ id: projectId, ...input }),
      ),
    listSessionClaims: (projectId, sessionId, input = {}) =>
      call("projects.sessions.claims", lenientSchemas.taskPage, () =>
        orpc.projects.sessions.claims({ id: projectId, sessionId, ...input }),
      ),
    listSessionEvents: (projectId, sessionId, input = {}) =>
      call("projects.sessions.events", lenientSchemas.eventPage, () =>
        orpc.projects.sessions.events({ id: projectId, sessionId, ...input }),
      ),
    listSessionScopes: (projectId, sessionId, input = {}) =>
      call("projects.sessions.scopes.list", lenientSchemas.scopePage, () =>
        orpc.projects.sessions.scopes.list({ id: projectId, sessionId, ...input }),
      ),
    addSessionScope: (projectId, input) =>
      call("projects.sessions.scopes.add", createdScope, () =>
        orpc.projects.sessions.scopes.add({ id: projectId, ...input }),
      ),
    removeSessionScope: (projectId, input) =>
      call("projects.sessions.scopes.remove", removedScope, () =>
        orpc.projects.sessions.scopes.remove({ id: projectId, ...input }),
      ),
    checkSessionOverlaps: (projectId, sessionId, input = {}) =>
      call("projects.sessions.overlaps", overlapPage, () =>
        orpc.projects.sessions.overlaps({ id: projectId, sessionId, ...input }),
      ),
    registerCollectionManifest: (projectId, input) =>
      call("projects.sessions.collections.manifest", collectionChange, () =>
        orpc.projects.sessions.collections.manifest({ id: projectId, ...input }),
      ),
    uploadCollectionBatch: (projectId, input) =>
      call("projects.sessions.collections.batch", collectionBatch, () =>
        orpc.projects.sessions.collections.batch({ id: projectId, ...input }),
      ),
    finalizeCollection: (projectId, input) =>
      call("projects.sessions.collections.finalize", collectionChange, () =>
        orpc.projects.sessions.collections.finalize({ id: projectId, ...input }),
      ),
    getProjectStatus: (projectId, sessionId) =>
      call("projects.status", projectStatus, () =>
        orpc.projects.status(
          sessionId === undefined ? { id: projectId } : { id: projectId, sessionId },
        ),
      ),
    listAdrs: (projectId, input = {}) =>
      call("projects.adrs.list", adrPage, () =>
        orpc.projects.adrs.list({ id: projectId, ...input }),
      ),
    reserveAdr: (projectId, input) =>
      call("projects.adrs.reserve", reservedAdr, () =>
        orpc.projects.adrs.reserve({ id: projectId, ...input }),
      ),
    getAdr: (projectId, number) =>
      call("projects.adrs.get", adrWithSync, () =>
        orpc.projects.adrs.get({ id: projectId, number }),
      ),
    uploadAdrContents: (projectId, files) =>
      call("projects.adrs.contents", uploadedAdrContents, () =>
        orpc.projects.adrs.contents({ id: projectId, files }),
      ),
    syncAdrs: (projectId, input) =>
      call("projects.adrs.sync", adrSyncResult, () =>
        orpc.projects.adrs.sync({ id: projectId, ...input }),
      ),
  };
}
