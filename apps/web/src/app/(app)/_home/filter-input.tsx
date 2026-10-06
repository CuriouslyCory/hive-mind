"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Input } from "../../../design-system/input";
import { homeHref } from "../../../server/dashboard/home-params";
import { type HomeParams, MAX_HOME_QUERY_LENGTH } from "../../../server/dashboard/home-types";

/** How long typing pauses before the filter applies. */
export const FILTER_DEBOUNCE_MS = 300;

/**
 * The home page's filter. All page state is in the URL, so typing replaces
 * the URL (debounced; Enter applies at once) and the server renders the
 * filtered page. The page is not remounted by a search-param change, so the
 * field keeps focus and its text while the new page loads.
 */
export function FilterInput({ params }: { params: HomeParams }) {
  const router = useRouter();
  const [value, setValue] = useState(params.q);
  const focused = useRef(false);
  // The params a debounced apply builds on: the latest render's, not the
  // ones from when typing started.
  const latest = useRef(params);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    latest.current = params;
  });

  // Follow the URL when it changes from elsewhere (Clear filters, Back),
  // unless the reader is typing: their text is newer than the URL.
  useEffect(() => {
    if (!focused.current) setValue(params.q);
  }, [params.q]);

  // A pending filter is dropped when the page is hidden or left.
  useEffect(() => () => clearTimeout(timer.current), []);

  function apply(text: string) {
    clearTimeout(timer.current);
    const current = latest.current;
    const q = text.trim().slice(0, MAX_HOME_QUERY_LENGTH);
    if (q === current.q) return;
    router.replace(homeHref(current, { q }) as Route, { scroll: false });
  }

  return (
    <Input
      className="home-filter"
      type="search"
      label="Filter Plans and Sessions"
      placeholder="parser, codex, PLAN-3, chore/deps…"
      maxLength={MAX_HOME_QUERY_LENGTH}
      autoComplete="off"
      value={value}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
      }}
      onChange={(event) => {
        const text = event.target.value;
        setValue(text);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => apply(text), FILTER_DEBOUNCE_MS);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply(event.currentTarget.value);
        }
      }}
    />
  );
}
