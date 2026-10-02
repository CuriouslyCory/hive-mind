import { connection } from "next/server";
import { readCronSecret } from "../../../../env";
import { createCronHandler } from "../../../../server/cron";
import { getDb } from "../../../../server/db";

// The coordination sweep, called by Vercel Cron (apps/web/vercel.json). The
// secret and the database are read on each request, never at build time. The
// secret is validated here only, apart from the server environment, so an
// invalid value refuses this route and leaves every other route working.
// Every response is `cache-control: no-store`.
const handle = createCronHandler({
  cronSecret: () => readCronSecret(),
  db: getDb,
});

export async function GET(request: Request): Promise<Response> {
  // Prerendering stops here, so `next build` never runs the sweep.
  await connection();
  return handle(request);
}
