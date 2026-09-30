import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { envSchema, parseEnv } from "../src/env";

const REQUIRED = {
  BETTER_AUTH_SECRET: "a".repeat(32),
  DATABASE_URL: "postgresql://user:pass@pooler.example.com/db?sslmode=require",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  OAUTH_PROXY_SECRET: "b".repeat(32),
};

function without(name: keyof typeof REQUIRED) {
  const { [name]: _, ...rest } = REQUIRED;
  return rest;
}

describe("parseEnv", () => {
  it.each(Object.keys(REQUIRED) as (keyof typeof REQUIRED)[])("fails without %s", (name) => {
    expect(() => parseEnv(without(name))).toThrow(name);
  });

  it("names every missing variable at once", () => {
    const message = (() => {
      try {
        parseEnv({});
      } catch (error) {
        return (error as Error).message;
      }
    })();
    for (const name of Object.keys(REQUIRED)) {
      expect(message).toContain(name);
    }
  });

  it.each(["BETTER_AUTH_SECRET", "OAUTH_PROXY_SECRET"] as const)(
    "fails when %s is shorter than 32 characters",
    (name) => {
      expect(() => parseEnv({ ...REQUIRED, [name]: "too-short" })).toThrow(name);
    },
  );

  it("does not echo variable values in the error", () => {
    expect(() => parseEnv({ ...REQUIRED, BETTER_AUTH_SECRET: "leaky-value" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("leaky-value") }),
    );
  });

  it("succeeds with only the required variables", () => {
    expect(parseEnv(REQUIRED)).toEqual(REQUIRED);
  });

  it("accepts the optional variables", () => {
    const source = {
      ...REQUIRED,
      BETTER_AUTH_URL: "https://hive-mind.example",
      DATABASE_URL_UNPOOLED: "postgresql://user:pass@direct.example.com/db?sslmode=require",
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_PRODUCTION_URL: "hive-mind.example",
      VERCEL_URL: "hive-mind-web-a1b2c3d4e-curiouslycorys-projects.vercel.app",
      VERCEL_BRANCH_URL: "hive-mind-web-git-feat-login-curiouslycorys-projects.vercel.app",
    };
    expect(parseEnv(source)).toEqual(source);
  });

  it("treats empty Vercel host variables as unset", () => {
    const source = {
      ...REQUIRED,
      VERCEL_PROJECT_PRODUCTION_URL: "",
      VERCEL_URL: "",
      VERCEL_BRANCH_URL: "",
    };
    expect(parseEnv(source)).toEqual(REQUIRED);
  });

  it("rejects an unknown VERCEL_ENV", () => {
    expect(() => parseEnv({ ...REQUIRED, VERCEL_ENV: "staging" })).toThrow(/VERCEL_ENV/);
  });
});

describe("env", () => {
  it("validates process.env on first read, not at import", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    vi.resetModules();
    const { env } = await import("../src/env");
    expect(() => env.BETTER_AUTH_SECRET).toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe(".env.example", () => {
  it("lists every variable in envSchema", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    // Commented-out lines count: optional and Vercel-set variables are listed that way.
    const listed = new Set(
      example.split("\n").flatMap((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)?.[1] ?? []),
    );
    expect(Object.keys(envSchema.shape).filter((name) => !listed.has(name))).toEqual([]);
  });
});
