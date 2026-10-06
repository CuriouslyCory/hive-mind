import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFilterController,
  FILTER_DEBOUNCE_MS,
  normalizeFilter,
} from "../src/app/(app)/_home/filter-controller";
import {
  DEFAULT_HOME_PARAMS,
  homeHref,
  parseHomeParams,
} from "../src/server/dashboard/home-params";
import { type HomeParams, MAX_HOME_QUERY_LENGTH } from "../src/server/dashboard/home-types";

// The home page's filter field against other navigation, with fake timers.

const PROJECT = "11111111-1111-4111-8111-111111111111";
const at = (patch: Partial<HomeParams> = {}): HomeParams => ({ ...DEFAULT_HOME_PARAMS, ...patch });

function setup(params = at()) {
  const navigate = vi.fn<(href: string) => void>();
  const filter = createFilterController({ params, navigate });
  return { navigate, filter };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the home page's filter", () => {
  it("applies once typing pauses, and at once on submit", () => {
    const { navigate, filter } = setup(at({ range: "30d" }));
    filter.edit("p");
    filter.edit("parser ");
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS - 1);
    expect(navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/?q=parser&range=30d");

    filter.edit("lexer");
    filter.submit("lexer");
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    expect(navigate).toHaveBeenLastCalledWith("/?q=lexer&range=30d");
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("drops a pending edit when another navigation renders, and shows the URL's filter", () => {
    const { navigate, filter } = setup(at({ q: "old" }));
    filter.edit("new");
    // A rail link was followed before the debounce ran out.
    expect(filter.rendered(at({ q: "old", projectId: PROJECT }))).toBe("old");
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS * 2);
    expect(navigate).not.toHaveBeenCalled();

    // The next edit builds on the rendered state.
    filter.submit("new");
    expect(navigate).toHaveBeenCalledExactlyOnceWith(`/?project=${PROJECT}&q=new`);
  });

  it("keeps the field as typed when its own request renders", () => {
    const { filter } = setup();
    filter.submit("pars");
    filter.edit("parser");
    // The request for "pars" renders while "parser" is still pending.
    expect(filter.rendered(at({ q: "pars" }))).toBeNull();
  });

  it("applies an edit back to the rendered filter while another request is loading", () => {
    const { navigate, filter } = setup(at({ q: "parser" }));
    filter.submit("");
    expect(navigate).toHaveBeenLastCalledWith("/");
    // The read for "" is slow; the reader types the old filter again.
    filter.submit("parser");
    expect(navigate).toHaveBeenLastCalledWith("/?q=parser");
    // Clearing the box during that read still applies.
    filter.edit("");
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    expect(navigate).toHaveBeenLastCalledWith("/");
    expect(navigate).toHaveBeenCalledTimes(3);
  });

  it("does not request what it last requested", () => {
    const { navigate, filter } = setup(at({ q: "parser" }));
    filter.submit(" parser ");
    expect(navigate).not.toHaveBeenCalled();
    filter.submit("lexer");
    filter.submit("lexer ");
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("applies a pending edit on blur, before the navigation the reader starts next", () => {
    const { navigate, filter } = setup();
    filter.edit("parser");
    filter.blur();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/?q=parser");
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    expect(navigate).toHaveBeenCalledTimes(1);
    // Nothing pending: blur requests nothing.
    filter.blur();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("drops a pending edit on Back", () => {
    const { navigate, filter } = setup();
    filter.edit("parser");
    filter.cancel();
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    filter.blur();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("follows a filter changed elsewhere, such as Clear filters", () => {
    const { navigate, filter } = setup(at({ q: "parser" }));
    expect(filter.rendered(at())).toBe("");
    // The rendered q is now the last requested one.
    filter.submit("");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("requests the q the server reads back", () => {
    const long = `${"a".repeat(MAX_HOME_QUERY_LENGTH - 1)} b`;
    for (const text of ["  parser  ", long, "ä/ö & ?=#"]) {
      const q = normalizeFilter(text);
      const parsed = parseHomeParams(
        Object.fromEntries(new URL(homeHref(at({ q })), "http://x").searchParams),
      );
      expect(parsed.q, text).toBe(q);
    }
  });
});
