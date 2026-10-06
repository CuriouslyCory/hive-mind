import { notFound } from "next/navigation";
import { Suspense } from "react";
import { cursorParam, loadPlanDetail } from "../../../../../../server/dashboard/queries";
import { getDb } from "../../../../../../server/db";
import { requireFreshLoginSession } from "../../../../../../server/login-session";
import { planPath, withParams } from "../../../../_components/paths";
import { PlanDetailView } from "../../../../_components/plan-detail";

type Props = PageProps<"/projects/[projectId]/plans/[planKey]">;

// `/projects/[projectId]/plans/[planKey]`: one Plan (issue #11). The login
// session, params and data are request-time reads, inside Suspense.
export default function PlanPage({ params, searchParams }: Props) {
  return (
    <div>
      <Suspense
        fallback={
          <p role="status" className="app-loading">
            Loading the Plan…
          </p>
        }
      >
        <Plan params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Plan({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const { projectId, planKey } = await params;
  const query = await searchParams;
  const cursors = {
    tasks: cursorParam(query.tasks),
    activity: cursorParam(query.activity),
    sessions: cursorParam(query.sessions),
  };
  const path = planPath(projectId, planKey);
  const { user } = await requireFreshLoginSession(withParams(path, cursors));
  const { data } = await loadPlanDetail(getDb(), user.id, projectId, planKey, cursors);
  // An absent Plan, one of another Project and an unreadable Project look the same.
  if (!data) notFound();
  return <PlanDetailView detail={data} path={path} cursors={cursors} />;
}
