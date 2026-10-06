import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// Component modules are imported directly: the index also re-exports
// fonts.ts, whose next/font calls only work inside a Next build.
import { Alert } from "../src/design-system/alert";
import { Badge } from "../src/design-system/badge";
import { type ButtonProps, Button as OverloadedButton } from "../src/design-system/button";
import { Card } from "../src/design-system/card";
import { Cell } from "../src/design-system/cell";
import { Hexagon, hexagonPoints, Icon, iconNames } from "../src/design-system/icon";
import { Input } from "../src/design-system/input";
import { Logo, LogoLockup } from "../src/design-system/logo";
import { Switch, switchToggle } from "../src/design-system/switch";
import { Tabs, tabElementId, tabIndexForKey, tabKeyAction } from "../src/design-system/tabs";

// createElement only sees the last overload of Button; JSX callers get both.
const Button = OverloadedButton as (props: ButtonProps) => ReactElement;

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** Parses the markup into a DOM-less list of opening tags with their attributes. */
function tags(html: string, name: string): Array<Record<string, string>> {
  const pattern = new RegExp(`<${name}\\b([^>]*)>`, "g");
  return [...html.matchAll(pattern)].map((match) => {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[1] ?? "").matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      const key = attribute[1];
      if (key) attributes[key] = attribute[2] ?? "";
    }
    return attributes;
  });
}

function classesOf(attributes: Record<string, string> | undefined): string[] {
  return (attributes?.class ?? "").split(" ").filter(Boolean);
}

describe("Button", () => {
  it("renders a type=button element with the outline variant by default", () => {
    const [button] = tags(render(createElement(Button, null, "Retry")), "button");
    expect(button?.type).toBe("button");
    expect(classesOf(button)).toEqual(["hm-btn", "hm-btn-outline"]);
  });

  it("maps variant, size and className onto hm- classes", () => {
    const html = render(
      createElement(Button, { variant: "honey", size: "lg", className: "cta" }, "Start"),
    );
    expect(classesOf(tags(html, "button")[0])).toEqual([
      "hm-btn",
      "hm-btn-honey",
      "hm-btn-lg",
      "cta",
    ]);
  });

  it("keeps an explicit submit type and the disabled attribute", () => {
    const [button] = tags(
      render(createElement(Button, { type: "submit", disabled: true }, "Save")),
      "button",
    );
    expect(button?.type).toBe("submit");
    expect(button).toHaveProperty("disabled");
  });

  it("draws the icon as a decorative svg before the label", () => {
    const html = render(createElement(Button, { icon: "plus" }, "Add task"));
    expect(html).toMatch(
      /<button[^>]*><svg[^>]*aria-hidden="true"[^>]*>.*<\/svg>Add task<\/button>/,
    );
  });

  it("renders an app route as a link with the same classes", () => {
    const html = render(createElement(Button, { href: "/sign-in", variant: "primary" }, "Sign in"));
    expect(html).not.toContain("<button");
    const [anchor] = tags(html, "a");
    expect(anchor?.href).toBe("/sign-in");
    expect(classesOf(anchor)).toEqual(["hm-btn", "hm-btn-primary"]);
  });

  it("renders an external URL as a plain anchor and passes anchor attributes", () => {
    const html = render(
      createElement(
        Button,
        { href: "https://github.com/CuriouslyCory/hive-mind", rel: "noopener", size: "sm" },
        "GitHub",
      ),
    );
    const [anchor] = tags(html, "a");
    expect(anchor?.href).toBe("https://github.com/CuriouslyCory/hive-mind");
    expect(anchor?.rel).toBe("noopener");
    expect(classesOf(anchor)).toEqual(["hm-btn", "hm-btn-outline", "hm-btn-sm"]);
  });
});

describe("Badge", () => {
  it("defaults to the neutral tone", () => {
    const [span] = tags(render(createElement(Badge, null, "Resting")), "span");
    expect(classesOf(span)).toEqual(["hm-badge", "hm-badge-neutral"]);
  });

  it("adds the pill and buzzing classes", () => {
    const html = render(
      createElement(Badge, { tone: "honey", pill: true, buzzing: true }, "Buzzing"),
    );
    expect(classesOf(tags(html, "span")[0])).toEqual([
      "hm-badge",
      "hm-badge-honey",
      "hm-badge-pill",
      "hm-badge-buzzing",
    ]);
    expect(html).toContain(">Buzzing</span>");
  });
});

