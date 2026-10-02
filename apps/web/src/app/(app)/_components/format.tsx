import type { PlanProgress, PlanStatus, SessionStatus, TaskStatus } from "@hivemind/db";
import type { Attribution } from "../../../server/dashboard/queries";

// Small display pieces shared by the dashboard pages. Everything renders as
// React text: status is spelled out (color only repeats it), and times are
// shown relative to the snapshot's database time with the exact UTC time in
// the `<time>` element.

/** Who did something: a User's name, a Project key's name, or the system. */
export function AttributionText({ value }: { value: Attribution }) {
  switch (value.kind) {
    case "user":
      return <span className="attribution">{value.name ?? "Unknown User"}</span>;
    case "project_key":
      if (value.revoked) {
        return (
          <span className="attribution">Project key (revoked, id {value.keyId.slice(0, 8)})</span>
        );
      }
      return (
        <span className="attribution">
          Project key {value.name ?? "unnamed"}
          {value.start ? ` (${value.start}…)` : ""}
        </span>
      );
    case "system":
      return <span className="attribution">hive-mind (automatic)</span>;
  }
}

const SESSION_STATUS_TEXT: Record<SessionStatus, string> = {
  active: "Active",
  idle: "Idle",
  stale: "Stale",
  ended: "Ended",
  abandoned: "Abandoned",
};

export function SessionStatusText({ status }: { status: SessionStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="visually-hidden">Status: </span>
      {SESSION_STATUS_TEXT[status]}
    </span>
  );
}

const PLAN_STATUS_TEXT: Record<PlanStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  done: "Done",
  abandoned: "Abandoned",
};

export function PlanStatusText({ status }: { status: PlanStatus }) {
  return (
    <span className={`status status-plan-${status}`}>
      <span className="visually-hidden">Status: </span>
      {PLAN_STATUS_TEXT[status]}
    </span>
  );
}

const TASK_STATUS_TEXT: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

export function TaskStatusText({ status }: { status: TaskStatus }) {
  return <span className={`status status-task-${status}`}>{TASK_STATUS_TEXT[status]}</span>;
}

/** "3 of 5 Tasks done" with the other counts, and a progress bar repeating it. */
export function ProgressText({ progress }: { progress: PlanProgress }) {
  if (progress.total === 0) return <span data-testid="plan-progress">No Tasks yet</span>;
  const rest = [
    progress.inProgress > 0 ? `${progress.inProgress} in progress` : null,
    progress.blocked > 0 ? `${progress.blocked} blocked` : null,
    progress.todo > 0 ? `${progress.todo} to do` : null,
  ].filter((part) => part !== null);
  const label = `${progress.done} of ${progress.total} Tasks done`;
  return (
    <span className="progress" data-testid="plan-progress">
      <progress value={progress.done} max={progress.total} aria-hidden="true" />{" "}
      <span>
        {label}
        {rest.length > 0 ? ` (${rest.join(", ")})` : ""}
      </span>
    </span>
  );
}

/** A UTC date and time, to the minute. */
export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** How far `date` is from `asOf`, in words ("5 min ago", "in 3 min"). */
export function relativeTo(date: Date, asOf: Date): string {
  const seconds = Math.round((date.getTime() - asOf.getTime()) / 1000);
  const magnitude = Math.abs(seconds);
  let amount: string;
  if (magnitude < 60) amount = `${magnitude} s`;
  else if (magnitude < 3600) amount = `${Math.floor(magnitude / 60)} min`;
  else if (magnitude < 86_400) amount = `${Math.floor(magnitude / 3600)} h`;
  else amount = `${Math.floor(magnitude / 86_400)} d`;
  if (magnitude < 5) return "just now";
  return seconds < 0 ? `${amount} ago` : `in ${amount}`;
}

/** A time shown relative to the snapshot, with the exact time machine-readable. */
export function Timestamp({ date, asOf }: { date: Date; asOf: Date }) {
  return (
    <time dateTime={date.toISOString()} title={formatUtc(date)}>
      {relativeTo(date, asOf)}
    </time>
  );
}

/** A value the client could not determine, shown as such rather than blank. */
export function Optional({
  value,
  fallback = "unknown",
}: {
  value: string | null;
  fallback?: string;
}) {
  return value === null || value === "" ? <span className="muted">{fallback}</span> : value;
}
