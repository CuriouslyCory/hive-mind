import {
  HOME_RANGES,
  HOME_VIEWS,
  type HomeParams,
  MAX_HOME_QUERY_LENGTH,
  PLAN_TABS,
  SESSION_TABS,
} from "./home-types";

// The home page's state lives in its search params, so a filtered view is a
// link and a live refresh re-reads exactly what is on screen. Defaults are
// left out of the URL.

type SearchParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_HOME_PARAMS: HomeParams = {
  projectId: null,
  q: "",
  view: "home",
  sessionTab: "active",
  planTab: "all",
  range: "7d",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function oneOf<T extends string>(values: readonly T[], value: string | undefined, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

/** Reads the page state from search params. Unknown or malformed values fall back to the defaults. */
export function parseHomeParams(searchParams: SearchParams): HomeParams {
  const project = first(searchParams.project);
  return {
    projectId: project !== undefined && UUID.test(project) ? project.toLowerCase() : null,
    q: (first(searchParams.q) ?? "").trim().slice(0, MAX_HOME_QUERY_LENGTH),
    view: oneOf(HOME_VIEWS, first(searchParams.view), DEFAULT_HOME_PARAMS.view),
    sessionTab: oneOf(SESSION_TABS, first(searchParams.sessions), DEFAULT_HOME_PARAMS.sessionTab),
    planTab: oneOf(PLAN_TABS, first(searchParams.plans), DEFAULT_HOME_PARAMS.planTab),
    range: oneOf(HOME_RANGES, first(searchParams.range), DEFAULT_HOME_PARAMS.range),
  };
}

/** The `/` URL for `params` with `patch` applied, omitting defaults. */
export function homeHref(params: HomeParams, patch: Partial<HomeParams> = {}): string {
  const next = { ...params, ...patch };
  const search = new URLSearchParams();
  if (next.projectId !== null) search.set("project", next.projectId);
  if (next.q !== "") search.set("q", next.q);
  if (next.view !== DEFAULT_HOME_PARAMS.view) search.set("view", next.view);
  if (next.sessionTab !== DEFAULT_HOME_PARAMS.sessionTab) search.set("sessions", next.sessionTab);
  if (next.planTab !== DEFAULT_HOME_PARAMS.planTab) search.set("plans", next.planTab);
  if (next.range !== DEFAULT_HOME_PARAMS.range) search.set("range", next.range);
  const query = search.toString();
  return query === "" ? "/" : `/?${query}`;
}
