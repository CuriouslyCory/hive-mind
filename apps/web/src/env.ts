import { z } from "zod";

/**
 * The single source of truth for the server's environment variable names.
 * Server variables never use the `HIVEMIND_` prefix; that prefix belongs to the CLI.
 *
 * There is deliberately no way to skip validation.
 */
export const envSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  // The production origin, for example https://hive-mind.example. Set only in
  // Production; elsewhere src/server/auth.ts falls back to
  // VERCEL_PROJECT_PRODUCTION_URL.
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

  // Vercel system variables. VERCEL_PROJECT_PRODUCTION_URL is the production
  // host name without a scheme, and is set in every Vercel environment.
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().min(1).optional(),
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
