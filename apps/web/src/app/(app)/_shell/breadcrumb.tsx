import type { Route } from "next";
import Link from "next/link";
import { Icon } from "../../../design-system/icon";

/** One step of a breadcrumb: a link, or the current page when `href` is absent. */
export type Crumb = { label: string; href?: Route };

/**
 * Where a signed-in page sits, at the top of its content: links to the pages
 * above it, then the current page (the last item, without `href`).
 */
export function Breadcrumb({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="app-breadcrumb">
      <ol>
        {items.map((item, index) => (
          <li key={item.href ?? item.label}>
            {index > 0 ? <Icon name="chevron-right" size={16} className="app-crumb-sep" /> : null}
            {item.href === undefined ? (
              <span aria-current="page" className="app-crumb-current">
                {item.label}
              </span>
            ) : (
              <Link className="app-crumb-link" href={item.href}>
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
