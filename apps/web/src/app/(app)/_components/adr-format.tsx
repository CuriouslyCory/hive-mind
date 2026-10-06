import type { AdrStatus } from "@hivemind/contract";
import type { AdrSyncView } from "../../../server/dashboard/queries";
import { AttributionText, Timestamp } from "./format";

// Display pieces of the ADR pages (issue #19). hive-mind shows a read-only
// copy of the repository's `docs/adr/` files as of one synced commit, so
// every ADR page says which commit and that the files are the source of
// truth. An ADR's state (reserved, published, removed) is never shown as a
// status.

const ADR_STATUS_TEXT: Record<AdrStatus, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  superseded: "Superseded",
  deprecated: "Deprecated",
};

/** An ADR file's status in words. */
export function adrStatusText(status: AdrStatus): string {
  return ADR_STATUS_TEXT[status];
}

/** What the copy is as of, or that nothing was synced yet. */
export function AdrSyncBanner({ lastSync, asOf }: { lastSync: AdrSyncView | null; asOf: Date }) {
  if (lastSync === null) {
    return (
      <p className="project-note" data-testid="adr-sync-banner">
        No ADRs synced yet. Run <code>hivemind adr sync</code> on the default branch.
      </p>
    );
  }
  return (
    <p className="project-note" data-testid="adr-sync-banner">
      Copied from <code>docs/adr/</code> at commit <code>{lastSync.commitSha.slice(0, 7)}</code>,
      synced <Timestamp date={lastSync.syncedAt} asOf={asOf} /> by{" "}
      <AttributionText value={lastSync.syncedBy} />. The files in the repository are the source of
      truth.
    </p>
  );
}
