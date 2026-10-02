import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveStatusView } from "../src/components/dashboard/live-status";
import type { ProjectEventStreamSnapshot } from "../src/lib/project-event-stream";

const snapshot = (patch: Partial<ProjectEventStreamSnapshot>): ProjectEventStreamSnapshot => ({
  status: { kind: "live" },
  cursor: "cursor",
  lastEventAt: null,
  lastSyncAt: Date.UTC(2026, 9, 1, 12, 0, 0),
  withheld: false,
  refreshing: false,
  ...patch,
});

const render = (value: ProjectEventStreamSnapshot | null) =>
  renderToStaticMarkup(createElement(LiveStatusView, { snapshot: value }));

/** The live region's content. */
const announced = (html: string) => /<output aria-live="polite">(.*?)<\/output>/.exec(html)?.[1];

describe("LiveStatusView", () => {
  it("keeps the time of the last read out of the live region", () => {
    const reconnecting = render(
      snapshot({ status: { kind: "reconnecting", attempt: 1, nextAttemptAt: null } }),
    );
    expect(announced(reconnecting)).toBe("Reconnecting.");
    expect(reconnecting).toContain("Showing data from <time");

    // A refresh moves only the time, so the announced text does not change.
    const later = render(
      snapshot({
        status: { kind: "reconnecting", attempt: 1, nextAttemptAt: null },
        lastSyncAt: Date.UTC(2026, 9, 1, 12, 5, 0),
      }),
    );
    expect(announced(later)).toBe(announced(reconnecting));
    expect(later).not.toBe(reconnecting);

    const live = render(snapshot({ refreshing: true }));
    expect(announced(live)).toBe("Live");
    expect(live).toContain('<span aria-hidden="true">. Updating…</span>');
  });

  it("claims no read time it does not know, and renders an empty region before any state", () => {
    const offline = render(snapshot({ status: { kind: "offline" }, lastSyncAt: null }));
    expect(announced(offline)).toBe("Offline.");
    expect(offline).not.toContain("<time");
    expect(announced(render(null))).toBe("");
  });
});
