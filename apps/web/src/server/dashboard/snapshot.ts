import { encodeFeedCursor } from "@hivemind/contract";
import {
  type Db,
  type FeedPosition,
  type FeedSnapshotContext,
  withFeedSnapshot,
} from "@hivemind/db";

// The one transaction a dashboard page reads in (issue #11, "Snapshot
// handoff"). Authorization and every query of a page run in a single short
// READ ONLY REPEATABLE READ transaction (`withFeedSnapshot`), so counts,
// claims and liveness come from one database snapshot and one database
// `now`, and the Event feed's fence `(H, 0)` is read from that same snapshot.
// A Project page hands the fence to the browser as a feed cursor; resuming
// the stream from it misses nothing committed after the snapshot. The
// transaction ends before the page responds, never spanning a stream.

/** What a dashboard read returns: the page's data and the snapshot's feed fence. */
export interface DashboardSnapshot<T> {
  data: T;
  /** `(H, "0")` for the snapshot `data` was read from. */
  fence: FeedPosition;
}

/**
 * Runs `fn` in one short READ ONLY REPEATABLE READ transaction and returns
 * its result with the snapshot's fence. `context.now` is the database time
 * the reads judge liveness and leases at. Keep `fn` to database reads: no
 * network calls, and nothing that waits on the user.
 */
export async function runDashboardSnapshot<T>(
  db: Db,
  fn: (context: FeedSnapshotContext) => Promise<T>,
): Promise<DashboardSnapshot<T>> {
  return withFeedSnapshot(db, async (context) => ({
    data: await fn(context),
    fence: context.fence,
  }));
}

/**
 * The opaque cursor a Project page gives its live-update subscription: the
 * snapshot's fence, bound to the Project. Only for a Project the User was
 * just authorized for in that snapshot.
 */
export function projectFeedCursor(projectId: string, fence: FeedPosition): string {
  return encodeFeedCursor({ projectId, ...fence });
}
