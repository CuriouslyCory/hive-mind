import type { Route } from "next";

// Dashboard URLs. Ids come from the database but are encoded anyway, so no
// value can change the path's shape.

export function projectPath(projectId: string): Route {
  return `/projects/${encodeURIComponent(projectId)}` as Route;
}

export function planPath(projectId: string, planKey: string): Route {
  return `${projectPath(projectId)}/plans/${encodeURIComponent(planKey)}` as Route;
}

export function sessionPath(projectId: string, sessionId: string): Route {
  return `${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}` as Route;
}

/** The cursor search params a page reads, by name. */
export type CursorParams = Record<string, string | undefined>;

/** `path` with `params` as its query, leaving out unset ones. */
export function withParams(path: Route, params: CursorParams): Route {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.set(name, value);
  }
  const search = query.toString();
  return (search ? `${path}?${search}` : path) as Route;
}
