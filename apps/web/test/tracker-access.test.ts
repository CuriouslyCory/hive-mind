import { beforeEach, describe, expect, it, vi } from "vitest";

// The dev tracker's gate (docs/tracker.md → Opening the page), with Next.js's
// request APIs and the login session check as stand-ins: a 404 everywhere
// but local `next dev`, and the fresh login session check only after it.

const request = vi.hoisted(() => ({ host: "localhost:3000" as string | null }));
const NOT_FOUND = new Error("NEXT_NOT_FOUND");

vi.mock("next/headers", () => ({
  headers: async () => new Headers(request.host === null ? {} : { host: request.host }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));
vi.mock("../src/server/login-session", () => ({
  requireFreshLoginSession: vi.fn(async () => ({ user: { id: "user-1" }, loginSession: {} })),
}));

const { requireFreshLoginSession } = await import("../src/server/login-session");
const { requireTrackerAccess } = await import("../src/server/tracker-access");

describe("requireTrackerAccess", () => {
  beforeEach(() => {
    request.host = "localhost:3000";
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "localhost"])(
    "checks the login session under next dev on %s",
    async (host) => {
      request.host = host;
      await expect(requireTrackerAccess("/tracker?tab=blog")).resolves.toMatchObject({
        user: { id: "user-1" },
      });
      expect(requireFreshLoginSession).toHaveBeenCalledWith("/tracker?tab=blog");
    },
  );

  it("allows VERCEL_ENV=development (vercel env pull)", async () => {
    vi.stubEnv("VERCEL_ENV", "development");
    await expect(requireTrackerAccess()).resolves.toBeDefined();
    expect(requireFreshLoginSession).toHaveBeenCalledWith("/tracker");
  });

  it.each([
    ["next start", { NODE_ENV: "production" }, "localhost:3000"],
    ["a test run", { NODE_ENV: "test" }, "localhost:3000"],
    ["a production deployment", { VERCEL_ENV: "production" }, "localhost:3000"],
    ["a preview deployment", { VERCEL_ENV: "preview" }, "localhost:3000"],
    ["another host name", {}, "hivemind.curiouslycory.com"],
    ["a LAN address", {}, "192.168.1.20:3000"],
    ["a look-alike host", {}, "localhost.evil.example"],
    ["no Host header", {}, null],
  ] as const)("is a 404 for %s, before any login session check", async (_name, env, host) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    request.host = host;
    await expect(requireTrackerAccess()).rejects.toBe(NOT_FOUND);
    expect(requireFreshLoginSession).not.toHaveBeenCalled();
  });
});
