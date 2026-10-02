import { notFound } from "next/navigation";
import { Suspense } from "react";
import { cursorParam, loadSessionDetail } from "../../../../../../server/dashboard/queries";
import { getDb } from "../../../../../../server/db";
import { requireFreshLoginSession } from "../../../../../../server/login-session";
import { sessionPath, withParams } from "../../../../_components/paths";
import { SessionDetailView } from "../../../../_components/session-detail";

type Props = PageProps<"/projects/[projectId]/sessions/[sessionId]">;

// `/projects/[projectId]/sessions/[sessionId]`: one Session (issue #11). The
// login session, params and data are request-time reads, inside Suspense.
export default function SessionPage({ params, searchParams }: Props) {
  return (
    <main>
      <Suspense fallback={<p role="status">Loading the Session…</p>}>
        <SessionContent params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function SessionContent({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const { projectId, sessionId } = await params;
  const query = await searchParams;
  const cursors = { events: cursorParam(query.events), scopes: cursorParam(query.scopes) };
  const path = sessionPath(projectId, sessionId);
  const { user } = await requireFreshLoginSession(withParams(path, cursors));
  const { data } = await loadSessionDetail(getDb(), user.id, projectId, sessionId, cursors);
  // An absent Session, one of another Project and an unreadable Project look the same.
  if (!data) notFound();
  return <SessionDetailView detail={data} path={path} cursors={cursors} />;
}
