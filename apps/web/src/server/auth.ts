import { randomBytes } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Db } from "@hivemind/db";
import * as schema from "@hivemind/db/schema";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { nextCookies } from "better-auth/next-js";
import { bearer, deviceAuthorization, oAuthProxy, organization } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { env } from "../env";
import { AUTH_BASE_PATH, AUTH_COOKIE_PREFIX } from "../lib/auth-config";
import { getDb } from "./db";
import { guardDeviceCodeDecisions } from "./device-code-guard";

// Threat model notes (ADR-0006):
// - Preview deployments sign in through production with oAuthProxy, because a
//   GitHub OAuth app allows one callback URL. The proxy payload is encrypted
//   with OAUTH_PROXY_SECRET, which Production and Preview share.
// - Only the hosts in `allowedHosts` can be a base URL or a trusted origin.
//   They are exact hosts, never patterns: a `*` in a vercel.app host can match
//   deployments of other Vercel teams. Production does not trust preview
//   hosts; it returns the OAuth result to the preview named in the encrypted
//   state, not to a URL taken from the request.
// - `activeOrganizationId` is a UI default, not an authorization decision.
//   Authorize through project -> organization membership.
// - The CLI's device client ID is public and identifies the client; it never
//   proves who is calling. Approval happens in the browser, under the user's
//   cookie login session.
// - A Project key is an organization-owned API key bound to one Project by
//   the application's `project_api_key` table. It never becomes a login
//   session, and the plugin's own HTTP routes are disabled, so keys are only
//   created, listed and revoked by server code that checks the binding.

/** `next dev`. Trusted only outside Vercel deployments. */
export const LOCAL_DEV_HOST = "localhost:3000";

/** GitHub's maximum login length, and so the maximum organization slug length. */
export const MAX_SLUG_LENGTH = 39;

/**
 * Organization plugin routes that answer 404 until M3 builds invitations and
 * member management (ADR-0007). Every user has exactly their personal
 * organization until then. Teams are off, so their routes do not exist.
 * `disabledPaths` applies to HTTP requests only; server code can still call
 * the matching `auth.api` methods.
 */
export const ORGANIZATION_PATHS_DISABLED_UNTIL_M3 = [
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/get-invitation",
  "/organization/list-invitations",
  "/organization/list-user-invitations",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/leave",
];

/** The device authorization client ID the CLI sends. Public, not a secret. */
export const CLI_CLIENT_ID = "hivemind-cli";

/** Client IDs allowed to start the device flow. Any other is `invalid_client`. */
export const DEVICE_CLIENT_IDS: readonly string[] = [CLI_CLIENT_ID];

/**
 * How long a device code and its user code stay valid, and the minimum
 * polling interval the CLI is told to use. better-auth's time strings; the
 * response reports them in seconds (`expires_in`, `interval`).
 */
export const DEVICE_CODE_EXPIRES_IN = "10m";
export const DEVICE_CODE_POLLING_INTERVAL = "5s";

/**
 * The page where the user enters or confirms the user code, relative to the
 * request's origin. The device flow returns it as `verification_uri`, and
 * `verification_uri_complete` adds `?user_code=...`.
 */
export const DEVICE_VERIFICATION_PATH = "/device";

/**
 * The device plugin's approve and deny routes answer 404 over HTTP. The
 * `/device` page's server action calls them through `auth.api`, with the
 * browser's cookie login session only, after showing the user code. Over HTTP
 * they would also accept a bearer login session token, so a CLI token could
 * approve further device codes for its User.
 */
export const DEVICE_DECISION_PATHS_DISABLED = ["/device/approve", "/device/deny"];

/**
 * Every Project key starts with this, so `/api/v1` can tell one from a login
 * session token before verifying it. Recognizing the prefix never
 * authenticates anything.
 */
export const PROJECT_KEY_PREFIX = "hm_";

/** Longest Project key name; the contract's limit (issue #3). */
export const PROJECT_KEY_NAME_MAX_LENGTH = 120;

/** Bounds on a Project key's lifetime when the caller sets one, in days. */
export const PROJECT_KEY_MIN_EXPIRES_IN_DAYS = 1;
export const PROJECT_KEY_MAX_EXPIRES_IN_DAYS = 365;

