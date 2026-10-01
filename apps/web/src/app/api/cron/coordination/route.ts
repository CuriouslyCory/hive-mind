import { connection } from "next/server";
import { env } from "../../../../env";
import { createCronHandler } from "../../../../server/cron";
import { getDb } from "../../../../server/db";

// The coordination sweep, called by Vercel Cron (apps/web/vercel.json). The
// secret and the database are read on each request, never at build time.
// Every response is `cache-control: no-store`.
const handle = createCronHandler({
  cronSecret: () => env.CRON_SECRET,
  db: getDb,
});

export async function GET(request: Request): Promise<Response> {
  // Prerendering stops here, so `next build` never runs the sweep.
  await connection();
  return handle(request);
}
