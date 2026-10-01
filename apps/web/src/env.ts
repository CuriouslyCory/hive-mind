import { z } from "zod";

/**
 * The single source of truth for the server's environment variable names.
 * Server variables never use the `HIVEMIND_` prefix; that prefix belongs to the CLI.
 *
 * There is deliberately no way to skip validation.
 */
// Vercel system variables can be present but empty (for example
// VERCEL_BRANCH_URL on a deployment made without git); treat that as unset.
const vercelHost = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

export const envSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  // The canonical production origin, https://hivemind.curiouslycory.com.
  // Set in Production and Preview; leave unset locally. src/server/auth.ts
  // falls back to VERCEL_PROJECT_PRODUCTION_URL when absent.
  BETTER_AUTH_URL: z.url().optional(),

  // The pooled connection used at runtime. The unpooled URL is read only by the
  // migrator (packages/db), so it stays optional here.
  DATABASE_URL: z.url(),
  DATABASE_URL_UNPOOLED: z.url().optional(),

  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  // Encrypts what oAuthProxy passes between production and preview
  // deployments. Must be the same in Production and Preview.
  OAUTH_PROXY_SECRET: z.string().min(32),

  // Authenticates Vercel Cron's calls to /api/cron/coordination, which Vercel
  // sends as `Authorization: Bearer <CRON_SECRET>`. Optional so builds and
  // local development need none; when unset the Cron route refuses every
  // request. At least 16 printable ASCII characters without spaces, the
  // characters a bearer token may hold.
  CRON_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[\x21-\x7e]{16,}$/, "Must be at least 16 printable ASCII characters without spaces.")
      .optional(),
  ),

  // Vercel system variables. VERCEL_PROJECT_PRODUCTION_URL is the production
  // host name without a scheme, and is set in every Vercel environment.
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  VERCEL_PROJECT_PRODUCTION_URL: vercelHost,
  // This deployment's generated URL and its git branch alias, also host names
  // without a scheme. A preview deployment trusts only these hosts.
  VERCEL_URL: vercelHost,
  VERCEL_BRANCH_URL: vercelHost,
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates `source` against `envSchema`. Throws on invalid input; the message
 * names the failing variables but never includes their values.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let parsed: Env | undefined;

function load(): Env {
  parsed ??= parseEnv(process.env);
  return parsed;
}

/**
 * The validated server environment. `process.env` is parsed on first access,
 * not at import, so modules that import `env` can be bundled by `next build`
 * without real secrets. Any read of an invalid environment throws.
 */
export const env: Readonly<Env> = new Proxy({} as Env, {
  get: (_target, key) => Reflect.get(load(), key),
  has: (_target, key) => Reflect.has(load(), key),
  ownKeys: () => Reflect.ownKeys(load()),
  getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(load(), key),
});
