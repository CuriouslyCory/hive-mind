import {
  getRedirectUrl,
  getRewrittenUrl,
  isRewrite,
  unstable_doesMiddlewareMatch,
} from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "../src/proxy";

// Next.js 16.3 documents `unstable_doesProxyMatch` but ships only the older
// `unstable_doesMiddlewareMatch`, which applies the same matcher logic.
function matches(url: string) {
  return unstable_doesMiddlewareMatch({ config, url });
}

describe("proxy", () => {
  it("shows the landing page at / without a login session cookie", () => {
    const response = proxy(new NextRequest("https://hive-mind.example/"));
    expect(isRewrite(response)).toBe(true);
    expect(getRewrittenUrl(response)).toBe("https://hive-mind.example/welcome");
    expect(getRedirectUrl(response)).toBeNull();
  });

  it("keeps a query that is not a Projects page on the landing page", () => {
    const response = proxy(new NextRequest("https://hive-mind.example/?utm_source=example"));
    expect(getRewrittenUrl(response)).toBe("https://hive-mind.example/welcome?utm_source=example");
    expect(getRedirectUrl(response)).toBeNull();
  });

  it("sends a signed-out link to a Projects page to /sign-in, returning to it", () => {
    const response = proxy(new NextRequest("https://hive-mind.example/?cursor=abc"));
    expect(isRewrite(response)).toBe(false);
    expect(response.status).toBe(307);
    expect(getRedirectUrl(response)).toBe(
      "https://hive-mind.example/sign-in?returnTo=%2F%3Fcursor%3Dabc",
    );
  });

  it("redirects any other page without a login session cookie to /sign-in", () => {
    const response = proxy(new NextRequest("https://hive-mind.example/settings"));
    expect(isRewrite(response)).toBe(false);
    expect(response.status).toBe(307);
    expect(getRedirectUrl(response)).toBe("https://hive-mind.example/sign-in?returnTo=%2Fsettings");
  });

  it("carries the requested page to /sign-in as a return path", () => {
    const response = proxy(new NextRequest("https://hive-mind.example/device?user_code=ABCD-EFGH"));
    expect(getRedirectUrl(response)).toBe(
      "https://hive-mind.example/sign-in?returnTo=%2Fdevice%3Fuser_code%3DABCD-EFGH",
    );
  });

  it("never carries a path that leaves the origin", () => {
    // `//evil.example` as a request path is `/evil.example` on this origin
    // after URL parsing, so the worst case is a same-origin path.
    const response = proxy(new NextRequest("https://hive-mind.example//evil.example/x"));
    const target = new URL(getRedirectUrl(response) ?? "");
    expect(target.origin).toBe("https://hive-mind.example");
    expect(target.pathname).toBe("/sign-in");
    const returnTo = target.searchParams.get("returnTo");
    expect(returnTo === null || new URL(returnTo, target).origin === target.origin).toBe(true);
  });

  it.each(["hivemind.session_token", "__Secure-hivemind.session_token"])(
    "lets a request with a %s cookie through",
    (cookie) => {
      const request = new NextRequest("https://hive-mind.example/", {
        headers: { cookie: `${cookie}=token-value` },
      });
      const response = proxy(request);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(getRedirectUrl(response)).toBeNull();
      expect(isRewrite(response)).toBe(false);
    },
  );

  it("ignores another prefix's login session cookie", () => {
    const request = new NextRequest("https://hive-mind.example/settings", {
      headers: { cookie: "better-auth.session_token=token-value" },
    });
    expect(getRedirectUrl(proxy(request))).toBe(
      "https://hive-mind.example/sign-in?returnTo=%2Fsettings",
    );
  });
});

describe("proxy matcher", () => {
  it.each([
    "/",
    "/device",
    "/settings",
    "/projects/abc",
    "/apiary",
    "/sign-in-help",
    "/welcome-back",
  ])("matches %s", (url) => {
    expect(matches(url)).toBe(true);
  });

  it.each([
    "/api",
    "/api/auth/ok",
    "/api/v1/projects",
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/favicon.ico",
    "/robots.txt",
    "/sign-in",
    "/welcome",
  ])("does not match %s", (url) => {
    expect(matches(url)).toBe(false);
  });
});
