import type { PlanProgress, PlanStatus, SessionStatus } from "@hivemind/db";
import type { Attribution, EventView, SessionLabel } from "./queries";

// The read model of the signed-in home page, `/` (the Dashboard design in
// docs/dashboard.md). One `loadHomeDashboard` call (./home.ts) reads all of
// it in one snapshot, across every Project the User can read or within one
// selected Project. Every list here is bounded; the limits are below.

// --- Page state (search params, parsed by ./home-params.ts) -------------------

export const HOME_VIEWS = ["home", "plans", "sessions"] as const;
export type HomeView = (typeof HOME_VIEWS)[number];

export const HOME_RANGES = ["24h", "7d", "30d"] as const;
export type HomeRange = (typeof HOME_RANGES)[number];

export const SESSION_TABS = ["active", "ended", "overlap", "all"] as const;
export type SessionTab = (typeof SESSION_TABS)[number];

export const PLAN_TABS = ["all", "active", "paused", "done"] as const;
export type PlanTab = (typeof PLAN_TABS)[number];

/** The longest filter text the page accepts; longer input is cut to this. */
export const MAX_HOME_QUERY_LENGTH = 100;

export interface HomeParams {
  /** The selected Project, or null for all of them. A Project the User cannot read is treated as null. */
  projectId: string | null;
  /** Trimmed filter text, matched case-insensitively as a substring. Empty means no filter. */
  q: string;
  view: HomeView;
  sessionTab: SessionTab;
  planTab: PlanTab;
  range: HomeRange;
}

// --- Limits -------------------------------------------------------------------

/** Rows of the Sessions and Plans tables on the home view. */
export const HOME_TABLE_ROWS = 5;
/** Rows of the Sessions and Plans tables on their list views. */
export const LIST_TABLE_ROWS = 100;
/** Projects in the rail. */
export const HOME_PROJECT_LIMIT = 50;
export const HOME_EVENT_LIMIT = 7;
export const HOME_ATTENTION_LIMIT = 10;
export const HOME_OVERLAP_LIMIT = 5;
export const HOME_DECISION_LIMIT = 4;
export const HOME_HOT_PATH_LIMIT = 6;
export const HOME_AGENT_LIMIT = 10;
/** A claim whose lease ends within this many seconds is "Lease ending". */
export const LEASE_ENDING_SECONDS = 120;
/** An active Plan with open Tasks and no claim or Plan update for this long is "Unclaimed". */
export const UNCLAIMED_PLAN_SECONDS = 24 * 60 * 60;
/** A gap between two heartbeats of one Session counts as active time only when shorter than this. */
export const ACTIVE_GAP_SECONDS = 5 * 60;

// --- Projects -----------------------------------------------------------------

export interface HomeProject {
  id: string;
  name: string;
  slug: string;
  organizationName: string;
  /** Sessions of this Project that are effectively `active` at `asOf`. */
  buzzingCount: number;
}

// --- Sessions and Plans tables ------------------------------------------------

/**
 * How the page shows a Session's effective status: `buzzing` is `active`,
 * `resting` is `idle` or `stale`, `ended` is `ended` or `abandoned`.
 */
export type HomeSessionState = "buzzing" | "resting" | "ended";

export interface HomeSessionRow {
  id: string;
  projectId: string;
  projectName: string;
  intent: string;
  agent: string;
  owner: Attribution;
  machine: string | null;
  /** The effective status at `asOf`. */
  status: SessionStatus;
  state: HomeSessionState;
  gitBranch: string | null;
  /** The attached Plan's PLAN-N key, or null. */
  focusPlanKey: string | null;
  lastHeartbeatAt: Date;
  endedAt: Date | null;
  /** True when the Session is a side of one of the scope's current overlaps. */
  overlapping: boolean;
}

export interface HomeSessionsSection {
  /** Sessions in scope that match `q`, in every tab. */
  total: number;
  counts: Record<SessionTab, number>;
  /** The tab shown: the requested one, or `active` when `overlap` has no Sessions. */
  tab: SessionTab;
  /** Sessions in the shown tab; `rows` holds at most the view's row limit of them. */
  matching: number;
  /** Live Sessions by last heartbeat, newest first; ended ones by end time, newest first. */
  rows: HomeSessionRow[];
}

export interface HomePlanRow {
  id: string;
  projectId: string;
  projectName: string;
  key: string;
  title: string;
  status: PlanStatus;
  progress: PlanProgress;
  createdBy: Attribution;
  updatedAt: Date;
}

export interface HomePlansSection {
  /** Plans in scope that match `q`, in every status (drafts and abandoned Plans included). */
  total: number;
  counts: Record<PlanTab, number>;
  tab: PlanTab;
  matching: number;
  /** Most recently updated first. */
  rows: HomePlanRow[];
}

// --- Summary cells and overlaps -----------------------------------------------

export interface HomeCounts {
  /** Plans with status `active`. */
  activePlans: number;
  /** Sessions effectively `active`. */
  buzzing: number;
  /** Tasks not `done` in Plans that are not `done` or `abandoned`. */
  openTasks: number;
  /** `task.done` Events in the selected range (equals `throughput.tasksDone.value`). */
  tasksDone: number;
  /** Tasks with status `blocked` in Plans that are not `done` or `abandoned`. */
  blockedTasks: number;
  /** Current overlap pairs between live Sessions. */
  overlaps: number;
}

