# The design system

The HiveMind design system is the brand's colours, type, spacing and components, ported to typed React from a design-system file exported from Claude Design. Where it came from, what changed in the port and how the landing page is routed are in [ADR-0016](adr/0016-hivemind-design-system-and-landing-page.md); this page describes the code. Its identity comes from the logo: hexagonal cells, a navy ground and a honey-gold hub. Its three principles are **precise** (a 4px grid, tabular figures, real contrast), **warm** (navy and honey, never grey and blue) and **a little playful** (hexagons where others use circles, a honey glow where others use a shadow).

The public pages use it (the landing page and sign-in, both framed by `SitePage`; see Site pages), and so does the signed-in home page, `/` (`apps/web/src/app/(app)/page.tsx` and `_home/`, its rules scoped under `.hm-home`; [ADR-0018](adr/0018-home-dashboard.md)). The Project pages and the dev tracker keep their own stylesheets (`apps/web/src/app/(app)/dashboard.css`, `tracker/tracker.css`) and are not affected by it. `dashboard.css` styles `body`, tables and a few class names globally, so the home page uses none of those class names, positions its root over the viewport as `SitePage` does, and restyles tables and focus at a higher specificity.

## Where it lives

| Path | Contents |
|---|---|
| `apps/web/src/design-system/tokens.css` | Every token as a CSS custom property, with the light, dark and system themes (see Themes). |
| `apps/web/src/design-system/components.css` | The component classes and the type scale classes, all prefixed `hm-`. |
| `apps/web/src/design-system/styles.css` | Imports both, tokens first. |
| `apps/web/src/design-system/fonts.ts` | The three faces via `next/font/local`, and `designSystemFontClassName`. |
| `apps/web/src/design-system/fonts/` | The vendored font files (woff2) and each family's OFL licence. |
| `apps/web/src/design-system/index.ts` | The React components. There is no `@/` alias; import it by relative path. |
| `apps/web/public/brand/` | The logo files: mark, wordmark and the square lockup, downscaled from the originals. |
| `apps/web/src/app/icon.png`, `apple-icon.png` | The favicon and touch icon, from the mark (app-router metadata files). |
| `apps/web/src/site/` | The frame of the public pages (see Site pages): `SitePage`, `SiteHeader`, `SiteFooter`, `ThemeSwitch`, the shared repository links and `site.css`. |
| `apps/web/test/design-system.test.ts` | The markup contracts (classes per variant, ARIA, link versus button), the keyboard and toggle rules, and the theme and hive card tokens with their contrast. |

## Using it on a page

```tsx
import "../../design-system/styles.css";
import { Button, designSystemFontClassName, Logo } from "../../design-system";

export default function Page() {
  return (
    <div className={`hm-root ${designSystemFontClassName}`} data-theme="system">
      <Logo loading="eager" />
      <Button variant="primary" href="/sign-in">Sign in with GitHub</Button>
    </div>
  );
}
```

- `designSystemFontClassName` loads Sora, Nunito Sans and JetBrains Mono, served from the app itself, for that page only and points `--font-display`, `--font-sans` and `--font-mono` at them. Without it the font tokens fall back to the system stacks in `tokens.css`. The fonts are never set on `<body>`.
- `hm-root` sets the base text (Nunito Sans 15/22 in `ink` on `surface`), `box-sizing` for everything inside, and `color-scheme` from the theme, so form controls and scrollbars inside the element match it. It does not reach the viewport: the page's own scrollbar and the canvas around the element keep the browser's default scheme. Do not fix that with a `:root:has(.hm-root)` rule; Cache Components keeps a visited page mounted but hidden, so the rule would also apply on the dashboard.
- A public page uses `SitePage` instead (next section), which does all of this for it.
- Importing `tokens.css` declares its custom properties on `:root`. No stylesheet in `apps/web` outside the design system and the pages that opt into it declares or uses these names, so loading it changes nothing outside elements that use the `hm-` classes or the tokens.

### Site pages

