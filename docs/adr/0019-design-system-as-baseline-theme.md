---
status: accepted
date: 2026-10-06
---

# The design system as every page's baseline theme, with an app shell

## Context

ADR-0016 made the HiveMind design system opt-in per page, so its styles could not leak into the dashboard's own stylesheet. Since then the landing page, sign-in and the signed-in home page ([ADR-0018](0018-home-dashboard.md)) each opted in, and each one repeated the same setup: it imported the styles, put the design-system root, the fonts and `data-theme="system"` on its own element, positioned that element over the viewport to escape `dashboard.css`'s `body` rules, and redrew its own skip link and top bar. The Project pages, the dev tracker and the CLI's device approval page stayed on `dashboard.css`, `tracker.css` or browser defaults. The owner asked for the design system to be the theme of the whole site, applied once rather than per page, and for a standard layout for the signed-in app. [#1](https://github.com/CuriouslyCory/hive-mind/issues/1) is the stack issue; no milestone issue covers this work.

## Decision

- **The root layout applies it.** `apps/web/src/app/layout.tsx` imports `design-system/styles.css` and renders `<html class="hm-root …fonts" data-theme="system">`. The fonts load on every page, and the theme follows the operating system on every page until a `ThemeSwitch` forces one on `<html>`. Pages no longer import the styles or carry the root, and `designSystemFontClassName` is no longer exported from the design system's `index.ts`.
- **An element baseline.** `design-system/base.css` styles elements for every page: body, headings, links, code, tables, focus, selection and native form controls (a control without an `hm-` class looks like the outline Button or the Input). All of it is in the `hm-base` cascade layer, so any unlayered rule (a component, a frame, a page) overrides it without raising specificity.
- **An app shell.** The `(app)` layout renders `AppShell` (`apps/web/src/app/(app)/_shell`): a skip link, a top bar (logo, Primary navigation, theme switch, the signed-in User and Sign out) and the one `<main>`. Pages render a `Breadcrumb` and their heading inside it. The viewer and the navigation's current item are request data, each inside its own Suspense boundary, so the shell stays static and every page still checks the login session itself (ADR-0003).
- **Every page on it.** `dashboard.css` is deleted. The Project pages use Badges for status, Alerts for warnings, Button-styled pagers and a scoped `project.css`; the tracker uses the Tabs and Button classes with a token-based `tracker.css`; the device page uses the site frame with Input, Button and Alert.
- **Scoping stays.** Every stylesheet other than the design system's is scoped under its frame's or page's root class, and nothing but `base.css` styles elements unscoped. `apps/web/test/page-styles.test.ts` enforces both and lists every such stylesheet.

This replaces ADR-0016's rule that only pages that opt in load the design system and that nothing in it styles `html` or `body`. The rest of ADR-0016 stands, so it is amended (with notes pointing here) rather than superseded.

## Consequences

- A new page is themed with no setup. Its stylesheet, if any, lays out its own content under its own scope class.
- The forced theme is the document's, so it holds across client navigation between any pages (it was per page) and is still lost on a full reload. Keeping it across visits still needs a cookie read before the first paint.
- All three font files are preloaded on every page, including `/device` and the tracker.
- The `(app)` layout now reads the login session for the viewer on every request, the same per-request cached read the page makes, so it adds no database lookup.
- The shell adds tab stops (logo, navigation, theme switch, Sign out) before each page's content; the skip link moves past them.
- A cascade layer is a newer CSS feature; browsers without `@layer` support (before 2022) drop `base.css`'s rules and fall back to their defaults, while the components still apply.

## Alternatives considered

- **Keep opt-in, with a shared wrapper component:** every page would still have to remember the wrapper, the wrapper would still need to escape the `body` rules of pages that do not use it, and the next unthemed page would be the default.
- **Baseline rules at element specificity, without a layer:** a page's zero-specificity resets (`:where(.hm-landing) :where(h1, p)`) and some component rules would lose to `h1` or `button`, so each would need its specificity raised.
- **Breadcrumb in the shell's top bar:** the layout does not re-render with its page and cannot read the page's data, so the trail would need a client-side portal from the page; a page hidden by Cache Components would leave its trail behind.