describe("Card", () => {
  it("wraps a string body in the muted paragraph and renders eyebrow, title and footer", () => {
    const html = render(
      createElement(
        Card,
        { eyebrow: "Scopes", title: "Fewer merge conflicts", footer: "actions" },
        "Each Session declares the paths it touches.",
      ),
    );
    expect(html).toContain('<p class="hm-card-eyebrow">Scopes</p>');
    expect(html).toContain('<h3 class="hm-card-title">Fewer merge conflicts</h3>');
    expect(html).toContain(
      '<p class="hm-card-body hm-muted">Each Session declares the paths it touches.</p>',
    );
    expect(html).toContain('<div class="hm-card-footer">actions</div>');
  });

  it("maps variant, interactive and selected, and honours headingLevel", () => {
    const html = render(
      createElement(Card, {
        variant: "hive",
        interactive: true,
        selected: true,
        title: "Get started",
        headingLevel: 2,
      }),
    );
    expect(classesOf(tags(html, "div")[0])).toEqual([
      "hm-card",
      "hm-card-hive",
      "hm-card-interactive",
      "hm-card-selected",
    ]);
    expect(html).toContain('<h2 class="hm-card-title">Get started</h2>');
  });

  it("renders element children as they are", () => {
    const html = render(createElement(Card, null, createElement("ul", null)));
    expect(html).toBe('<div class="hm-card"><ul></ul></div>');
  });
});

describe("Input", () => {
  it("ties the label and help text to the input", () => {
    const html = render(
      createElement(Input, { id: "key", label: "Project key", help: "From hivemind init." }),
    );
    expect(tags(html, "label")[0]?.for).toBe("key");
    const [input] = tags(html, "input");
    expect(input?.id).toBe("key");
    expect(input?.type).toBe("text");
    expect(input?.["aria-describedby"]).toBe("key-help");
    expect(input).not.toHaveProperty("aria-invalid");
    expect(html).toContain('<div class="hm-help" id="key-help">From hivemind init.</div>');
  });

  it("marks an invalid field and a mono input", () => {
    const html = render(
      createElement(Input, { id: "k", invalid: true, mono: true, help: "Required." }),
    );
    expect(classesOf(tags(html, "div")[0])).toEqual(["hm-field", "hm-field-invalid"]);
    const [input] = tags(html, "input");
    expect(input?.["aria-invalid"]).toBe("true");
    expect(classesOf(input)).toEqual(["hm-input", "hm-input-mono"]);
  });

  it("generates an id when none is given", () => {
    const html = render(createElement(Input, { label: "Name" }));
    const [input] = tags(html, "input");
    expect(input?.id).toBeTruthy();
    expect(tags(html, "label")[0]?.for).toBe(input?.id);
  });
});

describe("Switch", () => {
  it("renders role=switch with aria-checked from defaultChecked", () => {
    const off = tags(render(createElement(Switch, { label: "Live updates" })), "button")[0];
    expect(off?.role).toBe("switch");
    expect(off?.type).toBe("button");
    expect(off?.["aria-checked"]).toBe("false");
    const on = tags(
      render(createElement(Switch, { defaultChecked: true, "aria-label": "Live" })),
      "button",
    )[0];
    expect(on?.["aria-checked"]).toBe("true");
    expect(on?.["aria-label"]).toBe("Live");
  });

  it("prefers the controlled checked prop and keeps disabled", () => {
    const [button] = tags(
      render(createElement(Switch, { checked: true, defaultChecked: false, disabled: true })),
      "button",
    );
    expect(button?.["aria-checked"]).toBe("true");
    expect(button).toHaveProperty("disabled");
  });

  it("flips the state on a click and stores it only when uncontrolled", () => {
    expect(switchToggle({ on: false, controlled: false })).toEqual({
      checked: true,
      storeOwnState: true,
    });
    expect(switchToggle({ on: true, controlled: false })).toEqual({
      checked: false,
      storeOwnState: true,
    });
    expect(switchToggle({ on: true, controlled: true })).toEqual({
      checked: false,
      storeOwnState: false,
    });
  });

  it("does nothing when disabled, controlled or not", () => {
    expect(switchToggle({ on: false, controlled: false, disabled: true })).toBeNull();
    expect(switchToggle({ on: true, controlled: true, disabled: true })).toBeNull();
  });
});