A public page renders `SitePage` from `apps/web/src/site` as its root. It imports the design system's styles, puts `hm-root`, `designSystemFontClassName` and `data-theme="system"` on its root element, and renders a skip link, the `header` it is given, `<main>` and the site footer (`SiteFooter`, the same on every page). The root covers the viewport whatever styles `<body>` has, so the page needs no rules on `html` or `body`.

```tsx
import { Button } from "../../design-system";
import { SiteHeader, SitePage, ThemeSwitch } from "../../site";
// After the site import, so the page's rules come after the design system's.
import "./my-page.css";

export default function Page() {
  return (
    <SitePage
      className="hm-my-page"
      mainId="my-page"
      header={
        <SiteHeader nav={[{ href: "#how", label: "How it works" }]}>
          <ThemeSwitch />
          <Button href="/sign-in">Sign in</Button>
        </SiteHeader>
      }
    >
      …
    </SitePage>
  );
}
```

- `mainId` is the id of `<main>` and the skip link's target. Give each page its own: Cache Components keeps a visited page mounted but hidden, so two pages' `<main>` can be in the document at once, and with a shared id the skip link would go to the hidden one.
- `className` is the page's scope class. Scope every rule in the page's stylesheet under it (`.hm-landing`, `.hm-sign-in`), and the frame's under `.hm-site` (`site.css`): global stylesheets stay loaded after client navigation, so an unscoped rule reaches every page visited later.
- `SiteHeader` takes `homeHref` (`/` by default, or an anchor such as `#top` on the home page itself), `nav` (links for the Primary navigation, hidden at 1024px and below) and, as children, the controls at its right end. On screens 720px wide or less and on touch screens those controls are 44px tall. A label too long for a 320px screen can wrap its spare words in `site-hide-sm` and keep the whole label as the control's `aria-label`.
- `ThemeSwitch` sets `data-theme` on the nearest `hm-root` (the `SitePage` root, or the home page's), so the forced theme applies to the whole page. It is not kept across visits.
- `site-wrap` is the content column: at most 1200px wide with the page gutters, `space-12` and `space-4` at 720px and below.

### Themes

Every colour token has a light and a dark value. The theme is chosen in CSS alone, so the first paint is already right and nothing flashes before hydration:

| `data-theme` on an element | Theme for it and everything inside |
|---|---|
| `light` | Light. |
| `dark` | Dark. |
| `system` | The operating system's colour scheme (`prefers-color-scheme`), even inside a forced theme. |
| none | Inherited. At the top, `:root` follows the operating system unless `<html>` has `data-theme="light"`. |

A page that follows the system by default and offers a toggle renders `data-theme="system"` on its root, and the toggle (a `Switch`) replaces it with `light` or `dark`. To keep the reader's choice across visits it has to be read before the first paint, from a cookie on the server, for example; a choice applied only after hydration flashes the system theme first.

The rules that differ only in the dark theme (the primary button's hover, the text of success and danger badges) are component tokens (`--hm-btn-primary-hover`, `--hm-badge-success-ink`, `--hm-badge-danger-ink`) set per theme in `tokens.css`, so they follow every row of the table.

A `hive` Card is navy in both themes, so `tokens.css` re-points the colour tokens inside `.hm-card-hive` to the dark palette on the card's navy: `ink` becomes `on-surface-hive`, `hive` and `focus` become honey, and the lines, tints and signals take their dark values. Buttons, inputs, switches, tabs, badges and alerts inside it then meet 4.5:1 for text and 3:1 for borders and the focus ring in both themes; `apps/web/test/design-system.test.ts` computes each pair.

## Tokens

The values are in `tokens.css`; do not copy them elsewhere. Every colour, length and radius a component uses is one of these:

- **Surfaces:** `surface` grounds every screen, `surface-sunken` recesses (code, wells), `surface-raised` lifts (cards). `surface-hive` is the navy panel; put `on-surface-hive` on it.
- **Text:** `ink` for body copy, `ink-muted` for secondary text, `ink-faint` for placeholders and timestamps. Never set body copy in a colour.
- **Brand:** `hive` is the primary action colour (navy in light, honey in dark, so the primary button is the brightest thing on screen in both); put `on-hive` on it. `honey` is the accent for fills, highlights, the active node and selection. On white, honey is decorative only (1.61:1): honey that must be read uses `honey-ink`. `honey-deep` is only the hover of a honey fill and the end of the one permitted gradient, `honey` to `honey-deep` at 135deg.
- **Tints:** `honey-tint`, `hive-tint`, `success-tint`, `danger-tint` are grounds for callouts, selected rows and badges.
- **Signals:** `success`, `danger`, `info`, and `honey-ink` for warnings. Each always travels with a word or a glyph.
- **Lines:** `line` at `border-hair` for dividers; `line-strong` at `border-control` for borders that mean something (inputs, outline buttons, switches, a selected edge).
- **Focus:** a solid `border-focus` outline in `focus`, offset 2px, on every control in both themes. `shadow-glow` is the honey halo for an active node or selected tile and never replaces the ring.
- **Elevation:** `shadow-cell` for cards and tiles, `shadow-float` for hover and popovers.
- **Space:** `space-0_5` (2px) to `space-16` (64px) on a 4px grid. **Radius:** `radius-sm` (chips), `radius-md` (anything you click), `radius-lg` (anything that contains), `radius-xl` (dialogs, heroes), `radius-pill` (switches, pill badges, node dots).
- **Motion:** `duration-fast` (hover and press), `duration-base` (indicators, tooltips), `duration-slow` (panels and tile grids, with `ease-settle`).
- **Added in the port:** `logo-tile` (always white) and `ease-settle` (`cubic-bezier(0.2, 0.8, 0.2, 1)`) were not tokens in the original (ADR-0016).

### Type scale

The type styles are classes in `components.css`, one per style. They set the face, size, line height, weight and tracking, not the colour.

| Class | Face, weight, size/line | Use |
|---|---|---|
| `hm-text-display-xl` | Sora 800, 56/60, −0.02em | Marketing heroes. One per page. |
| `hm-text-display-lg` | Sora 800, 40/44, −0.015em | Page titles in the product. |
| `hm-text-heading-md` | Sora 700, 28/34, −0.01em | Section and dialog titles. |
| `hm-text-heading-sm` | Sora 700, 20/26 | Card titles, panel headers. |
| `hm-text-stat` | Sora 800, 32/36, −0.02em, tabular figures | The number in a Cell. |
| `hm-text-body-lg` | Nunito Sans 400, 17/26 | Long-form reading: docs, onboarding, empty states. |
| `hm-text-body` | Nunito Sans 400, 15/22 | Default UI text (also what `hm-root` sets). |
| `hm-text-body-strong` | Nunito Sans 700, 15/22 | Emphasis, table headers, list item titles. |
| `hm-text-small` | Nunito Sans 400, 13/18 | Metadata, helper text, Badge text, in `ink-muted` or `ink-faint`. |
| `hm-text-label` | Nunito Sans 700, 12/16, 0.06em, uppercase | Eyebrows and Cell captions. |
| `hm-text-code` | JetBrains Mono 400, 13/20 | Inline code, IDs, shortcuts, log lines. |
| `hm-text-code-sm` | JetBrains Mono 500, 11/16 | Dense telemetry and identifiers in tables. |

`hm-code` is the inline code chip: `code` on `surface-sunken` with `radius-sm`.

### Fonts

The app serves the three faces itself. `apps/web/src/design-system/fonts/` holds the latin subset of each family's variable woff2 from Google Fonts (Sora 600–800, Nunito Sans 400–700, JetBrains Mono 400–500), each with its OFL licence, and `fonts.ts` loads them with `next/font/local`. They are not fetched from Google at build time: `next/font/google` asks with an old user agent, and the Nunito Sans file Google returns to it renders a gap after "t" (ADR-0016). To update a face, download the file Google Fonts' css2 API serves to a current browser's user agent, and compare a rendering of "coding agents working on the same codebase GitHub" before and after.

## Rules

- **Type.** Sora (600–800) for display, Nunito Sans (400–700) for text, JetBrains Mono (400–500) for code. One `display-xl` heading per marketing page; sections in a heading size; cards and panels smaller. Emphasis is bold, never italic. Numbers in stats use tabular figures. Uppercase is only for eyebrows and captions, letter-spaced 0.06em. Code, IDs and commands are mono on `surface-sunken` with `radius-sm`. Reading width 60–75 characters, left-aligned; centred headings only in heroes.
- **Layout.** Controls are 36px tall (small 28px, large 44px); touch targets are at least 44px on mobile. Cards pad `space-4` on small screens and `space-5` on large, sit `space-6` apart in a grid; sections are `space-8` apart; page gutters `space-12`. Content is at most 1200px wide, on 12 columns with `space-6` gutters.
- **Hexagons.** The signature shape, drawn with the clip path in `HEXAGON_CLIP_PATH` (or the `hm-hex` class). Use it for avatars, step numbers, a Cell's corner and loading indicators, one or two per view. Never a honeycomb wallpaper behind content.
- **Logo.** Use the supplied files only: never redraw, recolour or crop the mark. All three sit on an opaque white ground, so on `surface-hive` or any dark surface they go inside the white logo tile (`radius-lg`), never straight on the dark colour; there is no dark variant yet. The wordmark sits beside the mark in the top bar at 28–36px tall. The mark alone is for the app icon, favicon and spaces narrower than 120px, at least 24px, with clear space of about 1/8 of its width on every side. The lockup is for marketing pages and sign-in, at least 160px wide.
- **Icons.** The 16 glyphs of the icon set (24px viewBox, 2px round strokes and joins, a hexagon where a circle would be the default, filled dots for emphasis) at 20px in controls and 16px in badges, `space-1` or `space-2` from their label. `spark` marks anything AI-generated; `node` means connected agents; `hex` and `hive` are the empty and filled cell. A new icon follows the same grammar.
- **Motion.** Hover and press change colour in `duration-fast`. A working agent *buzzes*: its dot pulses `shadow-glow` every 1.2s (`Badge buzzing`). Under `prefers-reduced-motion` the pulse stops and transform motion (button press, switch thumb) becomes an instant change. By default the pulse repeats for as long as the agent works, because there it is live status. On a page where it is decorative or illustrative, such as the landing page, the page must stop it within 5 seconds or offer a way to pause it (WCAG 2.2.2); the landing page sets `animation-iteration-count` under `.hm-landing`. Disabled controls drop to 50% opacity and keep their colour.
- **Copy.** The product is **HiveMind** on the public pages and in brand assets, and "hive-mind" in other prose (`CONTEXT.md` → Naming rules). Sentence case everywhere except eyebrows. Speak to one person ("you"); the hive is "it", never "we"; agents are "agents". Lead with the result, then the mechanism, with specific numbers. Whimsy lives in nouns and verbs (a workspace is a *hive*, a running agent is *buzzing*, an idle one *resting*). No exclamation marks in UI copy and at most one per marketing page; no emoji. Errors say what happened and the next step in two short sentences. Empty states invite: "No tasks yet. Drop one in and the hive will pick it up."

## Components

All are exported from `apps/web/src/design-system/index.ts`. `Tabs` and `Switch` are client components; the rest render in server components. Every component takes `className`. `Button`, `Badge`, `Card`, `Switch`, `Alert` and `Cell` pass other HTML attributes to their root element, and `Input` to its `<input>`. `Icon` and `Hexagon` take only `className` and `style` besides their own props, and `Logo`, `LogoLockup` and `Tabs` only `className`.

| Component | Props | Renders |
|---|---|---|
| `Button` | `variant`: `primary`, `honey`, `outline` (default), `quiet`, `danger`; `size`: `sm`, `lg` (omit for 36px); `icon`: an icon name; `href` | `<button type="button">` (pass `type="submit"` to submit). With `href`: an app route (`/…`) renders a Next `Link`, anything else (`https:`, `#id`) an `<a>`, with the same classes. `href` is a typed route; a link cannot be `disabled`. `buttonClassName()` returns the classes for other elements. |
| `Badge` | `tone`: `neutral` (default), `honey`, `success`, `danger`, `info`; `pill`; `buzzing`; `children` (the status word) | `<span class="hm-badge">` with a dot that repeats the word. |
| `Card` | `variant`: `default`, `hive`; `interactive`; `selected`; `eyebrow`; `title`; `headingLevel`: 2, 3 (default), 4; `footer` | `<div class="hm-card">`. A string child becomes the muted body paragraph. `interactive` only adds the pointer cursor and the hover shadow. |
| `Input` | `label`; `help`; `invalid`; `mono`; `id` (generated if absent); input attributes | A field with `<label for>`, the input (`type="text"` by default) and help text tied by `aria-describedby`. `invalid` sets `aria-invalid` and turns `help` into the error message. |
| `Switch` | `checked` or `defaultChecked`; `onChange(checked)`; `label` or `aria-label`; `disabled` | `<button role="switch" aria-checked>`. |
| `Tabs` | `items`: `{ value, label, count?, panel? }[]`; `defaultValue` (first item if absent) or `value`; `onChange(value)`; `aria-label` or `aria-labelledby`; `activation`: `automatic` (default) or `manual`; `id` (the base of the tabs' ids, `tabElementId(id, index)`); `controls` | A `tablist` of `tab` buttons with `aria-selected` and one tab stop, wrapping onto another row in a container too narrow for them. Arrow keys move and select, Home and End jump; with `activation="manual"` they only move focus, and Enter or Space selects. A count is read after its label as ", 3" (a visually hidden separator). When items have a `panel`, each gets a `tabpanel` tied by `aria-controls` and `aria-labelledby`, hidden unless selected. Without panels, `controls` names the element(s) rendered elsewhere that show the selected tab's content, and every tab gets it as `aria-controls`. Panels are not tab stops (Biome's `noNoninteractiveTabindex` forbids `tabIndex` on them), so a panel needs focusable content to be reachable by keyboard. |
| `Alert` | `tone`: `info` (default), `warning`, `success`, `danger`; `title`; `children`; `action`; `live` (default true) | `role="alert"` for `danger`, `role="status"` otherwise, with the tone's glyph. Both are live regions, even when the Alert is rendered with the page (see Component rules). With `live={false}`, `role="note"` for every tone. |
| `Cell` | `label`; `value`; `tone`: `neutral` (default), `honey`, `success`, `danger`; `delta` (number); `deltaUnit` (default `%`); `deltaLabel`; `selected` | The hexagon stat tile. A delta is signed and drawn up and green, down and red, or flat. |
| `Icon` | `name` (see `iconNames`); `size` (default 24); `title` | Inline SVG in `currentColor`; decorative (`aria-hidden`) unless `title` is given. Names: the 16 glyphs of the icon set plus `up`, `down`, `flat`. |
| `Hexagon` | `size` (default 44); `tone`: `tint` (default), `honey`, `hive`; `children` | A clipped hexagon, decorative when empty. `hexagonPoints(cx, cy, r)` returns SVG `points` for hexagons in illustrations. |
| `Logo` | `mark`, `wordmark` (both default true); `height` (wordmark height, default 28; the mark is 32/28 of it); `tile` (default true); `loading` | Mark and wordmark via `next/image` on the white logo tile, named "HiveMind" once. |
| `LogoLockup` | `size` (default 200); `loading`; `decorative` | The square lockup via `next/image`, named "HiveMind", or with empty alt text when `decorative`. `brandAssets` lists the files and their pixel sizes. |

The CSS also has the layout helpers `hm-row` and `hm-stack`.

### Component rules

- **Button.** Outline is the default. `primary` appears at most once per view, for the thing the page is for; `honey` is reserved for AI-flavoured actions ("Ask the hive"); `quiet` sits beside a primary as its cancel; `danger` always confirms before acting. Labels are verb first, two or three words, never "OK" or "Submit". An icon-only button needs `aria-label`.
- **Badge.** One or two words with the dot, never colour alone and no other icon. `honey` + `buzzing` is an agent working, `success` finished, `neutral` idle, `info` queued, `danger` failed. Square in tables and lists, `pill` in headers and beside titles. Not clickable: wrap it in a `quiet` Button if it must be.
- **Card.** At most one `hive` card per view (a tip, a promo, a hero summary). An `interactive` card has one obvious action, and that action is a real link or `Button` inside it: the card itself is a `<div>` with no role, tab stop or key handling, so a click handler on it is unreachable by keyboard and invisible to assistive technology. Cards sit `space-6` apart and never nest; no coloured left borders or decorative corner icons (the corner hexagon belongs to Cell).
- **Input.** Always pass `label`; a placeholder is an example, never the label. Help text says what is expected and, when invalid, how to fix it. Fields stretch to their container and stack `space-4` apart.
- **Switch.** A setting that takes effect at once (otherwise use a checkbox and a Save button). Label the setting, not the state: "Notify on failure", never "On".
- **Tabs.** Two to six peer views of one thing, labelled with one or two nouns; `count` is for live quantities. Tabs switch content in place and never navigate; use links for navigation. Tabs whose selection is a server read (the home page's `NavTabs`, whose selection is in the URL) use `activation="manual"`, so arrowing past a tab does not load it.
- **Alert.** By default an Alert is a live region (`role="status"`, or `role="alert"` for `danger`), even one rendered with the page that never changes: screen readers announce changes to its text, and some announce it when it appears, for example when the tab panel holding it is shown. For a notice that should not be announced, such as one in a static picture of the product, pass `live={false}`: it renders `role="note"`. `title` is the sentence that matters and the body one line of detail, two sentences in all. `action` is a small Button for the next step. It sits at the top of what it describes, full width; never stack more than two. Transient confirmations are toasts, not Alerts.
- **LogoLockup.** Pass `decorative` when the lockup adds nothing a screen reader needs, for example beside a heading at the end of a page that has named HiveMind already.
- **Cell.** `tone` colours the corner hexagon only: `honey` for the headline number (one per row), `success` and `danger` for health. Pass `deltaLabel` ("vs yesterday") so a delta has a reference. Cells are at least 184px wide, in rows `space-4` apart that wrap to two per row on small screens; `selected` marks the tile that drives the chart beneath.

## Deviations from the original

ADR-0016 records where the design system came from. The React components keep the original components' props, markup and classes, except:

- Fonts are vendored and loaded with `next/font/local`, not a Google Fonts `@import` or `next/font/google` (see Fonts), and apply only under `designSystemFontClassName`. The font tokens are declared outside the theme blocks so a nested `data-theme` cannot reset them.
- The props match the original typed API, widened where React allows it (titles and labels take any node, HTML attributes pass through, `icon` takes any icon name). `Button` gained `href`; `Card` gained `headingLevel`; `Tabs` gained panels, `aria-controls`, roving focus and arrow keys, and its tablist wraps. `Alert` gained `live`, and `LogoLockup` gained `decorative`. `Input` uses `useId` instead of a module counter, so ids match between server and client.
- The original `[data-theme="dark"] …` rules became component tokens (see Themes), `tokens.css` adds the `system` theme and the hive card's token overrides, and `components.css` the type scale classes.
- `Alert` wraps non-string children in a `<div>` rather than a `<p>`, so block content is valid HTML. The inline styles on Alert's action and Cell's delta label became the classes `hm-alert-action` and `hm-cell-delta-label`.
- Icons use the icon set's drawings rather than the component stylesheet's, so `info` and `alert` have the set's slightly larger hexagon frame and `spark` its second star.
- `components.css` adds `a.hm-btn` (no underline), `hm-hex`, `hm-code`, the logo tile and the reduced-motion rules for transforms.
- Not built yet: a hexagon loading indicator ("tracer") for loading states and loading buttons.
