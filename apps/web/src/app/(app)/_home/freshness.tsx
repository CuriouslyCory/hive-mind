"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { shortDuration } from "./format";

/** How often the page re-reads its data while the tab is visible. */
export const HOME_REFRESH_MS = 15_000;

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

/**
 * Keeps the home page fresh and says how fresh it is. The page spans many
 * Projects, so it opens no per-Project event stream; instead it re-reads the
 * whole page (`router.refresh()`) every 15 s while the browser tab is visible
 * and online, and once when it becomes visible or online again.
 *
 * Cache Components hides a page the reader navigated away from in a React
 * Activity, which runs effect cleanups: the timer and listeners stop while
 * the page is hidden. When it is shown again (Back), the effect runs again
 * and refreshes at once if what is on screen is older than the interval.
 */
export function Freshness({ asOf }: { asOf: string }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [online, setOnline] = useState(true);
  // When this client received the snapshot, and the clock it is compared
  // with. Null until mounted, so the server and hydration render agree.
  const receivedAt = useRef<number | null>(null);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // A new snapshot (`asOf` changed) restarts the age.
    void asOf;
    receivedAt.current = Date.now();
    setNow(Date.now());
  }, [asOf]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      startTransition(() => router.refresh());
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onOnline = () => {
      setOnline(true);
      refresh();
    };
    const onOffline = () => setOnline(false);

    setOnline(navigator.onLine);
    if (receivedAt.current !== null && Date.now() - receivedAt.current >= HOME_REFRESH_MS) {
      refresh();
    }
    const refreshTimer = setInterval(refresh, HOME_REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [router]);

  const state: FreshnessState = !online ? "offline" : refreshing ? "updating" : "live";
  const age =
    now === null || receivedAt.current === null
      ? null
      : Math.max(0, Math.round((now - receivedAt.current) / 1000));

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