describe("Tabs", () => {
  const items = [
    { value: "plans", label: "Plans", count: 3, panel: "Plan list" },
    { value: "sessions", label: "Sessions", count: 4, panel: "Session list" },
    { value: "activity", label: "Activity", panel: "Event stream" },
  ];

  it("renders a tablist of tabs with one tab stop on the selected tab", () => {
    const html = render(
      createElement(Tabs, { items, defaultValue: "sessions", "aria-label": "Project views" }),
    );
    const [tablist] = tags(html, "div");
    expect(tablist?.role).toBe("tablist");
    expect(tablist?.["aria-label"]).toBe("Project views");
    const tabs = tags(html, "button");
    expect(tabs.map((tab) => tab.role)).toEqual(["tab", "tab", "tab"]);
    expect(tabs.map((tab) => tab["aria-selected"])).toEqual(["false", "true", "false"]);
    expect(tabs.map((tab) => tab.tabindex)).toEqual(["-1", "0", "-1"]);
    expect(html).toContain('<span class="hm-tab-count">4</span>');
  });

  it("reads a count after its label with a hidden separator", () => {
    const html = render(createElement(Tabs, { items }));
    expect(html).toContain(
      'Sessions<span class="hm-sr-only">, </span><span class="hm-tab-count">4</span>',
    );
    // No separator without a count.
    expect(html).toContain("Activity</button>");
  });

  it("selects with the arrow keys by default, and only moves focus with manual activation", () => {
    expect(tabKeyAction("ArrowRight", 0, 3)).toEqual({ focus: 1, select: true });
    expect(tabKeyAction("End", 0, 3, "automatic")).toEqual({ focus: 2, select: true });
    expect(tabKeyAction("ArrowRight", 0, 3, "manual")).toEqual({ focus: 1, select: false });
    expect(tabKeyAction("Home", 2, 3, "manual")).toEqual({ focus: 0, select: false });
    // Enter and Space are the buttons' own click, which selects.
    expect(tabKeyAction("Enter", 1, 3, "manual")).toBeNull();
    expect(tabKeyAction(" ", 1, 3, "manual")).toBeNull();
  });

  it("renders the same markup with manual activation", () => {
    const props = { items, value: "plans", id: "views" };
    expect(render(createElement(Tabs, { ...props, activation: "manual" }))).toBe(
      render(createElement(Tabs, props)),
    );
  });

  it("names its tabs from id and ties them to a panel rendered elsewhere", () => {
    const html = render(
      createElement(Tabs, {
        items: items.map(({ value, label }) => ({ value, label })),
        value: "sessions",
        id: "views",
        controls: "views-panel",
      }),
    );
    const tabs = tags(html, "button");
    expect(tabs.map((tab) => tab.id)).toEqual(
      [0, 1, 2].map((index) => tabElementId("views", index)),
    );
    expect(tabs.every((tab) => tab["aria-controls"] === "views-panel")).toBe(true);
    expect(html).not.toContain("tabpanel");
  });

  it("ties every tab to its panel and shows only the selected panel", () => {
    const html = render(createElement(Tabs, { items, value: "activity" }));
    const tabs = tags(html, "button");
    const panels = tags(html, "div").filter((div) => div.role === "tabpanel");
    expect(panels).toHaveLength(3);
    tabs.forEach((tab, index) => {
      const panel = panels[index];
      expect(tab["aria-controls"]).toBe(panel?.id);
      expect(panel?.["aria-labelledby"]).toBe(tab.id);
    });
    expect(panels.map((panel) => "hidden" in panel)).toEqual([true, true, false]);
  });

  it("moves with the arrow keys, wrapping at both ends", () => {
    expect(tabIndexForKey("ArrowRight", 0, 3)).toBe(1);
    expect(tabIndexForKey("ArrowRight", 2, 3)).toBe(0);
    expect(tabIndexForKey("ArrowLeft", 1, 3)).toBe(0);
    expect(tabIndexForKey("ArrowLeft", 0, 3)).toBe(2);
    expect(tabIndexForKey("ArrowRight", 0, 1)).toBe(0);
  });

  it("jumps to the ends with Home and End, and ignores other keys", () => {
    expect(tabIndexForKey("Home", 2, 3)).toBe(0);
    expect(tabIndexForKey("End", 0, 3)).toBe(2);
    for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "Tab", "a"]) {
      expect(tabIndexForKey(key, 1, 3), key).toBeNull();
    }
    expect(tabIndexForKey("ArrowRight", 0, 0)).toBeNull();
  });

  it("selects the first item by default and omits aria-controls without panels", () => {
    const html = render(
      createElement(Tabs, { items: items.map(({ value, label }) => ({ value, label })) }),
    );
    const tabs = tags(html, "button");
    expect(tabs[0]?.["aria-selected"]).toBe("true");
    expect(tabs.every((tab) => !("aria-controls" in tab))).toBe(true);
    expect(html).not.toContain("tabpanel");
    expect(html).not.toContain("hm-tab-count");
  });
});

