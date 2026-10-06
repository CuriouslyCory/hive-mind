import "../../design-system/styles.css";
// After the design system, so the page's rules come after its rules.
import "./_home/home.css";
import { Suspense } from "react";
import { designSystemFontClassName } from "../../design-system/fonts";
import { Logo } from "../../design-system/logo";
import { loadHomeDashboard } from "../../server/dashboard/home";
import { homeHref, parseHomeParams } from "../../server/dashboard/home-params";
import { getDb } from "../../server/db";
import { requireFreshLoginSession } from "../../server/login-session";
import { HomeView } from "./_home/home-view";

// `/` signed in: the Dashboard across every Project the User can read, or
// one of them (docs/dashboard.md). The design-system root is the static
// shell; the login session and the dashboard are read at request time,
// inside Suspense (ADR-0003). A signed-out `/` is the landing page
// (ADR-0016).
//
// The root covers the viewport whatever styles <body> has (the (app)
// layout's dashboard.css styles body for the Project pages), and every rule
// of home.css is scoped under .hm-home.
export default function HomePage({ searchParams }: PageProps<"/">) {
  return (
    <div className={`hm-root hm-home ${designSystemFontClassName}`} data-theme="system">
      <Suspense fallback={<HomeLoading />}>
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

function HomeLoading() {
  return (
    <>
      <header className="home-topbar">
        <div className="home-wrap home-topbar-inner">
          <Logo height={24} loading="eager" />
        </div>
      </header>
      <div className="home-body">
        <p role="status" className="home-loading">
          Loading your dashboard…
        </p>
      </div>
    </>
  );
}
