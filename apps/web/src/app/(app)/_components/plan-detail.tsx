import type { Route } from "next";
import Link from "next/link";
import { SafeMarkdown } from "../../../server/dashboard/markdown";
import type { PlanDetail } from "../../../server/dashboard/queries";
import {
  AttributionText,
  formatUtc,
  PlanStatusText,
  ProgressText,
  SessionStatusText,
  TaskStatusText,
  Timestamp,
} from "./format";
import { EventList, SessionTable } from "./lists";
import { Pager } from "./pager";
import { type CursorParams, sessionPath } from "./paths";
import { ProjectHeading } from "./project-heading";

/** A Plan page's content, from one snapshot. */
export function PlanDetailView({
  detail,
  path,
  cursors,
}: {
  detail: PlanDetail;
  path: Route;
  cursors: CursorParams;
}) {
  const { project, plan, asOf } = detail;
  return (
    <div data-feed-cursor={detail.feedCursor}>
      <ProjectHeading project={project} asOf={asOf} linked />
      <h1>
        {plan.key}: {plan.title}
      </h1>
      <dl>
        <dt>Status</dt>
        <dd>
          <PlanStatusText status={plan.status} />
        </dd>
        <dt>Progress</dt>
        <dd>
          <ProgressText progress={plan.progress} />
        </dd>
        <dt>Created by</dt>
        <dd>
          <AttributionText value={plan.createdBy} />,{" "}
          <time dateTime={plan.createdAt.toISOString()}>{formatUtc(plan.createdAt)}</time>
        </dd>
        {plan.ownerName !== null && (
          <>
            <dt>Owner</dt>
            <dd>{plan.ownerName}</dd>
          </>
        )}
      </dl>

      <section aria-labelledby="plan-body">
        <h2 id="plan-body">Plan</h2>
        {plan.body === null ? (
          <p className="muted">No description.</p>
        ) : (
          <SafeMarkdown source={plan.body} />
        )}
      </section>

      <section aria-labelledby="plan-tasks">
        <h2 id="plan-tasks">Tasks</h2>
        {detail.tasks.items.length === 0 && cursors.tasks === undefined ? (
          <p>No Tasks yet.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Tasks in order</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Claimed by</th>
              </tr>
            </thead>
            <tbody>
              {detail.tasks.items.map((task) => (
                <tr key={task.id}>
                  <td>{task.position}</td>
                  <td>
                    {task.title}
                    {task.blockedReason !== null && (
                      <div className="intent">Blocked: {task.blockedReason}</div>
                    )}
                  </td>
                  <td>
                    <TaskStatusText status={task.status} />
                  </td>
                  <td>
                    {task.claim === null ? (
                      <span className="muted">unclaimed</span>
                    ) : (
                      <>
                        <Link href={sessionPath(project.id, task.claim.sessionId)}>
                          {task.claim.holder?.agent ?? "a Session"}
                        </Link>
                        {task.claim.holder && (
                          <>
                            {" "}
                            (<AttributionText value={task.claim.holder.owner} />,{" "}
                            <SessionStatusText status={task.claim.holder.status} />)
                          </>
                        )}
                        <div className="muted">
                          Lease ends <Timestamp date={task.claim.leaseExpiresAt} asOf={asOf} />
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager
          path={path}
          current={cursors}
          param="tasks"
          nextCursor={detail.tasks.nextCursor}
          label="Tasks"
        />
      </section>

      <section aria-labelledby="plan-sessions">
        <h2 id="plan-sessions">Sessions attached to this Plan</h2>
        {detail.sessions.items.length === 0 ? (
          <p>No Sessions are attached to this Plan.</p>
        ) : (
          <SessionTable
            projectId={project.id}
            sessions={detail.sessions.items}
            asOf={asOf}
            caption="Sessions attached to this Plan, most recently started first"
          />
        )}
        <Pager
          path={path}
          current={cursors}
          param="sessions"
          nextCursor={detail.sessions.nextCursor}
          label="attached Sessions"
        />
      </section>

      <section aria-labelledby="plan-activity">
        <h2 id="plan-activity">Activity</h2>
        {detail.activity.items.length === 0 ? (
          <p>No activity yet.</p>
        ) : (
          <EventList
            projectId={project.id}
            events={detail.activity.items}
            asOf={asOf}
            label="Plan activity, newest first"
          />
        )}
        <Pager
          path={path}
          current={cursors}
          param="activity"
          nextCursor={detail.activity.nextCursor}
          label="activity"
        />
      </section>
    </div>
  );
}
