"use client";

import type { TrackerSnapshot } from "@hivemind/tracker";
import { type KeyboardEvent, useRef, useState } from "react";
import { BacklogTab } from "./backlog-tab";
import { BlogTab } from "./blog-tab";
import { ChangelogTab } from "./changelog-tab";
import { TrackerProvider, useTrackerRunner } from "./runner";
import { TRACKER_TAB_LABELS, TRACKER_TABS, type TrackerTab } from "./tabs";

// The tracker page's client side: the status line and three tabs. Every tab
// stays rendered (hidden when not selected), so an open form survives a tab
// switch. The selected tab is written to `?tab=` with `history.replaceState`,
// which Next.js syncs with its router, so a reload or `router.refresh()`
// keeps it without a server round trip on each switch.

function tabId(tab: TrackerTab): string {
  return `tracker-tab-${tab}`;
}

function panelId(tab: TrackerTab): string {
  return `tracker-panel-${tab}`;
}

export function TrackerWorkspace({
  snapshot,
  initialTab,
}: {
  snapshot: TrackerSnapshot;
  initialTab: TrackerTab;
}) {
  const [tab, setTab] = useState(initialTab);
  const [runner, status] = useTrackerRunner();
  const tabRefs = useRef(new Map<TrackerTab, HTMLButtonElement>());

  function select(next: TrackerTab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  // Arrow keys, Home and End move between tabs and select them (the ARIA
  // tabs pattern with automatic activation); Tab moves into the panel.
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = TRACKER_TABS.length - 1;
    let target: number;
    if (event.key === "ArrowRight") target = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") target = index === 0 ? last : index - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = last;
    else return;
    event.preventDefault();
    const next = TRACKER_TABS[target];
    if (next === undefined) return;
    select(next);
    tabRefs.current.get(next)?.focus();
  }

  return (
    <TrackerProvider value={runner}>
      <p className="muted">
        The changelog, announcement ideas and issue backlog for developing hive-mind. Local{" "}
        <code>next dev</code> only; see <code>docs/tracker.md</code>.
      </p>
      <p role="status" className="tracker-status" data-kind={status?.kind}>
        {status?.text}
      </p>
      <div role="tablist" aria-label="Tracker sections" className="hm-tabs tracker-tabs">
        {TRACKER_TABS.map((id, index) => (
          <button
            key={id}
            ref={(element) => {
              if (element) tabRefs.current.set(id, element);
              else tabRefs.current.delete(id);
            }}
            type="button"
            role="tab"
            className="hm-tab"
            id={tabId(id)}
            aria-controls={panelId(id)}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => select(id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {TRACKER_TAB_LABELS[id]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={panelId("backlog")}
        aria-labelledby={tabId("backlog")}
        hidden={tab !== "backlog"}
      >
        <BacklogTab
          phases={snapshot.backlog}
          nextStep={snapshot.nextStep}
          scan={snapshot.backlogScan}
        />
      </div>
      <div
        role="tabpanel"
        id={panelId("changelog")}
        aria-labelledby={tabId("changelog")}
        hidden={tab !== "changelog"}
      >
        <ChangelogTab entries={snapshot.changelog} scan={snapshot.gitScan} />
      </div>
      <div
        role="tabpanel"
        id={panelId("blog")}
        aria-labelledby={tabId("blog")}
        hidden={tab !== "blog"}
      >
        <BlogTab ideas={snapshot.blogIdeas} />
      </div>
    </TrackerProvider>
  );
}
