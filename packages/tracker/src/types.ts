import type { TrackerBlogStatus, TrackerIssueState, TrackerScanKind } from "@hivemind/db/schema";

// What `getTrackerSnapshot` returns, and what the page and `pnpm tracker
// snapshot` show. Every timestamp is an ISO 8601 string and every `date` is
// `YYYY-MM-DD`, so a snapshot survives JSON and the server/client boundary
// unchanged. `updatedAt` is the value to send back with an update or delete.

export type ScanKind = TrackerScanKind;
export type BlogStatus = TrackerBlogStatus;
export type IssueState = TrackerIssueState;

export interface TrackerScanView {
  id: string;
  kind: ScanKind;
  completedAt: string;
  throughAt: string;
  throughSha: string | null;
  note: string | null;
}

export interface ChangelogEntryView {
  id: string;
  date: string;
  category: string;
  title: string;
  summary: string;
  prNumbers: number[];
  updatedAt: string;
}

export interface BlogIdeaView {
  id: string;
  title: string;
  pitch: string;
  notes: string | null;
  prNumbers: number[];
  status: BlogStatus;
  publishedAt: string | null;
  publishedUrl: string | null;
  sortOrder: number;
  updatedAt: string;
}

export interface BacklogStepView {
  id: string;
  key: string;
  label: string;
  prompt: string | null;
  sortOrder: number;
  completedAt: string | null;
  updatedAt: string;
}

export interface BacklogIssueView {
  id: string;
  issueNumber: number;
  title: string;
  note: string | null;
  state: IssueState;
  githubUpdatedAt: string | null;
  sortOrder: number;
  updatedAt: string;
  steps: BacklogStepView[];
}

export interface BacklogPhaseView {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  updatedAt: string;
  issues: BacklogIssueView[];
}

/** The Backlog tab's "Up next": the first unfinished step of the first open issue. */
export interface NextStepView {
  phaseTitle: string;
  issueNumber: number;
  issueTitle: string;
  step: BacklogStepView;
}

export interface TrackerSnapshot {
  readAt: string;
  /** The newest scan of each kind, by completion time. */
  gitScan: TrackerScanView | null;
  backlogScan: TrackerScanView | null;
  /** Newest date first, then by title. */
  changelog: ChangelogEntryView[];
  /** By sortOrder, then creation. */
  blogIdeas: BlogIdeaView[];
  /** Phases, their issues and the issues' steps, each by sortOrder, then creation. */
  backlog: BacklogPhaseView[];
  nextStep: NextStepView | null;
}
