import {
  EVENT_STREAM_MAX_DURATION_SECONDS,
  EVENT_STREAM_ROTATE_AFTER_MS,
} from "@hivemind/contract";
import { describe, expect, it, vi } from "vitest";
import * as dashboardRoute from "../src/app/api/dashboard/projects/[projectId]/events/stream/route";
import * as v1Route from "../src/app/api/v1/projects/[id]/events/stream/route";

// Next.js reads each stream route's `maxDuration` statically, so the routes
// export a literal; this ties it to the contract (ADR-0010). Neither handler
// runs here: the auth and database modules are stand-ins.

vi.mock("../src/server/auth", () => ({ auth: {} }));
vi.mock("../src/server/db", () => ({ getDb: () => ({}) }));

/** Time a stream needs past its rotation to send its last frames and close. */
const ROTATION_MARGIN_SECONDS = 5;

describe("Event stream routes", () => {
  for (const [name, route] of [
    ["/api/v1", v1Route],
    ["/api/dashboard", dashboardRoute],
  ] as const) {
    it(`gives the ${name} stream the contract's function duration`, () => {
      expect(route.maxDuration).toBe(EVENT_STREAM_MAX_DURATION_SECONDS);
      expect(route.maxDuration).toBeGreaterThanOrEqual(
        EVENT_STREAM_ROTATE_AFTER_MS / 1000 + ROTATION_MARGIN_SECONDS,
      );
      expect(typeof route.GET).toBe("function");
    });
  }
});