describe("Alert", () => {
  it("uses role=status and the info glyph by default", () => {
    const html = render(createElement(Alert, { title: "Heads up" }, "Two Sessions share a path."));
    const [root] = tags(html, "div");
    expect(root?.role).toBe("status");
    expect(classesOf(root)).toEqual(["hm-alert", "hm-alert-info"]);
    expect(html).toContain('<p class="hm-alert-title">Heads up</p>');
    expect(html).toContain('<p class="hm-alert-body">Two Sessions share a path.</p>');
  });

  it("announces danger with role=alert and renders the action", () => {
    const html = render(
      createElement(
        Alert,
        { tone: "danger", action: createElement(Button, null, "Retry") },
        "Couldn't reach agent-04.",
      ),
    );
    const [root] = tags(html, "div");
    expect(root?.role).toBe("alert");
    expect(classesOf(root)).toContain("hm-alert-danger");
    expect(html).toContain('<div class="hm-alert-action"><button');
  });

  it("uses role=status for warning and success", () => {
    for (const tone of ["warning", "success"] as const) {
      expect(tags(render(createElement(Alert, { tone }, "x")), "div")[0]?.role).toBe("status");
    }
  });

  it("renders role=note, not a live region, when live is false", () => {
    for (const tone of ["info", "warning", "success", "danger"] as const) {
      const [root] = tags(render(createElement(Alert, { tone, live: false }, "x")), "div");
      expect(root?.role).toBe("note");
      expect(root).not.toHaveProperty("aria-live");
      expect(classesOf(root)).toContain(`hm-alert-${tone}`);
    }
  });
});

describe("Cell", () => {
  it("renders the hexagon corner, label and value", () => {
    const html = render(createElement(Cell, { label: "Active plans", value: 3, tone: "honey" }));
    expect(classesOf(tags(html, "div")[0])).toEqual(["hm-cell", "hm-cell-honey"]);
    expect(html).toContain('<span class="hm-cell-hex" aria-hidden="true"></span>');
    expect(html).toContain('<p class="hm-cell-label">Active plans</p>');
    expect(html).toContain('<p class="hm-cell-value">3</p>');
    expect(html).not.toContain("hm-cell-delta");
  });

  it("signs and colours the delta by direction", () => {
    const up = render(
      createElement(Cell, { label: "Tasks", value: 11, delta: 12, deltaLabel: "vs last week" }),
    );
    expect(up).toContain('class="hm-cell-delta hm-cell-delta-up"');
    expect(up).toContain("+12%");
    expect(up).toContain('<span class="hm-cell-delta-label">vs last week</span>');

    const down = render(
      createElement(Cell, { label: "Overlaps", value: 1, delta: -2, deltaUnit: "" }),
    );
    expect(down).toContain("hm-cell-delta-down");
    expect(down).toMatch(/<\/svg>-2<\/p>/);

    const flat = render(
      createElement(Cell, { label: "Overlaps", value: 1, delta: 0, selected: true }),
    );
    expect(flat).toContain("hm-cell-delta-flat");
    expect(flat).toContain("0%");
    expect(classesOf(tags(flat, "div")[0])).toContain("hm-cell-selected");
  });
});

