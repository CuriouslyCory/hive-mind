import { type Db, describeFailure } from "@hivemind/db";
import { isTrackerCommandName, runTrackerCommand, TrackerError } from "@hivemind/tracker";

/** What the tracker page's server action answers. */
export type TrackerActionResult = { ok: true; result: unknown } | { ok: false; error: string };

export const TRACKER_ACTION_FAILED = "The change could not be saved. See the server log.";

/**
 * Runs one tracker command for the page. A `TrackerError` is a refusal meant
 * for the person at the page (invalid input, a conflict, a broken rule), so
 * its message goes back as is; anything else is logged and answered with a
 * generic message.
 */
export async function executeTrackerAction(
  db: Db,
  command: unknown,
  input: unknown,
): Promise<TrackerActionResult> {
  if (!isTrackerCommandName(command)) return { ok: false, error: "Unknown tracker command." };
  try {
    return { ok: true, result: await runTrackerCommand(db, command, input) };
  } catch (error) {
    if (error instanceof TrackerError) return { ok: false, error: error.message };
    console.error(`Tracker command ${command} failed: ${describeFailure(error)}`);
    return { ok: false, error: TRACKER_ACTION_FAILED };
  }
}
