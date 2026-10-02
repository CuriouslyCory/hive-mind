"use client";

import type { ReactNode } from "react";
import type { ProjectEventStreamSnapshot } from "../../lib/project-event-stream";
import { useProjectLiveSnapshot } from "./project-live-updates";

export type LiveStatusState =
  | "connecting"
  | "live"
  | "delayed"
  | "reconnecting"
  | "offline"
  | "stopped"
  | "access-lost";

/** The state `LiveStatus` shows for a snapshot (null: not connected yet). */
export function liveStatusState(snapshot: ProjectEventStreamSnapshot | null): LiveStatusState {
  switch (snapshot?.status.kind ?? "connecting") {
    case "connecting":
      return "connecting";
    case "live":
      return snapshot?.withheld ? "delayed" : "live";
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
 * colour). `data-state` is for styling. Screen readers hear changes politely.
 */
export function LiveStatus() {
  const snapshot = useProjectLiveSnapshot();
  const state = liveStatusState(snapshot);
  const syncedAt = snapshot ? <SyncedAt at={snapshot.lastSyncAt} /> : null;

  let text: ReactNode;
  switch (state) {
    case "connecting":
      text = "Connecting to live updates…";
      break;
    case "live":
      text = snapshot?.refreshing ? "Live. Updating…" : "Live";
      break;
    case "delayed":
      text = <>Live, but updates are delayed by a long-running change. Updated at {syncedAt}.</>;
      break;
    case "reconnecting":
      text = <>Reconnecting. Showing data from {syncedAt}.</>;
      break;
    case "offline":
      text = <>Offline. Showing data from {syncedAt}.</>;
      break;
    case "stopped":
      text = <>Live updates stopped. Reload the page to resume. Showing data from {syncedAt}.</>;
      break;
    case "access-lost":
      text = "Access to this Project ended.";
      break;
  }

  return (
    <output aria-live="polite" data-state={state}>
      {text}
    </output>
  );
}
