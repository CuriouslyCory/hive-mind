"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { cx } from "./cx";

export type TabItem = {
  value: string;
  label: ReactNode;
  /** A count shown in a honey chip after the label. */
  count?: number;
  /**
   * The content of this tab's panel. When any item has one, Tabs renders a
   * `tabpanel` per item and ties each tab to it with `aria-controls`.
   */
  panel?: ReactNode;
};

export type TabsProps = {
  items: readonly TabItem[];
  /** Initially selected value when uncontrolled. Defaults to the first item. */
  defaultValue?: string;
  /** Controlled selected value. */
  value?: string;
  /** Called with the newly selected value. */
  onChange?: (value: string) => void;
  /** Applied to the tablist. */
  className?: string;
  /** Names the tablist. Pass this or `aria-labelledby`. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

/**
 * Peer views. Follows the WAI-ARIA tabs pattern: one tab stop (the selected
 * tab), arrow keys move between tabs and select them, Home and End jump to
 * the ends.
 */
export function Tabs({
  items,
  defaultValue,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: TabsProps) {
  const baseId = useId();
  const [ownValue, setOwnValue] = useState(defaultValue ?? items[0]?.value);
  const selected = value ?? ownValue;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hasPanels = items.some((item) => item.panel !== undefined);
  const selectedIndex = items.findIndex((item) => item.value === selected);
  const focusableIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const tabId = (index: number) => `${baseId}-tab-${index}`;
  const panelId = (index: number) => `${baseId}-panel-${index}`;

  function select(next: string) {
    if (value === undefined) setOwnValue(next);
    if (next !== selected) onChange?.(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = items.length - 1;
    let target: number;
    switch (event.key) {
      case "ArrowRight":
        target = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        target = index === 0 ? last : index - 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    const item = items[target];
    if (!item) return;
    select(item.value);
    tabRefs.current[target]?.focus();
  }

  const tablist = (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={cx("hm-tabs", className)}
    >
      {items.map((item, index) => {
        const isSelected = item.value === selected;
        return (
          <button
            key={item.value}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={tabId(index)}
            aria-selected={isSelected}
            aria-controls={hasPanels ? panelId(index) : undefined}
            tabIndex={index === focusableIndex ? 0 : -1}
            className="hm-tab"
            onClick={() => select(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.label}
            {item.count === undefined ? null : <span className="hm-tab-count">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );

  if (!hasPanels) return tablist;

  return (
    <>
      {tablist}
      {items.map((item, index) => (
        <div
          key={item.value}
          role="tabpanel"
          id={panelId(index)}
          aria-labelledby={tabId(index)}
          hidden={item.value !== selected}
          className="hm-tabpanel"
        >
          {item.panel}
        </div>
      ))}
    </>
  );
}
