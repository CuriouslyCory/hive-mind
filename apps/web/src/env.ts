import { z } from "zod";

/**
 * The single source of truth for the server's environment variable names.
 * Server variables never use the `HIVEMIND_` prefix; that prefix belongs to the CLI.
 *
 * There is deliberately no way to skip validation.
 */
export const envSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url().optional(),

  // Optional only until packages/db (M0 step 5) and auth (M0 step 6) land,
  // so the skeleton builds without them. Those steps make them required.
  DATABASE_URL: z.url().optional(),
  DATABASE_URL_UNPOOLED: z.url().optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_PROXY_SECRET: z.string().min(1).optional(),

  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
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
