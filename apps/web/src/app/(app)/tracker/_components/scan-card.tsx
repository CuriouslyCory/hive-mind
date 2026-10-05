"use client";

import type { ScanKind, TrackerScanView } from "@hivemind/tracker";
import { TRACKER_SCAN_SKILLS } from "@hivemind/tracker/constants";
import { useRef, useState } from "react";
import { useTracker } from "./runner";
import { Field, formText, TimeText } from "./shared";

// A scan card (docs/tracker.md → Scan cards): when an agent last ran the
// skill, how far it read, the command to copy, and a form to record a run by
// hand.

const SCAN_TITLES: Record<ScanKind, string> = {
  git_history: "Git history scan",
  backlog: "Backlog review",
};

export function ScanCard({ kind, scan }: { kind: ScanKind; scan: TrackerScanView | null }) {
  const { run, copy } = useTracker();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [saving, setSaving] = useState(false);
  const command = `/${TRACKER_SCAN_SKILLS[kind]}`;
  const isGit = kind === "git_history";
  const title = SCAN_TITLES[kind];
  const headingId = `tracker-scan-${kind}`;

  return (
    <section className="tracker-card" aria-labelledby={headingId} data-testid={`scan-${kind}`}>
      <h2 id={headingId}>{title}</h2>
      <dl className="tracker-facts">
        <div>
          <dt>Completed</dt>
          <dd>{scan ? <TimeText iso={scan.completedAt} /> : "Never"}</dd>
        </div>
        <div>
          <dt>Cursor</dt>
          <dd>
            {scan ? (
              <code>
                <time dateTime={scan.throughAt}>{scan.throughAt}</time>
              </code>
            ) : (
              "None"
            )}
          </dd>
        </div>
        {isGit ? (
          <div>
            <dt>Commit</dt>
            <dd>
              {scan?.throughSha ? (
                <code title={scan.throughSha}>{scan.throughSha.slice(0, 7)}</code>
              ) : (
                "None"
              )}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Note</dt>
          <dd className="tracker-prose">{scan?.note ?? "None"}</dd>
        </div>
      </dl>
      <p>
        <button type="button" onClick={() => void copy(command, `Copied ${command}.`)}>
          Copy {command}
        </button>{" "}
        <span className="muted">
          Run it in a fresh Claude Code conversation; it reads this cursor with the tracker CLI.
        </span>
      </p>
      <details ref={detailsRef}>
        <summary>Record a completed {title}</summary>
        <form
          className="tracker-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (saving) return;
            const form = event.currentTarget;
            const data = new FormData(form);
            setSaving(true);
            void run(
              "record-scan",
              {
                kind,
                throughAt: formText(data, "throughAt").trim(),
                throughSha: isGit ? formText(data, "throughSha").trim() : null,
                note: formText(data, "note"),
              },
              `Recorded the ${title}.`,
            )
              .then((saved) => {
                if (!saved) return;
                form.reset();
                if (detailsRef.current) detailsRef.current.open = false;
              })
              .finally(() => setSaving(false));
          }}
        >
          <fieldset>
            <legend className="visually-hidden">Record a completed {title}</legend>
            <Field
              label="Cursor"
              hint={
                isGit
                  ? "ISO 8601 time with offset: the newest mergedAt among the PRs reviewed, not the completion time."
                  : "ISO 8601 time with offset: the newest GitHub updatedAt among the issues reviewed."
              }
            >
              {(props) => (
                <input
                  {...props}
                  name="throughAt"
                  required
                  defaultValue={scan?.throughAt ?? ""}
                  placeholder="2026-10-02T04:44:37Z"
                />
              )}
            </Field>
            {isGit ? (
              <Field
                label="Commit SHA"
                hint="The exact origin/main commit reviewed, 40 hex characters."
              >
                {(props) => (
                  <input
                    {...props}
                    name="throughSha"
                    required
                    pattern="[0-9a-f]{40}"
                    defaultValue={scan?.throughSha ?? ""}
                    className="tracker-mono"
                  />
                )}
              </Field>
            ) : null}
            <Field label="Note" wide>
              {(props) => <textarea {...props} name="note" rows={2} />}
            </Field>
            <div className="tracker-actions">
              <button type="submit" className="tracker-primary">
                {saving ? "Saving…" : "Record scan"}
              </button>
            </div>
          </fieldset>
        </form>
      </details>
    </section>
  );
}
