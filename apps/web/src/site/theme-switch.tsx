"use client";

import { useEffect, useRef, useState } from "react";
import { Switch } from "../design-system/switch";

/**
 * The page's design-system root, which carries `data-theme`: `SitePage` on
 * the public pages, the home page's root on `/` signed in.
 */
const ROOT_SELECTOR = ".hm-root";

/**
 * The dark theme switch, for a `SiteHeader` or any page header inside a
 * design-system root. The root renders `data-theme="system"`, so the first
 * paint follows the operating system in CSS alone; this switch only reflects the effective theme once mounted and,
 * when toggled, forces `light` or `dark` on the page root. The choice is not
 * kept across visits.
 */
export function ThemeSwitch() {
  const ref = useRef<HTMLSpanElement>(null);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>(ROOT_SELECTOR);
    if (!root) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    // Read the root rather than assume "system": the page can be hidden and
    // shown again (Cache Components keeps it in a React Activity) after a
    // toggle, and this effect then runs again on the same element.
    const sync = () => {
      const theme = root.dataset.theme;
      setDark(theme === "dark" || (theme !== "light" && query.matches));
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <span ref={ref} className="site-theme">
      <Switch
        aria-label="Dark theme"
        checked={dark}
        onChange={(next) => {
          const root = ref.current?.closest<HTMLElement>(ROOT_SELECTOR);
          if (root) root.dataset.theme = next ? "dark" : "light";
          setDark(next);
        }}
      />
    </span>
  );
}
