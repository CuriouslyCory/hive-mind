"use client";

import type { BacklogStepView, TrackerCommandInput, TrackerCommandName } from "@hivemind/tracker";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState } from "react";
import { runTrackerAction } from "../actions";

// How the tracker's components write: every command goes through the page's
// one server action, the outcome goes to the status line, and a success
// re-renders the page from the server with `router.refresh()`.

export interface TrackerStatus {
  kind: "working" | "done" | "error";
  text: string;
}

export interface TrackerRunner {
  /** Runs one command. True when it succeeded. */
  run<N extends TrackerCommandName>(
    command: N,
    input: TrackerCommandInput<N>,
    success: string,
  ): Promise<boolean>;
  /** Copies `text` to the clipboard. */
  copy(text: string, success: string): Promise<boolean>;
  /** Copies a step's prompt and marks the step complete (docs/tracker.md → Backlog). */
  copyPrompt(step: BacklogStepView): Promise<boolean>;
  /** Marks a step complete or not, as its checkbox does. */
  setStepComplete(step: BacklogStepView, complete: boolean): Promise<boolean>;
}

const TrackerContext = createContext<TrackerRunner | null>(null);

export const TrackerProvider = TrackerContext.Provider;

export function useTracker(): TrackerRunner {
  const runner = useContext(TrackerContext);
  if (!runner) throw new Error("useTracker must be used inside TrackerProvider.");
  return runner;
}

/**
 * Writes `content` to the clipboard. Falls back to a hidden textarea and
 * `execCommand("copy")` where the Clipboard API is missing or refused, as on
 * `next dev` reached over plain http by a host name other than localhost.
 */
async function copyText(content: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(content);
      return;
    } catch {
      // Refused (no permission, or the document lost focus): try the fallback.
    }
  }
  const previous = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (previous instanceof HTMLElement) previous.focus();
  if (!copied) throw new Error("The browser refused to copy.");
}

/** The runner for the page, and the status line's current text. */
export function useTrackerRunner(): [TrackerRunner, TrackerStatus | null] {
  const router = useRouter();
  const [status, setStatus] = useState<TrackerStatus | null>(null);

  async function run<N extends TrackerCommandName>(
    command: N,
    input: TrackerCommandInput<N>,
    success: string,
  ): Promise<boolean> {
    setStatus({ kind: "working", text: "Saving…" });
    try {
      const outcome = await runTrackerAction(command, input);
      if (!outcome?.ok) {
        setStatus({ kind: "error", text: outcome?.error ?? "The change was not saved." });
        return false;
      }
    } catch {
      setStatus({ kind: "error", text: "Could not reach the server. Try again." });
      return false;
    }
    setStatus({ kind: "done", text: success });
    router.refresh();
    return true;
  }

  async function copy(text: string, success: string): Promise<boolean> {
    try {
      await copyText(text);
    } catch {
      setStatus({ kind: "error", text: "Could not copy to the clipboard." });
      return false;
    }
    setStatus({ kind: "done", text: success });
    return true;
  }

  async function copyPrompt(step: BacklogStepView): Promise<boolean> {
    if (step.prompt === null) return false;
    if (!(await copy(step.prompt, `Copied the prompt for ${step.label}.`))) return false;
    if (step.completedAt !== null) return true;
    return run(
      "set-step-complete",
      { id: step.id, complete: true },
      `Copied the prompt for ${step.label} and marked the step complete.`,
    );
  }

  function setStepComplete(step: BacklogStepView, complete: boolean): Promise<boolean> {
    return run(
      "set-step-complete",
      { id: step.id, complete },
      complete ? `Marked ${step.label} complete.` : `Marked ${step.label} not complete.`,
    );
  }

  return [{ run, copy, copyPrompt, setStepComplete }, status];
}
