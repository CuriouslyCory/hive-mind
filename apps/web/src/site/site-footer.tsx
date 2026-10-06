import { Logo } from "../design-system/logo";
import { CLI_DOCS_URL, DASHBOARD_DOCS_URL, DECISIONS_URL, REPOSITORY_URL } from "./links";

const FOOTER_LINKS = [
  { href: REPOSITORY_URL, label: "GitHub" },
  { href: CLI_DOCS_URL, label: "CLI docs" },
  { href: DASHBOARD_DOCS_URL, label: "Dashboard docs" },
  { href: DECISIONS_URL, label: "Decisions" },
] as const;

/** The footer of every public page. `SitePage` renders it. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-wrap site-footer-inner">
        <Logo mark={false} height={22} />
        <nav className="site-foot-links" aria-label="Footer">
          {FOOTER_LINKS.map((link) => (
            <a key={link.href} className="site-foot-link" href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <span className="site-footer-note">Many minds, one hive. © 2026 CuriouslyCory</span>
      </div>
    </footer>
  );
}
