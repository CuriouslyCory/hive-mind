import { formatAdrNumber } from "@hivemind/contract";
import type { AdrLink } from "@hivemind/db";
import Link from "next/link";
import { ProjectLivePage } from "../../../components/dashboard/project-live-updates";
import { Alert } from "../../../design-system/alert";
import { SafeMarkdown } from "../../../server/dashboard/markdown";
import type { AdrDetail } from "../../../server/dashboard/queries";
import { AdrSyncBanner, adrStatusText } from "./adr-format";
import { AttributionText, formatUtc, Optional, Timestamp } from "./format";
import { adrListPath, adrPath } from "./paths";
import { ProjectHeading } from "./project-heading";

/** An ADR page's content, from one snapshot. */
export function AdrDetailView({ detail }: { detail: AdrDetail }) {
  const { project, adr, asOf } = detail;
  const name = formatAdrNumber(adr.number);
  return (
    <div data-testid="adr-detail">
      <ProjectLivePage
        projectId={project.id}
        cursor={detail.feedCursor}
        asOf={asOf}
        scope={{ kind: "adr", number: adr.number }}
      />
      <ProjectHeading
        project={project}
        asOf={asOf}
        trail={[{ label: "ADRs", href: adrListPath(project.id) }, { label: name }]}
        title={`${name}: ${adr.title}`}
      />
      <AdrSyncBanner lastSync={detail.lastSync} asOf={asOf} />
      {adr.state === "reserved" && (
        <Alert live={false}>
          Reserved, not merged yet: no synced commit has a file with this number.
        </Alert>
      )}
      {adr.state === "removed" && (
        <Alert tone="warning" live={false}>
          Removed: the last sync found no file with this number. This is the last copy hive-mind
          has.
        </Alert>
      )}
      {adr.reservationTaken && adr.reservation && (
        <Alert tone="warning" live={false}>
          {name} was reserved for “{adr.reservation.title}”; this file took the number, so the
          reserved ADR needs a new number.
        </Alert>
      )}

      <dl className="project-facts">
        {adr.status !== null && (
          <>
            <dt>Status</dt>
            <dd>{adrStatusText(adr.status)}</dd>
          </>
        )}
        {adr.date !== null && (
          <>
            <dt>Date</dt>
            <dd>{adr.date}</dd>
          </>
        )}
        {adr.path !== null && (
          <>
            <dt>File</dt>
            <dd>
              <code>{adr.path}</code>
            </dd>
          </>
        )}
        {adr.commitSha !== null && (
          <>
            <dt>Copied from commit</dt>
            <dd>
              <code>{adr.commitSha.slice(0, 12)}</code>
              {adr.syncedAt !== null && (
                <>
                  {", synced "}
                  <Timestamp date={adr.syncedAt} asOf={asOf} />
                </>
              )}
            </dd>
          </>
        )}
        {adr.reservation !== null && (
          <>
            <dt>Reserved by</dt>
            <dd>
              <AttributionText value={adr.reservation.reservedBy} />,{" "}
              <time dateTime={adr.reservation.reservedAt.toISOString()}>
                {formatUtc(adr.reservation.reservedAt)}
              </time>
              , on branch <Optional value={adr.reservation.gitBranch} fallback="unknown" />
            </dd>
          </>
        )}
      </dl>

      <section className="project-card" aria-labelledby="adr-chain">
        <h2 id="adr-chain">Supersedes and superseded by</h2>
        <AdrChain projectId={project.id} detail={detail} />
      </section>

      <section className="project-card" aria-labelledby="adr-text">
        <h2 id="adr-text">Text</h2>
        {adr.body !== null ? (
          <SafeMarkdown source={adr.body} />
        ) : (
          <p className="muted">
            {adr.state === "reserved"
              ? "No file with this number has been synced."
              : "The text of this copy cannot be shown."}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The ADR's supersedes links in sentences: the ones it names directly, then
 * the rest of the chain, as far as the loader followed it. A number with no
 * synced file is marked "not found" rather than linked.
 */
function AdrChain({ projectId, detail }: { projectId: string; detail: AdrDetail }) {
  const back = detail.supersedes;
  const forward = detail.supersededBy;
  if (back.length === 0 && forward.length === 0) {
    return <p>This ADR supersedes no other ADR, and no ADR supersedes it.</p>;
  }
  const direct = (links: AdrLink[]) => links.filter((link) => link.depth === 1);
  const further = (links: AdrLink[]) => links.filter((link) => link.depth > 1);
  return (
    <>
      {direct(back).length > 0 && (
        <p>
          Supersedes <AdrLinks projectId={projectId} links={direct(back)} />.
        </p>
      )}
      {further(back).length > 0 && (
        <p>
          Earlier in the chain: <AdrLinks projectId={projectId} links={further(back)} />.
        </p>
      )}
      {direct(forward).length > 0 && (
        <p>
          Superseded by <AdrLinks projectId={projectId} links={direct(forward)} />.
        </p>
      )}
      {further(forward).length > 0 && (
        <p>
          Later in the chain: <AdrLinks projectId={projectId} links={further(forward)} />.
        </p>
      )}
      {detail.chainTruncated && (
        <p className="muted">
          The chain continues past the ADRs shown. Open the last one to follow it.
        </p>
      )}
    </>
  );
}

function AdrLinks({ projectId, links }: { projectId: string; links: AdrLink[] }) {
  return links.map((link, index) => (
    <span key={link.number}>
      {index > 0 && ", "}
      {link.found ? (
        <>
          <Link href={adrPath(projectId, link.number)}>{formatAdrNumber(link.number)}</Link>
          {link.title !== null && ` (${link.title})`}
        </>
      ) : (
        `${formatAdrNumber(link.number)} (not found)`
      )}
    </span>
  ));
}
