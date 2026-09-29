import { describe, expect, it, vi } from "vitest";
import { parseEnv } from "../src/env";

const SECRET = "a".repeat(32);

describe("parseEnv", () => {
  it("fails without BETTER_AUTH_SECRET", () => {
    expect(() => parseEnv({})).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("fails when BETTER_AUTH_SECRET is shorter than 32 characters", () => {
    expect(() => parseEnv({ BETTER_AUTH_SECRET: "too-short" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("does not echo variable values in the error", () => {
    expect(() => parseEnv({ BETTER_AUTH_SECRET: "leaky-value" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("leaky-value") }),
    );
  });

  it("succeeds with a valid minimal set", () => {
    expect(parseEnv({ BETTER_AUTH_SECRET: SECRET })).toEqual({ BETTER_AUTH_SECRET: SECRET });
  });

  it("accepts Postgres connection URLs and a known VERCEL_ENV", () => {
    const source = {
      BETTER_AUTH_SECRET: SECRET,
      DATABASE_URL: "postgresql://user:pass@pooler.example.com/db?sslmode=require",
      DATABASE_URL_UNPOOLED: "postgresql://user:pass@direct.example.com/db?sslmode=require",
      VERCEL_ENV: "preview",
    };
    expect(parseEnv(source)).toEqual(source);
  });

  it("rejects an unknown VERCEL_ENV", () => {
    expect(() => parseEnv({ BETTER_AUTH_SECRET: SECRET, VERCEL_ENV: "staging" })).toThrow(
      /VERCEL_ENV/,
    );
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
