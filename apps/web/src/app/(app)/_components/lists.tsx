import Link from "next/link";
import { SafeMarkdown } from "../../../server/dashboard/markdown";
import type { EventView, SessionSummary } from "../../../server/dashboard/queries";
import { AttributionText, Optional, SessionStatusText, Timestamp } from "./format";
import { planPath, sessionPath } from "./paths";

// Lists shared by several dashboard pages.

/** Sessions as a table: who, where, focus and liveness. */
export function SessionTable({
  projectId,
  sessions,
  asOf,
  caption,
}: {
  projectId: string;
  sessions: SessionSummary[];
  asOf: Date;
  caption: string;
}) {
  return (
    <table>
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Session</th>
          <th scope="col">Status</th>
          <th scope="col">Owner</th>
          <th scope="col">Machine and branch</th>
          <th scope="col">Focus</th>
          <th scope="col">Last heartbeat</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => (
          <tr key={session.id}>
            <td>
              <Link href={sessionPath(projectId, session.id)}>{session.agent}</Link>
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
              <SessionFocus projectId={projectId} session={session} />
            </td>
            <td>
              <Timestamp date={session.lastHeartbeatAt} asOf={asOf} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The Plan and Task a Session is attached to, if any. */
export function SessionFocus({
  projectId,
  session,
}: {
  projectId: string;
  session: SessionSummary;
}) {
  if (!session.attachedPlanKey) return <span className="muted">none</span>;
  return (
    <>
      <Link href={planPath(projectId, session.attachedPlanKey)}>{session.attachedPlanKey}</Link>
      {session.attachedTask && (
        <>
          {", Task "}
          {session.attachedTask.position}: {session.attachedTask.title}
        </>
      )}
    </>
  );
}

/** Events, newest first: who, what and when, with links to what they affected. */
export function EventList({
  projectId,
  events,
  asOf,
  label,
}: {
  projectId: string;
  events: EventView[];
  asOf: Date;
  label: string;
}) {
  return (
    <ol className="events" aria-label={label}>
      {events.map((event) => (
        <li key={event.id} data-testid="timeline-item" data-event-type={event.type}>
          <p>
            <AttributionText value={event.actor} />
            {": "}
            {event.text}
          </p>
          {event.markdown !== null && <SafeMarkdown source={event.markdown} headingOffset={3} />}
          <p className="meta">
            <Timestamp date={event.effectiveAt} asOf={asOf} />
            {event.planKey && (
              <>
                {" · "}
                <Link href={planPath(projectId, event.planKey)}>{event.planKey}</Link>
              </>
            )}
            {event.task && (
              <>
                {" · Task "}
                {event.task.position}: {event.task.title}
              </>
            )}
            {event.sessionId && (
              <>
                {" · "}
                <Link href={sessionPath(projectId, event.sessionId)}>Session</Link>
              </>
            )}
            {event.actorSessionId && event.actorSessionId !== event.sessionId && (
              <>
                {" · "}
                <Link href={sessionPath(projectId, event.actorSessionId)}>Acting Session</Link>
              </>
            )}
            {" · "}
            <span className="muted">{event.type}</span>
          </p>
        </li>
      ))}
    </ol>
  );
}