/**
 * The api-key plugin's HTTP routes in better-auth 1.7.6. They answer 404:
 * they would let a caller create, change or list organization keys that no
 * Project binding restricts. Server code calls the matching `auth.api`
 * methods after its own authorization. The auth route handler also rejects
 * every `/api-key/*` path (see `isRawApiKeyPath`), so a route added by a
 * plugin upgrade is not exposed before it is reviewed.
 */
export const API_KEY_PATHS_DISABLED = [
  "/api-key/create",
  "/api-key/get",
  "/api-key/update",
  "/api-key/delete",
  "/api-key/list",
];

export interface CreateAuthOptions {
  db: Db;
  /** BETTER_AUTH_SECRET: signs cookies and encrypts stored OAuth tokens. */
  secret: string;
  github: { clientId: string; clientSecret: string };
  /** OAUTH_PROXY_SECRET: encrypts the oAuthProxy payload. */
  oauthProxySecret: string;
  /**
   * The production origin, such as `https://hive-mind.example`. oAuthProxy
   * sends OAuth callbacks there from every other allowed host. Unset in local
   * development, where the dev OAuth app calls back to localhost directly.
   */
  productionURL?: string | undefined;
  /** The hosts this deployment serves; see `allowedHosts`. */
  allowedHosts: string[];
  /**
   * Extra plugins, inserted before `nextCookies` (which must stay last). For
   * tests, such as better-auth's `testUtils`.
   */
  plugins?: BetterAuthPlugin[];
}

export interface HostPolicyInput {
  /** VERCEL_ENV. Anything but `production` or `preview` is local development. */
  vercelEnv: "production" | "preview" | "development" | undefined;
  productionURL: string | undefined;
  /** The deployment's own hosts, VERCEL_URL and VERCEL_BRANCH_URL. */
  deploymentHosts: (string | undefined)[];
}

/**
 * Hosts that may serve the auth API. better-auth resolves the base URL of
 * each request from its `Host` header and rejects any host not listed here.
 * Each host is also a trusted origin (https, plus http for localhost), so
 * `trustedOrigins` needs no separate list.
 *
 * Production trusts only its own host, each preview only its deployment URL
 * and branch alias, and local development only localhost.
 */
export function allowedHosts(input: HostPolicyInput): string[] {
  switch (input.vercelEnv) {
    case "production": {
      if (!input.productionURL) {
        throw new Error("Production needs BETTER_AUTH_URL or VERCEL_PROJECT_PRODUCTION_URL.");
      }
      return [new URL(input.productionURL).host];
    }
    case "preview": {
      const hosts = input.deploymentHosts.filter((host): host is string => Boolean(host));
      if (hosts.length === 0) {
        throw new Error("A preview deployment needs VERCEL_URL or VERCEL_BRANCH_URL.");
      }
      return [...new Set(hosts)];
    }
    default:
      return [LOCAL_DEV_HOST];
  }
}

/**
 * Builds a better-auth instance. The app uses the lazy `auth` below; tests
 * call this directly with their own database and plugins.
 */
