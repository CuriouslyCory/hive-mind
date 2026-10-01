import { API_ERRORS, type ApiErrorCode } from "@hivemind/contract";
import type { Db } from "@hivemind/db";
import { member, project } from "@hivemind/db/schema";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import type { ApiPrincipal, ProjectKeyPrincipal, UserPrincipal } from "./principal";

// Request-level authorization for `/api/v1`. Every procedure calls one of
// these before touching data; `proxy.ts` is not an access check.
//
// Rules (issue #3):
// - Project keys may read their own principal and their bound Project only.
//   Anything else they try is a known forbidden operation: 403.
// - Users act through organization membership, read from `member` on every
//   request; the login session's `activeOrganizationId` is never consulted.
// - Any member may create and read the organization's Projects. Only owners
//   manage Project keys: other members get 403 for a Project they can see.
// - A Project or organization the caller cannot see is 404, the same answer
//   as one that does not exist, so its existence does not leak.

/** The organization role that may manage Project keys (the plugin's creator role). */
export const KEY_MANAGER_ROLE = "owner";

/**
 * An error in the contract's vocabulary, with the contract's status and
 * default message. `defined` matches errors raised through the contract's
 * error map, so every error body has the same shape.
 */
export function apiError(code: ApiErrorCode, message?: string): ORPCError<ApiErrorCode, undefined> {
  return new ORPCError(code, {
    defined: true,
    status: API_ERRORS[code].status,
    message: message ?? API_ERRORS[code].message,
  });
}

/** The caller as a user, or 403 for a Project key. */
export function requireUser(principal: ApiPrincipal): UserPrincipal {
  if (principal.kind !== "user") {
    throw apiError("FORBIDDEN", "Project keys cannot perform this operation.");
  }
  return principal;
}

/** The user's role in the organization, or `null` if they are not a member. */
export async function membershipRole(
  db: Db,
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
    .limit(1);
  return row?.role ?? null;
}

/** 404 unless the user is a member of the organization. */
export async function requireMembership(
  db: Db,
  user: UserPrincipal,
  organizationId: string,
): Promise<string> {
  const role = await membershipRole(db, user.user.id, organizationId);
  if (role === null) throw apiError("NOT_FOUND", "Organization not found.");
  return role;
}

type ProjectRow = typeof project.$inferSelect;

/**
 * The Project if the caller may read it: a member of its organization, or
 * the Project key bound to it. Otherwise 404.
 */
export async function requireReadableProject(
  db: Db,
  principal: ApiPrincipal,
  projectId: string,
): Promise<ProjectRow> {
  if (principal.kind === "projectKey") return requireBoundProject(db, principal, projectId);
  const [row] = await db
    .select({ project })
    .from(project)
    .innerJoin(
      member,
      and(eq(member.organizationId, project.organizationId), eq(member.userId, principal.user.id)),
    )
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) throw projectNotFound();
  return row.project;
}

/**
 * The Project if the caller owns its organization. Project keys get 403
 * whatever the Project; a member who is not an owner gets 403 for a Project
 * they can read; anyone else gets 404.
 */
export async function requireKeyManager(
  db: Db,
  principal: ApiPrincipal,
  projectId: string,
): Promise<{ user: UserPrincipal; project: ProjectRow }> {
  const user = requireUser(principal);
  const [row] = await db
    .select({ project, role: member.role })
    .from(project)
    .innerJoin(
      member,
      and(eq(member.organizationId, project.organizationId), eq(member.userId, user.user.id)),
    )
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) throw projectNotFound();
  if (row.role !== KEY_MANAGER_ROLE) {
    throw apiError("FORBIDDEN", "Only organization owners can manage Project keys.");
  }
  return { user, project: row.project };
}

async function requireBoundProject(
  db: Db,
  key: ProjectKeyPrincipal,
  projectId: string,
): Promise<ProjectRow> {
  if (projectId !== key.projectId) throw projectNotFound();
  const [row] = await db
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.organizationId, key.organizationId)))
    .limit(1);
  if (!row) throw projectNotFound();
  return row;
}

function projectNotFound() {
  return apiError("NOT_FOUND", "Project not found.");
}
