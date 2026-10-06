"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { shortDuration } from "./format";
import { createHomeFreshness, type HomeFreshnessSnapshot } from "./freshness-controller";

export type FreshnessState = "live" | "updating" | "offline";

/**
 * The words of each state. Only these go in the live region: the age of the
 * data changes every second and is not announced.
 */
export const FRESHNESS_WORDS: Record<FreshnessState, string> = {
  live: "Live",
  updating: "Live",
  offline: "Offline",
};

// The server and hydration render: online, with no age yet.
const SERVER_SNAPSHOT: HomeFreshnessSnapshot = { online: true, receivedAt: null };

/**
 * Keeps the home page fresh and says how fresh it is. The page spans many
 * Projects, so it opens no per-Project event stream; instead it re-reads the
 * whole page (`router.refresh()`) on the schedule in `createHomeFreshness`
 * (./freshness-controller.ts).
 *
 * Cache Components hides a page the reader navigated away from in a React
 * Activity, which runs effect cleanups: the timers and listeners stop while
 * the page is hidden. When it is shown again (Back), the effects run again in
 * order: `receive` keeps the age of a snapshot already received, then
 * `start` refreshes at once if that data is old.
 */
export function Freshness({ asOf }: { asOf: string }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [freshness] = useState(() =>
    createHomeFreshness({ refresh: () => startTransition(() => router.refresh()) }),
  );
  const { online, receivedAt } = useSyncExternalStore(
    freshness.subscribe,
    freshness.getSnapshot,
    () => SERVER_SNAPSHOT,
  );
  // The clock the age is measured with. Null until mounted, so the server
  // and hydration render agree.
  const [now, setNow] = useState<number | null>(null);

  // These three run in this order on mount and on every reveal.
  useEffect(() => {
    freshness.receive(asOf);
  }, [freshness, asOf]);

  useEffect(() => {
    if (!refreshing) freshness.settle();
  }, [freshness, refreshing]);

  useEffect(() => {
    freshness.start();
    return () => freshness.stop();
  }, [freshness]);

  useEffect(() => {
    // A new receipt time restarts the clock at once rather than on its next tick.
    void receivedAt;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [receivedAt]);

  const state: FreshnessState = !online ? "offline" : refreshing ? "updating" : "live";
  const age =
    now === null || receivedAt === null ? null : Math.max(0, Math.round((now - receivedAt) / 1000));

  return <FreshnessView state={state} asOf={asOf} ageSeconds={age} />;
}

/** `Freshness` for a given state, for rendering without a router. */
export function FreshnessView({
  state,
  asOf,
  ageSeconds,
}: {
  state: FreshnessState;
  asOf: string;
  ageSeconds: number | null;
}) {
  return (
    <span className="home-freshness" data-state={state} data-testid="home-freshness">
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <polygon points="12,3 19.79,7.5 19.79,16.5 12,21 4.21,16.5 4.21,7.5" fill="currentColor" />
      </svg>
      <output aria-live="polite">{FRESHNESS_WORDS[state]}</output>
      {ageSeconds !== null ? (
        <span>
          {" · "}
          {state === "offline" ? "showing data read " : "read "}
          <time dateTime={asOf}>
            {ageSeconds < 2 ? "just now" : `${shortDuration(ageSeconds)} ago`}
          </time>
        </span>
      ) : null}
      {/* "Updating" flickers with every refresh, so it is not announced. */}
      {state === "updating" ? <span aria-hidden="true"> · Updating…</span> : null}
    </span>
  );
}
