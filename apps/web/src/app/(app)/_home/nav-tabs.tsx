"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useOptimistic, useTransition } from "react";
import { type TabItem, Tabs, tabElementId } from "../../../design-system/tabs";

export type NavTabItem = Omit<TabItem, "panel"> & {
  /** The page URL with this tab selected (`homeHref`). */
  href: string;
};

/**
 * Design-system `Tabs` whose selection lives in the URL: choosing a tab
 * replaces the URL and the server renders the page for it. The tab shows as
 * selected at once, while the new page loads.
 *
 * Every selection is a server read, so activation is manual: arrow keys move
 * focus, and Enter or Space selects. With `children`, the tabs control a
 * `tabpanel` holding them (`panelId`), labelled by the tab whose content it
 * shows; otherwise `controls` names the elements the selection changes.
 */
export function NavTabs({
  items,
  value,
  className,
  wrapperClassName,
  panelId,
  controls,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  items: readonly NavTabItem[];
  value: string;
  className?: string;
  /** Wraps the tablist alone, for spacing around it. */
  wrapperClassName?: string;
  panelId?: string;
  controls?: string;
  children?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useOptimistic(value);
  const id = useId();
  const shown = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );

  const tablist = (
    <Tabs
      id={id}
      className={className}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      activation="manual"
      controls={children === undefined ? controls : panelId}
      items={items.map(({ href: _href, ...item }) => item)}
      value={selected}
      onChange={(next) => {
        const item = items.find((candidate) => candidate.value === next);
        if (!item) return;
        startTransition(() => {
          setSelected(next);
          router.replace(item.href as Route, { scroll: false });
        });
      }}
    />
  );
  const tabs = wrapperClassName ? <div className={wrapperClassName}>{tablist}</div> : tablist;
  if (children === undefined) return tabs;
  return (
    <>
      {tabs}
      <div role="tabpanel" id={panelId} aria-labelledby={tabElementId(id, shown)}>
        {children}
      </div>
    </>
  );
}
