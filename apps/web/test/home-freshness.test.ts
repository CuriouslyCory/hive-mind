import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHomeFreshness,
  createReceiptLog,
  HOME_CATCH_UP_MS,
  HOME_REFRESH_MS,
  HOME_REFRESH_TIMEOUT_MS,
} from "../src/app/(app)/_home/freshness-controller";

// The home page's refresh schedule (docs/dashboard.md → Home page → Live
// behavior), with fake timers and a fake document and window.

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function fakeEnvironment() {
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, listener: () => void) => {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  };
  const off = (type: string, listener: () => void) => listeners.get(type)?.delete(listener);
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  const document = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: on,
    removeEventListener: off,
  };
  const navigator = { onLine: true };
  const window = { navigator, addEventListener: on, removeEventListener: off };
  return {
    document,
    window,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    hide() {
      document.visibilityState = "hidden";
      emit("visibilitychange");
    },
    show() {
      document.visibilityState = "visible";
      emit("visibilitychange");
    },
    offline() {
      navigator.onLine = false;
      emit("offline");
    },
    online() {
      navigator.onLine = true;
      emit("online");
    },
  };
}

function setup() {
  const env = fakeEnvironment();
  const refresh = vi.fn();
  const log = createReceiptLog();
  const make = () =>
    createHomeFreshness({ refresh, document: env.document, window: env.window, log });
  const freshness = make();
  return { env, refresh, log, freshness, make };
}

/** Mounts (or reveals) `freshness` showing `asOf`, as the component's effects do. */
function show(freshness: ReturnType<typeof createHomeFreshness>, asOf: string) {
  freshness.receive(asOf);
  freshness.settle();
  freshness.start();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the home page's refresh schedule", () => {
  it("refreshes every interval while visible, measuring the age from receipt", () => {
    const { refresh, freshness } = setup();
    show(freshness, iso(0));
    expect(freshness.getSnapshot()).toEqual({ online: true, receivedAt: T0 });

    vi.advanceTimersByTime(HOME_REFRESH_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The new snapshot arrives 2 s later; the next refresh is due 15 s after
    // it arrived.
    vi.advanceTimersByTime(2_000);
    freshness.receive(iso(HOME_REFRESH_MS + 2_000));
    expect(freshness.getSnapshot().receivedAt).toBe(T0 + HOME_REFRESH_MS + 2_000);
    vi.advanceTimersByTime(HOME_REFRESH_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("skips ticks while a refresh is in flight, until it settles or times out", () => {
    const { refresh, freshness } = setup();
    show(freshness, iso(0));

    vi.advanceTimersByTime(HOME_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    // No snapshot comes back: the next tick is skipped.
    vi.advanceTimersByTime(HOME_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    // After 20 s the refresh is treated as finished.
    expect(HOME_REFRESH_MS * 2).toBeGreaterThanOrEqual(HOME_REFRESH_TIMEOUT_MS);
    vi.advanceTimersByTime(HOME_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    // A transition that ends without a snapshot frees the next tick too.
    freshness.settle();
    vi.advanceTimersByTime(HOME_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops while the tab is hidden and catches up only on data older than 5 s", () => {
    const { env, refresh, freshness } = setup();
    show(freshness, iso(0));

    vi.advanceTimersByTime(3_000);
    env.hide();
    vi.advanceTimersByTime(HOME_REFRESH_MS * 4);
    expect(refresh).not.toHaveBeenCalled();
    env.show();
    expect(refresh).toHaveBeenCalledTimes(1);

    // Back and forth within 5 s of the new snapshot costs no read, and the
    // interval is not shortened by the visit.
    freshness.receive(iso(HOME_REFRESH_MS * 4 + 3_000));
    vi.advanceTimersByTime(HOME_CATCH_UP_MS - 1_000);
    env.hide();
    env.show();
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOME_REFRESH_MS - HOME_CATCH_UP_MS + 1_000 - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("restarts the interval after a catch-up, so two refreshes do not fire back to back", () => {
    const { env, refresh, freshness } = setup();
    show(freshness, iso(0));

    vi.advanceTimersByTime(HOME_REFRESH_MS - 100);
    env.hide();
    env.show();
    expect(refresh).toHaveBeenCalledTimes(1);
    freshness.receive(iso(HOME_REFRESH_MS));
    vi.advanceTimersByTime(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOME_REFRESH_MS - 100);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("says offline, stops, and catches up when back online", () => {
    const { env, refresh, freshness } = setup();
    show(freshness, iso(0));
    env.offline();
    expect(freshness.getSnapshot().online).toBe(false);
    vi.advanceTimersByTime(HOME_REFRESH_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    env.online();
    expect(freshness.getSnapshot().online).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the age of a snapshot shown again after a hidden Activity, and refreshes old data", () => {
    const { env, refresh, freshness } = setup();
    show(freshness, iso(0));
    vi.advanceTimersByTime(4_000);
    freshness.stop();
    expect(env.listenerCount()).toBe(0);
    vi.advanceTimersByTime(HOME_REFRESH_MS * 3);
    expect(refresh).not.toHaveBeenCalled();

    // Revealed with the same snapshot: still read at T0, and refreshed at once.
    show(freshness, iso(0));
    expect(freshness.getSnapshot().receivedAt).toBe(T0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("waits out the rest of the interval when revealed data is still recent", () => {
    const { refresh, freshness } = setup();
    show(freshness, iso(0));
    vi.advanceTimersByTime(4_000);
    freshness.stop();
    vi.advanceTimersByTime(3_000);
    show(freshness, iso(0));
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOME_REFRESH_MS - 7_000 - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps an older snapshot's receipt time when Back restores it, and refreshes it at once", () => {
    const { refresh, freshness, make } = setup();
    show(freshness, iso(0));
    vi.advanceTimersByTime(3_000);
    freshness.receive(iso(3_000));
    expect(freshness.getSnapshot().receivedAt).toBe(T0 + 3_000);
    freshness.stop();

    // Back shows a remembered render of the first snapshot in a new component.
    vi.advanceTimersByTime(1_000);
    const restored = make();
    show(restored, iso(0));
    expect(restored.getSnapshot().receivedAt).toBe(T0);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The same, in a component that is still shown.
    restored.receive(iso(4_000));
    restored.receive(iso(3_000));
    expect(restored.getSnapshot().receivedAt).toBe(T0 + 3_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing until started and nothing after stopping", () => {
    const { refresh, freshness } = setup();
    freshness.receive(iso(0));
    vi.advanceTimersByTime(HOME_REFRESH_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    // Started with 30 s old data: one refresh at once, then none once stopped.
    freshness.start();
    expect(refresh).toHaveBeenCalledTimes(1);
    freshness.stop();
    vi.advanceTimersByTime(HOME_REFRESH_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("createReceiptLog", () => {
  it("dates each snapshot by its first receipt and marks older ones", () => {
    const log = createReceiptLog(2);
    expect(log.receive(iso(0), 10)).toEqual({ receivedAt: 10, fresh: true, older: false });
    expect(log.receive(iso(0), 20)).toEqual({ receivedAt: 10, fresh: false, older: false });
    expect(log.receive(iso(5), 30)).toEqual({ receivedAt: 30, fresh: true, older: false });
    expect(log.receive(iso(0), 40)).toEqual({ receivedAt: 10, fresh: false, older: true });
    // Evicted: the earliest receipt still remembered bounds its age.
    log.receive(iso(9), 50);
    expect(log.receive(iso(0), 60)).toEqual({ receivedAt: 30, fresh: false, older: true });
  });
});
