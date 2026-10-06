import Link from "next/link";
import { Badge, Icon } from "../../../design-system";
import type { HomeDashboard, HomeStat } from "../../../server/dashboard/home-types";
import { planPath } from "../_components/paths";
import {
  attributionLabel,
  bucketLabel,
  eventIcon,
  eventPredicate,
  formatMinutes,
  logExcerpt,
  plural,
  RANGE_TEXT,
  statDelta,
  throughputSummary,
} from "./format";
import { HomeCard, When } from "./sections";

// The home view's history and context: Throughput, Agents, Activity,
// Decisions and Hot paths. The list views do not render them.

// --- Throughput -----------------------------------------------------------------

function Stat({
  label,
  stat,
  format,
  dashboard,
  lowerIsBetter = false,
}: {
  label: string;
  stat: HomeStat;
  format: (value: number) => string;
  dashboard: HomeDashboard;
  lowerIsBetter?: boolean;
}) {
  const delta = statDelta(stat, dashboard.params.range, lowerIsBetter);
  return (
    <div className="home-stat">
      <dt className="home-eyebrow">{label}</dt>
      <dd className="home-stat-value">{stat.value === null ? "—" : format(stat.value)}</dd>
      <dd className={`home-small home-num home-delta-${delta?.tone ?? "flat"}`}>
        {delta
          ? delta.text
          : `No comparison with the ${RANGE_TEXT[dashboard.params.range].previous}`}
      </dd>
    </div>
  );
}

