import {
  getRedirectUrl,
  getRewrittenUrl,
  isRewrite,
  unstable_doesMiddlewareMatch,
} from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "../src/proxy";
import { homeHref, parseHomeParams } from "../src/server/dashboard/home-params";

const PROJECT_ID = "0b6f2a2e-6a1d-4a43-9f43-3c3f4d1f2a10";

// Next.js 16.3 documents `unstable_doesProxyMatch` but ships only the older
// `unstable_doesMiddlewareMatch`, which applies the same matcher logic.
function matches(url: string) {
  return unstable_doesMiddlewareMatch({ config, url });
}

/** Whether the proxy shows the landing page for a signed-out request to `url`. */
function showsLanding(url: string): boolean {
  return isRewrite(proxy(new NextRequest(url)));
}

/** The query as the home page receives it in `searchParams`. */
function pageSearchParams(url: string): Record<string, string | string[]> {
  const { searchParams } = new URL(url);
  return Object.fromEntries(
    [...new Set(searchParams.keys())].map((key) => {
      const values = searchParams.getAll(key);
      return [key, values.length > 1 ? values : (values[0] ?? "")];
    }),
  );
}

describe("proxy", () => {
  it("shows the landing page at / without a login session cookie", () => {
    const response = proxy(new NextRequest("https://hive-mind.example/"));
    expect(isRewrite(response)).toBe(true);
    expect(getRewrittenUrl(response)).toBe("https://hive-mind.example/welcome");
    expect(getRedirectUrl(response)).toBeNull();
  });

  it("keeps a query that names no home-page state on the landing page", () => {
    const response = proxy(new NextRequest("https://hive-mind.example/?utm_source=example"));
    expect(getRewrittenUrl(response)).toBe("https://hive-mind.example/welcome?utm_source=example");
    expect(getRedirectUrl(response)).toBeNull();
  });

  it.each([
    ["a Project", `/?project=${PROJECT_ID}`],
    ["a filter", "/?q=auth"],
    ["the Plans list", "/?view=plans"],
    ["the Sessions list", "/?view=sessions"],
    ["a Sessions tab", "/?sessions=ended"],
    ["a Plans tab", "/?plans=paused"],
    ["a range", "/?range=30d"],
    ["a state next to tracking parameters", "/?utm_source=x&view=plans"],
  ])("sends a signed-out link to %s to /sign-in, returning to it", (_name, path) => {
    const response = proxy(new NextRequest(`https://hive-mind.example${path}`));
    expect(isRewrite(response)).toBe(false);
    expect(response.status).toBe(307);
    expect(getRedirectUrl(response)).toBe(
      `https://hive-mind.example/sign-in?returnTo=${encodeURIComponent(path)}`,
    );
  });

  it.each([
    ["an old Projects list cursor", "/?cursor=abc"],
    ["a Project that is not an id", "/?project=web"],
    ["an empty filter", "/?q="],
    ["a blank filter", "/?q=%20%20"],
    ["an unknown view", "/?view=agents"],
    ["the default view", "/?view=home"],
    ["the default tabs and range", "/?sessions=active&plans=all&range=7d"],
  ])("shows the landing page for %s, which the home page ignores", (_name, path) => {
    const url = `https://hive-mind.example${path}`;
    expect(showsLanding(url)).toBe(true);
    expect(homeHref(parseHomeParams(pageSearchParams(url)))).toBe("/");
  });

  it("agrees with the home page on which queries name a state", () => {
    for (const query of [
      "",
      "?view=plans",
      "?view=plans&view=home",
      "?view=home&view=plans",
      "?q=a&q=",
      `?q=${"b".repeat(200)}`,
      `?project=${PROJECT_ID.toUpperCase()}`,
      "?range=1y",
      "?sessions=overlap",
    ]) {
      const url = `https://hive-mind.example/${query}`;
      expect(showsLanding(url), query).toBe(
        homeHref(parseHomeParams(pageSearchParams(url))) === "/",
      );
    }
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
