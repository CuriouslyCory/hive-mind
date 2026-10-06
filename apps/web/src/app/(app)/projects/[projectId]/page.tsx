import { notFound } from "next/navigation";
import { Suspense } from "react";
import { cursorParam, loadProjectOverview } from "../../../../server/dashboard/queries";
import { getDb } from "../../../../server/db";
import { requireFreshLoginSession } from "../../../../server/login-session";
import { projectPath, withParams } from "../../_components/paths";
import { ProjectOverviewView } from "../../_components/project-overview";

// `/projects/[projectId]`: the Project overview (issue #11). The login
// session, params and data are request-time reads, inside Suspense.
export default function ProjectPage({ params, searchParams }: PageProps<"/projects/[projectId]">) {
  return (
    <div>
      <Suspense
        fallback={
          <p role="status" className="app-loading">
            Loading the Project…
          </p>
        }
      >
        <Overview params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Overview({
  params,
  searchParams,
}: Pick<PageProps<"/projects/[projectId]">, "params" | "searchParams">) {
  const { projectId } = await params;
  const query = await searchParams;
  const cursors = { plans: cursorParam(query.plans), recent: cursorParam(query.recent) };
  const path = projectPath(projectId);
  const { user } = await requireFreshLoginSession(withParams(path, cursors));
  const { data } = await loadProjectOverview(getDb(), user.id, projectId, cursors);
  // An absent Project and one the User cannot read look the same.
  if (!data) notFound();
  return <ProjectOverviewView overview={data} path={path} cursors={cursors} />;
}
