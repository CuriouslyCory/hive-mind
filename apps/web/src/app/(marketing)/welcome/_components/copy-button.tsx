"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../../design-system/button";

const FEEDBACK_FOR_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

const LABELS: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Select and copy",
};

/** Selects the text of the element with id `sourceId`, so Ctrl+C copies it. */
function selectSource(sourceId: string) {
  const source = document.getElementById(sourceId);
  const selection = window.getSelection();
  if (!source || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(source);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Copies `text` to the clipboard and says "Copied" for a moment. Without a
 * clipboard (an insecure origin, a denied permission) it selects the element
 * `sourceId`, which shows the same text, and says how to copy it by hand.
 */
export function CopyButton({
  text,
  what,
  sourceId,
}: {
  text: string;
  what: string;
  sourceId: string;
}) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), FEEDBACK_FOR_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("No clipboard.");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      selectSource(sourceId);
      setState("failed");
    }
  }

  return (
    <>
      <Button variant="quiet" size="sm" className="lp-copy" onClick={copy}>
        {LABELS[state]}
        <span className="lp-sr-only"> {what}</span>
      </Button>
      <span className="lp-sr-only" role="status" aria-live="polite">
        {state === "copied" ? `Copied the ${what}.` : null}
        {state === "failed"
          ? "Couldn't copy. The command is selected; press Ctrl+C to copy it."
          : null}
      </span>
    </>
  );
}
