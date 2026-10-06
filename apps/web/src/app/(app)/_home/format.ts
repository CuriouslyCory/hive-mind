import type { PlanStatus } from "@hivemind/db";
import type { Route } from "next";
import type { BadgeTone } from "../../../design-system";
import { homeHref } from "../../../server/dashboard/home-params";
import {
  ATTENTION_LABELS,
  type AttentionItem,
  type HomeParams,
  type HomeRange,
  type HomeStat,
  type HomeThroughputBucket,
  type PlanTab,
  type SessionTab,
} from "../../../server/dashboard/home-types";
import type { Attribution, SessionLabel } from "../../../server/dashboard/queries";

// Text the home page composes from its read model (docs/dashboard.md). Pure
// functions, so the page's wording is tested without rendering.

/** `homeHref` as a typed route, for `Link` and `Button`. */
export function homeRoute(params: HomeParams, patch: Partial<HomeParams> = {}): Route {
  return homeHref(params, patch) as Route;
}

/** "1 Task", "3 Tasks". `plural` is the irregular plural, when there is one. */
export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

const SESSION_TAB_WORDS: Record<SessionTab, string> = {
  active: "active ",
  ended: "ended ",
  overlap: "overlapping ",
  all: "",
};

const PLAN_TAB_WORDS: Record<PlanTab, string> = {
  all: "",
  active: "active ",
  paused: "paused ",
  done: "finished ",
};

/**
 * How many rows a list view's selected tab has, named by the tab so that it
 * agrees with the tab's count rather than the card's total: "3 active
 * Sessions", "4 Sessions" (All), "2 paused Plans".
 */
export function listCount(
  list: { kind: "sessions"; tab: SessionTab } | { kind: "plans"; tab: PlanTab },
  count: number,
): string {
  const word = list.kind === "sessions" ? SESSION_TAB_WORDS[list.tab] : PLAN_TAB_WORDS[list.tab];
  const noun = list.kind === "sessions" ? "Session" : "Plan";
  return `${count} ${word}${count === 1 ? noun : `${noun}s`}`;
}

/**
 * Who did something, as plain text: a User's name, a Project key as
 * "Project key · name" (never its secret), or the system.
 */
export function attributionLabel(value: Attribution): string {
  switch (value.kind) {
    case "user":
      return value.name ?? "Unknown User";
    case "project_key":
      if (value.revoked) return "Project key (revoked)";
      return `Project key · ${value.name ?? "unnamed"}`;
    case "system":
      return "hive-mind (automatic)";
  }
}

/** A Session in a sentence: its agent, or a stand-in when it is gone. */
export function sessionName(session: SessionLabel | null): string {
  return session?.agent ?? "A Session";
}

/** The length of `seconds` in short units: "12 s", "40 min", "2 h", "6 d". */
export function shortDuration(seconds: number): string {
  const magnitude = Math.max(0, Math.round(seconds));
  if (magnitude < 60) return `${magnitude} s`;
  if (magnitude < 3600) return `${Math.floor(magnitude / 60)} min`;
  if (magnitude < 86_400) return `${Math.floor(magnitude / 3600)} h`;
  return `${Math.floor(magnitude / 86_400)} d`;
}

/** The length of `seconds` in words: "45 seconds", "9 minutes", "1 day". */
export function longDuration(seconds: number): string {
  const magnitude = Math.max(0, Math.round(seconds));
  if (magnitude < 60) return plural(magnitude, "second");
  if (magnitude < 3600) return plural(Math.floor(magnitude / 60), "minute");
  if (magnitude < 86_400) return plural(Math.floor(magnitude / 3600), "hour");
  return plural(Math.floor(magnitude / 86_400), "day");
}

/** Seconds from `from` to `to`. */
export function secondsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 1000;
}

