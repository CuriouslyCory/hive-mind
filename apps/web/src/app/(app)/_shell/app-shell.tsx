import "./app-shell.css";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { Logo } from "../../../design-system/logo";
import { ThemeSwitch } from "../../../site/theme-switch";
import { AppNav, type AppNavItem, AppNavView } from "./app-nav";

/** The id of the signed-in pages' one `<main>`, the skip link's target. */
export const APP_MAIN_ID = "app-main";

/**
 * The signed-in area's primary navigation. The dev tracker is a 404 outside
 * `next dev` (docs/tracker.md), so it is only listed there; NODE_ENV is
 * inlined at build time.
 */
export function appNavItems(nodeEnv: string | undefined = process.env.NODE_ENV): AppNavItem[] {
  const items: AppNavItem[] = [{ href: "/", label: "Dashboard" }];
  if (nodeEnv === "development") items.push({ href: "/tracker", label: "Tracker" });
  return items;
}

/**
 * The frame of every signed-in page (docs/design-system.md → App shell): a
 * skip link, the top bar (logo, primary navigation, theme switch and
 * `viewer`, the signed-in User with Sign out) and the one `<main>`, which
 * holds the page. Pages render their own breadcrumb and heading inside it.
 * It reads no request data itself; `viewer` is the part that does, so the
 * layout passes it inside a Suspense boundary.
 */
export function AppShell({
  viewer,
  navItems = appNavItems(),
  children,
}: {
  viewer?: ReactNode;
  navItems?: readonly AppNavItem[];
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <a className="app-skip" href={`#${APP_MAIN_ID}`}>
        Skip to main content
      </a>
      <header className="app-topbar">
        <div className="app-wrap app-topbar-inner">
          <Link className="app-home" href="/" aria-label="HiveMind home">
            <Logo height={24} loading="eager" />
          </Link>
          <Suspense fallback={<AppNavView items={navItems} pathname={null} />}>
            <AppNav items={navItems} />
          </Suspense>
          <div className="app-topbar-right">
            <ThemeSwitch />
            {viewer}
          </div>
        </div>
      </header>
      <main id={APP_MAIN_ID} tabIndex={-1} className="app-wrap app-main">
        {children}
      </main>
    </div>
  );
}
