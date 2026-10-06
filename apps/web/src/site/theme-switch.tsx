"use client";

import { useEffect, useState } from "react";
import { Switch } from "../design-system/switch";

/**
 * The dark theme switch, for a `SiteHeader` or the app shell's top bar. The
 * root layout renders `data-theme="system"` on <html>, the design-system
 * root (ADR-0019), so the first paint follows the operating system in CSS
 * alone; this switch only reflects the effective theme once mounted and,
 * when toggled, forces `light` or `dark` on <html>. The choice holds for
 * every page until a full reload; it is not kept across visits.
 */
export function ThemeSwitch() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    // Read <html> rather than assume "system": a switch on another page (or
    // this one, hidden in a React Activity and shown again) may have forced
    // a theme, and it can change while this one is mounted.
    const sync = () => {
      const theme = root.dataset.theme;
      setDark(theme === "dark" || (theme !== "light" && query.matches));
    };
    sync();
    query.addEventListener("change", sync);
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      query.removeEventListener("change", sync);
      observer.disconnect();
    };
  }, []);

  return (
    <span className="site-theme">
      <Switch
        aria-label="Dark theme"
        checked={dark}
        onChange={(next) => {
          document.documentElement.dataset.theme = next ? "dark" : "light";
          setDark(next);
        }}
      />
    </span>
  );
}