describe("Icon and Hexagon", () => {
  it("draws every icon with currentColor and no hard-coded colour", () => {
    expect(iconNames).toHaveLength(19);
    for (const name of iconNames) {
      const html = render(createElement(Icon, { name }));
      expect(html).toContain('stroke="currentColor"');
      expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });

  it("is decorative without a title and an img with one", () => {
    expect(tags(render(createElement(Icon, { name: "hive" })), "svg")[0]?.["aria-hidden"]).toBe(
      "true",
    );
    const html = render(createElement(Icon, { name: "hive", title: "Hive" }));
    const [svg] = tags(html, "svg");
    expect(svg?.role).toBe("img");
    expect(svg?.["aria-label"]).toBe("Hive");
    expect(svg).not.toHaveProperty("aria-hidden");
  });

  it("computes the hexagons the icons draw", () => {
    const pointsOf = (name: "hex" | "info" | "hive") =>
      [...render(createElement(Icon, { name })).matchAll(/points="([^"]+)"/g)].map(
        (match) => match[1],
      );
    // HEX_OUTLINE (hex, hive, settings), HEX_FRAME (info, alert) and hive's filled centre.
    expect(pointsOf("hex")).toEqual([hexagonPoints(12, 12, 9)]);
    expect(pointsOf("info")).toEqual([hexagonPoints(12, 12, 9.5)]);
    expect(pointsOf("hive")).toEqual([hexagonPoints(12, 12, 9), hexagonPoints(12, 12, 3.5)]);
  });

  it("renders a sized hexagon, decorative only when empty", () => {
    const empty = tags(render(createElement(Hexagon, { size: 32, tone: "honey" })), "span")[0];
    expect(classesOf(empty)).toEqual(["hm-hex", "hm-hex-honey"]);
    expect(empty?.style).toBe("width:32px;height:32px");
    expect(empty?.["aria-hidden"]).toBe("true");
    const numbered = tags(render(createElement(Hexagon, null, "2")), "span")[0];
    expect(numbered).not.toHaveProperty("aria-hidden");
  });
});

describe("Logo", () => {
  it("puts the mark and wordmark on the logo tile with one accessible name", () => {
    const html = render(createElement(Logo));
    expect(classesOf(tags(html, "span")[0])).toEqual(["hm-logo-tile"]);
    const images = tags(html, "img");
    expect(images.map((image) => image.alt)).toEqual(["", "HiveMind"]);
    expect(images.map((image) => image.height)).toEqual(["32", "28"]);
    expect(images[0]?.src).toContain("hivemind-mark.png");
    expect(images[1]?.src).toContain("hivemind-wordmark.png");
  });

  it("names a lone mark and drops the tile on request", () => {
    const html = render(createElement(Logo, { wordmark: false, tile: false, height: 24 }));
    expect(classesOf(tags(html, "span")[0])).toEqual(["hm-logo-bare"]);
    const images = tags(html, "img");
    expect(images).toHaveLength(1);
    expect(images[0]?.alt).toBe("HiveMind");
    expect(images[0]?.height).toBe("24");
  });

  it("renders the square lockup", () => {
    const [image] = tags(render(createElement(LogoLockup, { size: 160 })), "img");
    expect(image?.alt).toBe("HiveMind");
    expect(image?.width).toBe("160");
    expect(image?.height).toBe("160");
    expect(image?.src).toContain("hivemind-lockup.png");
  });

  it("gives a decorative lockup empty alt text", () => {
    const [image] = tags(render(createElement(LogoLockup, { decorative: true })), "img");
    expect(image?.alt).toBe("");
    expect(image?.src).toContain("hivemind-lockup.png");
  });
});

