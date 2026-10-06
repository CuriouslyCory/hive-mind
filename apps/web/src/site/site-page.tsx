import "../design-system/styles.css";
import "./site.css";
import type { ReactNode } from "react";
import { cx } from "../design-system/cx";
import { designSystemFontClassName } from "../design-system/fonts";
import { SiteFooter } from "./site-footer";

export type SitePageProps = {
  /**
   * The id of the page's `<main>`, which the skip link targets. It must be
   * unique across pages: Cache Components keeps a visited page mounted but
   * hidden, so two pages' `<main>` elements can be in the document at once,
   * and a shared id would send the skip link to the hidden one.
   */
  mainId: string;
  /** The top bar, usually a `SiteHeader`. */
  header: ReactNode;
  /** The page's scope class (such as `hm-landing`), on the root element. */
  className?: string;
  mainClassName?: string;
  children: ReactNode;
};

/**
 * The frame of a public page on the design system (docs/design-system.md →
 * Site pages): the design-system root with its fonts and the system theme,
 * a skip link, the header, `<main>` and the site footer. The root covers the
 * viewport whatever styles `<body>` has, and its theme is the one the
 * header's `ThemeSwitch` changes.
 */
export function SitePage({ mainId, header, className, mainClassName, children }: SitePageProps) {
  return (
    <div
      className={cx("hm-root hm-site", designSystemFontClassName, className)}
      data-theme="system"
    >
      <a className="site-skip" href={`#${mainId}`}>
        Skip to main content
      </a>
      {header}
      <main id={mainId} tabIndex={-1} className={cx("site-main", mainClassName)}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