/** Minutes as "45 min" or "21 h 05 min". */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h ${String(whole % 60).padStart(2, "0")} min`;
}

// --- Plans ----------------------------------------------------------------------

const PLAN_STATUS: Record<PlanStatus, { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "honey" },
  done: { label: "Done", tone: "success" },
  paused: { label: "Paused", tone: "neutral" },
  draft: { label: "Draft", tone: "neutral" },
  abandoned: { label: "Abandoned", tone: "neutral" },
};

export function planStatusBadge(status: PlanStatus): { label: string; tone: BadgeTone } {
  return PLAN_STATUS[status];
}

// --- Needs attention ------------------------------------------------------------

export type AttentionColor = "danger" | "honey" | "info" | "muted";

export const ATTENTION_KINDS: Record<
  AttentionItem["kind"],
  { label: string; icon: "alert" | "link" | "hex" | "info"; color: AttentionColor }
> = {
  blocked_task: { label: ATTENTION_LABELS.blocked_task, icon: "alert", color: "danger" },
  lease_ending: { label: ATTENTION_LABELS.lease_ending, icon: "link", color: "honey" },
  claim_lapsed: { label: ATTENTION_LABELS.claim_lapsed, icon: "hex", color: "honey" },
  unclaimed_plan: { label: ATTENTION_LABELS.unclaimed_plan, icon: "info", color: "info" },
  paused_plan: { label: ATTENTION_LABELS.paused_plan, icon: "info", color: "muted" },
};

/** What the item is about: its Task's title, or its Plan's. */
export function attentionSubject(item: AttentionItem): string {
  switch (item.kind) {
    case "blocked_task":
    case "lease_ending":
    case "claim_lapsed":
      return item.taskTitle;
    case "unclaimed_plan":
    case "paused_plan":
      return item.planTitle;
  }
}

/** One or two sentences on what is going on, from the item's fields. */
export function attentionDetail(item: AttentionItem, asOf: Date): string {
  switch (item.kind) {
    case "blocked_task":
      return item.reason.trim() === "" ? "No reason was given." : item.reason;
    case "lease_ending": {
      const left = secondsBetween(asOf, item.leaseExpiresAt);
      const ends = left < 1 ? "is ending now" : `ends in ${shortDuration(left)}`;
      return `${sessionName(item.holder)}'s lease ${ends}. The next Heartbeat renews it.`;
    }
    case "claim_lapsed":
      return `${sessionName(item.holder)}'s lease lapsed. The Task is claimable again.`;
    case "unclaimed_plan":
      return `${plural(item.openTaskCount, "open Task")}, none claimed for ${longDuration(
        secondsBetween(item.idleSince, asOf),
      )}.`;
    case "paused_plan": {
      const open = plural(item.openTaskCount, "open Task");
      return item.pausedAt === null
        ? `Paused with ${open}.`
        : `Paused for ${longDuration(secondsBetween(item.pausedAt, asOf))} with ${open}.`;
    }
  }
}

/**
 * The time the item's right-hand column shows: a moment (`relative`, such
 * as "in 1 min" or "4 min ago") or a length (`since`, "40 min"). Null when
 * the item has no time.
 */
export function attentionWhen(
  item: AttentionItem,
): { at: Date; kind: "relative" | "since"; label: string } | null {
  switch (item.kind) {
    case "blocked_task":
      return item.blockedAt && { at: item.blockedAt, kind: "since", label: "Blocked for" };
    case "lease_ending":
      return { at: item.leaseExpiresAt, kind: "relative", label: "Lease ends" };
    case "claim_lapsed":
      return { at: item.lapsedAt, kind: "relative", label: "Lapsed" };
    case "unclaimed_plan":
      return { at: item.idleSince, kind: "since", label: "Unclaimed for" };
    case "paused_plan":
      return item.pausedAt && { at: item.pausedAt, kind: "since", label: "Paused for" };
  }
}

// --- Activity ---------------------------------------------------------------------

/**
 * An Event's description after its actor: "Claimed the Task" reads
 * "claude-code claimed the Task". Descriptions that do not start with a verb
 * in the past tense ("Heartbeat", "The Session became idle") keep their case
 * and are set apart with a colon.
 */
