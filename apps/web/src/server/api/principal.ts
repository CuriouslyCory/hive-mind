import { defaultKeyHasher } from "@better-auth/api-key";
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
// cannot ride on a cookie (no CSRF surface; see ADR-0009 and ADR-0013).

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
 * there is none or it is not valid. Never throws for a bad credential. Throws
 * when the credential could not be checked (a database failure, for either
 * kind of token), so the caller answers 500 rather than 401.
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
  if (!verified.valid || !verified.key) {
    if (verified.error?.code === UNVERIFIED_CODE) await assertNoLiveKey(db, token);
    return null;
  }

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
        ...liveKey(now),
      ),
    )
    .limit(1);
  if (!bound) return null;
  return { kind: "projectKey", ...bound, permissions: PROJECT_KEY_PERMISSIONS };
}

/**
 * The code `verifyApiKey` answers both for a key it did not find and for any
 * exception that is not a better-auth `APIError`, such as a database error,
 * which it catches and does not rethrow (better-auth 1.7.6). Its other codes
 * (disabled, expired, usage or rate limit exceeded) are verdicts on a key it
 * read, so they are always a 401.
 */
const UNVERIFIED_CODE = "INVALID_API_KEY";

/**
 * Tells "no such key" apart from "verification did not run" after the plugin
 * answered `UNVERIFIED_CODE`: reads the key by its stored hash and throws if
 * the read fails or finds a key that is live by the same checks as the
 * binding query. The plugin only answers that code for a key it found when it
 * failed before reaching a verdict, so a live key here means the request
 * could not be authenticated, not that the key is bad. A key that is not live
 * stays a 401 either way. This is a read, not a second verification: it
 * records no use of the key.
 */
async function assertNoLiveKey(db: Db, token: string): Promise<void> {
  const [live] = await db
    .select({ id: apikey.id })
    .from(apikey)
    .where(and(eq(apikey.key, await defaultKeyHasher(token)), ...liveKey(new Date())))
    .limit(1);
  if (live) {
    throw new Error(
      `Project key ${live.id} could not be verified: the api-key plugin failed without a verdict (see its log).`,
    );
  }
}

/** Conditions on `apikey` for a key `/api/v1` accepts at `now`. */
function liveKey(now: Date) {
  return [
    eq(apikey.configId, DEFAULT_KEY_CONFIG_ID),
    eq(apikey.enabled, true),
    isNull(apikey.permissions),
    or(isNull(apikey.expiresAt), gt(apikey.expiresAt, now)),
  ];
}
