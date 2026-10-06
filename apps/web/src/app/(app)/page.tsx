import "./_home/home.css";
import { Suspense } from "react";
import { loadHomeDashboard } from "../../server/dashboard/home";
import { homeHref, parseHomeParams } from "../../server/dashboard/home-params";
import { getDb } from "../../server/db";
import { requireFreshLoginSession } from "../../server/login-session";
import { HomeView } from "./_home/home-view";

// `/` signed in: the Dashboard across every Project the User can read, or
// one of them (docs/dashboard.md), inside the app shell. The page's root is
// the static shell; the login session and the dashboard are read at request
// time, inside Suspense (ADR-0003). A signed-out `/` is the landing page
// (ADR-0016). Every rule of home.css is scoped under .hm-home.
export default function HomePage({ searchParams }: PageProps<"/">) {
  return (
    <div className="hm-home">
      <Suspense
        fallback={
          <p role="status" className="app-loading">
            Loading your dashboard…
          </p>
        }
      >
        <Home searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Home({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const params = parseHomeParams(await searchParams);
  const { user } = await requireFreshLoginSession(homeHref(params));
  const dashboard = await loadHomeDashboard(getDb(), { id: user.id, name: user.name }, params);
  return <HomeView dashboard={dashboard} />;
}
