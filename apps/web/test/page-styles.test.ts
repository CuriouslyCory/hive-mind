import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The stylesheet contract of ADR-0019. The design system's baseline is the
// one stylesheet that styles elements on every page, and it is layered so
// any other rule overrides it. Every other stylesheet in the app is a frame's
// or a page's and is scoped under its root class: Next keeps global
// stylesheets loaded after client navigation, and Cache Components keeps a
// visited page mounted but hidden, so an unscoped rule would reach every
// page visited later.

const SRC = new URL("../src/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, SRC), "utf8");

/** Each stylesheet outside the design system, and the class its rules are scoped under. */
const SCOPES: Record<string, string> = {
  "site/site.css": "hm-site",
  "app/(app)/_shell/app-shell.css": "app-shell",
  "app/(app)/_home/home.css": "hm-home",
  "app/(app)/_components/project.css": "hm-project",
  "app/(app)/tracker/tracker.css": "tracker",
  "app/(marketing)/welcome/landing.css": "hm-landing",
  "app/sign-in/sign-in.css": "hm-sign-in",
  "app/device/device.css": "hm-device",
};

/** The source without comments. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Splits a selector list on its top-level commas (not those inside `:is(...)`). */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const char = list[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(list.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim().replace(/\s+/g, " "));
}

/** Every style rule's selectors, skipping at-rule preludes and keyframe steps. */
function selectors(css: string): string[] {
  return [...stripComments(css).matchAll(/([^{};]+)\{/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter((prelude) => !prelude.startsWith("@") && !/^(from|to|[\d.]+%)(\s*,|$)/.test(prelude))
    .flatMap(splitSelectors);
}

describe("the baseline theme", () => {
  it("is loaded on every page by the design system's one import, tokens first", () => {
    expect(read("app/layout.tsx")).toContain('import "../design-system/styles.css";');
    const imports = [...read("design-system/styles.css").matchAll(/@import "([^"]+)";/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["./tokens.css", "./base.css", "./components.css"]);
  });

  it("puts every rule of base.css in the hm-base layer", () => {
    const css = stripComments(read("design-system/base.css")).trim();
    expect(css.startsWith("@layer hm-base {")).toBe(true);
    // The layer's block closes at the end of the file, so nothing is outside it.
    let depth = 0;
    let closedAt = -1;
    for (let index = 0; index < css.length; index++) {
      if (css[index] === "{") depth++;
      else if (css[index] === "}" && --depth === 0) {
        closedAt = index;
        break;
      }
    }
    expect(closedAt).toBe(css.length - 1);
  });
});

describe("page and frame stylesheets", () => {
  it("are all listed with their scope, so a new one has to choose its root class", () => {
    const found = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".css") && !path.startsWith("design-system/"))
      .sort();
    expect(found).toEqual(Object.keys(SCOPES).sort());
  });

  for (const [path, scope] of Object.entries(SCOPES)) {
    it(`scopes every rule of ${path} under .${scope}`, () => {
      const scoped = new RegExp(`^(:where\\()?\\.${scope}(?![\\w-])`);
      const list = selectors(read(path));
      expect(list.length).toBeGreaterThan(0);
      expect(list.filter((selector) => !scoped.test(selector))).toEqual([]);
    });
  }

  it("leave html and body to the baseline", () => {
    for (const path of Object.keys(SCOPES)) {
      const list = selectors(read(path));
      expect(list.filter((selector) => /(^|[\s>+~(])(html|body|:root)\b/.test(selector))).toEqual(
        [],
      );
    }
  });
});
