import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME_PARAMS,
  homeHref,
  parseHomeParams,
} from "../src/server/dashboard/home-params";
import { type HomeParams, MAX_HOME_QUERY_LENGTH } from "../src/server/dashboard/home-types";

// The home page's state in its search params (apps/web/src/server/dashboard/home-params.ts).

const PROJECT = "0a0a0a0a-0000-4000-8000-00000000000a";

/** The search params of `href` as `parseHomeParams` receives them. */
function searchOf(href: string): Record<string, string | string[]> {
  const url = new URL(href, "http://localhost");
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    result[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return result;
}

describe("parseHomeParams", () => {
  it("defaults everything when there are no search params", () => {
    expect(parseHomeParams({})).toEqual(DEFAULT_HOME_PARAMS);
  });

  it("reads every param", () => {
    expect(
      parseHomeParams({
        project: PROJECT,
        q: "  parser  ",
        view: "sessions",
        sessions: "overlap",
        plans: "paused",
        range: "30d",
      }),
    ).toEqual({
      projectId: PROJECT,
      q: "parser",
      view: "sessions",
      sessionTab: "overlap",
      planTab: "paused",
      range: "30d",
    });
  });

  it("falls back to the defaults for unknown or malformed values", () => {
    expect(
      parseHomeParams({
        project: "not-a-uuid",
        view: "admin",
        sessions: "Active",
        plans: "draft",
        range: "1y",
      }),
    ).toEqual(DEFAULT_HOME_PARAMS);
  });

  it("lower-cases the Project id and takes the first of repeated values", () => {
    const params = parseHomeParams({
      project: [PROJECT.toUpperCase(), "0b0b0b0b-0000-4000-8000-00000000000b"],
      view: ["plans", "sessions"],
    });
    expect(params.projectId).toBe(PROJECT);
    expect(params.view).toBe("plans");
  });

  it("cuts the filter text to its maximum length", () => {
    const q = parseHomeParams({ q: "x".repeat(MAX_HOME_QUERY_LENGTH + 20) }).q;
    expect(q).toHaveLength(MAX_HOME_QUERY_LENGTH);
  });
});

describe("homeHref", () => {
  it("is / for the defaults, leaving every default out of the URL", () => {
    expect(homeHref(DEFAULT_HOME_PARAMS)).toBe("/");
    expect(homeHref(DEFAULT_HOME_PARAMS, { range: "7d", view: "home", q: "" })).toBe("/");
  });

  it("applies the patch over the params", () => {
    const params: HomeParams = { ...DEFAULT_HOME_PARAMS, projectId: PROJECT, range: "24h" };
    expect(homeHref(params, { view: "plans", planTab: "active" })).toBe(
      `/?project=${PROJECT}&view=plans&plans=active&range=24h`,
    );
    expect(homeHref(params, { projectId: null })).toBe("/?range=24h");
  });

  it("encodes the filter text", () => {
    expect(homeHref(DEFAULT_HOME_PARAMS, { q: "a&b c" })).toBe("/?q=a%26b+c");
  });

  it("round-trips through parseHomeParams", () => {
    const params: HomeParams = {
      projectId: PROJECT,
      q: "chore/deps & more",
      view: "sessions",
      sessionTab: "all",
      planTab: "done",
      range: "24h",
    };
    expect(parseHomeParams(searchOf(homeHref(params)))).toEqual(params);
    expect(parseHomeParams(searchOf(homeHref(DEFAULT_HOME_PARAMS)))).toEqual(DEFAULT_HOME_PARAMS);
  });
});