export function Throughput({ dashboard }: { dashboard: HomeDashboard }) {
  const { throughput } = dashboard.analytics;
  const { buckets, unit, range } = throughput;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.tasksDone));
  const count = String;
  return (
    <HomeCard
      id="home-throughput-heading"
      title="Throughput"
      aside={RANGE_TEXT[range].label}
      testId="home-throughput"
    >
      <div className="home-card-body">
        <dl className="home-stats">
          <Stat
            label="Tasks done"
            stat={throughput.tasksDone}
            format={count}
            dashboard={dashboard}
          />
          <Stat
            label="Sessions started"
            stat={throughput.sessionsStarted}
            format={count}
            dashboard={dashboard}
          />
          <Stat
            label="Plans finished"
            stat={throughput.plansFinished}
            format={count}
            dashboard={dashboard}
          />
          <Stat
            label="Median Task time"
            stat={throughput.medianTaskMinutes}
            format={formatMinutes}
            dashboard={dashboard}
            lowerIsBetter
          />
        </dl>
        {buckets.length > 0 ? (
          <figure className="home-chart">
            <div
              role="img"
              aria-label={throughputSummary(buckets, unit, range)}
              className="home-bars"
              data-dense={buckets.length > 14 || undefined}
            >
              {buckets.map((bucket, index) => (
                <div
                  key={bucket.start.toISOString()}
                  className={
                    index === buckets.length - 1 ? "home-bar home-bar-current" : "home-bar"
                  }
                  title={`${bucketLabel(bucket, unit)} · ${plural(bucket.tasksDone, "Task")} done`}
                  style={{
                    height: `${Math.max(2, Math.round((bucket.tasksDone / max) * 100))}%`,
                  }}
                />
              ))}
            </div>
            <figcaption className="home-axis home-small home-faint home-num">
              <span>{bucketLabel(buckets[0] ?? { start: new Date(0), tasksDone: 0 }, unit)}</span>
              <span>Tasks done per {unit} (UTC)</span>
              <span>{unit === "hour" ? "now" : "today"}</span>
            </figcaption>
            <table className="home-sr-only">
              <caption>Tasks done per {unit}, UTC</caption>
              <thead>
                <tr>
                  <th scope="col">{unit === "hour" ? "Hour" : "Day"}</th>
                  <th scope="col">Tasks done</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((bucket) => (
                  <tr key={bucket.start.toISOString()}>
                    <th scope="row">{bucketLabel(bucket, unit)}</th>
                    <td>{bucket.tasksDone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </figure>
        ) : null}
      </div>
    </HomeCard>
  );
}

// --- Agents -----------------------------------------------------------------------

export function Agents({ dashboard }: { dashboard: HomeDashboard }) {
  const { agents } = dashboard.analytics;
  const { range } = dashboard.params;
  return (
    <HomeCard
      id="home-agents-heading"
      title="Agents"
      count={agents.length}
      aside={RANGE_TEXT[range].label}
      testId="home-agents"
    >
      {agents.length === 0 ? (
        <p className="home-empty">
          No agents worked here in the {RANGE_TEXT[range].label.toLowerCase()}.
        </p>
      ) : (
        <div className="home-table-scroll">
          <table className="home-table home-agents-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col" className="home-col-num">
                  Sessions
                </th>
                <th scope="col" className="home-col-num">
                  Tasks done
                </th>
                <th scope="col" className="home-col-num home-col-wide">
                  Active time
                </th>
                <th scope="col" className="home-col-time">
                  Last seen
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const where = [
                  agent.machines.join(", "),
                  dashboard.selected ? "" : plural(agent.projectCount, "Project"),
                ]
                  .filter((part) => part !== "")
                  .join(" · ");
                return (
                  <tr key={agent.agent}>
                    <td>
                      <div className="home-strong">{agent.agent}</div>
                      {where ? <div className="home-small home-faint">{where}</div> : null}
                    </td>
                    <td className="home-num-cell">{agent.sessions}</td>
                    <td className="home-num-cell">{agent.tasksDone}</td>
                    <td className="home-num-cell">{formatMinutes(agent.activeMinutes)}</td>
                    <td className="home-time">
                      <When date={agent.lastSeenAt} asOf={dashboard.asOf} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </HomeCard>
  );
}

// --- Activity ------------------------------------------------------------------------

export function Activity({ dashboard }: { dashboard: HomeDashboard }) {
  const { events, selected, asOf } = dashboard;
  return (
    <HomeCard
      id="home-activity-heading"
      title="Activity"
      aside="newest first"
      testId="home-activity"
    >
      {events.length === 0 ? (
        <p className="home-empty">No Events match. The hive is quiet here.</p>
      ) : (
        <ol className="home-feed">
          {events.map((event) => {
            const predicate = eventPredicate(event.text);
            const excerpt = event.markdown === null ? "" : logExcerpt(event.markdown);
            return (
              <li key={event.id} className="home-feed-item" data-event-type={event.type}>
                <span className="home-feed-icon home-tone-honey">
                  <Icon name={eventIcon(event.type)} size={20} />
                </span>
                <div className="home-feed-text">
                  <div>
                    <strong>{event.actorAgent ?? attributionLabel(event.actor)}</strong>
                    {predicate.joiner}
                    {predicate.text}
                    {excerpt ? `: ${excerpt}` : null}
                  </div>
                  <div className="home-mono-meta">
                    {selected ? null : `${event.projectName} · `}
                    {event.planKey ? (
                      <>
                        <Link
                          className="home-link-quiet"
                          href={planPath(event.projectId, event.planKey)}
                        >
                          {event.planKey}
                        </Link>
                        {" · "}
                      </>
                    ) : null}
                    {event.type}
                  </div>
                </div>
                <span className="home-feed-when">
                  <When date={event.effectiveAt} asOf={asOf} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </HomeCard>
  );
}

// --- Decisions -----------------------------------------------------------------------

export function Decisions({ dashboard }: { dashboard: HomeDashboard }) {
  const { decisions, selected, asOf } = dashboard;
  return (
    <HomeCard id="home-decisions-heading" title="Decisions" testId="home-decisions">
      {decisions.length === 0 ? (
        <p className="home-empty">No decisions recorded here yet.</p>
      ) : (
        <ul className="home-feed">
          {decisions.map((decision) => (
            <li key={decision.id} className="home-feed-item home-decision">
              <p className="home-strong">{decision.text}</p>
              <div className="home-small home-faint home-decision-meta">
                <Link
                  className="home-link-quiet home-mono"
                  href={planPath(decision.projectId, decision.planKey)}
                >
                  {selected ? "" : `${decision.projectName} · `}
                  {decision.planKey}
                </Link>
                <span>
                  {" · "}
                  {decision.actorAgent ?? attributionLabel(decision.actor)} ·{" "}
                  <When date={decision.at} asOf={asOf} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}

// --- Hot paths ----------------------------------------------------------------------

export function HotPaths({ dashboard }: { dashboard: HomeDashboard }) {
  const { hotPaths } = dashboard.analytics;
  const { range } = dashboard.params;
  const max = Math.max(1, ...hotPaths.map((path) => path.touches));
  return (
    <HomeCard
      id="home-hot-paths-heading"
      title="Hot paths"
      aside={RANGE_TEXT[range].label}
      testId="home-hot-paths"
    >
      {hotPaths.length === 0 ? (
        <p className="home-empty">
          No touched paths reported in the {RANGE_TEXT[range].label.toLowerCase()}.
        </p>
      ) : (
        <ul className="home-feed">
          {hotPaths.map((path) => (
            <li key={`${path.projectId}:${path.path}`} className="home-feed-item home-hot-path">
              <div className="home-hot-path-head">
                <code className="home-hot-path-name" title={path.path}>
                  {dashboard.selected ? "" : `${path.projectName} / `}
                  {path.path}
                </code>
                {path.overlapping ? <Badge tone="danger">Overlap</Badge> : null}
              </div>
              <div className="home-meter" aria-hidden="true">
                <span
                  className="home-meter-fill home-meter-fill-alt"
                  style={{ width: `${Math.round((path.touches / max) * 100)}%` }}
                />
              </div>
              <span className="home-small home-faint home-num">
                {plural(path.touches, "touch", "touches")} · {plural(path.sessions, "Session")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  );
}
