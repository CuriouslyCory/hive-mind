import { ADR_STATUSES, type AdrStatus, formatAdrNumber } from "@hivemind/contract";
import type { Route } from "next";
import Link from "next/link";
import { ProjectLivePage } from "../../../components/dashboard/project-live-updates";
import type { AdrList, AdrSummary } from "../../../server/dashboard/queries";
import { AdrSyncBanner, adrStatusText } from "./adr-format";
import { AttributionText, Optional, Timestamp } from "./format";
import { Pager } from "./pager";
import { adrPath, type CursorParams, withParams } from "./paths";
import { ProjectHeading } from "./project-heading";

/** The ADR list's content, from one snapshot. */
export function AdrListView({
  list,
  path,
  cursors,
}: {
  list: AdrList;
  path: Route;
  cursors: CursorParams;
}) {
  const { project, asOf } = list;
  // Paging keeps the filter; changing the filter starts every list over.
  const current = { status: list.status ?? undefined, ...cursors };
  return (
    <div data-testid="adr-list-page">
      <ProjectLivePage
        projectId={project.id}
        cursor={list.feedCursor}
        asOf={asOf}
        scope={{ kind: "adrs" }}
      />
      <ProjectHeading project={project} asOf={asOf} linked />
      <h1>ADRs</h1>
      <AdrSyncBanner lastSync={list.lastSync} asOf={asOf} />

      <section aria-labelledby="adrs-published" data-testid="adr-list">
        <h2 id="adrs-published">
          {list.status === null ? "All ADRs" : `${adrStatusText(list.status)} ADRs`}
        </h2>
        <StatusFilter path={path} status={list.status} />
        {list.adrs.items.length === 0 ? (
          <p>{list.status === null ? "No ADRs yet." : "No ADRs with this status."}</p>
        ) : (
          <AdrTable projectId={project.id} adrs={list.adrs.items} caption="ADRs, newest first" />
        )}
        <Pager
          path={path}
          current={current}
          param="adrs"
          nextCursor={list.adrs.nextCursor}
          label="ADRs"
        />
      </section>

      <section aria-labelledby="adrs-reserved" data-testid="adr-reservations">
        <h2 id="adrs-reserved">Reserved, not merged yet</h2>
        <p className="muted">
          Numbers handed out by <code>hivemind adr new</code> whose file is not in a synced commit
          yet.
        </p>
        {list.reservations.items.length === 0 ? (
          <p>No reserved numbers are waiting.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Reserved ADR numbers, newest first</caption>
            <thead>
              <tr>
                <th scope="col">ADR</th>
                <th scope="col">Title</th>
                <th scope="col">Reserved by</th>
                <th scope="col">Branch</th>
                <th scope="col">Reserved</th>
              </tr>
            </thead>
            <tbody>
              {list.reservations.items.map((reservation) => (
                <tr
                  key={reservation.number}
                  data-testid="adr-reservation"
                  data-adr-number={reservation.number}
                >
                  <td>
                    <Link href={adrPath(project.id, reservation.number)}>
                      {formatAdrNumber(reservation.number)}
                    </Link>
                  </td>
                  <td>{reservation.title}</td>
                  <td>
                    <AttributionText value={reservation.reservedBy} />
                  </td>
                  <td>
                    <Optional value={reservation.gitBranch} fallback="no branch" />
                  </td>
                  <td>
                    <Timestamp date={reservation.reservedAt} asOf={asOf} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager
          path={path}
          current={current}
          param="reserved"
          nextCursor={list.reservations.nextCursor}
          label="reserved numbers"
        />
      </section>

      {(list.removed.items.length > 0 || cursors.removed !== undefined) && (
        <section aria-labelledby="adrs-removed">
          <h2 id="adrs-removed">Removed from the repository</h2>
          <p className="muted">
            An earlier sync found these files and a later one did not. hive-mind keeps their last
            copy.
          </p>
          <AdrTable
            projectId={project.id}
            adrs={list.removed.items}
            caption="Removed ADRs, newest first"
          />
          <Pager
            path={path}
            current={current}
            param="removed"
            nextCursor={list.removed.nextCursor}
            label="removed ADRs"
          />
        </section>
      )}
    </div>
  );
}

/** Plain links to every status, and to no filter; the current choice is text. */
function StatusFilter({ path, status }: { path: Route; status: AdrStatus | null }) {
  const choices: { value: AdrStatus | null; label: string }[] = [
    { value: null, label: "All" },
    ...ADR_STATUSES.map((value) => ({ value, label: adrStatusText(value) })),
  ];
  return (
    <nav aria-label="Filter ADRs by status">
      <p>
        Status:{" "}
        {choices.map((choice, index) => (
          <span key={choice.label}>
            {index > 0 && " · "}
            {choice.value === status ? (
              <strong aria-current="page">{choice.label}</strong>
            ) : (
              <Link href={withParams(path, { status: choice.value ?? undefined })}>
                {choice.label}
              </Link>
            )}
          </span>
        ))}
      </p>
    </nav>
  );
}

function AdrTable({
  projectId,
  adrs,
  caption,
}: {
  projectId: string;
  adrs: AdrSummary[];
  caption: string;
}) {
  return (
    <table>
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">ADR</th>
          <th scope="col">Title</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {adrs.map((adr) => (
          <tr
            key={adr.number}
            data-testid="adr-row"
            data-adr-number={adr.number}
            data-adr-status={adr.status ?? undefined}
            data-adr-state={adr.state}
          >
            <td>
              <Link href={adrPath(projectId, adr.number)}>{formatAdrNumber(adr.number)}</Link>
            </td>
            <td>{adr.title}</td>
            <td>
              {adr.status === null ? (
                <span className="muted">none</span>
              ) : (
                adrStatusText(adr.status)
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
