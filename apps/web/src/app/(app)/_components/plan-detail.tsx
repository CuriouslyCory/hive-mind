import type { Route } from "next";
import Link from "next/link";
import { ProjectLivePage } from "../../../components/dashboard/project-live-updates";
import type { LiveUpdateScope } from "../../../lib/project-event-filters";
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

/**
 * What a Plan page shows, for its live updates: the Plan, the Tasks listed,
 * and the Sessions it names (attached ones and claim holders), whose Scope,
 * heartbeat and liveness changes alter the page.
 */
export function planScope(detail: PlanDetail): LiveUpdateScope {
  const sessionIds = new Set(detail.sessions.items.map((session) => session.id));
  for (const task of detail.tasks.items) {
    if (task.claim) sessionIds.add(task.claim.sessionId);
  }
  return {
    kind: "plan",
    planId: detail.plan.id,
    taskIds: detail.tasks.items.map((task) => task.id),
    sessionIds: [...sessionIds],
  };
}

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
    <div data-testid="plan-detail">
      <ProjectLivePage
        projectId={project.id}
        cursor={detail.feedCursor}
        asOf={asOf}
        scope={planScope(detail)}
      />
      <ProjectHeading
        project={project}
        asOf={asOf}
        trail={[{ label: plan.key }]}
        title={`${plan.key}: ${plan.title}`}
      />
      <dl className="project-facts">
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

      <section className="project-card" aria-labelledby="plan-body">
        <h2 id="plan-body">Plan</h2>
        {plan.body === null ? (
          <p className="muted">No description.</p>
        ) : (
          <SafeMarkdown source={plan.body} />
        )}
      </section>

      <section className="project-card" aria-labelledby="plan-tasks">
        <h2 id="plan-tasks">Tasks</h2>
        {detail.tasks.items.length === 0 && cursors.tasks === undefined ? (
          <p>No Tasks yet.</p>
        ) : (
          <table>
            <caption className="hm-sr-only">Tasks in order</caption>
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
                <tr key={task.id} data-testid="task-row" data-task-status={task.status}>
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

      <section className="project-card" aria-labelledby="plan-sessions">
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

      <section className="project-card" aria-labelledby="plan-activity">
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
