import { Alert } from "../../../../design-system/alert";
import { Badge, type BadgeTone } from "../../../../design-system/badge";
import { Card } from "../../../../design-system/card";
import { Cell } from "../../../../design-system/cell";
import { Tabs } from "../../../../design-system/tabs";

// A picture of a Project page with sample data: one Project with four Plans
// and four live Sessions. Everything here is made up and consistent with
// itself (the counts in the Cells and tabs match the rows).

type SampleSession = {
  status: "Buzzing" | "Resting";
  intent: string;
  owner: string;
  branch: string;
  focus: string;
  heartbeat: string;
};

const SESSIONS: readonly SampleSession[] = [
  {
    status: "Buzzing",
    intent: "Fix parser error positions",
    owner: "claude-code · cory@hexlin",
    branch: "feat/parser-positions",
    focus: "PLAN-3",
    heartbeat: "12 s ago",
  },
  {
    status: "Buzzing",
    intent: "Add retry to the stream client",
    owner: "codex · maya@studio",
    branch: "fix/stream-retry",
    focus: "PLAN-4",
    heartbeat: "41 s ago",
  },
  {
    status: "Buzzing",
    intent: "Nightly dependency bump",
    owner: "ci · Project key",
    branch: "chore/deps",
    focus: "—",
    heartbeat: "2 s ago",
  },
  {
    status: "Resting",
    intent: "Write ADR for Project keys",
    owner: "claude-code · cory@hexlin",
    branch: "docs/adr-keys",
    focus: "PLAN-2",
    heartbeat: "3 min ago",
  },
];

type SamplePlan = {
  key: string;
  title: string;
  status: "Active" | "Done";
  done: number;
  total: number;
};

// Three active Plans with 11 open Tasks between them, as the Cells say.
const PLANS: readonly SamplePlan[] = [
  { key: "PLAN-1", title: "Project keys for CI", status: "Done", done: 5, total: 5 },
  { key: "PLAN-2", title: "Document Project keys", status: "Active", done: 2, total: 4 },
  { key: "PLAN-3", title: "Parser error positions", status: "Active", done: 3, total: 6 },
  { key: "PLAN-4", title: "Stream client retries", status: "Active", done: 1, total: 7 },
];

const PLAN_TONES: Record<SamplePlan["status"], BadgeTone> = {
  Active: "honey",
  Done: "success",
};

type SampleEvent = { actor: string; what: string; type: string; when: string };

const EVENTS: readonly SampleEvent[] = [
  {
    actor: "claude-code",
    what: "logged to PLAN-3: Error positions now count code points.",
    type: "plan.log_appended",
    when: "30 s ago",
  },
  {
    actor: "ci",
    what: "started a Session: Nightly dependency bump",
    type: "session.started",
    when: "1 min ago",
  },
  {
    actor: "claude-code",
    what: "claimed a Task on PLAN-3",
    type: "task.claimed",
    when: "2 min ago",
  },
  {
    actor: "codex",
    what: "started a Session: Add retry to the stream client",
    type: "session.started",
    when: "4 min ago",
  },
  {
    actor: "claude-code",
    what: "finished a Task on PLAN-2",
    type: "task.done",
    when: "9 min ago",
  },
];

// The panels are tables, so each cell is announced with its column header.
// Below 720px a column that does not fit (lp-hide-sm) moves to a secondary
// line in the main cell (lp-show-sm) rather than disappearing, and below
// 480px the Sessions' heartbeat moves under the status (lp-hide-xs,
// lp-show-xs).

