import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectPath } from "../src/app/(app)/_components/paths";
import { navItemCurrent } from "../src/app/(app)/_shell/app-nav";
import { APP_MAIN_ID, AppShell, appNavItems } from "../src/app/(app)/_shell/app-shell";
import { Breadcrumb } from "../src/app/(app)/_shell/breadcrumb";
import { Viewer, ViewerView } from "../src/app/(app)/_shell/viewer";
import RootLayout from "../src/app/layout";
import { getFreshLoginSession } from "../src/server/login-session";

// The baseline theme on <html> and the signed-in pages' frame (ADR-0019,
// docs/design-system.md → App shell), rendered to markup.

// next/font only works inside a Next build; the class names stand in for it.
vi.mock("../src/design-system/fonts", () => ({ designSystemFontClassName: "fonts hm-fonts" }));
const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
// The real module reads request headers and the database.
vi.mock("../src/server/login-session", () => ({ getFreshLoginSession: vi.fn() }));

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

// createElement's types want children among the props when they are
// required; JSX callers pass them as the element's content.
const Shell = AppShell as (props: {
  viewer?: ReactNode;
  navItems?: ReturnType<typeof appNavItems>;
  children?: ReactNode;
}) => ReactElement;
const Root = RootLayout as (props: { children?: ReactNode }) => ReactElement;

describe("the root layout", () => {
  it("makes <html> the design-system root, with the fonts and the system theme", () => {
    const [html] = tags(render(createElement(Root, null, "page")), "html");
    expect(html?.class?.split(" ")).toEqual(["hm-root", "fonts", "hm-fonts"]);
    expect(html?.["data-theme"]).toBe("system");
    expect(html?.lang).toBe("en");
  });
});

describe("AppShell", () => {
  beforeEach(() => {
    pathname.current = "/";
  });

  const shell = (viewer?: ReactNode) =>
    render(
      createElement(
        Shell,
        { viewer, navItems: appNavItems("production") },
        createElement("h1", null, "Page"),
      ),
    );

  it("starts with a skip link to its one focusable main, which holds the page", () => {
    const html = shell();
    const [skip] = tags(html, "a");
    expect(skip).toEqual({ class: "app-skip", href: `#${APP_MAIN_ID}` });
    expect(tags(html, "main")).toEqual([
      { id: APP_MAIN_ID, tabindex: "-1", class: "app-wrap app-main" },
    ]);
    expect(html).toMatch(/<main[^>]*><h1>Page<\/h1><\/main>/);
  });

  it("puts the logo, the Primary navigation, the theme switch and the viewer in the banner", () => {
    const html = shell(createElement("span", null, "viewer"));
    const banner = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const home = tags(banner, "a")[0];
    expect(home?.href).toBe("/");
    expect(home?.["aria-label"]).toBe("HiveMind home");
    expect(tags(banner, "nav")).toEqual([{ class: "app-nav", "aria-label": "Primary" }]);
    expect(tags(banner, "button").find((button) => button.role === "switch")?.["aria-label"]).toBe(
      "Dark theme",
    );
    expect(banner).toMatch(/<div class="app-topbar-right">.*<span>viewer<\/span><\/div>/);
  });

  it("marks the Dashboard as the current page on / and the current section on a Project page", () => {
    const dashboardLink = (html: string) =>
      tags(html, "a").find((link) => link.class === "app-nav-link");
    expect(dashboardLink(shell())?.["aria-current"]).toBe("page");
    pathname.current = "/projects/p1/plans/PLAN-1";
    expect(dashboardLink(shell())?.["aria-current"]).toBe("true");
    pathname.current = "/tracker";
    expect(dashboardLink(shell())?.["aria-current"]).toBeUndefined();
  });
});

describe("appNavItems", () => {
  it("lists the dev tracker only under next dev, where it exists", () => {
    expect(appNavItems("production")).toEqual([{ href: "/", label: "Dashboard" }]);
    expect(appNavItems("test")).toEqual([{ href: "/", label: "Dashboard" }]);
    expect(appNavItems("development")).toEqual([
      { href: "/", label: "Dashboard" },
      { href: "/tracker", label: "Tracker" },
    ]);
  });
});

describe("navItemCurrent", () => {
  it("tells the item's own page from its section and from elsewhere", () => {
    expect(navItemCurrent("/", "/")).toBe("page");
    expect(navItemCurrent("/", "/projects/p1")).toBe("true");
    expect(navItemCurrent("/", "/tracker")).toBeUndefined();
    expect(navItemCurrent("/tracker", "/tracker")).toBe("page");
    expect(navItemCurrent("/tracker", "/tracker/x")).toBe("true");
    expect(navItemCurrent("/tracker", "/trackers")).toBeUndefined();
  });
});

describe("Breadcrumb", () => {
  it("links the pages above and marks the last item as the current page", () => {
    const html = render(
      createElement(Breadcrumb, {
        items: [
          { label: "Dashboard", href: "/" },
          { label: "web-app", href: projectPath("p1") },
          { label: "PLAN-1" },
        ],
      }),
    );
    expect(tags(html, "nav")).toEqual([{ "aria-label": "Breadcrumb", class: "app-breadcrumb" }]);
    expect(tags(html, "a").map((link) => link.href)).toEqual(["/", "/projects/p1"]);
    expect(html).toContain('<span aria-current="page" class="app-crumb-current">PLAN-1</span>');
    // A separator between items only, and decorative.
    expect(tags(html, "svg")).toHaveLength(2);
    expect(tags(html, "svg").every((svg) => svg["aria-hidden"] === "true")).toBe(true);
  });
});

describe("Viewer", () => {
  it("shows the signed-in User's initial and name, with Sign out", () => {
    const html = render(createElement(ViewerView, { name: " ada lovelace" }));
    expect(html).toContain('<span class="app-viewer-initial">A</span>');
    expect(html).toContain('<span class="app-viewer-name"> ada lovelace</span>');
    expect(tags(html, "button")[0]?.class).toBe("hm-btn hm-btn-quiet hm-btn-sm");
    expect(html).toContain(">Sign out</button>");
  });

  it("reads the fresh login session, and renders nothing signed out", async () => {
    vi.mocked(getFreshLoginSession).mockResolvedValueOnce(null);
    expect(await Viewer()).toBeNull();

    vi.mocked(getFreshLoginSession).mockResolvedValueOnce({
      user: { name: "Cory" },
    } as Awaited<ReturnType<typeof getFreshLoginSession>>);
    const element = await Viewer();
    expect(element && render(element)).toContain('<span class="app-viewer-name">Cory</span>');
  });
});
