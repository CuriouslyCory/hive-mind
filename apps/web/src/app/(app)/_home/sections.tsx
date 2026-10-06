import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Button, Icon } from "../../../design-system";
import { homeHref } from "../../../server/dashboard/home-params";
import type {
  HomeDashboard,
  HomeSessionRow,
  PlanTab,
  SessionTab,
} from "../../../server/dashboard/home-types";
import { formatUtc, relativeTo } from "../_components/format";
import { planPath, sessionPath } from "../_components/paths";
import {
  ATTENTION_KINDS,
  attentionDetail,
  attentionSubject,
  attentionWhen,
  attributionLabel,
  homeRoute,
  planStatusBadge,
  plural,
  secondsBetween,
  shortDuration,
} from "./format";
import { NavTabs } from "./nav-tabs";

// Needs attention and the Sessions and Plans tables: the home view shows the
// first rows of each table, the list views (`view=sessions|plans`) up to
// `LIST_TABLE_ROWS`.

/** A time relative to the snapshot, with the exact time machine-readable. */
export function When({ date, asOf, prefix }: { date: Date; asOf: Date; prefix?: string }) {
  return (
    <time dateTime={date.toISOString()} title={formatUtc(date)}>
      {prefix}
      {relativeTo(date, asOf)}
    </time>
  );
}

