"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../../design-system/button";

const COPIED_FOR_MS = 1500;

/**
 * Copies `text` to the clipboard and says "Copied" for a moment. Without a
 * clipboard (an insecure origin, a denied permission) it does nothing.
 */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FOR_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard, or no permission to write it: the label stays "Copy".
    }
  }

  return (
    <>
      <Button variant="quiet" size="sm" className="lp-copy" onClick={copy}>
        {copied ? "Copied" : "Copy"}
        <span className="lp-sr-only"> {what}</span>
      </Button>
      <span className="lp-sr-only" role="status" aria-live="polite">
        {copied ? `Copied the ${what}.` : ""}
      </span>
    </>
  );
}