describe("theme tokens", () => {
  const read = (file: string) =>
    readFileSync(new URL(`../src/design-system/${file}`, import.meta.url), "utf8");
  const tokens = read("tokens.css");

  /** The custom properties declared in the first block whose selector list starts with `selector`. */
  function block(selector: string): Map<string, string> {
    const start = tokens.indexOf(`${selector}`);
    const open = tokens.indexOf("{", start);
    const close = tokens.indexOf("}", open);
    return new Map(
      [...tokens.slice(open + 1, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
        match[1] ?? "",
        match[2]?.trim() ?? "",
      ]),
    );
  }

  const light = block(':root,\n[data-theme="light"]');
  const dark = block('[data-theme="dark"] {');
  const systemDark = block(':root:not([data-theme="light"])');

  it("gives every themed light token a dark value", () => {
    const themed = [...light.keys()].filter(
      (name) => !/^--(space|radius|border|duration)-/.test(name),
    );
    expect(themed.length).toBeGreaterThan(30);
    for (const name of themed) expect(dark.has(name), name).toBe(true);
  });

  it("applies the same dark values when following the system scheme", () => {
    expect(systemDark).toEqual(dark);
  });

  it("drives dark-only component rules from tokens, not [data-theme] selectors", () => {
    const components = read("components.css");
    expect(components).not.toMatch(/\[data-theme[^\]]*\]\s*\./);
    expect(dark.get("--hm-badge-success-ink")).toBe("var(--ink)");
    expect(dark.get("--hm-btn-primary-hover")).toBe("var(--honey-deep)");
    expect(light.get("--hm-btn-primary-hover")).toBe("var(--surface-hive)");
  });
  describe("inside the hive card", () => {
    const hive = block(".hm-card-hive {");
    const themes = { light, dark };

    /** A token's value inside a hive card on `theme`, with var() references resolved. */
    function resolve(name: string, theme: Map<string, string>): string {
      const value = hive.get(name) ?? theme.get(name);
      if (value === undefined) throw new Error(`${name} is not declared`);
      const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      return reference ? resolve(reference, theme) : value;
    }

    function luminance(hex: string): number {
      const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
      const [r = 0, g = 0, b = 0] = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function contrast(first: string, second: string): number {
      const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
      return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
    }

    it("re-points the tokens its controls read", () => {
      for (const name of [
        "--surface",
        "--surface-raised",
        "--surface-sunken",
        "--ink",
        "--ink-muted",
        "--ink-faint",
        "--line",
        "--line-strong",
        "--hive",
        "--on-hive",
        "--focus",
        "--hive-tint",
        "--honey-ink",
        "--honey-tint",
        "--success",
        "--success-tint",
        "--danger",
        "--danger-tint",
        "--info",
        "--hm-color-scheme",
        "--hm-btn-primary-hover",
        "--hm-badge-success-ink",
        "--hm-badge-danger-ink",
      ]) {
        expect(hive.has(name), name).toBe(true);
      }
      expect(hive.get("--ink")).toBe("var(--on-surface-hive)");
      expect(hive.get("--surface")).toBe("var(--surface-hive)");
      expect(hive.get("--focus")).toBe(hive.get("--hive"));
    });

    // [foreground, background, minimum]: text 4.5:1, borders and the focus ring 3:1.
    const pairs: Array<[string, string, number]> = [
      ["--ink", "--surface-hive", 4.5], // card text, outline and quiet buttons, inputs
      ["--ink-muted", "--surface-hive", 4.5], // muted text, unselected tabs, help text
      ["--ink-faint", "--surface-hive", 4.5], // placeholders
      ["--honey", "--surface-hive", 4.5], // the hive card eyebrow
      ["--danger", "--surface-hive", 4.5], // danger button text, error help
      ["--on-hive", "--hive", 4.5], // primary button
      ["--on-hive", "--hm-btn-primary-hover", 4.5],
      ["--on-honey", "--honey", 4.5], // honey button
      ["--on-honey", "--honey-deep", 4.5],
      ["--ink", "--hive-tint", 4.5], // hovered buttons and tabs, neutral badge, info alert
      ["--info", "--hive-tint", 4.5], // info badge
      ["--honey-ink", "--honey-tint", 4.5], // honey badge, tab count
      ["--ink", "--honey-tint", 4.5], // warning alert
      ["--ink", "--success-tint", 4.5],
      ["--ink", "--danger-tint", 4.5],
      ["--danger", "--danger-tint", 4.5], // hovered danger button
      ["--ink", "--surface-sunken", 4.5], // hm-code
      ["--line-strong", "--surface-hive", 3], // outline button, input, switch track and thumb
      ["--focus", "--surface-hive", 3], // the focus ring
      ["--honey-ink", "--surface-hive", 3], // a focused input's border
      ["--hive", "--surface-hive", 3], // a checked switch's track
    ];

    for (const [themeName, theme] of Object.entries(themes)) {
      it.each(pairs)(`keeps %s on %s at %s:1 or more in the ${themeName} theme`, (fg, bg, min) => {
        expect(contrast(resolve(fg, theme), resolve(bg, theme))).toBeGreaterThanOrEqual(min);
      });
    }
  });
});