/** A card section with an `h2`: the frame every block of the page shares. */
export function HomeCard({
  id,
  title,
  count,
  aside,
  children,
  testId,
  ruled = true,
}: {
  id: string;
  title: string;
  count?: number;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** A rule under the header; off for a header followed by tabs. */
  ruled?: boolean;
}) {
  return (
    <section className="hm-card home-card" aria-labelledby={id} data-testid={testId}>
      <div className={ruled ? "home-card-head home-card-head-ruled" : "home-card-head"}>
        <h2 id={id} className="home-card-title">
          {title}
        </h2>
        {count === undefined ? null : (
          <span className="hm-tab-count">
            {count}
            <span className="home-sr-only"> in all</span>
          </span>
        )}
        {aside ? <span className="home-card-aside">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** The grey strip under a table: how many rows are shown, and the way to the rest. */
function TableFooter({ showing, more }: { showing: string; more: ReactNode }) {
  if (showing === "" && !more) return null;
  return (
    <div className="home-card-foot">
      <span className="home-faint">{showing}</span>
      {more ? <span className="home-card-foot-more">{more}</span> : null}
    </div>
  );
}

function quote(q: string): string {
  return `“${q}”`;
}

// --- Needs attention --------------------------------------------------------------

export function NeedsAttention({ dashboard }: { dashboard: HomeDashboard }) {
  const { attention, asOf, selected } = dashboard;
  return (
    <HomeCard
      id="home-attention-heading"
      title="Needs attention"
      count={attention.total}
      aside="Advisory only; nothing is blocked."
      testId="home-attention"
    >
      {attention.items.length === 0 ? (
        <p className="home-empty">Nothing needs you right now. The hive is handling it.</p>
      ) : (
        <ul className="home-feed">
          {attention.items.map((item) => {
            const kind = ATTENTION_KINDS[item.kind];
            const when = attentionWhen(item);
            return (
              <li
                key={`${item.kind}:${"taskId" in item ? item.taskId : item.planId}`}
                className="home-feed-item"
                data-kind={item.kind}
              >
                <span className={`home-feed-icon home-tone-${kind.color}`}>
                  <Icon name={kind.icon} size={20} />
                </span>
                <div className="home-feed-text">
                  <div>
                    <strong>{kind.label}</strong> ·{" "}
                    <Link className="home-link" href={planPath(item.projectId, item.planKey)}>
                      {attentionSubject(item)}
                    </Link>
                  </div>
                  <div className="home-small home-muted">{attentionDetail(item, asOf)}</div>
                  <div className="home-mono-meta">
                    {selected ? "" : `${item.projectName} · `}
                    {item.planKey}
                  </div>
                </div>
                <span className="home-feed-when">
                  {when === null ? null : when.kind === "relative" ? (
                    <When date={when.at} asOf={asOf} />
                  ) : (
                    <time dateTime={when.at.toISOString()} title={formatUtc(when.at)}>
                      <span className="home-sr-only">{when.label} </span>
                      {shortDuration(secondsBetween(when.at, asOf))}
                    </time>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {attention.total > attention.items.length ? (
        <TableFooter
          showing={`Showing ${attention.items.length} of ${plural(attention.total, "item")}`}
          more={null}
        />
      ) : null}
    </HomeCard>
  );
}

// --- Sessions --------------------------------------------------------------------

const SESSION_TAB_LABELS: Record<SessionTab, string> = {
  active: "Active",
  ended: "Ended",
  overlap: "Overlapping",
  all: "All",
};

function SessionState({ row }: { row: HomeSessionRow }) {
  switch (row.state) {
    case "buzzing":
      return (
        <Badge tone="honey" buzzing>
          Buzzing
        </Badge>
      );
    case "resting":
      return <Badge title={row.status === "stale" ? "Stale" : "Idle"}>Resting</Badge>;
    case "ended":
      return (
        <Badge tone="info" title={row.status === "abandoned" ? "Abandoned" : "Ended"}>
          Ended
        </Badge>
      );
  }
}

function emptySessionsText(dashboard: HomeDashboard): ReactNode {
  const { params, sessions } = dashboard;
  if (params.q !== "") return `No Sessions match ${quote(params.q)}.`;
  if (sessions.total === 0) {
    return (
      <>
        No Sessions here yet. Start one with <code className="hm-code">hivemind start</code> and it
        shows up within a heartbeat.
      </>
    );
  }
  switch (sessions.tab) {
    case "active":
      return "No Sessions are running right now.";
    case "ended":
      return "No Sessions have ended here yet.";
    default:
      return "No Sessions overlap right now.";
  }
}

export function SessionsSection({ dashboard }: { dashboard: HomeDashboard }) {
  const { params, sessions, asOf } = dashboard;
  const tabs = (["active", "ended", "overlap", "all"] as const)
    .filter((tab) => tab !== "overlap" || sessions.counts.overlap > 0 || sessions.tab === "overlap")
    .map((tab) => ({
      value: tab,
      label: SESSION_TAB_LABELS[tab],
      count: sessions.counts[tab],
      href: homeHref(params, { sessionTab: tab }),
    }));
  const showing =
    sessions.matching === 0
      ? ""
      : `Showing ${sessions.rows.length} of ${plural(sessions.matching, "Session")}`;
  const more =
    params.view === "home" && sessions.total > sessions.rows.length ? (
      <Button
        variant="quiet"
        size="sm"
        href={homeRoute(params, { view: "sessions", sessionTab: "all" })}
      >
        See all {plural(sessions.total, "Session")}
      </Button>
    ) : null;

  return (
    <HomeCard
      id="home-sessions-heading"
      title="Sessions"
      count={sessions.total}
      ruled={false}
      testId="home-sessions"
    >
      <div className="home-card-tabs">
        <NavTabs aria-label="Session status" value={sessions.tab} items={tabs} />
      </div>
      {sessions.rows.length === 0 ? (
        <p className="home-empty">{emptySessionsText(dashboard)}</p>
      ) : (
        <div className="home-table-scroll">
          <table className="home-table home-sessions-table">
            <thead>
              <tr>
                <th scope="col" className="home-col-status">
                  Status
                </th>
                <th scope="col">Session</th>
                <th scope="col" className="home-col-focus">
                  Project · Focus
                </th>
                <th scope="col" className="home-col-branch">
                  Branch
                </th>
                <th scope="col" className="home-col-time">
                  Heartbeat
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <SessionState row={row} />
                  </td>
                  <td>
                    <Link className="home-link" href={sessionPath(row.projectId, row.id)}>
                      {row.intent.trim() === "" ? "Session without an intent" : row.intent}
                    </Link>
                    <div className="home-byline">
                      <span className="home-small home-faint">
                        {row.agent} · {attributionLabel(row.owner)}
                      </span>
                      {row.overlapping ? <Badge tone="danger">Overlap</Badge> : null}
                    </div>
                  </td>
                  <td>
                    <div className="home-small home-muted">{row.projectName}</div>
                    {row.focusPlanKey ? (
                      <Link
                        className="home-link home-mono"
                        href={planPath(row.projectId, row.focusPlanKey)}
                      >
                        {row.focusPlanKey}
                      </Link>
                    ) : (
                      <span className="home-mono home-faint">
                        <span aria-hidden="true">—</span>
                        <span className="home-sr-only">No focus</span>
                      </span>
                    )}
                  </td>
                  <td className="home-branch">{row.gitBranch ?? "—"}</td>
                  <td className="home-time">
                    {row.state === "ended" && row.endedAt ? (
                      <When date={row.endedAt} asOf={asOf} prefix="ended " />
                    ) : (
                      <When date={row.lastHeartbeatAt} asOf={asOf} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TableFooter showing={showing} more={more} />
    </HomeCard>
  );
}

// --- Plans -------------------------------------------------------------------------

const PLAN_TAB_LABELS: Record<PlanTab, string> = {
  all: "All",
  active: "Active",
  paused: "Paused",
  done: "Done",
};

export function PlansSection({ dashboard }: { dashboard: HomeDashboard }) {
  const { params, plans, asOf } = dashboard;
  const tabs = (["all", "active", "paused", "done"] as const).map((tab) => ({
    value: tab,
    label: PLAN_TAB_LABELS[tab],
    count: plans.counts[tab],
    href: homeHref(params, { planTab: tab }),
  }));
  const showing =
    plans.matching === 0 ? "" : `Showing ${plans.rows.length} of ${plural(plans.matching, "Plan")}`;
  const more =
    params.view === "home" && plans.total > plans.rows.length ? (
      <Button variant="quiet" size="sm" href={homeRoute(params, { view: "plans", planTab: "all" })}>
        See all {plural(plans.total, "Plan")}
      </Button>
    ) : null;
  const empty =
    params.q !== ""
      ? `No Plans match ${quote(params.q)}.`
      : "No Plans with this status. Add one and the next agent can claim its Tasks.";

  return (
    <HomeCard
      id="home-plans-heading"
      title="Plans"
      count={plans.total}
      aside="most recently updated first"
      ruled={false}
      testId="home-plans"
    >
      <div className="home-card-tabs">
        <NavTabs aria-label="Plan status" value={plans.tab} items={tabs} />
      </div>
      {plans.rows.length === 0 ? (
        <p className="home-empty">{empty}</p>
      ) : (
        <div className="home-table-scroll">
          <table className="home-table home-plans-table">
            <thead>
              <tr>
                <th scope="col" className="home-col-plan">
                  Plan
                </th>
                <th scope="col">Title</th>
                <th scope="col" className="home-col-status">
                  Status
                </th>
                <th scope="col" className="home-col-progress">
                  Progress
                </th>
                <th scope="col" className="home-col-time">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {plans.rows.map((row) => {
                const status = planStatusBadge(row.status);
                const { done, total } = row.progress;
                return (
                  <tr key={row.id}>
                    <td>
                      <div className="home-mono">{row.key}</div>
                      <div className="home-small home-faint">{row.projectName}</div>
                    </td>
                    <td>
                      <Link className="home-link" href={planPath(row.projectId, row.key)}>
                        {row.title}
                      </Link>
                      <div className="home-small home-faint">
                        by {attributionLabel(row.createdBy)}
                      </div>
                    </td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td>
                      <span className="home-small home-muted home-num">
                        {total === 0 ? "No Tasks yet" : `${done} of ${plural(total, "Task")} done`}
                      </span>
                      <div className="home-meter" aria-hidden="true">
                        <span
                          className="home-meter-fill"
                          style={{
                            width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%`,
                          }}
                        />
                      </div>
                    </td>
                    <td className="home-time">
                      <When date={row.updatedAt} asOf={asOf} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <TableFooter showing={showing} more={more} />
    </HomeCard>
  );
}
