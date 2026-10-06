import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  attentionDetail,
  attributionLabel,
  eventPredicate,
  statDelta,
  throughputSummary,
} from "../src/app/(app)/_home/format";
import { FreshnessView } from "../src/app/(app)/_home/freshness";
import { HomeView } from "../src/app/(app)/_home/home-view";
import type { HomeDashboard, HomeParams } from "../src/server/dashboard/home-types";
import { AS_OF, homeDashboard, PROJECT_A, PROJECT_B } from "./support/home-dashboard";

// The signed-in home page's server components, rendered from a hand-written
// `HomeDashboard` (./support/home-dashboard.ts): links built with
// `homeHref`, empty states, attribution, the list views and the analytics.

// next/font only works inside a Next build; the class name stands in for it.
vi.mock("../src/design-system/fonts", () => ({ designSystemFontClassName: "fonts" }));
// The filter, the tabs and the freshness line use the App Router, which is
// not mounted here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

function render(dashboard: HomeDashboard): string {
  return renderToStaticMarkup(createElement(HomeView, { dashboard }));
}

function page(params: Partial<HomeParams> = {}, overrides: Partial<HomeDashboard> = {}): string {
  return render(homeDashboard(params, overrides));
}

/** The visible text of `html`, with tags dropped and entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** The opening `<a>` tags of `html`, as attribute maps. */
function links(html: string): Array<Record<string, string>> {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => {
    const attributes: Record<string, string> = { text: text(match[2] ?? "") };
    for (const attribute of (match[1] ?? "").matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      const key = attribute[1];
      if (key) attributes[key] = (attribute[2] ?? "").replaceAll("&amp;", "&");
    }
    return attributes;
  });
}

function hrefOf(html: string, name: string | RegExp): string | undefined {
  return links(html).find((link) =>
    typeof name === "string"
      ? link.text === name || link["aria-label"] === name
      : name.test(link.text ?? "") || name.test(link["aria-label"] ?? ""),
  )?.href;
}

