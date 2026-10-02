import { createApiHandler } from "../../../../../../../server/api/router";
import { auth } from "../../../../../../../server/auth";
import { getDb } from "../../../../../../../server/db";

// `GET /api/v1/projects/{id}/events/stream`: the Event stream of ADR-0010.
// The catch-all `/api/v1` route would serve it the same way through
// `createApiHandler`; this route exists to give the stream its function
// duration without changing any other route's. The stream ends itself after
// EVENT_STREAM_ROTATE_AFTER_MS (50 s), inside this limit.

/**
 * Seconds. Next.js reads segment config statically, so this is a literal:
 * it must equal EVENT_STREAM_MAX_DURATION_SECONDS in `@hivemind/contract`.
 */
export const maxDuration = 60;
// Node.js, the default runtime: Cache Components rejects a `runtime` export.

export const GET = createApiHandler(() => ({ auth, db: getDb() }));
