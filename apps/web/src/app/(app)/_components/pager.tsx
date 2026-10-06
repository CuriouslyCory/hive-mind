import type { Route } from "next";
import Link from "next/link";
import { buttonClassName } from "../../../design-system/button";
import { type CursorParams, withParams } from "./paths";

interface PagerProps {
  /** The page's path without a query. */
  path: Route;
  /** Every cursor param the page currently has, so other lists keep their place. */
  current: CursorParams;
  /** This list's cursor param. */
  param: string;
  nextCursor: string | null;
  /** What the list holds, for the links' accessible names ("Tasks"). */
  label: string;
}

const PAGER_LINK = buttonClassName({ size: "sm" });

/**
 * Keyset paging links for one list of a page: back to its first page when
 * the list is past it, and on to the next page when there is one.
 */
export function Pager({ path, current, param, nextCursor, label }: PagerProps) {
  const paged = current[param] !== undefined;
  if (!paged && nextCursor === null) return null;
  return (
    <nav className="pager" aria-label={`${label} pages`}>
      {paged && (
        <Link className={PAGER_LINK} href={withParams(path, { ...current, [param]: undefined })}>
          First page of {label}
        </Link>
      )}
      {nextCursor !== null && (
        <Link className={PAGER_LINK} href={withParams(path, { ...current, [param]: nextCursor })}>
          Next page of {label}
        </Link>
      )}
    </nav>
  );
}