describe("the home view", () => {
  const html = page();

  it("renders no design annotations", () => {
    expect(text(html)).not.toContain("Proposed");
    expect(text(html)).not.toContain("Data:");
  });

  it("names the page and the viewer, with Dashboard as the current breadcrumb", () => {
    expect(html).toMatch(/<h1[^>]*>Dashboard<\/h1>/);
    expect(text(html)).toContain("Signed in as Cory");
    expect(html).toMatch(/<span aria-current="page"[^>]*>Dashboard<\/span>/);
    expect(hrefOf(html, "HiveMind home")).toBe("/");
    expect(html).toContain('id="home-main"');
    expect(hrefOf(html, "Skip to main content")).toBe("#home-main");
  });

  it("links the rail to each Project's view, marking the selected one", () => {
    expect(hrefOf(html, /^All Projects/)).toBe("/");
    expect(hrefOf(html, /^web-app/)).toBe(`/?project=${PROJECT_A}`);
    expect(hrefOf(html, /^parser/)).toBe(`/?project=${PROJECT_B}`);
    const current = links(html).filter((link) => link["aria-current"] === "page");
    expect(current.map((link) => link.text)).toEqual(["All Projects2 Projects2 buzzing"]);
  });

  it("links each summary cell to the list it summarizes", () => {
    expect(hrefOf(html, /^Active Plans: 3\./)).toBe("/?view=plans&plans=active");
    expect(hrefOf(html, /^Buzzing: 2\./)).toBe("/?view=sessions");
    expect(hrefOf(html, /^Tasks done: 23\./)).toBe("/?view=plans&plans=done");
    expect(hrefOf(html, /^Overlaps: 1\./)).toBe("/?view=sessions&sessions=overlap");
  });

  it("shows overlaps with a link to the overlapping Sessions", () => {
    expect(text(html)).toContain(
      "claude-code's packages/parser/** and codex's packages/parser/lexer.ts both match.",
    );
    expect(hrefOf(html, "View Sessions")).toBe("/?view=sessions&sessions=overlap");
  });

  it("links Sessions, their focus and Plans to the Project pages", () => {
    expect(hrefOf(html, "Fix parser error positions")).toBe(`/projects/${PROJECT_A}/sessions/s1`);
    expect(hrefOf(html, "PLAN-4")).toBe(`/projects/${PROJECT_A}/plans/PLAN-4`);
    expect(hrefOf(html, "Tokenizer performance")).toBe(`/projects/${PROJECT_B}/plans/PLAN-4`);
    expect(hrefOf(html, "Changelog entry")).toBe(`/projects/${PROJECT_A}/plans/PLAN-3`);
  });

  it("shows a Project key by its name and a revoked one as revoked", () => {
    expect(text(html)).toContain("ci · Project key · ci-nightly");
    expect(text(html)).toContain("by Project key (revoked)");
    expect(html).not.toContain("key-1");
  });

  it("links See all to the list views", () => {
    expect(hrefOf(html, "See all 7 Sessions")).toBe("/?view=sessions&sessions=all");
    expect(hrefOf(html, "See all 9 Plans")).toBe("/?view=plans");
    expect(text(html)).toContain("Showing 2 of 9 Plans");
  });

  it("composes Needs attention from the structured fields", () => {
    const shown = text(html);
    expect(shown).toContain("Blocked Task · Changelog entry");
    expect(shown).toContain("Waiting on the 0.2.0 release notes.");
    expect(shown).toContain("claude-code's lease ends in 1 min. The next Heartbeat renews it.");
    expect(shown).toContain("A Session's lease lapsed. The Task is claimable again.");
    expect(shown).toContain("4 open Tasks, none claimed for 1 day.");
    expect(shown).toContain("Paused with 5 open Tasks.");
  });

  it("shows Throughput deltas, colored by whether they are good, and a dash for a null median", () => {
    expect(html).toMatch(/home-delta-good[^"]*">\+15% vs previous 7 days/);
    expect(html).toMatch(/home-delta-bad[^"]*">-25% vs previous 7 days/);
    // Plans finished had no previous value to compare with.
    expect(text(html)).toContain("No comparison with the previous 7 days");
    expect(html).toMatch(/<dd class="home-stat-value">—<\/dd>/);
    expect(html).toContain('role="img" aria-label="23 Tasks done, last 7 days.');
  });

  it("renders times relative to the snapshot, machine-readable", () => {
    expect(html).toContain(`<time dateTime="${new Date(AS_OF.getTime() - 12_000).toISOString()}"`);
    expect(text(html)).toContain("12 s ago");
  });

  it("does not offer Clear filters without filters", () => {
    expect(hrefOf(html, "Clear filters")).toBeUndefined();
  });
});

describe("the home view in one Project with a filter", () => {
  const html = page({ projectId: PROJECT_A, q: "parser", range: "30d" });

  it("marks the Project in the rail and opens it", () => {
    const current = links(html).find((link) => link["aria-current"] === "page");
    expect(current?.href).toBe(`/?project=${PROJECT_A}&q=parser&range=30d`);
    expect(hrefOf(html, "Open Project")).toBe(`/projects/${PROJECT_A}`);
    expect(text(html)).toContain("acme · Project");
  });

  it("clears the filters but keeps the view and the range", () => {
    expect(hrefOf(html, "Clear filters")).toBe("/?range=30d");
  });

  it("leaves out the Project names it no longer needs", () => {
    expect(text(html)).toContain("packages/parser/lexer.ts");
    expect(text(html)).not.toContain("web-app / packages/parser/lexer.ts");
  });
});

describe("the list views", () => {
  it("shows only Plans on view=plans, with a breadcrumb back home", () => {
    const html = page({ view: "plans", q: "x" });
    expect(html).toMatch(/<h1[^>]*>Plans<\/h1>/);
    expect(text(html)).toContain("9 Plans in all Projects matching “x”.");
    expect(hrefOf(html, "Dashboard")).toBe("/?q=x");
    expect(html).toMatch(/aria-current="page"[^>]*>Plans<\/span>/);
    for (const hidden of [
      "home-sessions",
      "home-attention",
      "home-throughput",
      "home-agents",
      "home-activity",
      "home-decisions",
      "home-hot-paths",
    ]) {
      expect(html).not.toContain(`data-testid="${hidden}"`);
    }
    expect(html).toContain('data-testid="home-plans"');
    expect(text(html)).not.toContain("See all");
    expect(text(html)).not.toContain("History");
  });

  it("shows only Sessions on view=sessions", () => {
    const html = page({ view: "sessions" });
    expect(html).toMatch(/<h1[^>]*>Sessions<\/h1>/);
    expect(html).toContain('data-testid="home-sessions"');
    expect(html).not.toContain('data-testid="home-plans"');
    expect(html).not.toContain("Active Plans: 3");
  });
});

describe("empty states", () => {
  const empty: Partial<HomeDashboard> = {
    overlaps: [],
    attention: { items: [], total: 0 },
    events: [],
    decisions: [],
    sessions: {
      total: 0,
      counts: { active: 0, ended: 0, overlap: 0, all: 0 },
      tab: "active",
      matching: 0,
      rows: [],
    },
    plans: {
      total: 0,
      counts: { all: 0, active: 0, paused: 0, done: 0 },
      tab: "all",
      matching: 0,
      rows: [],
    },
  };

  it("invites rather than shows empty tables", () => {
    const html = page({}, empty);
    const shown = text(html);
    expect(shown).toContain("Nothing needs you right now. The hive is handling it.");
    expect(shown).toContain("No Sessions here yet. Start one with hivemind start");
    expect(shown).toContain("No Plans with this status.");
    expect(shown).toContain("No Events match. The hive is quiet here.");
    expect(shown).toContain("No decisions recorded here yet.");
    expect(html).not.toContain("home-sessions-table");
    expect(html).not.toContain("home-plans-table");
    // With no overlapping Sessions, the Overlaps cell opens the active ones.
    expect(hrefOf(html, /^Overlaps: /)).toBe("/?view=sessions");
    expect(shown).not.toContain("Overlapping");
  });

  it("says what matched nothing when filtered", () => {
    const shown = text(page({ q: "zzz" }, empty));
    expect(shown).toContain("No Sessions match “zzz”.");
    expect(shown).toContain("No Plans match “zzz”.");
  });

  it("tells a User with no Projects how to create one", () => {
    const html = page({}, { projects: { items: [], total: 0, buzzingTotal: 0 } });
    expect(text(html)).toContain("You have no Projects yet.");
    expect(html).toContain("hivemind init --name");
    expect(html).not.toContain('data-testid="home-sessions"');
  });
});

describe("home page text", () => {
  it("attributes Users, Project keys and the system", () => {
    expect(attributionLabel({ kind: "user", userId: "u", name: null })).toBe("Unknown User");
    expect(attributionLabel({ kind: "project_key", keyId: "k", name: "ci", revoked: false })).toBe(
      "Project key · ci",
    );
    expect(attributionLabel({ kind: "project_key", keyId: "k", name: null, revoked: true })).toBe(
      "Project key (revoked)",
    );
    expect(attributionLabel({ kind: "system" })).toBe("hive-mind (automatic)");
  });

  it("treats a lower median Task time as better", () => {
    expect(statDelta({ value: 30, previous: 40 }, "7d", true)).toEqual({
      text: "-25% vs previous 7 days",
      tone: "good",
    });
    expect(statDelta({ value: 50, previous: 40 }, "24h", true)).toEqual({
      text: "+25% vs previous 24 h",
      tone: "bad",
    });
    expect(statDelta({ value: 40, previous: 40 }, "30d")?.tone).toBe("flat");
    expect(statDelta({ value: null, previous: 40 }, "7d")).toBeNull();
    expect(statDelta({ value: 4, previous: 0 }, "7d")).toBeNull();
  });

  it("reads an Event after its actor", () => {
    expect(eventPredicate("Claimed the Task")).toEqual({ joiner: " ", text: "claimed the Task" });
    expect(eventPredicate("The Session became idle")).toEqual({
      joiner: ": ",
      text: "The Session became idle",
    });
  });

  it("names the busiest bucket in the chart's text alternative", () => {
    const buckets = [
      { start: new Date(Date.UTC(2026, 9, 4)), tasksDone: 2 },
      { start: new Date(Date.UTC(2026, 9, 5)), tasksDone: 5 },
    ];
    expect(throughputSummary(buckets, "day", "7d")).toBe(
      "7 Tasks done, last 7 days. Busiest day: Oct 5 UTC, with 5.",
    );
  });

  it("says when a paused Plan was paused, when it is known", () => {
    const item = {
      kind: "paused_plan" as const,
      projectId: PROJECT_A,
      projectName: "web-app",
      planKey: "PLAN-5",
      planTitle: "Settings",
      openTaskCount: 1,
      pausedAt: new Date(AS_OF.getTime() - 6 * 86_400_000),
    };
    expect(attentionDetail(item, AS_OF)).toBe("Paused for 6 days with 1 open Task.");
  });
});

describe("the freshness line", () => {
  it("puts only the state's words in the live region", () => {
    const html = renderToStaticMarkup(
      createElement(FreshnessView, { state: "live", asOf: AS_OF.toISOString(), ageSeconds: 12 }),
    );
    expect(html).toContain('<output aria-live="polite">Live</output>');
    expect(text(html)).toContain("Live · read 12 s ago");
  });

  it("says Offline and how old the data is", () => {
    const html = renderToStaticMarkup(
      createElement(FreshnessView, { state: "offline", asOf: AS_OF.toISOString(), ageSeconds: 90 }),
    );
    expect(html).toContain('<output aria-live="polite">Offline</output>');
    expect(text(html)).toContain("showing data read 1 min ago");
  });

  it("marks a refresh in progress without announcing it", () => {
    const html = renderToStaticMarkup(
      createElement(FreshnessView, {
        state: "updating",
        asOf: AS_OF.toISOString(),
        ageSeconds: 15,
      }),
    );
    expect(html).toContain('<span aria-hidden="true"> · Updating…</span>');
  });
});
