import type { ProjectKeyPermission } from "@hivemind/contract";
import type {
  CreationFailure,
  Db,
  PlanClosed,
  PlanNotFound,
  Principal,
  SessionEnded,
  SessionForbidden,
  SessionNotFound,
} from "@hivemind/db";
import type { project } from "@hivemind/db/schema";
import type { ORPCError } from "@orpc/server";
import { apiError, requireReadableProject } from "./authorize";
import { invalidCursor } from "./keyset";
import type { ApiPrincipal } from "./principal";

// Authorization for the coordination routes of #12 (ADR-0014, "Authorization
// matrix"). Every handler calls `authorizeProject` first, then resolves its
// nested resources (Plan, Task, Session) within that Project, then applies
// Session ownership rules, in that order:
//
// 1. Project access. A User must be a current Member of the Project's
//    Organization, read from `member` on this request; a Project key must be
//    bound to this Project. Anything else is 404, the same answer as a
//    Project that does not exist. Cookies and the login session's
//    `activeOrganizationId` never take part.
// 2. Capability. A Project key needs every permission the route lists, from
//    the permissions the server assigned it (`principal.ts`), never from the
//    request. Missing one on a Project it can see is 403. Users act through
//    membership and need no permission strings.
// 3. Nested resources. A Plan, Task or Session id that is absent or belongs to
//    another Project is 404 with the same message as an absent one.
// 4. Session ownership. Every Session of a Project the caller can see is
//    visible to it (`session:read`), so a Session of this Project owned by
//    another User or Project key is 403 when the caller tries to change it or
//    act through it (Session routes, Task actions, the optional actor Session
//    of Plan writes), never 404.
//
// 401 (no or bad credential) is answered before any handler runs, and
// verifier or database failures stay 500.

type ProjectRow = typeof project.$inferSelect;

export interface ProjectAccess {
  project: ProjectRow;
  /** The caller as `@hivemind/db` records it in Events and creator columns. */
  principal: Principal;
}

/**
 * The Project and the caller's database principal, if the caller may use the
 * Project with `permissions`; otherwise throws 404 (no access) or 403 (a
 * Project key without a listed permission).
 */
export async function authorizeProject(
  db: Db,
  principal: ApiPrincipal,
  projectId: string,
  permissions: readonly ProjectKeyPermission[],
): Promise<ProjectAccess> {
  const row = await requireReadableProject(db, principal, projectId);
  if (principal.kind === "projectKey") {
    const missing = permissions.filter((permission) => !principal.permissions.includes(permission));
    if (missing.length > 0) {
      throw apiError("FORBIDDEN", `This Project key lacks the ${missing.join(", ")} permission.`);
    }
  }
  return { project: row, principal: toDbPrincipal(principal) };
}

/** The API caller as a `@hivemind/db` principal. */
export function toDbPrincipal(principal: ApiPrincipal): Principal {
  return principal.kind === "user"
    ? { kind: "user", userId: principal.user.id }
    : { kind: "project_key", keyId: principal.keyId };
}

/** The 404 for a Plan that is absent or not in the path's Project. */
export function planNotFound() {
  return apiError("NOT_FOUND", "Plan not found.");
}

/** The 404 for a Session that is absent or not in the path's Project. */
export function sessionNotFound() {
  return apiError("NOT_FOUND", "Session not found.");
}

/** The 403 for a visible Session of the Project that another principal owns. */
export function sessionForbidden() {
  return apiError(
    "FORBIDDEN",
    "The Session belongs to another User or Project key; only its owner can change it or act through it.",
  );
}

/** Failure outcomes of the `@hivemind/db` coordination functions. */
export type CoordinationFailure =
  | PlanNotFound
  | PlanClosed
  | SessionNotFound
  | SessionForbidden
  | SessionEnded
  | CreationFailure
  | { status: "invalid_transition"; from: string; to: string }
  | { status: "unfinished_tasks"; count: number };

/**
 * The API error for a failure outcome. Creation conflicts and ids taken in
 * another Project say nothing about the record that holds the id.
 */
export function coordinationError(failure: CoordinationFailure) {
  switch (failure.status) {
    case "plan_not_found":
      return planNotFound();
    case "session_not_found":
      return sessionNotFound();
    case "session_forbidden":
      return sessionForbidden();
    case "id_not_found":
      return apiError("NOT_FOUND");
    case "conflict":
      return apiError(
        "CONFLICT",
        "This ID was already used with different input or by another caller.",
      );
    case "session_ended":
      return apiError("CONFLICT", "The Session has ended or was abandoned.");
    case "plan_closed":
      return apiError("CONFLICT", `The Plan is ${failure.planStatus} and accepts no changes.`);
    case "invalid_transition":
      return apiError("CONFLICT", `A Plan cannot move from ${failure.from} to ${failure.to}.`);
    case "unfinished_tasks":
      return apiError(
        "CONFLICT",
        `The Plan has ${failure.count} ${failure.count === 1 ? "Task" : "Tasks"} not done.`,
      );
  }
}

/**
 * Failure outcomes of the Session, Task-claim and Scope functions of
 * `@hivemind/db`: `not_found` (absent or another Project's), `forbidden`
 * (another principal's Session of this Project), `conflict` (with a message
 * safe to show), and `invalid` (input the contract normally rejects first).
 */
export type LifecycleFailure =
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "conflict"; message: string }
  | { status: "invalid"; message: string }
  | { status: "invalid_cursor" };

/**
 * The API error for a lifecycle or Scope failure. `notFound` names what was
 * missing, since the outcome does not say which of the route's ids it was.
 */
export function lifecycleError(
  failure: LifecycleFailure,
  notFound: () => ORPCError<string, unknown>,
) {
  switch (failure.status) {
    case "not_found":
      return notFound();
    case "forbidden":
      return sessionForbidden();
    case "conflict":
      return apiError("CONFLICT", failure.message);
    case "invalid":
      return apiError("BAD_REQUEST", failure.message);
    case "invalid_cursor":
      return invalidCursor();
  }
}