export function eventPredicate(text: string): { joiner: " " | ": "; text: string } {
  if (/^[A-Z][a-z]+ed /.test(text)) {
    return { joiner: " ", text: text.charAt(0).toLowerCase() + text.slice(1) };
  }
  return { joiner: ": ", text };
}

const EVENT_ICONS: Record<string, "hive" | "link" | "agent" | "check" | "alert" | "hex" | "spark"> =
  {
    "plan.created": "hive",
    "plan.updated": "hive",
    "plan.status_changed": "hive",
    "plan.log_appended": "hive",
    "plan.decision_recorded": "spark",
    "task.added": "hex",
    "task.claimed": "link",
    "task.released": "link",
    "task.started": "agent",
    "task.blocked": "alert",
    "task.done": "check",
    "session.started": "agent",
    "session.ended": "check",
  };

export function eventIcon(
  type: string,
): "hive" | "link" | "agent" | "check" | "alert" | "hex" | "spark" {
  return EVENT_ICONS[type] ?? "hex";
}

/** The first line of a log entry's markdown, as a short plain excerpt. */
export function logExcerpt(markdown: string, max = 120): string {
  const line =
    markdown
      .split("\n")
      .map((part) => part.replace(/^[#>\-*\s]+/, "").trim())
      .find((part) => part !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// --- Throughput ---------------------------------------------------------------------

export const RANGE_TEXT: Record<HomeRange, { label: string; previous: string; tab: string }> = {
  "24h": { label: "Last 24 hours", previous: "previous 24 h", tab: "24 h" },
  "7d": { label: "Last 7 days", previous: "previous 7 days", tab: "7 days" },
  "30d": { label: "Last 30 days", previous: "previous 30 days", tab: "30 days" },
};

export type DeltaTone = "good" | "bad" | "flat";

/**
 * The change of `stat` against the previous range, as "+12% vs previous 7
 * days", and whether it is good. `lowerIsBetter` for times. Null when there
 * is no previous value to compare with (none, or zero).
 */
export function statDelta(
  stat: HomeStat,
  range: HomeRange,
  lowerIsBetter = false,
): { text: string; tone: DeltaTone } | null {
  if (stat.value === null || stat.previous === null || stat.previous === 0) return null;
  const percent = Math.round(((stat.value - stat.previous) / stat.previous) * 100);
  const text = `${percent > 0 ? "+" : ""}${percent}% vs ${RANGE_TEXT[range].previous}`;
  if (percent === 0) return { text, tone: "flat" };
  const better = lowerIsBetter ? percent < 0 : percent > 0;
  return { text, tone: better ? "good" : "bad" };
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** A bucket's start: "14:00" for an hour, "Oct 5" for a day, both in UTC. */
export function bucketLabel(bucket: HomeThroughputBucket, unit: "hour" | "day"): string {
  if (unit === "hour") return `${String(bucket.start.getUTCHours()).padStart(2, "0")}:00`;
  return DAY_FORMAT.format(bucket.start);
}

/** The chart's text alternative: the total, the range and the busiest bucket. */
export function throughputSummary(
  buckets: HomeThroughputBucket[],
  unit: "hour" | "day",
  range: HomeRange,
): string {
  const total = buckets.reduce((sum, bucket) => sum + bucket.tasksDone, 0);
  const head = `${plural(total, "Task")} done, ${RANGE_TEXT[range].label.toLowerCase()}.`;
  const busiest = buckets.reduce<HomeThroughputBucket | null>(
    (best, bucket) => (best === null || bucket.tasksDone > best.tasksDone ? bucket : best),
    null,
  );
  if (busiest === null || busiest.tasksDone === 0) return head;
  return `${head} Busiest ${unit}: ${bucketLabel(busiest, unit)} UTC, with ${busiest.tasksDone}.`;
}
