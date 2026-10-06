import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "../design-system/logo";

export type SiteNavItem = { href: string; label: string };

export type SiteHeaderProps = {
  /**
   * Where the logo leads: `/`, or an anchor such as `#top` on a page that is
   * itself the home page. Defaults to `/`.
   */
  homeHref?: "/" | `#${string}`;
  /** The page's primary navigation, after the logo. Hidden at 1024px and below. */
  nav?: readonly SiteNavItem[];
  /** Controls at the right end, such as the theme switch and a Button. */
  children?: ReactNode;
};

/** The top bar of a public page: the logo, then `nav`, then `children` on the right. */
export function SiteHeader({ homeHref = "/", nav, children }: SiteHeaderProps) {
  const logo = <Logo loading="eager" />;
  return (
    <header className="site-topbar">
      <div className="site-wrap site-topbar-inner">
        {homeHref === "/" ? (
          <Link className="site-home" href="/" aria-label="HiveMind home">
            {logo}
          </Link>
        ) : (
          <a className="site-home" href={homeHref} aria-label="HiveMind home">
            {logo}
          </a>
        )}
        {nav?.length ? (
          <nav className="site-nav" aria-label="Primary">
            {nav.map((item) => (
              <a key={item.href} className="site-nav-link" href={item.href}>
                {item.label}
              </a>
            ))}
          </nav>
        ) : null}
        {children ? <div className="site-topbar-right">{children}</div> : null}
      </div>
    </header>
  );
}
