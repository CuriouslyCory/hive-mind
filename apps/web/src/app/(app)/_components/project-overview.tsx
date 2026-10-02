import type { Route } from "next";
import Link from "next/link";
import { ProjectLivePage } from "../../../components/dashboard/project-live-updates";
import type { OverlapView, ProjectOverview, SessionLabel } from "../../../server/dashboard/queries";
import { AttributionText, Optional, ProgressText, SessionStatusText, Timestamp } from "./format";
import { SessionFocus, SessionTable } from "./lists";
import { Pager } from "./pager";
import { type CursorParams, planPath, sessionPath } from "./paths";
import { ProjectHeading } from "./project-heading";

/** The Project overview's content, from one snapshot. */
export function ProjectOverviewView({
  overview,
  path,
  cursors,
}: {
  overview: ProjectOverview;
  path: Route;
  cursors: CursorParams;
}) {
  const { project, asOf } = overview;
  return (
    <div data-testid="project-overview">
      <ProjectLivePage
        projectId={project.id}
        cursor={overview.feedCursor}
        scope={{ kind: "project" }}
      />
      <ProjectHeading project={project} asOf={asOf} />

      <section aria-labelledby="active-plans">
        <h2 id="active-plans">Active Plans</h2>
        {overview.activePlans.items.length === 0 ? (
          <p>No active Plans.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Progress</th>
              </tr>
            </thead>
            <tbody>
              {overview.activePlans.items.map((plan) => (
                <tr key={plan.id}>
                  <td>
                    <Link href={planPath(project.id, plan.key)}>
                      {plan.key}: {plan.title}
                    </Link>
                  </td>
                  <td>
                    <ProgressText progress={plan.progress} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager
          path={path}
          current={cursors}
          param="plans"
          nextCursor={overview.activePlans.nextCursor}
          label="active Plans"
        />
      </section>

      <section aria-labelledby="overlaps">
        <h2 id="overlaps">Overlap warnings</h2>
        <p className="muted">
          Live Sessions whose Scopes overlap. Warnings are advisory: they never block work.
        </p>
        {overview.overlaps.items.length === 0 ? (
          <p>{overview.overlaps.complete ? "No overlaps." : "No overlaps found so far."}</p>
        ) : (
          <ul>
            {overview.overlaps.items.map((overlap) => (
              <li
                key={`${overlap.sessionId}|${overlap.scope}|${overlap.otherSessionId}|${overlap.otherScope}`}
              >
                <OverlapText projectId={project.id} overlap={overlap} />
              </li>
            ))}
          </ul>
        )}
        {!overview.overlaps.complete && (
          <p className="warning">
            <strong>Incomplete:</strong> some overlaps may be missing, because a Session's
            touched-path record is incomplete or there were more Sessions or results than one check
            covers.
          </p>
        )}
      </section>

      <section aria-labelledby="live-sessions">
        <h2 id="live-sessions">Live Sessions</h2>
        {overview.liveSessions.items.length === 0 ? (
          <p>No live Sessions.</p>
        ) : (
          <table>
            <caption className="visually-hidden">
              Live Sessions, most recent heartbeat first
            </caption>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Status</th>
                <th scope="col">Owner</th>
                <th scope="col">Machine and branch</th>
                <th scope="col">Focus</th>
                <th scope="col">Last heartbeat</th>
                <th scope="col">Scope</th>
              </tr>
            </thead>
            <tbody>
              {overview.liveSessions.items.map((session) => (
                <tr key={session.id}>
                  <td>
                    <Link href={sessionPath(project.id, session.id)}>{session.agent}</Link>
                    <div className="intent">{session.intent}</div>
                  </td>
                  <td>
                    <SessionStatusText status={session.status} />
                  </td>
                  <td>
                    <AttributionText value={session.owner} />
                  </td>
                  <td>
                    <Optional value={session.machine} fallback="unknown machine" />
                    <br />
                    <Optional value={session.gitBranch} fallback="no branch" />
                  </td>
                  <td>
                    <SessionFocus projectId={project.id} session={session} />
                    {session.claimCount > 0 && (
                      <div>
                        {session.claimCount} {session.claimCount === 1 ? "claim" : "claims"}
                      </div>
                    )}
                  </td>
                  <td>
                    <Timestamp date={session.lastHeartbeatAt} asOf={asOf} />
                  </td>
                  <td>
                    {session.declaredScopes.length > 0 ? (
                      <ul>
                        {session.declaredScopes.map((scope) => (
                          <li key={scope.id}>
                            <code>{scope.value}</code>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted">none declared</span>
                    )}
                    <div className="muted">
                      {session.touchedScopeCount} touched{" "}
                      {session.touchedScopeCount === 1 ? "path" : "paths"}
                      {session.scopeComplete ? "" : " (record incomplete)"}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!overview.liveSessions.complete && (
          <p className="muted">
            Showing the {overview.liveSessions.items.length} live Sessions with the most recent
            heartbeats.
          </p>
        )}
      </section>

      <section aria-labelledby="recent-sessions">
        <h2 id="recent-sessions">Recent Sessions</h2>
        {overview.recentSessions.items.length === 0 ? (
          <p>No ended or abandoned Sessions.</p>
        ) : (
          <SessionTable
            projectId={project.id}
            sessions={overview.recentSessions.items}
            asOf={asOf}
            caption="Ended and abandoned Sessions, most recently started first"
          />
        )}
        <Pager
          path={path}
          current={cursors}
          param="recent"
          nextCursor={overview.recentSessions.nextCursor}
          label="recent Sessions"
        />
      </section>
    </div>
  );
}

function SessionName({
  projectId,
  label,
  id,
}: {
  projectId: string;
  label: SessionLabel | null;
  id: string;
}) {
  if (!label) return <Link href={sessionPath(projectId, id)}>a Session</Link>;
  return (
    <>
      <Link href={sessionPath(projectId, id)}>{label.agent}</Link> (
      <AttributionText value={label.owner} />)
    </>
  );
}

function OverlapText({ projectId, overlap }: { projectId: string; overlap: OverlapView }) {
  return (
    <>
      <SessionName projectId={projectId} label={overlap.session} id={overlap.sessionId} />{" "}
      <code>{overlap.scope}</code> and{" "}
      <SessionName projectId={projectId} label={overlap.otherSession} id={overlap.otherSessionId} />{" "}
      <code>{overlap.otherScope}</code>
      {overlap.kind === "overlap" ? (
        <>
          {" "}
          both match <code>{overlap.witness}</code>
        </>
      ) : (
        " may overlap (the check ran out of budget before deciding)"
      )}
    </>
  );
}
