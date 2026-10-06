import type { Transaction } from "@hivemind/db";
import type { HomeDecision } from "./home-types";

export interface HomeDecisionsInput {
  /** The Projects in scope. Never empty. */
  projects: { id: string; name: string }[];
  /** The filter text; empty means none. */
  q: string;
  limit: number;
}

/** The newest recorded decisions in scope. Not implemented yet: returns none. */
export async function loadRecentDecisions(
  _tx: Transaction,
  _input: HomeDecisionsInput,
): Promise<HomeDecision[]> {
  return [];
}
