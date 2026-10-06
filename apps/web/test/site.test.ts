import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CLI_DOCS_URL, DASHBOARD_DOCS_URL, DECISIONS_URL, REPOSITORY_URL } from "../src/site/links";
import { SiteFooter } from "../src/site/site-footer";
import { SiteHeader } from "../src/site/site-header";
import { SitePage, type SitePageProps } from "../src/site/site-page";

// next/font only works inside a Next build; the class names stand in for it.
vi.mock("../src/design-system/fonts", () => ({ designSystemFontClassName: "fonts hm-fonts" }));

// createElement's types want children among the props when they are
// required; JSX callers pass them as the element's content.
const Page = SitePage as (
  props: Omit<SitePageProps, "children"> & { children?: ReactNode },
) => ReactElement;

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** The opening tags named `name`, as attribute maps. */
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

describe("SiteHeader", () => {
  it("links the logo to / by default, named once", () => {
    const html = render(createElement(SiteHeader));
    const [home] = tags(html, "a");
    expect(home?.href).toBe("/");
    expect(home?.["aria-label"]).toBe("HiveMind home");
    // The logo images inside the link add nothing to its name.
    expect(tags(html, "img").map((img) => img.alt)).toEqual(["", "HiveMind"]);
  });

  it("links the logo to an anchor on the home page itself", () => {
    const [home] = tags(render(createElement(SiteHeader, { homeHref: "#top" })), "a");
    expect(home?.href).toBe("#top");
  });

  it("renders no nav and no right-hand group when given neither", () => {
    const html = render(createElement(SiteHeader));
    expect(tags(html, "nav")).toEqual([]);
    expect(html).not.toContain("site-topbar-right");
  });

  it("renders nav as the Primary navigation, in order", () => {
    const html = render(
      createElement(SiteHeader, {
        nav: [
          { href: "#how", label: "How it works" },
          { href: REPOSITORY_URL, label: "GitHub" },
        ],
      }),
    );
    expect(tags(html, "nav")).toEqual([{ class: "site-nav", "aria-label": "Primary" }]);
    expect(tags(html, "a").map((a) => a.href)).toEqual(["/", "#how", REPOSITORY_URL]);
  });

  it("puts children in the right-hand group", () => {
    const html = render(createElement(SiteHeader, null, createElement("span", null, "Act")));
    expect(html).toMatch(/<div class="site-topbar-right"><span>Act<\/span><\/div>/);
  });
});

describe("SiteFooter", () => {
  it("links to the repository and its docs in the Footer navigation", () => {
    const html = render(createElement(SiteFooter));
    expect(tags(html, "footer")).toHaveLength(1);
    expect(tags(html, "nav")[0]?.["aria-label"]).toBe("Footer");
    expect(tags(html, "a").map((a) => a.href)).toEqual([
      REPOSITORY_URL,
      CLI_DOCS_URL,
      DASHBOARD_DOCS_URL,
      DECISIONS_URL,
    ]);
  });
});

describe("SitePage", () => {
  const page = () =>
    render(
      createElement(
        Page,
        {
          mainId: "sign-in",
          className: "hm-sign-in",
          mainClassName: "si-main",
          header: createElement(SiteHeader),
        },
        createElement("h1", null, "Title"),
      ),
    );

  it("is a design-system root that follows the system theme, with the page's scope class", () => {
    const [root] = tags(page(), "div");
    expect(root?.class?.split(" ")).toEqual([
      "hm-root",
      "hm-site",
      "fonts",
      "hm-fonts",
      "hm-sign-in",
    ]);
    expect(root?.["data-theme"]).toBe("system");
  });

  it("starts with a skip link to its focusable main", () => {
    const html = page();
    const [skip] = tags(html, "a");
    expect(skip).toEqual({ class: "site-skip", href: "#sign-in" });
    expect(tags(html, "main")).toEqual([
      { id: "sign-in", tabindex: "-1", class: "site-main si-main" },
    ]);
  });

  it("orders the landmarks header, main, footer", () => {
    const html = page();
    const order = ["<header", "<main", "<footer"].map((tag) => html.indexOf(tag));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("<h1>Title</h1>");
  });
});