export interface HomeOverlap {
  projectId: string;
  projectName: string;
  /** A concrete path both sides match, when known; otherwise the first side's Scope. */
  path: string;
  session: SessionLabel | null;
  scope: string;
  otherSession: SessionLabel | null;
  otherScope: string;
  kind: "overlap" | "possible";
}

// --- Needs attention ----------------------------------------------------------

interface AttentionBase {
  projectId: string;
  projectName: string;
  planKey: string;
}

/** Things a person may want to act on. Advisory: nothing is blocked by them. */
export type AttentionItem =
  | (AttentionBase & {
      kind: "blocked_task";
      taskTitle: string;
      reason: string;
      /** When the Task became blocked; null for a Task blocked before `blocked_at` existed and with no Event to say. */
      blockedAt: Date | null;
    })
  | (AttentionBase & {
      kind: "lease_ending";
      taskTitle: string;
      holder: SessionLabel | null;
      leaseExpiresAt: Date;
    })
  | (AttentionBase & {
      kind: "claim_lapsed";
      taskTitle: string;
      /** The Session whose claim lapsed. */
      holder: SessionLabel | null;
      lapsedAt: Date;
    })
  | (AttentionBase & {
      kind: "unclaimed_plan";
      planTitle: string;
      openTaskCount: number;
      /** The later of the Plan's last update and its last claim. */
      idleSince: Date;
    })
  | (AttentionBase & {
      kind: "paused_plan";
      planTitle: string;
      openTaskCount: number;
      /** Null for a Plan paused before `paused_at` existed and with no Event to say. */
      pausedAt: Date | null;
    });

export type AttentionKind = AttentionItem["kind"];

/**
 * Each kind's label as the page shows it. The filter matches it too, so
 * "lapsed" lists every lapsed claim.
 */
export const ATTENTION_LABELS: Record<AttentionKind, string> = {
  blocked_task: "Blocked Task",
  lease_ending: "Lease ending",
  claim_lapsed: "Claim lapsed",
  unclaimed_plan: "Unclaimed Plan",
  paused_plan: "Paused Plan",
};

// --- Activity -----------------------------------------------------------------

export interface HomeEventView extends EventView {
  projectId: string;
  projectName: string;
  /** The agent of the Session the Event was written through, or null. */
  actorAgent: string | null;
}

// --- Analytics (./home-analytics.ts) ------------------------------------------

/** A figure for the selected range and the same-length range before it. */
export interface HomeStat {
  /** Null when there is nothing to compute it from (a median with no samples). */
  value: number | null;
  previous: number | null;
}

export interface HomeThroughputBucket {
  /** The bucket's start: an hour (24h) or a UTC day (7d, 30d). */
  start: Date;
  tasksDone: number;
}

export interface HomeThroughput {
  range: HomeRange;
  unit: "hour" | "day";
  /** Oldest first; the last bucket is the current, partial one. 24, 7 or 30 buckets. */
  buckets: HomeThroughputBucket[];
  tasksDone: HomeStat;
  sessionsStarted: HomeStat;
  /** `plan.status_changed` Events to `done`. */
  plansFinished: HomeStat;
  /** Median minutes from a Task's last claim to its `task.done`, for Tasks done in the range. */
  medianTaskMinutes: HomeStat;
}

export interface HomeAgentRow {
  /** The Session's agent name, such as `claude-code`. */
  agent: string;
  /** Distinct machines, sorted; empty when none reported one. */
  machines: string[];
  projectCount: number;
  /** Sessions started in the range. */
  sessions: number;
  /** `task.done` Events in the range written through this agent's Sessions. */
  tasksDone: number;
  /** Sum of gaps between consecutive heartbeats (and start) shorter than `ACTIVE_GAP_SECONDS`, in the range. */
  activeMinutes: number;
  lastSeenAt: Date;
}

export interface HomeHotPath {
  projectId: string;
  projectName: string;
  path: string;
  /** Touched-path collection batches in the range that carried the path. */
  touches: number;
  /** Distinct Sessions that touched it in the range. */
  sessions: number;
  /** True when a current overlap's Scope matches the path. */
  overlapping: boolean;
}

export interface HomeAnalytics {
  throughput: HomeThroughput;
  agents: HomeAgentRow[];
  hotPaths: HomeHotPath[];
}

// --- Decisions (./home-decisions.ts) ------------------------------------------

export interface HomeDecision {
  /** The `plan.decision_recorded` Event's id. */
  id: string;
  projectId: string;
  projectName: string;
  planKey: string;
  /** Plain text, never markdown. */
  text: string;
  actor: Attribution;
  actorAgent: string | null;
  at: Date;
}

// --- The page -----------------------------------------------------------------

export interface HomeDashboard {
  /** The snapshot's database time; relative times and liveness are as of it. */
  asOf: Date;
  viewer: { name: string };
  /** The parameters actually applied (an unreadable Project becomes null, a missing tab falls back). */
  params: HomeParams;
  projects: {
    /** At most `HOME_PROJECT_LIMIT`, by name. */
    items: HomeProject[];
    total: number;
    buzzingTotal: number;
  };
  /** The selected Project, or null. */
  selected: HomeProject | null;
  counts: HomeCounts;
  overlaps: HomeOverlap[];
  attention: { items: AttentionItem[]; total: number };
  sessions: HomeSessionsSection;
  plans: HomePlansSection;
  /** Newest first. Empty on the list views. */
  events: HomeEventView[];
  /** Empty sections on the list views. */
  analytics: HomeAnalytics;
  decisions: HomeDecision[];
}
