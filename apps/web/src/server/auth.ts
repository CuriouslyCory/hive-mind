import { randomBytes } from "node:crypto";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Db } from "@hivemind/db";
import * as schema from "@hivemind/db/schema";
import type { BetterAuthPlugin } from "better-auth";
import { betterAuth } from "better-auth/minimal";
import { nextCookies } from "better-auth/next-js";
import { oAuthProxy, organization } from "better-auth/plugins";
import { env } from "../env";
import { AUTH_BASE_PATH, AUTH_COOKIE_PREFIX } from "../lib/auth-config";
import { getDb } from "./db";

// Threat model notes (ADR-0006):
// - Preview deployments sign in through production with oAuthProxy, because a
//   GitHub OAuth app allows one callback URL. The proxy payload is encrypted
//   with OAUTH_PROXY_SECRET, which Production and Preview share.
// - Only the hosts in `allowedHosts` can be a base URL or a trusted origin.
//   Never widen the preview pattern to `*.vercel.app`: any Vercel user can
//   deploy there.
// - `activeOrganizationId` is a UI default, not an authorization decision.
//   Authorize through project -> organization membership.

/**
 * Preview deployments of the `hive-mind-web` Vercel project in the
 * `curiouslycorys-projects` team. Matches both deployment URLs
 * (`hive-mind-web-<hash>-curiouslycorys-projects.vercel.app`) and branch
 * aliases (`hive-mind-web-git-<branch>-curiouslycorys-projects.vercel.app`).
 *
 * `*` also matches hyphens, so another Vercel team whose slug ends in
 * `-curiouslycorys-projects` could deploy a matching host. A custom preview
 * domain would close that gap.
 */
export const PREVIEW_HOST_PATTERN = "hive-mind-*-curiouslycorys-projects.vercel.app";

/** `next dev`. Trusted only outside Vercel deployments. */
export const LOCAL_DEV_HOST = "localhost:3000";

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
  /** Whether `http://localhost:3000` is an allowed host. */
  allowLocalDev: boolean;
  /**
   * Extra plugins, inserted before `nextCookies` (which must stay last). For
   * tests, such as better-auth's `testUtils`.
   */
  plugins?: BetterAuthPlugin[];
}

/**
 * Hosts that may serve the auth API. better-auth resolves the base URL of
 * each request from its `Host` header and rejects any host not listed here.
 * Each host is also a trusted origin (https, plus http for localhost), so
 * `trustedOrigins` needs no separate list.
 */
export function allowedHosts(opts: Pick<CreateAuthOptions, "productionURL" | "allowLocalDev">) {
  return [
    ...(opts.productionURL ? [new URL(opts.productionURL).host] : []),
    PREVIEW_HOST_PATTERN,
    ...(opts.allowLocalDev ? [LOCAL_DEV_HOST] : []),
  ];
}

/**
 * Builds a better-auth instance. The app uses the lazy `auth` below; tests
 * call this directly with their own database and plugins.
 */
export function createAuth(opts: CreateAuthOptions) {
  const { db } = opts;
  return betterAuth({
    basePath: AUTH_BASE_PATH,
    baseURL: {
      allowedHosts: allowedHosts(opts),
      // No fallback: a request from any other host fails instead of being
      // treated as production.
    },
    secret: opts.secret,
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
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
      database: { generateId: "uuid" },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await createPersonalOrganization(db, user);
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
      organization(),
      oAuthProxy({ productionURL: opts.productionURL, secret: opts.oauthProxySecret }),
      ...(opts.plugins ?? []),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Creates the organization every user gets on first sign-in, with the user as
 * `owner`. The slug is the GitHub login, lowercased; if that is taken, a
 * random suffix is added. Returns the organization's id.
 */
async function createPersonalOrganization(
  db: Db,
  user: { id: string; name: string; email: string; githubLogin?: unknown },
): Promise<string> {
  const base = slugify(
    typeof user.githubLogin === "string" && user.githubLogin
      ? user.githubLogin
      : user.name || (user.email.split("@")[0] ?? ""),
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
    const organizationId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.organization)
        .values({ name: user.name || slug, slug })
        .onConflictDoNothing({ target: schema.organization.slug })
        .returning({ id: schema.organization.id });
      if (!created) return undefined;
      await tx
        .insert(schema.member)
        .values({ organizationId: created.id, userId: user.id, role: "owner" });
      return created.id;
    });
    if (organizationId) return organizationId;
  }
  throw new Error(`Could not find a free organization slug for user ${user.id}.`);
}

/**
 * The organization a new login session starts in: the user's first
 * membership, which is their personal organization. If the user has none
 * (because creating it failed during sign-up), it is created now.
 */
async function defaultOrganizationId(db: Db, userId: string): Promise<string> {
  const first = await db.query.member.findFirst({
    columns: { organizationId: true },
    where: (member, { eq }) => eq(member.userId, userId),
    orderBy: (member, { asc }) => [asc(member.createdAt)],
  });
  if (first) return first.organizationId;

  const user = await db.query.user.findFirst({ where: (user, { eq }) => eq(user.id, userId) });
  if (!user) throw new Error(`User ${userId} does not exist.`);
  return createPersonalOrganization(db, user);
}

/** Lowercase letters, digits and single hyphens; never empty. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
    .replace(/-+$/, "");
  return slug || "user";
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
  instance ??= createAuth({
    db: getDb(),
    secret: env.BETTER_AUTH_SECRET,
    github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    oauthProxySecret: env.OAUTH_PROXY_SECRET,
    productionURL: productionURLFromEnv(),
    allowLocalDev: env.VERCEL_ENV !== "production" && env.VERCEL_ENV !== "preview",
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
