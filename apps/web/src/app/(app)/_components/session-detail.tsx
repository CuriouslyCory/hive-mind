import type { Route } from "next";
import { ProjectLivePage } from "../../../components/dashboard/project-live-updates";
import { SafeMarkdown } from "../../../server/dashboard/markdown";
import type { SessionDetail } from "../../../server/dashboard/queries";
import { AttributionText, formatUtc, Optional, SessionStatusText, Timestamp } from "./format";
import { EventList, SessionFocus } from "./lists";
import { Pager } from "./pager";
import type { CursorParams } from "./paths";
import { ProjectHeading } from "./project-heading";

/** A Session page's content, from one snapshot. */
export function SessionDetailView({
  detail,
  path,
  cursors,
}: {
  detail: SessionDetail;
  path: Route;
  cursors: CursorParams;
}) {
  const { project, session, asOf } = detail;
  return (
    <div data-testid="session-detail">
      <ProjectLivePage
        projectId={project.id}
        cursor={detail.feedCursor}
        asOf={asOf}
        scope={{ kind: "session", sessionId: session.id, taskId: session.attachedTask?.id ?? null }}
      />
      <ProjectHeading project={project} asOf={asOf} linked />
      <h1>Session: {session.agent}</h1>
      <p>
        <strong>Intent:</strong> {session.intent}
      </p>
      <dl>
        <dt>Status</dt>
        <dd>
          <SessionStatusText status={session.status} />
        </dd>
        <dt>Owner</dt>
        <dd>
          <AttributionText value={session.owner} />
        </dd>
        <dt>Machine</dt>
        <dd>
          <Optional value={session.machine} />
        </dd>
        <dt>Branch and commit</dt>
        <dd>
          <Optional value={session.gitBranch} fallback="no branch" />
          {session.gitCommit !== null && (
            <>
              {" at "}
              <code>{session.gitCommit.slice(0, 12)}</code>
            </>
          )}
        </dd>
        <dt>Focus</dt>
        <dd>
          <SessionFocus projectId={project.id} session={session} />
        </dd>
        <dt>Started</dt>
        <dd>
          <time dateTime={session.startedAt.toISOString()}>{formatUtc(session.startedAt)}</time>
        </dd>
        <dt>Last heartbeat</dt>
        <dd>
          <Timestamp date={session.lastHeartbeatAt} asOf={asOf} />
        </dd>
        {session.endedAt !== null && (
          <>
            <dt>Ended</dt>
            <dd>
              <time dateTime={session.endedAt.toISOString()}>{formatUtc(session.endedAt)}</time>
            </dd>
          </>
        )}
      </dl>

      <section aria-labelledby="session-summary">
        <h2 id="session-summary">End summary</h2>
        {session.summary === null ? (
          <p className="muted">
            {session.endedAt === null ? "The Session has not ended." : "No summary was given."}
          </p>
        ) : (
          <SafeMarkdown source={session.summary} />
        )}
      </section>

      <section aria-labelledby="session-scope">
        <h2 id="session-scope">Scope</h2>
        {!session.scopeComplete && (
          <p className="warning">
            The touched-path record of this Session is incomplete, so overlap checks involving it
            may miss overlaps.
          </p>
        )}
        {detail.scopes.items.length === 0 && cursors.scopes === undefined ? (
          <p>No Scopes reported.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Scopes, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">Path or pattern</th>
                <th scope="col">Kind</th>
                <th scope="col">Reported</th>
              </tr>
            </thead>
            <tbody>
              {detail.scopes.items.map((scope) => (
                <tr key={scope.id}>
                  <td>
                    <code>{scope.value}</code>
                  </td>
                  <td>{scope.source === "declared" ? "Declared" : "Touched"}</td>
                  <td>
                    <Timestamp date={scope.createdAt} asOf={asOf} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager
          path={path}
          current={cursors}
          param="scopes"
          nextCursor={detail.scopes.nextCursor}
          label="Scopes"
        />
      </section>

      <section aria-labelledby="session-events">
        <h2 id="session-events">Timeline</h2>
        {detail.events.items.length === 0 ? (
          <p>No Events yet.</p>
        ) : (
          <EventList
            projectId={project.id}
            events={detail.events.items}
            asOf={asOf}
            label="Session timeline, newest first"
          />
        )}
        <Pager
          path={path}
          current={cursors}
          param="events"
          nextCursor={detail.events.nextCursor}
          label="timeline Events"
        />
      </section>
    </div>
  );
}
