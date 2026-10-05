import type { TrackerScanKind } from "@hivemind/db/schema";

/** The GitHub repository the tracker's issues and PRs belong to. */
export const TRACKER_REPO = "CuriouslyCory/hive-mind";

/** The project skill (`.agents/skills/<name>/SKILL.md`) that runs each scan. */
export const TRACKER_SCAN_SKILLS = {
  git_history: "tracker-git-scan",
  backlog: "tracker-backlog-review",
} as const satisfies Record<TrackerScanKind, string>;

export function issueUrl(issueNumber: number): string {
  return `https://github.com/${TRACKER_REPO}/issues/${issueNumber}`;
}

export function pullUrl(prNumber: number): string {
  return `https://github.com/${TRACKER_REPO}/pull/${prNumber}`;
}
