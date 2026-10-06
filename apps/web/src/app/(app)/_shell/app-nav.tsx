"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type AppNavItem = { href: Route; label: string };

/**
 * How a navigation item relates to `pathname`: `page` on the item's own page,
 * `true` inside its section (the Dashboard's section is the Project pages),
 * otherwise nothing.
 */
export function navItemCurrent(href: string, pathname: string): "page" | "true" | undefined {
  if (pathname === href) return "page";
  const section = href === "/" ? "/projects/" : `${href}/`;
  return pathname.startsWith(section) ? "true" : undefined;
}

/**
 * The app shell's primary navigation, marking the current page or section.
 * The pathname is request data on a dynamic route, so the shell renders this
 * inside Suspense, with `AppNavView` and no pathname as the fallback.
 */
export function AppNav({ items }: { items: readonly AppNavItem[] }) {
  return <AppNavView items={items} pathname={usePathname()} />;
}

/** The navigation's links; with no `pathname`, none is marked current. */
export function AppNavView({
  items,
  pathname,
}: {
  items: readonly AppNavItem[];
  pathname: string | null;
}) {
  return (
    <nav className="app-nav" aria-label="Primary">
      {items.map((item) => (
        <Link
          key={item.href}
          className="app-nav-link"
          href={item.href}
          aria-current={pathname === null ? undefined : navItemCurrent(item.href, pathname)}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
