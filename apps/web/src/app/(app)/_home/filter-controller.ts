// The home page's filter field, without React: `FilterInput`
// (./filter-input.tsx) wires it to the router and the field.

import { homeHref } from "../../../server/dashboard/home-params";
import { type HomeParams, MAX_HOME_QUERY_LENGTH } from "../../../server/dashboard/home-types";

/** How long typing pauses before the filter applies. */
export const FILTER_DEBOUNCE_MS = 300;

/** How many of the field's own requests are remembered until they render. */
const OWN_REQUEST_LIMIT = 8;

/**
 * The `q` the server reads from `text` (`parseHomeParams` trims and cuts it
 * to length), so that what the field requests is what the URL comes back
 * with.
 */
export function normalizeFilter(text: string): string {
  return text.trim().slice(0, MAX_HOME_QUERY_LENGTH).trim();
}

export interface FilterController {
  /** The field's text changed: apply it once typing pauses. */
  edit(text: string): void;
  /** Enter: apply `text` now. */
  submit(text: string): void;
  /**
   * Focus moved elsewhere on the page. A pending edit is applied now, so
   * that a navigation the reader starts next (a rail link, Clear filters, a
   * tab) is requested after it and wins.
   */
  blur(): void;
  /** Drop a pending edit: Back or Forward, or the page is hidden or left. */
  cancel(): void;
  /**
   * The page rendered `params`. Returns the text the field should show, or
   * null to keep the reader's own: a render this field requested keeps the
   * field as typed, any other navigation drops a pending edit and shows the
   * URL's filter.
   */
  rendered(params: HomeParams): string | null;
}

export function createFilterController(options: {
  params: HomeParams;
  /** Replaces the URL (`router.replace`). */
  navigate: (href: string) => void;
  debounceMs?: number;
}): FilterController {
  const debounceMs = options.debounceMs ?? FILTER_DEBOUNCE_MS;
  // The latest rendered state, which a request builds on.
  let params = options.params;
  // The last q requested, by this field or by the URL: an edit back to the
  // q already in view still applies while a request for another is loading.
  let requested = params.q;
  let pending: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  // The URLs this field requested that have not rendered yet, oldest first.
  const own: string[] = [];

  function cancel() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function apply(text: string) {
    cancel();
    const q = normalizeFilter(text);
    if (q === requested) return;
    requested = q;
    const href = homeHref(params, { q });
    own.push(href);
    if (own.length > OWN_REQUEST_LIMIT) own.shift();
    options.navigate(href);
  }

  return {
    edit(text) {
      cancel();
      pending = { text, timer: setTimeout(() => apply(text), debounceMs) };
    },
    submit: apply,
    blur() {
      if (pending) apply(pending.text);
    },
    cancel,
    rendered(next) {
      params = next;
      const index = own.indexOf(homeHref(next));
      if (index !== -1) {
        own.splice(0, index + 1);
        return null;
      }
      cancel();
      own.length = 0;
      requested = next.q;
      return next.q;
    },
  };
}
