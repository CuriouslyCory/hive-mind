import "../design-system/styles.css";
import type { Metadata } from "next";
import { cx } from "../design-system/cx";
import { designSystemFontClassName } from "../design-system/fonts";

export const metadata: Metadata = {
  title: "hive-mind",
  description:
    "A shared, live view of project state for coding agents working on the same codebase.",
};

// Every page is on the design system (ADR-0019): <html> is its root, with the
// fonts and the theme, and the root layout loads its styles, whose baseline
// element styles theme a page that has no stylesheet of its own. The theme
// follows the operating system until a ThemeSwitch forces light or dark on
// <html>. The layout reads no request data, so it stays in the static shell.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="system" className={cx("hm-root", designSystemFontClassName)}>
      <body>{children}</body>
    </html>
  );
}
