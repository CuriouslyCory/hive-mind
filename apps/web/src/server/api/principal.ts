import { PROJECT_KEY_PERMISSIONS, type ProjectKeyPermission } from "@hivemind/contract";
import type { Db } from "@hivemind/db";
import { apikey, project, projectApiKey } from "@hivemind/db/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { type Auth, PROJECT_KEY_PREFIX } from "../auth";

// Who is calling `/api/v1`. Every request resolves exactly one of these, or
// none (401). The two kinds never convert into each other: a Project key is
// not a login session, and a login session is not scoped to a Project.
//
// Only `Authorization: Bearer <token>` is read. Browser cookies are dropped
// before any lookup, so an invalid bearer token cannot fall back to the
// cookie login session of the browser that sent it, and a cross-site request
// cannot ride on a cookie (no CSRF surface; see notes/api-v1.md, decision 1).

export interface UserPrincipal {
  kind: "user";
  user: { id: string; name: string; email: string };
}

export interface ProjectKeyPrincipal {
  kind: "projectKey";
  keyId: string;
  organizationId: string;
  projectId: string;
  permissions: readonly ProjectKeyPermission[];
}

export type ApiPrincipal = UserPrincipal | ProjectKeyPrincipal;

export interface ApiDeps {
  auth: Auth;
  db: Db;
}

/** The api-key plugin's configuration id when only one configuration exists. */
const DEFAULT_KEY_CONFIG_ID = "default";

/**
 * Resolves the caller from the request's bearer token, or returns `null` when
 * there is none or it is not valid. Never throws for a bad credential; a
 * database failure propagates.
 */
export async function resolvePrincipal(
  deps: ApiDeps,
  request: Request,
): Promise<ApiPrincipal | null> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return null;
  // The prefix only picks the verifier. A token that looks like a key but is
  // not one fails key verification; it is not retried as a login session.
  return token.startsWith(PROJECT_KEY_PREFIX)
    ? resolveProjectKey(deps, request, token)
    : resolveLoginSession(deps, request, token);
}

/** The token of `Bearer <token>`, or `null` for any other shape. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer ([\x21-\x7e]+)$/i.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
}

/**
 * The request's headers with every credential removed, for server-side
 * `auth.api` calls: better-auth still needs the Host (and forwarded) headers
 * to resolve its base URL against `allowedHosts`, but must not find a cookie
 * or key to authenticate with. Removing cookies is what stops the bearer
 * plugin from falling back to a browser login session when a bearer token
 * fails its checks.
 */
export function withoutCredentials(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-api-key");
  // Next.js always sends Host; in-process callers may not.
  if (!headers.has("host")) headers.set("host", new URL(request.url).host);
  return headers;
}

/** `headers` with the bearer token as their only credential. */
function withBearer(headers: Headers, token: string): Headers {
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function resolveLoginSession(
  { auth }: ApiDeps,
  request: Request,
  token: string,
): Promise<UserPrincipal | null> {
  const result = await auth.api.getSession({
    headers: withBearer(withoutCredentials(request), token),
    // The cookie cache is a signed copy of the login session in a cookie.
    // There are no cookies here, but say so: every request reads the database,
    // so a revoked login session fails immediately.
    query: { disableCookieCache: true },
  });
  if (!result) return null;
  const { id, name, email } = result.user;
  return { kind: "user", user: { id, name, email } };
}

/**
 * Verifies a Project key once with the plugin (hash, enabled, expiry), then
 * requires its Project binding. Everything the principal carries comes from
 * the database rows, not from anything the caller sent.
 */
async function resolveProjectKey(
  { auth, db }: ApiDeps,
  request: Request,
  token: string,
): Promise<ProjectKeyPrincipal | null> {
  const verified = await auth.api.verifyApiKey({
    headers: withoutCredentials(request),
    body: { key: token },
  });
  if (!verified.valid || !verified.key) return null;

  const now = new Date();
  // One row only if the key is still live, uses the single expected
  // configuration with no plugin permissions, and its binding, its
  // organization and its Project's organization all agree. Anything else,
  // including a key with no binding, fails closed.
  const [bound] = await db
    .select({
      keyId: apikey.id,
      organizationId: projectApiKey.organizationId,
      projectId: projectApiKey.projectId,
    })
    .from(apikey)
    .innerJoin(
      projectApiKey,
      and(eq(projectApiKey.keyId, apikey.id), eq(projectApiKey.organizationId, apikey.referenceId)),
    )
    .innerJoin(
      project,
      and(
        eq(project.id, projectApiKey.projectId),
        eq(project.organizationId, projectApiKey.organizationId),
      ),
    )
    .where(
      and(
        eq(apikey.id, verified.key.id),
        eq(apikey.referenceId, verified.key.referenceId),
        eq(apikey.configId, DEFAULT_KEY_CONFIG_ID),
        eq(apikey.enabled, true),
        isNull(apikey.permissions),
        or(isNull(apikey.expiresAt), gt(apikey.expiresAt, now)),
      ),
    )
    .limit(1);
  if (!bound) return null;
  return { kind: "projectKey", ...bound, permissions: PROJECT_KEY_PERMISSIONS };
}
