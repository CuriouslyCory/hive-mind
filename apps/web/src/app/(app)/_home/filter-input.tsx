"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Input } from "../../../design-system/input";
import { homeHref } from "../../../server/dashboard/home-params";
import { type HomeParams, MAX_HOME_QUERY_LENGTH } from "../../../server/dashboard/home-types";
import { createFilterController, normalizeFilter } from "./filter-controller";

/**
 * The home page's filter. All page state is in the URL, so typing replaces
 * the URL (debounced; Enter applies at once) and the server renders the
 * filtered page. The page is not remounted by a search-param change, so the
 * field keeps focus and its text while the new page loads. The races between
 * typing and other navigation are settled in `createFilterController`
 * (./filter-controller.ts).
 */
export function FilterInput({ params }: { params: HomeParams }) {
  const router = useRouter();
  const [value, setValue] = useState(params.q);
  const [filter] = useState(() =>
    createFilterController({
      params,
      navigate: (href) => router.replace(href as Route, { scroll: false }),
    }),
  );
  const latest = useRef(params);

  useEffect(() => {
    latest.current = params;
  });

  // Each change of URL state, keyed by its URL so that a refresh of the same
  // state is not one. Another navigation (a rail link, Clear filters, a tab,
  // Back) drops a pending edit and shows the URL's filter.
  const href = homeHref(params);
  useEffect(() => {
    void href;
    const text = filter.rendered(latest.current);
    if (text !== null) setValue((shown) => (normalizeFilter(shown) === text ? shown : text));
  }, [filter, href]);

  // Back and Forward drop a pending edit before it can replace the entry they
  // show. So does hiding or leaving the page.
  useEffect(() => {
    const cancel = () => filter.cancel();
    window.addEventListener("popstate", cancel);
    return () => {
      window.removeEventListener("popstate", cancel);
      filter.cancel();
    };
  }, [filter]);

  return (
    <Input
      className="home-filter"
      type="search"
      label="Filter Plans and Sessions"
      placeholder="parser, codex, PLAN-3, chore/deps…"
      maxLength={MAX_HOME_QUERY_LENGTH}
      autoComplete="off"
      value={value}
      onBlur={() => {
        // Focus left the window (another app, the browser's Back button):
        // the edit stays pending, and Back cancels it.
        if (document.hasFocus()) filter.blur();
      }}
      onChange={(event) => {
        setValue(event.target.value);
        filter.edit(event.target.value);
      }}
      onKeyDown={(event) => {
        // Enter that confirms an IME composition is not a submit. Safari
        // reports it after compositionend, with keyCode 229.
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) {
          return;
        }
        event.preventDefault();
        filter.submit(event.currentTarget.value);
      }}
    />
  );
}
