"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";
import { type TabItem, Tabs } from "../../../design-system/tabs";

export type NavTabItem = Omit<TabItem, "panel"> & {
  /** The page URL with this tab selected (`homeHref`). */
  href: string;
};

/**
 * Design-system `Tabs` whose selection lives in the URL: choosing a tab
 * replaces the URL and the server renders the page for it. The tab shows as
 * selected at once, while the new page loads.
 */
export function NavTabs({
  items,
  value,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  items: readonly NavTabItem[];
  value: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useOptimistic(value);

  return (
    <Tabs
      className={className}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
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
}
