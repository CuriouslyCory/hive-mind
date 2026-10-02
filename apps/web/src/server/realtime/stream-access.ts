import type { DbOrTransaction } from "@hivemind/db";
import { session } from "@hivemind/db/schema";
import { ORPCError } from "@orpc/server";
import { and, eq, gt } from "drizzle-orm";
import { requireReadableProject } from "../api/authorize";
import { type ApiPrincipal, readLiveProjectKey, type UserPrincipal } from "../api/principal";
import type { Auth } from "../auth";
import type { StreamAccess } from "./event-stream";

// Who may keep receiving a Project's Event stream (issue #11, "Authorization
// and transport"; ADR-0010).
//
// When a stream opens, its adapter resolves the caller with better-auth's
// full verification: a bearer token or Project key for `/api/v1`
// (`principal.ts`), the signed cookie for the dashboard route
// (`resolveCookiePrincipal`). Both read the database, never a cookie cache.
// Before every later batch the engine calls `recheckStreamAccess`, which
// re-reads the rows a revocation changes, in the batch's own transaction,
// with no result kept between calls: the same split as M2's lock-time
// `recheckProjectAccess` (ADR-0014).

/**
 * Whether `principal` may still read `projectId`'s Events, from the database
 * now: the login session row still exists, belongs to the User and has not
 * expired, or the Project key is still live and bound; then Project access
 * through current Organization membership or the key's binding (the same
 * rule as `requireReadableProject`). A lost credential is `UNAUTHORIZED`,
 * lost Project access `NOT_FOUND`. Throws when the database fails.
 */
export async function recheckStreamAccess(
  executor: DbOrTransaction,
  principal: ApiPrincipal,
  projectId: string,
): Promise<StreamAccess> {
  const now = new Date();
  let current: ApiPrincipal;
  if (principal.kind === "user") {
    if (!(await loginSessionIsLive(executor, principal, now))) {
      return { ok: false, code: "UNAUTHORIZED" };
    }
    current = principal;
  } else {
    const key = await readLiveProjectKey(
      executor,
      { keyId: principal.keyId, organizationId: principal.organizationId },
      now,
    );
    if (!key) return { ok: false, code: "UNAUTHORIZED" };
    current = key;
  }
  try {
    await requireReadableProject(executor, current, projectId);
  } catch (error) {
    if (error instanceof ORPCError && error.code === "NOT_FOUND") {
      return { ok: false, code: "NOT_FOUND" };
    }
    throw error;
  }
  return { ok: true };
}

/**
 * Whether the login session row behind `user` still authenticates them:
 * revoking deletes the row, and better-auth refuses it once `expiresAt` has
 * passed. Its signature or bearer token was verified when the stream opened.
 */
async function loginSessionIsLive(
  executor: DbOrTransaction,
  user: UserPrincipal,
  now: Date,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, user.loginSessionId),
        eq(session.userId, user.user.id),
        gt(session.expiresAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The User of the request's cookie login session, read from the database
 * (cookie cache off, no refresh written), or `null` when there is none or it
 * is not valid. Only the cookie counts: `Authorization` and `X-API-Key` are
 * removed first, so a bearer token or Project key can neither sign in nor
 * stand in for a missing cookie. Throws when the check could not run.
 */
export async function resolveCookiePrincipal(
  auth: Auth,
  request: Request,
): Promise<UserPrincipal | null> {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  if (!headers.has("host")) headers.set("host", new URL(request.url).host);
  const result = await auth.api.getSession({
    headers,
    // Read the login session row on every request, so a revoked one fails
    // at once; a stream does not extend the login session.
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!result) return null;
  const { id, name, email } = result.user;
  return { kind: "user", user: { id, name, email }, loginSessionId: result.session.id };
}
