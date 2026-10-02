import { auth } from "../../../../../../../server/auth";
import { getDb } from "../../../../../../../server/db";
import { createDashboardEventStreamHandler } from "../../../../../../../server/realtime/dashboard-stream";

// `GET /api/dashboard/projects/{projectId}/events/stream`: the browser's
// cookie adapter for the Event stream (ADR-0010). GET only; it serves no
// other procedure and no mutation.

/**
 * Seconds. Next.js reads segment config statically, so this is a literal:
 * it must equal EVENT_STREAM_MAX_DURATION_SECONDS in `@hivemind/contract`.
 */
export const maxDuration = 60;
// Node.js, the default runtime: Cache Components rejects a `runtime` export.

export const GET = createDashboardEventStreamHandler(() => ({ auth, db: getDb() }));