export function createAuth(opts: CreateAuthOptions) {
  const { db } = opts;
  return betterAuth({
    basePath: AUTH_BASE_PATH,
    disabledPaths: [
      ...ORGANIZATION_PATHS_DISABLED_UNTIL_M3,
      ...DEVICE_DECISION_PATHS_DISABLED,
      ...API_KEY_PATHS_DISABLED,
    ],
    baseURL: {
      allowedHosts: opts.allowedHosts,
      // No fallback: a request from any other host fails instead of being
      // treated as production.
    },
    secret: opts.secret,
    database: guardDeviceCodeDecisions(
      drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    ),
    socialProviders: {
      github: {
        clientId: opts.github.clientId,
        clientSecret: opts.github.clientSecret,
        mapProfileToUser: (profile) => ({ githubLogin: profile.login }),
      },
    },
    user: {
      additionalFields: {
        // Set from the GitHub profile when the user is created, and used to
        // derive the personal organization's slug. It is a label only: never
        // authorize with it. oAuthProxy does not forward mapped fields, so
        // users created on a preview deployment have none.
        githubLogin: { type: "string", required: false },
      },
    },
    account: {
      encryptOAuthTokens: true,
    },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      // better-auth skips origin and callback URL checks when NODE_ENV is
      // `test`. Keep them on everywhere, so tests exercise them too.
      disableOriginCheck: false,
      database: { generateId: "uuid" },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await ensurePersonalOrganization(db, user);
          },
        },
        update: {
          // `githubLogin` must accept input so the GitHub profile can set it,
          // which would also let a user rewrite it with /update-user.
          before: async (changes) => !("githubLogin" in changes),
        },
      },
      session: {
        create: {
          before: async (loginSession) => {
            if (loginSession.activeOrganizationId) return;
            return {
              data: { activeOrganizationId: await defaultOrganizationId(db, loginSession.userId) },
            };
          },
        },
      },
    },
    plugins: [
      organization({
        // Users get their personal organization from the hooks above and no
        // other until M3. ensurePersonalOrganization writes to the database
        // directly, so this does not block it.
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
      }),
      oAuthProxy({ productionURL: opts.productionURL, secret: opts.oauthProxySecret }),
      deviceAuthorization({
        expiresIn: DEVICE_CODE_EXPIRES_IN,
        interval: DEVICE_CODE_POLLING_INTERVAL,
        verificationUri: DEVICE_VERIFICATION_PATH,
        validateClient: (clientId) => DEVICE_CLIENT_IDS.includes(clientId),
      }),
      rejectDeviceUserPreBinding(),
      // The device flow returns the raw login session token, which is not
      // signed, so bearer() must accept unsigned tokens. It looks each one up
      // like a cookie, so a revoked or expired login session fails.
      bearer({ requireSignature: false }),
      apiKey({
        references: "organization",
        defaultPrefix: PROJECT_KEY_PREFIX,
        // Only a SHA-256 hash is stored; the key is shown once, at creation.
        disableKeyHashing: false,
        // A key must never act as a login session (issue #3): /api/v1 maps it
        // to a separate Project-key principal instead.
        enableSessionForAPIKeys: false,
        // Authorization comes from project_api_key, never from metadata a
        // caller could set.
        enableMetadata: false,
        maximumNameLength: PROJECT_KEY_NAME_MAX_LENGTH,
        keyExpiration: {
          defaultExpiresIn: null,
          minExpiresIn: PROJECT_KEY_MIN_EXPIRES_IN_DAYS,
          maxExpiresIn: PROJECT_KEY_MAX_EXPIRES_IN_DAYS,
        },
        // The plugin's default allows 10 requests a day per key, and counts
        // them with a write on every verification. Request limits are M7's.
        rateLimit: { enabled: false },
      }),
      ...(opts.plugins ?? []),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Whether a path under the auth base path is, or could normalize to, an
 * api-key plugin route: any segment that starts with `api-key`, compared
 * without case after repeated percent-decoding, with a backslash read as `/` and
 * empty segments dropped. The auth route handler answers 404 for these before
 * better-auth sees the request, so this does not depend on how better-auth or
 * its router normalize paths. A path that does not decode cleanly counts as
 * one, so it fails closed.
 */
export function isRawApiKeyPath(pathname: string): boolean {
  let decoded = pathname;
  for (let round = 0; ; round++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) break;
    if (round === 4) return true;
    decoded = next;
  }
  return decoded
    .toLowerCase()
    .split(/[/\\]+/)
    .some((segment) => segment.trim().startsWith("api-key"));
}

/**
 * Rejects a device authorization request that names a user. better-auth
 * accepts `user_id` to pre-bind the code to a user, but the caller is an
 * unauthenticated CLI, so the user must come from the browser approval.
 * Checked for JSON and form bodies, which the plugin both accepts.
 */
function rejectDeviceUserPreBinding(): BetterAuthPlugin {
  return {
    id: "hivemind-device-no-user-binding",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/device/code",
          handler: createAuthMiddleware(async (ctx) => {
            const body: unknown = ctx.body;
            let named = typeof body === "object" && body !== null && "user_id" in body;
            const contentType = ctx.request?.headers.get("content-type")?.toLowerCase() ?? "";
            if (
              !named &&
              ctx.request &&
              contentType.includes("application/x-www-form-urlencoded")
            ) {
              named = new URLSearchParams(await ctx.request.clone().text()).has("user_id");
            }
            if (named) {
              throw new APIError("BAD_REQUEST", {
                error: "invalid_request",
                error_description: "user_id is not accepted",
              });
            }
          }),
        },
      ],
    },
  };
}

