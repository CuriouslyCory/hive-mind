import { notFound } from "next/navigation";
import { Suspense } from "react";
import { adrStatusParam, cursorParam, loadAdrList } from "../../../../../server/dashboard/queries";
import { getDb } from "../../../../../server/db";
import { requireFreshLoginSession } from "../../../../../server/login-session";
import { AdrListView } from "../../../_components/adr-list";
import { adrListPath, withParams } from "../../../_components/paths";

type Props = PageProps<"/projects/[projectId]/adrs">;

// `/projects/[projectId]/adrs`: the Project's ADRs, filtered by `?status=`
// (issue #19). The login session, params and data are request-time reads,
// inside Suspense.
export default function AdrsPage({ params, searchParams }: Props) {
  return (
    <main>
      <Suspense fallback={<p role="status">Loading the ADRs…</p>}>
        <Adrs params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Adrs({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const { projectId } = await params;
  const query = await searchParams;
  // A value that is not an ADR status shows every status.
  const status = adrStatusParam(query.status);
  const cursors = {
    adrs: cursorParam(query.adrs),
    removed: cursorParam(query.removed),
    reserved: cursorParam(query.reserved),
  };
  const path = adrListPath(projectId);
  const { user } = await requireFreshLoginSession(withParams(path, { status, ...cursors }));
  const { data } = await loadAdrList(getDb(), user.id, projectId, { status, ...cursors });
  // An absent Project and one the User cannot read look the same.
  if (!data) notFound();
  return <AdrListView list={data} path={path} cursors={cursors} />;
}
