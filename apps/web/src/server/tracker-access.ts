import { trackerPageEnabled } from "@hivemind/tracker";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requireFreshLoginSession, type SignedIn } from "./login-session";

/**
 * The dev tracker's access check (docs/tracker.md → Opening the page): a 404
 * unless this is `next dev` reached as localhost outside a Vercel deployment,
 * then a fresh login session. The page and its server action both call it: a
 * server action is a public POST endpoint, so it cannot rely on the page.
 */
export async function requireTrackerAccess(returnPath = "/tracker"): Promise<SignedIn> {
  const host = (await headers()).get("host");
  if (!trackerPageEnabled(process.env.NODE_ENV, host, process.env.VERCEL_ENV)) notFound();
  return requireFreshLoginSession(returnPath);
}
