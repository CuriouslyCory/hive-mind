---
status: accepted
date: 2026-10-05
---

# HiveMind design system and public landing page

## Context

Until now hive-mind had no visual identity: the dashboard uses a minimal stylesheet (`apps/web/src/app/(app)/dashboard.css`), and a signed-out visit to `/` redirected to `/sign-in`, so nothing told a visitor what the product is. [#1](https://github.com/CuriouslyCory/hive-mind/issues/1) is the stack issue; no milestone issue covers this work, which landed in [#24](https://github.com/CuriouslyCory/hive-mind/pull/24).

The identity comes from the HiveMind design system, a file exported from Claude Design. It contains a brand book (colour, type, spacing, shape, motion, copy and logo rules), a token file with light and dark values, a reference component bundle (Button, Badge, Card, Input, Switch, Tabs, Alert, Cell) with its stylesheet, the logo files (mark, wordmark, lockup) and an icon set of 16 glyphs. A landing page design came with it. The export is not in the repo, so this ADR records what was taken from it.

The landing page has to live at `/`, which is already the signed-in Projects list, without making either page slower or leaking the design system's styles into the dashboard.

## Decision

### The design system

- It lives in `apps/web/src/design-system`, documented in `docs/design-system.md`. `tokens.css` holds every token and is the source of truth for their values in the repo; nothing is generated from the export, and no stylesheet outside the design system and the pages that opt into it declares or uses those names. `components.css` holds the `hm-` component classes, and the React components are typed ports of the bundle's props, markup and classes. The logo files are downscaled copies in `apps/web/public/brand`, and the app icons come from the mark.
- Deviations from the export, all listed in `docs/design-system.md` → Deviations:
  - **Fonts.** Sora, Nunito Sans and JetBrains Mono are vendored as woff2 (Google Fonts' current variable files, latin subset, with their OFL licences) in `apps/web/src/design-system/fonts` and loaded with `next/font/local`, not a Google Fonts `@import` or `next/font/google`. `next/font/google` fetches at build time with an old user agent, and Google answers it with a Nunito Sans file that renders a gap after "t" ("agent s", "Git Hub").
  - **Themes.** The bundle's `[data-theme="dark"] …` component rules became component tokens set per theme in `tokens.css`, and `tokens.css` adds a `system` theme that follows `prefers-color-scheme`. Both work in CSS alone, before hydration. The hive card re-points the colour tokens so the controls inside it keep their contrast on navy in both themes.
  - **Components.** `Input` uses `useId` instead of a module counter, so ids match between server and client. `Button` gained `href` (a Next `Link` for app routes), `Card` gained `headingLevel`, `Tabs` gained panels, roving focus, arrow keys and a wrapping tablist, `Alert` gained `live` (`role="note"` when false) and `LogoLockup` gained `decorative`. `components.css` adds the type scale classes, `hm-hex`, `hm-code`, the logo tile and reduced-motion rules.
- The landing page and the brand assets call the product **HiveMind**, the wordmark's spelling; other prose keeps "hive-mind" and identifiers keep `hivemind` (`CONTEXT.md` → Naming rules). The root layout's title and the dashboard are unchanged.
- Only the landing page uses it. The dashboard and the dev tracker keep their own stylesheets, and the sign-in and device pages stay unstyled; migrating them is separate work. (Sign-in has since moved onto it, inside the site frame described in `docs/design-system.md` → Site pages, and so has the signed-in home page, [ADR-0018](0018-home-dashboard.md).)

### Routing

- `apps/web/src/proxy.ts` rewrites a signed-out request for `/` to `/welcome`, so the URL stays `/`. `/welcome` is public and excluded from the proxy's matcher. The page reads no request data, so it prerenders, and a signed-in `/` is still the Projects list.
- The exception is a `/` whose `cursor` the Projects list would use (one value, not empty, at most `MAX_CURSOR_LENGTH`, as `cursorParam` in `apps/web/src/server/dashboard/queries.ts` decides). That URL names a page of a signed-in list, so a signed-out visitor is redirected to `/sign-in` and returns to it, like any other signed-in page. A cursor the list would ignore, or any other query such as tracking parameters, still shows the landing page.
- (Since [ADR-0018](0018-home-dashboard.md), a signed-in `/` is the home dashboard rather than the Projects list, and the exception is a `/` that names a home-page state `parseHomeParams` in `apps/web/src/server/dashboard/home-params.ts` would use: a Project, a filter, a list view, a tab or a range. The proxy imports that function, so there is no mirrored copy. `cursor` no longer has a meaning at `/`.)
- The landing page's canonical URL and `og:url` are `/`, so `/welcome` is not indexed as a second copy.

## Consequences

- The landing page is static and costs signed-in Users nothing: their `/` takes the same path as before.
- The proxy decides which `/` queries are deep links with `parseHomeParams`, which imports nothing from the database, so the proxy and the home page cannot disagree. `apps/web/test/proxy.test.ts` checks them against each other. (This replaced a mirrored copy of the Projects list's `cursorParam`, which the proxy could not import because `queries.ts` pulls in the database.)
- The proxy only checks that a login session cookie exists. A visitor with a stale cookie gets the home page's own check and is sent to `/sign-in`, not the landing page.
- Next keeps global stylesheets loaded after client navigation, and Cache Components keeps a visited page mounted but hidden, so neither the design-system nor the landing styles may reach other pages. Every selector in `components.css` is built on an `hm-`-prefixed class (element names appear only with one, as in `a.hm-btn` or `.hm-alert svg`), and `landing.css` scopes every rule under `.hm-landing`. Beyond declaring the tokens on `:root`, nothing in them styles `html` or `body`, and nothing uses `:root:has(.hm-root)`: a hidden landing page would still match it and restyle the dashboard.
- Updating the fonts means downloading new files and checking them visually; there is no build-time fetch.

## Alternatives considered

- **Rendering the landing page inside the `/` page when signed out:** the page would read the login session, so neither variant could prerender, and the landing page would load `dashboard.css`.
- **Redirecting signed-out `/` to `/welcome`:** an extra round trip, and the address people share would not be the product's root.
- **Keeping `next/font/google`:** the gap after "t" appears in every heading and paragraph in Nunito Sans.