function SessionsPanel() {
  return (
    <table className="lp-table" aria-label="Live Sessions">
      <thead>
        <tr>
          <th scope="col" className="lp-col-status">
            Status
          </th>
          <th scope="col" className="lp-col-main">
            Intent
          </th>
          <th scope="col" className="lp-col-branch lp-hide-sm">
            Branch
          </th>
          <th scope="col" className="lp-col-focus lp-hide-sm">
            Focus
          </th>
          <th scope="col" className="lp-col-when lp-hide-xs">
            Heartbeat
          </th>
        </tr>
      </thead>
      <tbody>
        {SESSIONS.map((session) => (
          <tr key={session.intent}>
            <td>
              {session.status === "Buzzing" ? (
                <Badge tone="honey" buzzing>
                  Buzzing
                </Badge>
              ) : (
                <Badge tone="neutral">Resting</Badge>
              )}
              <span className="lp-show-xs lp-small lp-muted">{session.heartbeat}</span>
            </td>
            <td className="lp-cell-main">
              <b>{session.intent}</b>
              <br />
              <span className="lp-faint lp-small">{session.owner}</span>
              <span className="lp-show-sm lp-mono lp-muted">
                {session.focus === "—" ? session.branch : `${session.branch} · ${session.focus}`}
              </span>
            </td>
            <td className="lp-mono lp-muted lp-hide-sm">{session.branch}</td>
            <td className="lp-mono lp-hide-sm">{session.focus}</td>
            <td className="lp-small lp-muted lp-hide-xs">{session.heartbeat}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlansPanel() {
  return (
    <table className="lp-table" aria-label="Plans">
      <thead>
        <tr>
          <th scope="col" className="lp-col-key">
            Plan
          </th>
          <th scope="col" className="lp-col-main">
            Title
          </th>
          <th scope="col" className="lp-col-plan-status">
            Status
          </th>
          <th scope="col" className="lp-col-tasks lp-hide-sm">
            Tasks
          </th>
        </tr>
      </thead>
      <tbody>
        {PLANS.map((plan) => (
          <tr key={plan.key}>
            <td className="lp-mono">{plan.key}</td>
            <td className="lp-cell-main">
              <b>{plan.title}</b>
              <span className="lp-show-sm lp-small lp-muted">
                {plan.done} of {plan.total} Tasks done
              </span>
            </td>
            <td>
              <Badge tone={PLAN_TONES[plan.status]}>{plan.status}</Badge>
            </td>
            <td className="lp-small lp-muted lp-hide-sm">
              {plan.done} of {plan.total} done
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActivityPanel() {
  return (
    <table className="lp-table" aria-label="Recent Events">
      <thead>
        <tr>
          <th scope="col" className="lp-col-main">
            Event
          </th>
          <th scope="col" className="lp-col-type lp-hide-sm">
            Type
          </th>
          <th scope="col" className="lp-col-when">
            When
          </th>
        </tr>
      </thead>
      <tbody>
        {EVENTS.map((event) => (
          <tr key={`${event.type}-${event.when}`}>
            <td className="lp-cell-main">
              <b>{event.actor}</b> {event.what}
              <span className="lp-show-sm lp-mono lp-muted">{event.type}</span>
            </td>
            <td className="lp-mono lp-muted lp-hide-sm">{event.type}</td>
            <td className="lp-small lp-muted">{event.when}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LiveHex() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <polygon points="12,3 19.79,7.5 19.79,16.5 12,21 4.21,16.5 4.21,7.5" fill="currentColor" />
    </svg>
  );
}

export function DashboardMock() {
  return (
    <Card className="lp-dash" role="region" aria-label="Example dashboard with sample data">
      <div className="lp-dash-head">
        <h3 className="lp-h3">web-app</h3>
        <span className="lp-small lp-muted">acme · PLAN-1 to PLAN-4</span>
        <span className="lp-live">
          <LiveHex />
          Live · read 2 s ago
        </span>
      </div>
      <div className="lp-dash-body">
        <div className="lp-cells">
          <Cell label="Active plans" value="3" tone="neutral" />
          <Cell label="Live sessions" value="4" tone="honey" />
          <Cell label="Open tasks" value="11" tone="neutral" />
          <Cell label="Overlaps" value="1" tone="neutral" />
        </div>
        {/* Part of a static picture: announcing it would interrupt the page. */}
        <Alert tone="warning" live={false} title="Overlap on packages/parser/lexer.ts">
          Two live Sessions' Scopes cover this path. Advisory only; nothing is blocked.
        </Alert>
        <Tabs
          aria-label="Example Project views"
          defaultValue="sessions"
          items={[
            { value: "plans", label: "Plans", count: 3, panel: <PlansPanel /> },
            { value: "sessions", label: "Sessions", count: 4, panel: <SessionsPanel /> },
            { value: "activity", label: "Activity", panel: <ActivityPanel /> },
          ]}
        />
      </div>
    </Card>
  );
}
