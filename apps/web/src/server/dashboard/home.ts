import type { Db } from "@hivemind/db";
import type { HomeDashboard, HomeParams } from "./home-types";

/**
 * `/`: the signed-in home page's data (./home-types.ts), read in one
 * snapshot across every Project the User can read, or within the selected
 * one. Not implemented yet.
 */
export async function loadHomeDashboard(
  _db: Db,
  _viewer: { id: string; name: string },
  _params: HomeParams,
): Promise<HomeDashboard> {
  throw new Error("loadHomeDashboard is not implemented yet.");
}
