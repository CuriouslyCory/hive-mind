import { notFound } from "next/navigation";
import { Suspense } from "react";
import { loadAdrDetail } from "../../../../../../server/dashboard/queries";
import { getDb } from "../../../../../../server/db";
import { requireFreshLoginSession } from "../../../../../../server/login-session";
import { AdrDetailView } from "../../../../_components/adr-detail";
import { adrListPath } from "../../../../_components/paths";

type Props = PageProps<"/projects/[projectId]/adrs/[number]">;

// `/projects/[projectId]/adrs/[number]`: one ADR (issue #19). The login
// session, params and data are request-time reads, inside Suspense.
export default function AdrPage({ params }: Props) {
  return (
    <main>
      <Suspense fallback={<p role="status">Loading the ADR…</p>}>
        <Adr params={params} />
      </Suspense>
    </main>
  );
}

async function Adr({ params }: Pick<Props, "params">) {
  const { projectId, number } = await params;
  const { user } = await requireFreshLoginSession(
    `${adrListPath(projectId)}/${encodeURIComponent(number)}`,
  );
  const { data } = await loadAdrDetail(getDb(), user.id, projectId, number);
  // An absent ADR, a malformed number and an unreadable Project look the same.
  if (!data) notFound();
  return <AdrDetailView detail={data} />;
}
