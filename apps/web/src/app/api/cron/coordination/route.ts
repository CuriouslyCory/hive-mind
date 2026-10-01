import { env } from "../../../../env";
import { createCronHandler } from "../../../../server/cron";
import { getDb } from "../../../../server/db";

// The coordination sweep, called by Vercel Cron (apps/web/vercel.json). The
// secret and the database are read on each request, never at build time.
// Reading the request's headers keeps this GET handler out of prerendering,
// and every response is sent with `cache-control: no-store`.
export const GET = createCronHandler({
  cronSecret: () => env.CRON_SECRET,
  db: getDb,
});
