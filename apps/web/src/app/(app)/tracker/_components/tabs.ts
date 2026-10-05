// The tracker's tabs, in order. The selected one is `?tab=` (docs/tracker.md).

export const TRACKER_TABS = ["backlog", "changelog", "blog"] as const;
export type TrackerTab = (typeof TRACKER_TABS)[number];

export const TRACKER_TAB_LABELS: Record<TrackerTab, string> = {
  backlog: "Backlog",
  changelog: "Changelog",
  blog: "Blog",
};

/** The tab a `?tab=` value names; Backlog for anything else. */
export function trackerTab(value: string | string[] | undefined): TrackerTab {
  return TRACKER_TABS.find((tab) => tab === value) ?? "backlog";
}
