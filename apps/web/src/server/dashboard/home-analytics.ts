import type { Transaction } from "@hivemind/db";
import type { HomeAnalytics, HomeRange } from "./home-types";

export interface HomeAnalyticsInput {
  /** The Projects in scope: every readable one, or the selected one. Never empty. */
  projects: { id: string; name: string }[];
  /** The filter text (./home-types.ts `HomeParams.q`); empty means none. */
  q: string;
  range: HomeRange;
  /** The snapshot's database time. */
  now: Date;
  /** The Scopes of current overlaps, to flag hot paths. */
  overlappingScopes: { projectId: string; scope: string }[];
}

/** Throughput, agents and hot paths for the home page. Not implemented yet: returns empty sections. */
export async function loadHomeAnalytics(
  _tx: Transaction,
  input: HomeAnalyticsInput,
): Promise<HomeAnalytics> {
  const empty = { value: 0, previous: 0 };
  return {
    throughput: {
      range: input.range,
      unit: input.range === "24h" ? "hour" : "day",
      buckets: [],
      tasksDone: empty,
      sessionsStarted: empty,
      plansFinished: empty,
      medianTaskMinutes: { value: null, previous: null },
    },
    agents: [],
    hotPaths: [],
  };
}
