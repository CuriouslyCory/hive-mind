"use server";

import { getDb } from "../../../server/db";
import { requireTrackerAccess } from "../../../server/tracker-access";
import { executeTrackerAction, type TrackerActionResult } from "../../../server/tracker-action";

/**
 * Every write on `/tracker`. A server action is a public POST endpoint, so it
 * checks access itself; the command's input is validated by
 * `@hivemind/tracker`. Writes record no Event (docs/tracker.md).
 */
export async function runTrackerAction(
  command: string,
  input: unknown,
): Promise<TrackerActionResult> {
  await requireTrackerAccess();
  return executeTrackerAction(getDb(), command, input);
}
