import { getTrackerSnapshot } from "@hivemind/tracker";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getDb } from "../../../server/db";
import { requireTrackerAccess } from "../../../server/tracker-access";
import { trackerTab } from "./_components/tabs";
import { TrackerWorkspace } from "./_components/tracker-workspace";
import "./tracker.css";

export const metadata: Metadata = {
  title: "Development tracker · hive-mind",
  robots: { index: false, follow: false },
};

// `/tracker`: the dev tracker (docs/tracker.md), a 404 outside local
// `next dev`. NODE_ENV is inlined at build time, so a production build
// prerenders the 404 with its status; checking it inside Suspense would stream
// a 200 first. The heading is the static shell; the host and login session
// checks, `?tab=` and the snapshot are request-time reads, inside Suspense.
export default function TrackerPage({ searchParams }: PageProps<"/tracker">) {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <main className="tracker">
      <h1>Development tracker</h1>
      <Suspense fallback={<p role="status">Loading the tracker…</p>}>
        <Tracker searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Tracker({ searchParams }: { searchParams: PageProps<"/tracker">["searchParams"] }) {
  const tab = trackerTab((await searchParams).tab);
  await requireTrackerAccess(`/tracker?tab=${tab}`);
  const snapshot = await getTrackerSnapshot(getDb());
  return <TrackerWorkspace snapshot={snapshot} initialTab={tab} />;
}
