"use client";

import type { ReactNode } from "react";
import type { ProjectEventStreamSnapshot } from "../../lib/project-event-stream";
import { useProjectLiveSnapshot } from "./project-live-updates";

export type LiveStatusState =
  /** No stream runs: no page has registered yet, or the Project was left. */
  | "idle"
  | "connecting"
  | "live"
  | "delayed"
  | "reconnecting"
  | "offline"
  | "stopped"
  | "access-lost";

/** The state `LiveStatus` shows for a snapshot (null: no stream runs). */
export function liveStatusState(snapshot: ProjectEventStreamSnapshot | null): LiveStatusState {
  if (snapshot === null) return "idle";
  switch (snapshot.status.kind) {
    case "connecting":
      return "connecting";
    case "live":
      return snapshot.withheld ? "delayed" : "live";
    case "reconnecting":
      return "reconnecting";
    case "offline":
      return "offline";
    case "access-lost":
      return "access-lost";
    default:
      return "stopped";
  }
}

function SyncedAt({ at }: { at: number }) {
  const date = new Date(at);
  return <time dateTime={date.toISOString()}>{date.toLocaleTimeString()}</time>;
}

/**
 * The freshness of the enclosing `ProjectLiveUpdates`, in words (never only
 * colour). `data-state` is for styling and tests.
 */
export function LiveStatus() {
  return <LiveStatusView snapshot={useProjectLiveSnapshot()} />;
}

/**
 * `LiveStatus` for a given snapshot. Screen readers hear changes of state
 * politely: only the state's words are in the live region, so the time of
 * the last read, which changes with every refresh, is not announced. The
 * region renders (empty) before the first state so that the first change is
 * announced.
 */
export function LiveStatusView({ snapshot }: { snapshot: ProjectEventStreamSnapshot | null }) {
  const state = liveStatusState(snapshot);
  const lastSyncAt = snapshot?.lastSyncAt ?? null;

  let words: ReactNode = null;
  // Whether the state is qualified by when the data on screen was read.
  let showsSyncedAt = false;
  switch (state) {
    case "idle":
      break;
    case "connecting":
      words = "Connecting to live updates…";
      break;
    case "live":
      words = "Live";
      break;
    case "delayed":
      words = "Live, but updates are delayed by a long-running change.";
      showsSyncedAt = true;
      break;
    case "reconnecting":
      words = "Reconnecting.";
      showsSyncedAt = true;
      break;
    case "offline":
      words = "Offline.";
      showsSyncedAt = true;
      break;
    case "stopped":
      words = "Live updates stopped. Reload the page to resume.";
      showsSyncedAt = true;
      break;
    case "access-lost":
      words = "Access to this Project ended.";
      break;
  }

  return (
    <div className="live-status" data-state={state} data-testid="live-status">
      <output aria-live="polite">{words}</output>
      {/* "Updating" flickers with every refresh, so it is not announced. */}
      {state === "live" && snapshot?.refreshing && <span aria-hidden="true">. Updating…</span>}
      {showsSyncedAt && lastSyncAt !== null && (
        <span data-testid="live-status-synced-at">
          {state === "delayed" ? " Updated at " : " Showing data from "}
          <SyncedAt at={lastSyncAt} />.
        </span>
      )}
    </div>
  );
}
