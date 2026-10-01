import { createHash, timingSafeEqual } from "node:crypto";
import { type Db, type SweepResult, sweepCoordination } from "@hivemind/db";
import { bearerToken } from "./api/principal";

// The coordination sweep's Cron endpoint, `GET /api/cron/coordination`
// (ADR-0014, "Sweep"). Vercel Cron calls it every minute in Production with
// `Authorization: Bearer <CRON_SECRET>`. It is outside the `/api/v1` bearer
// contract: the only credential is the shared secret.

/** Bounds on one invocation, so it finishes well inside a function's time limit. */
export const CRON_SWEEP_LIMITS = {
  projectBatch: 50,
  sessionBatch: 100,
  /** No further Project is started after this long. */
  budgetMs: 20_000,
} as const;

export interface CronDeps {
  /** Read per request, so builds need no secret. Unset or empty fails closed. */
  cronSecret: () => string | undefined;
  db: () => Db;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Constant-time comparison of two secrets of any length. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Creates the Cron request handler. Without a configured secret every
 * request is refused with 500 and nothing runs; a missing or wrong bearer
 * token is 401. Otherwise it runs one bounded sweep and returns its counts.
 */
export function createCronHandler(deps: CronDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const secret = deps.cronSecret();
      if (!secret) {
        console.error("/api/cron/coordination: CRON_SECRET is not set; refusing to run.");
        return json({ error: "Cron is not configured." }, 500);
      }
      const token = bearerToken(request.headers.get("authorization"));
      if (token === null || !sameSecret(token, secret)) {
        return json({ error: "Unauthorized." }, 401);
      }
      const result: SweepResult = await sweepCoordination(deps.db(), {
        projectBatch: CRON_SWEEP_LIMITS.projectBatch,
        sessionBatch: CRON_SWEEP_LIMITS.sessionBatch,
        deadline: new Date(Date.now() + CRON_SWEEP_LIMITS.budgetMs),
      });
      return json(result, 200);
    } catch (error) {
      console.error("/api/cron/coordination failed:", error);
      return json({ error: "Sweep failed." }, 500);
    }
  };
}
