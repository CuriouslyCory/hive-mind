import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert, Badge, Button, Cell, type CellTone } from "../../../design-system";
import { homeHref } from "../../../server/dashboard/home-params";
import type { HomeDashboard, HomeParams } from "../../../server/dashboard/home-types";
import { projectPath } from "../_components/paths";
import { Breadcrumb } from "../_shell/breadcrumb";
import { FilterInput } from "./filter-input";
import { homeRoute, listCount, plural, RANGE_TEXT, sessionName } from "./format";
import { Freshness } from "./freshness";
import { Activity, Agents, Decisions, HotPaths, Throughput } from "./insights";
import { NavTabs } from "./nav-tabs";
import { NeedsAttention, PlansSection, SessionsSection } from "./sections";

// The signed-in home page, `/` (docs/dashboard.md): every Project the User can
// read, or one of them, with the list views `view=plans` and
// `view=sessions`, inside the app shell. Server components, except the
// filter, the tabs and the freshness line. All page state is in the URL, so
// every control is a link to `homeHref(...)` or navigates to one.

/** The content of the home page's root for `dashboard`. */
export function HomeView({ dashboard }: { dashboard: HomeDashboard }) {
  const { params } = dashboard;
  return (
    <>
      <HomeBreadcrumb params={params} />
      <div className="home-body">
        <ProjectsRail dashboard={dashboard} />
        <div className="home-main">
          <MainHeading dashboard={dashboard} />
          <FilterRow params={params} />
          {dashboard.projects.total === 0 ? (
            <NoProjects />
          ) : (
            <>
              {params.view === "home" ? (
                <>
                  <SummaryCells dashboard={dashboard} />
                  <Overlaps dashboard={dashboard} />
                </>
              ) : null}
              <div className="home-columns">
                <div className="home-column-main">
                  {params.view === "home" ? <NeedsAttention dashboard={dashboard} /> : null}
                  {params.view !== "plans" ? <SessionsSection dashboard={dashboard} /> : null}
                  {params.view !== "sessions" ? <PlansSection dashboard={dashboard} /> : null}
                  {params.view === "home" ? (
                    <>
                      <Throughput dashboard={dashboard} />
                      <Agents dashboard={dashboard} />
                    </>
                  ) : null}
                </div>
                {params.view === "home" ? (
                  <div className="home-column-side">
                    <Activity dashboard={dashboard} />
                    <Decisions dashboard={dashboard} />
                    <HotPaths dashboard={dashboard} />
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// --- Breadcrumb -------------------------------------------------------------------

const LIST_NAMES = { plans: "Plans", sessions: "Sessions" } as const;

/** The Dashboard, then the list view when one is open. */
export function HomeBreadcrumb({ params }: { params: HomeParams }) {
  return (
    <Breadcrumb
      items={
        params.view === "home"
          ? [{ label: "Dashboard" }]
          : [
              { label: "Dashboard", href: homeRoute(params, { view: "home" }) },
              { label: LIST_NAMES[params.view] },
            ]
      }
    />
  );
}

// --- Projects rail ------------------------------------------------------------------

function RailLink({
  to,
  selected,
  name,
  sub,
  buzzing,
}: {
  to: Route;
  selected: boolean;
  name: string;
  sub: string;
  buzzing: number;
}) {
  return (
    <li>
      <Link
        className="home-rail-item"
        href={to}
        aria-current={selected ? "page" : undefined}
        data-selected={selected || undefined}
      >
        <span className="home-rail-text">
          <span className="home-rail-name" title={name}>
            {name}
          </span>
          <span className="home-rail-sub">{sub}</span>
        </span>
        {buzzing > 0 ? (
          <Badge tone="honey">
            {buzzing}
            <span className="home-sr-only"> buzzing</span>
          </Badge>
        ) : null}
      </Link>
    </li>
  );
}

export function ProjectsRail({ dashboard }: { dashboard: HomeDashboard }) {
  const { params, projects } = dashboard;
  return (
    // One landmark: the navigation, named by the heading. The rail's notes
    // need none of their own.
    <div className="home-rail">
      <h2 id="home-rail-heading" className="home-eyebrow home-rail-heading">
        Projects
      </h2>
      <nav aria-labelledby="home-rail-heading">
        <ul className="home-rail-list">
          <RailLink
            to={homeRoute(params, { projectId: null })}
            selected={params.projectId === null}
            name="All Projects"
            sub={plural(projects.total, "Project")}
            buzzing={projects.buzzingTotal}
          />
          {projects.items.map((project) => (
            <RailLink
              key={project.id}
              to={homeRoute(params, { projectId: project.id })}
              selected={params.projectId === project.id}
              name={project.name}
              sub={project.organizationName}
              buzzing={project.buzzingCount}
            />
          ))}
        </ul>
      </nav>
      {projects.total > projects.items.length ? (
        <p className="home-rail-note">
          Showing {projects.items.length} of {plural(projects.total, "Project")}.
        </p>
      ) : null}
      <p className="home-rail-note home-rail-foot">
        Add a Project with <code className="hm-code">hivemind init</code> in its repository.
      </p>
    </div>
  );
}

// --- Heading, filters ----------------------------------------------------------------

function MainHeading({ dashboard }: { dashboard: HomeDashboard }) {
  const { params, selected } = dashboard;
  const scopeName = selected?.name ?? "all Projects";
  const matching = params.q === "" ? "" : ` matching “${params.q}”`;
  let title: string;
  let meta: string;
  if (params.view === "home") {
    title = selected?.name ?? "Dashboard";
    meta = selected
      ? "Every Plan, Session and Event in this Project, live."
      : "Every Plan, Session and Event across the Organizations you belong to, live.";
  } else if (params.view === "plans") {
    title = "Plans";
    const { tab, matching: count } = dashboard.plans;
    meta = `${listCount({ kind: "plans", tab }, count)} in ${scopeName}${matching}.`;
  } else {
    title = "Sessions";
    const { tab, matching: count } = dashboard.sessions;
    meta = `${listCount({ kind: "sessions", tab }, count)} in ${scopeName}${matching}.`;
  }
  return (
    <div className="home-heading-row">
      <div className="home-heading">
        <p className="home-eyebrow">
          {selected
            ? `${selected.organizationName} · Project`
            : `Signed in as ${dashboard.viewer.name}`}
        </p>
        <h1 className="home-title">{title}</h1>
        <p className="home-meta">{meta}</p>
      </div>
      <div className="home-heading-actions">
        <Freshness asOf={dashboard.asOf.toISOString()} />
        {selected ? (
          <Button size="sm" href={projectPath(selected.id)}>
            Open Project
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function hasFilters(params: HomeParams): boolean {
  return (
    params.q !== "" ||
    params.projectId !== null ||
    params.planTab !== "all" ||
    params.sessionTab !== "active"
  );
}

/** The sections whose content the History range changes (`HomeCard` region ids). */
const RANGE_REGIONS = "home-throughput home-agents home-hot-paths";

function FilterRow({ params }: { params: HomeParams }) {
  return (
    <div className="home-filter-row">
      <FilterInput params={params} />
      {hasFilters(params) ? (
        <Button
          variant="quiet"
          icon="close"
          href={homeRoute(params, { q: "", projectId: null, planTab: "all", sessionTab: "active" })}
        >
          Clear filters
        </Button>
      ) : null}
      {params.view === "home" ? (
        <div className="home-range">
          <span id="home-range-label" className="home-eyebrow">
            History
          </span>
          <NavTabs
            aria-labelledby="home-range-label"
            controls={RANGE_REGIONS}
            value={params.range}
            items={(["24h", "7d", "30d"] as const).map((range) => ({
              value: range,
              label: RANGE_TEXT[range].tab,
              href: homeHref(params, { range }),
            }))}
          />
        </div>
      ) : null}
    </div>
  );
}

function NoProjects() {
  return (
    <section className="hm-card home-card home-empty-card" aria-labelledby="home-empty-heading">
      <h2 id="home-empty-heading" className="home-card-title">
        No Projects yet
      </h2>
      <p>
        You have no Projects yet. In your repository, run{" "}
        <code className="hm-code">
          hivemind init --name &apos;My project&apos; --slug my-project
        </code>{" "}
        to create one and link the repository to it (see{" "}
        <a href="https://github.com/CuriouslyCory/hive-mind/blob/main/docs/cli.md#hivemind-init">
          the CLI guide
        </a>
        ).
      </p>
    </section>
  );
}

// --- Summary cells and overlaps ----------------------------------------------------------

function SummaryCells({ dashboard }: { dashboard: HomeDashboard }) {
  const { params, counts } = dashboard;
  const cells: Array<{
    label: string;
    value: number;
    tone: CellTone;
    action: string;
    to: Route;
  }> = [
    {
      label: "Active Plans",
      value: counts.activePlans,
      tone: "neutral",
      action: "Show active Plans",
      to: homeRoute(params, { view: "plans", planTab: "active" }),
    },
    {
      label: "Buzzing",
      value: counts.buzzing,
      tone: "honey",
      action: "Show active Sessions",
      to: homeRoute(params, { view: "sessions", sessionTab: "active" }),
    },
    {
      label: "Open Tasks",
      value: counts.openTasks,
      tone: "neutral",
      action: "Show active Plans",
      to: homeRoute(params, { view: "plans", planTab: "active" }),
    },
    {
      label: "Tasks done",
      value: counts.tasksDone,
      tone: "neutral",
      action: "Show finished Plans",
      to: homeRoute(params, { view: "plans", planTab: "done" }),
    },
    {
      label: "Blocked Tasks",
      value: counts.blockedTasks,
      tone: counts.blockedTasks > 0 ? "danger" : "neutral",
      action: "Show active Plans",
      to: homeRoute(params, { view: "plans", planTab: "active" }),
    },
    {
      label: "Overlaps",
      value: counts.overlaps,
      tone: counts.overlaps > 0 ? "danger" : "neutral",
      action: "Show overlapping Sessions",
      to: homeRoute(params, {
        view: "sessions",
        sessionTab: dashboard.sessions.counts.overlap > 0 ? "overlap" : "active",
      }),
    },
  ];
  return (
    <ul className="home-cells" aria-label="Summary">
      {cells.map((cell) => (
        <li key={cell.label}>
          <Link
            className="home-cell-link"
            href={cell.to}
            aria-label={`${cell.label}: ${cell.value}. ${cell.action}`}
          >
            <Cell label={cell.label} value={cell.value} tone={cell.tone} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Overlaps({ dashboard }: { dashboard: HomeDashboard }) {
  const { params, overlaps, selected } = dashboard;
  if (overlaps.length === 0) return null;
  const sessionsHref = homeRoute(params, { view: "sessions", sessionTab: "overlap" });
  return (
    <div className="home-overlaps">
      {overlaps.map((overlap) => {
        const where = selected ? "" : ` in ${overlap.projectName}`;
        const title: ReactNode = (
          <>
            {overlap.kind === "possible" ? "Possible overlap on " : "Overlap on "}
            <code className="hm-code">{overlap.path}</code>
            {where}
          </>
        );
        return (
          <Alert
            key={`${overlap.projectId}:${overlap.session?.id ?? ""}:${overlap.scope}:${overlap.otherSession?.id ?? ""}:${overlap.otherScope}`}
            tone="warning"
            live={false}
            title={title}
          >
            <div className="home-overlap-body">
              <p>
                {sessionName(overlap.session)}&apos;s{" "}
                <code className="hm-code">{overlap.scope}</code> and{" "}
                {sessionName(overlap.otherSession)}&apos;s{" "}
                <code className="hm-code">{overlap.otherScope}</code> both match. Advisory only;
                nothing is blocked.
              </p>
              <Button size="sm" href={sessionsHref}>
                View Sessions
              </Button>
            </div>
          </Alert>
        );
      })}
    </div>
  );
}
