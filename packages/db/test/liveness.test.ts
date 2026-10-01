import { describe, expect, it } from "vitest";
import {
  CLAIM_LEASE_MS,
  effectiveSessionStatus,
  isClaimUsable,
  isSessionLive,
  SESSION_ABANDONED_AFTER_MS,
  SESSION_STALE_AFTER_MS,
} from "../src/index.ts";

const heartbeat = new Date("2026-10-01T12:00:00.000Z");
const at = (ms: number) => new Date(heartbeat.getTime() + ms);

describe("effectiveSessionStatus", () => {
  it("is stale from exactly five minutes and abandoned from exactly thirty", () => {
    const session = { status: "active" as const, lastHeartbeatAt: heartbeat };
    expect(effectiveSessionStatus(session, at(SESSION_STALE_AFTER_MS - 1))).toBe("active");
    expect(effectiveSessionStatus(session, at(SESSION_STALE_AFTER_MS))).toBe("stale");
    expect(effectiveSessionStatus(session, at(SESSION_ABANDONED_AFTER_MS - 1))).toBe("stale");
    expect(effectiveSessionStatus(session, at(SESSION_ABANDONED_AFTER_MS))).toBe("abandoned");
  });

  it("keeps idle while fresh and terminal statuses always", () => {
    expect(effectiveSessionStatus({ status: "idle", lastHeartbeatAt: heartbeat }, at(0))).toBe(
      "idle",
    );
    expect(effectiveSessionStatus({ status: "ended", lastHeartbeatAt: heartbeat }, at(0))).toBe(
      "ended",
    );
    expect(effectiveSessionStatus({ status: "abandoned", lastHeartbeatAt: heartbeat }, at(0))).toBe(
      "abandoned",
    );
  });

  it("counts only effectively active or idle Sessions as live", () => {
    expect(isSessionLive({ status: "active", lastHeartbeatAt: heartbeat }, at(0))).toBe(true);
    expect(isSessionLive({ status: "stale", lastHeartbeatAt: heartbeat }, at(0))).toBe(false);
    expect(
      isSessionLive({ status: "active", lastHeartbeatAt: heartbeat }, at(SESSION_STALE_AFTER_MS)),
    ).toBe(false);
  });
});

describe("isClaimUsable", () => {
  const holder = { status: "active" as const, lastHeartbeatAt: heartbeat };
  const claim = { leaseExpiresAt: at(CLAIM_LEASE_MS) };

  it("expires at exactly the lease end", () => {
    expect(isClaimUsable(claim, holder, at(CLAIM_LEASE_MS - 1))).toBe(true);
    expect(isClaimUsable(claim, holder, at(CLAIM_LEASE_MS))).toBe(false);
  });

  it("is unusable without a lease, without a holder or with a non-live holder", () => {
    expect(isClaimUsable({ leaseExpiresAt: null }, holder, at(0))).toBe(false);
    expect(isClaimUsable(claim, null, at(0))).toBe(false);
    expect(isClaimUsable(claim, { status: "ended", lastHeartbeatAt: heartbeat }, at(0))).toBe(
      false,
    );
  });
});