/**
 * Returns the user's first organization, creating their personal organization
 * with the user as `owner` if they have none. The slug is the GitHub login,
 * lowercased; if that is taken, a random suffix is added.
 *
 * Idempotent per user: a transaction-scoped advisory lock on the user id
 * serializes concurrent calls (such as two first login sessions at once), and
 * membership is re-checked after taking it, so only one call creates an
 * organization.
 */
async function ensurePersonalOrganization(
  db: Db,
  user: { id: string; name: string; email: string; githubLogin?: unknown },
): Promise<string> {
  const base = slugify(
    typeof user.githubLogin === "string" && user.githubLogin
      ? user.githubLogin
      : user.name || (user.email.split("@")[0] ?? ""),
  );
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${user.id}::text, 0))`);
    const existing = await firstOrganizationId(tx, user.id);
    if (existing) return existing;

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : suffixedSlug(base, randomBytes(3).toString("hex"));
      const [created] = await tx
        .insert(schema.organization)
        .values({ name: user.name || slug, slug })
        .onConflictDoNothing({ target: schema.organization.slug })
        .returning({ id: schema.organization.id });
      if (!created) continue;
      await tx
        .insert(schema.member)
        .values({ organizationId: created.id, userId: user.id, role: "owner" });
      return created.id;
    }
    throw new Error(`Could not find a free organization slug for user ${user.id}.`);
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The organization of the user's oldest membership, if any. */
async function firstOrganizationId(db: Db | Tx, userId: string): Promise<string | undefined> {
  const first = await db.query.member.findFirst({
    columns: { organizationId: true },
    where: (member, { eq }) => eq(member.userId, userId),
    orderBy: (member, { asc }) => [asc(member.createdAt)],
  });
  return first?.organizationId;
}

/**
 * The organization a new login session starts in: the user's first
 * membership, which is their personal organization. If the user has none
 * (because creating it failed during sign-up), it is created now.
 */
async function defaultOrganizationId(db: Db, userId: string): Promise<string> {
  const first = await firstOrganizationId(db, userId);
  if (first) return first;

  const user = await db.query.user.findFirst({ where: (user, { eq }) => eq(user.id, userId) });
  if (!user) throw new Error(`User ${userId} does not exist.`);
  return ensurePersonalOrganization(db, user);
}

/**
 * Lowercase letters, digits and single hyphens, at most `MAX_SLUG_LENGTH`
 * characters; never empty.
 */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || "user";
}

/**
 * `base-suffix`, with `base` shortened so the result stays within
 * `MAX_SLUG_LENGTH`.
 */
export function suffixedSlug(base: string, suffix: string): string {
  const room = MAX_SLUG_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, "")}-${suffix}`;
}

/**
 * The login session's active organization, or `null` if it has none or the
 * user is no longer a member of it. In that case better-auth also clears
 * the login session's `activeOrganizationId`.
 */
export async function getActiveOrganization(instance: Auth, headers: Headers) {
  try {
    return await instance.api.getFullOrganization({ headers, query: { membersLimit: 1 } });
  } catch (error) {
    if (isAPIError(error) && error.body?.code === "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION") {
      return null;
    }
    throw error;
  }
}

/**
 * The production origin: BETTER_AUTH_URL, which is set only in Production, or
 * else Vercel's production domain on Vercel deployments. Undefined in local
 * development, so oAuthProxy stays out of the way there.
 */
function productionURLFromEnv(): string | undefined {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  const onVercel = env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
  if (onVercel && env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return undefined;
}

let instance: Auth | undefined;

function load(): Auth {
  if (instance) return instance;
  const productionURL = productionURLFromEnv();
  instance = createAuth({
    db: getDb(),
    secret: env.BETTER_AUTH_SECRET,
    github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    oauthProxySecret: env.OAUTH_PROXY_SECRET,
    productionURL,
    allowedHosts: allowedHosts({
      vercelEnv: env.VERCEL_ENV,
      productionURL,
      deploymentHosts: [env.VERCEL_URL, env.VERCEL_BRANCH_URL],
    }),
  });
  return instance;
}

/**
 * The app's better-auth instance. It is created on first property access,
 * not at import, so `next build` can import route modules without auth
 * environment variables. A missing variable fails the first request with an
 * error that names it.
 */
export const auth: Auth = new Proxy({} as Auth, {
  get: (_target, key) => Reflect.get(load(), key),
  has: (_target, key) => Reflect.has(load(), key),
  ownKeys: () => Reflect.ownKeys(load()),
  getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(load(), key),
});
