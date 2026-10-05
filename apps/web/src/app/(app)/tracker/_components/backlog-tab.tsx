"use client";

import type {
  BacklogIssueView,
  BacklogPhaseView,
  BacklogStepView,
  NextStepView,
  TrackerScanView,
} from "@hivemind/tracker";
import { issueUrl } from "@hivemind/tracker/constants";
import { useState } from "react";
import { IssueForm, PhaseForm, StepForm } from "./backlog-forms";
import { useTracker } from "./runner";
import { ScanCard } from "./scan-card";
import { DeleteButton, nextSortOrder, TimeText, useEditor } from "./shared";

// The Backlog tab (docs/tracker.md → Backlog): Up next, then phases, their
// GitHub issues and each issue's steps. Copying a prompt marks its step
// complete.

const ADD_PHASE_ID = "tracker-add-phase";

type BacklogEdit =
  | { kind: "phase"; phase: BacklogPhaseView | null }
  | { kind: "issue"; phaseId: string; issue: BacklogIssueView | null }
  | { kind: "step"; issue: BacklogIssueView; step: BacklogStepView | null };

type Editor = ReturnType<typeof useEditor<BacklogEdit>>;

/** An issue with nothing left to do: closed, or every step complete. */
function isFinished(issue: BacklogIssueView): boolean {
  return issue.state === "closed" || issue.steps.every((step) => step.completedAt !== null);
}

function addIssueId(phase: BacklogPhaseView): string {
  return `tracker-add-issue-${phase.id}`;
}

function addStepId(issue: BacklogIssueView): string {
  return `tracker-add-step-${issue.id}`;
}

export function BacklogTab({
  phases,
  nextStep,
  scan,
}: {
  phases: readonly BacklogPhaseView[];
  nextStep: NextStepView | null;
  scan: TrackerScanView | null;
}) {
  const editor = useEditor<BacklogEdit>();
  const [hideFinished, setHideFinished] = useState(false);
  const steps = phases.flatMap((phase) => phase.issues.flatMap((issue) => issue.steps));
  const done = steps.filter((step) => step.completedAt !== null).length;

  return (
    <>
      <div className="tracker-grid">
        <UpNext next={nextStep} />
        <ScanCard kind="backlog" scan={scan} />
      </div>
      <div className="tracker-toolbar">
        <p>
          {done} of {steps.length} steps complete
        </p>
        <label className="tracker-toggle">
          <input
            type="checkbox"
            checked={hideFinished}
            onChange={(event) => setHideFinished(event.currentTarget.checked)}
          />{" "}
          Hide completed issues
        </label>
        <button
          id={ADD_PHASE_ID}
          type="button"
          onClick={() => editor.open({ kind: "phase", phase: null }, ADD_PHASE_ID)}
          aria-expanded={editor.editing?.kind === "phase" && editor.editing.phase === null}
        >
          Add phase
        </button>
      </div>
      {editor.editing?.kind === "phase" && editor.editing.phase === null ? (
        <PhaseForm phase={null} defaultOrder={nextSortOrder(phases)} onClose={editor.close} />
      ) : null}
      {phases.length === 0 ? (
        <p>
          No phases yet. Add one, or run <code>/tracker-backlog-review</code> to backfill the
          backlog.
        </p>
      ) : null}
      {phases.map((phase) => (
        <Phase
          key={phase.id}
          phase={phase}
          phases={phases}
          editor={editor}
          hideFinished={hideFinished}
        />
      ))}
    </>
  );
}

function UpNext({ next }: { next: NextStepView | null }) {
  const { copyPrompt, setStepComplete } = useTracker();
  return (
    <section className="tracker-card tracker-next" aria-labelledby="tracker-up-next">
      <h2 id="tracker-up-next">Up next</h2>
      {next ? (
        <>
          <p>
            <a href={issueUrl(next.issueNumber)}>#{next.issueNumber}</a> {next.issueTitle}{" "}
            <span className="muted">({next.phaseTitle})</span>
          </p>
          <p className="tracker-next-step">{next.step.label}</p>
          {next.step.prompt !== null ? (
            <p>
              <button
                type="button"
                className="tracker-primary"
                onClick={() => void copyPrompt(next.step)}
              >
                Copy prompt<span className="visually-hidden"> for {next.step.label}</span>
              </button>{" "}
              <span className="muted">Copying marks the step complete.</span>
            </p>
          ) : (
            <p>
              <button type="button" onClick={() => void setStepComplete(next.step, true)}>
                Mark complete<span className="visually-hidden"> {next.step.label}</span>
              </button>{" "}
              <span className="muted">This step has no prompt.</span>
            </p>
          )}
        </>
      ) : (
        <p>No unfinished step in an open issue.</p>
      )}
    </section>
  );
}

function Phase({
  phase,
  phases,
  editor,
  hideFinished,
}: {
  phase: BacklogPhaseView;
  phases: readonly BacklogPhaseView[];
  editor: Editor;
  hideFinished: boolean;
}) {
  const { run } = useTracker();
  const { editing } = editor;
  const headingId = `tracker-phase-${phase.id}`;
  const editId = `tracker-edit-phase-${phase.id}`;
  const visible = hideFinished ? phase.issues.filter((issue) => !isFinished(issue)) : phase.issues;
  const hidden = phase.issues.length - visible.length;
  if (hidden > 0 && visible.length === 0 && editing?.kind !== "phase") return null;

  return (
    <section className="tracker-phase" aria-labelledby={headingId}>
      <h2 id={headingId}>{phase.title}</h2>
      {editing?.kind === "phase" && editing.phase?.id === phase.id ? (
        <PhaseForm phase={phase} defaultOrder={phase.sortOrder} onClose={editor.close} />
      ) : (
        <>
          {phase.description ? <p className="tracker-prose muted">{phase.description}</p> : null}
          <div className="tracker-actions">
            <button
              id={editId}
              type="button"
              onClick={() => editor.open({ kind: "phase", phase }, editId)}
            >
              Edit phase<span className="visually-hidden"> {phase.title}</span>
            </button>
            {phase.issues.length === 0 ? (
              <DeleteButton
                label={`phase ${phase.title}`}
                onDelete={async () => {
                  const deleted = await run(
                    "delete-phase",
                    { id: phase.id, updatedAt: phase.updatedAt },
                    `Deleted phase ${phase.title}.`,
                  );
                  if (deleted) document.getElementById(ADD_PHASE_ID)?.focus();
                  return deleted;
                }}
              />
            ) : null}
          </div>
        </>
      )}
      {visible.map((issue) => (
        <Issue key={issue.id} issue={issue} phase={phase} phases={phases} editor={editor} />
      ))}
      {hidden > 0 ? (
        <p className="muted">
          {hidden} completed {hidden === 1 ? "issue" : "issues"} hidden.
        </p>
      ) : null}
      {editing?.kind === "issue" && editing.issue === null && editing.phaseId === phase.id ? (
        <IssueForm
          issue={null}
          phaseId={phase.id}
          phases={phases}
          defaultOrder={nextSortOrder(phase.issues)}
          onClose={editor.close}
        />
      ) : (
        <p>
          <button
            id={addIssueId(phase)}
            type="button"
            onClick={() =>
              editor.open({ kind: "issue", phaseId: phase.id, issue: null }, addIssueId(phase))
            }
          >
            Add issue<span className="visually-hidden"> to {phase.title}</span>
          </button>
        </p>
      )}
    </section>
  );
}

function Issue({
  issue,
  phase,
  phases,
  editor,
}: {
  issue: BacklogIssueView;
  phase: BacklogPhaseView;
  phases: readonly BacklogPhaseView[];
  editor: Editor;
}) {
  const { run } = useTracker();
  const { editing } = editor;
  const headingId = `tracker-issue-${issue.id}`;
  const editId = `tracker-edit-issue-${issue.id}`;
  const done = issue.steps.filter((step) => step.completedAt !== null).length;

  return (
    <article className="tracker-issue" aria-labelledby={headingId}>
      <h3 id={headingId}>
        <a href={issueUrl(issue.issueNumber)}>#{issue.issueNumber}</a> {issue.title}
      </h3>
      {editing?.kind === "issue" && editing.issue?.id === issue.id ? (
        <IssueForm
          issue={issue}
          phaseId={phase.id}
          phases={phases}
          defaultOrder={issue.sortOrder}
          onClose={editor.close}
        />
      ) : (
        <>
          <p className="tracker-meta">
            <span className={`status tracker-issue-${issue.state}`}>
              <span className="visually-hidden">State: </span>
              {issue.state === "open" ? "Open" : "Closed"}
            </span>{" "}
            {done} of {issue.steps.length} steps complete
          </p>
          {issue.note ? <p className="tracker-prose muted">{issue.note}</p> : null}
        </>
      )}
      {issue.steps.length > 0 ? (
        <ol className="tracker-steps" aria-label={`Steps of #${issue.issueNumber}`}>
          {issue.steps.map((step) => (
            <Step key={step.id} step={step} issue={issue} editor={editor} />
          ))}
        </ol>
      ) : (
        <p className="muted">No steps.</p>
      )}
      {editing?.kind === "step" && editing.step === null && editing.issue.id === issue.id ? (
        <StepForm
          issue={issue}
          step={null}
          defaultOrder={nextSortOrder(issue.steps)}
          onClose={editor.close}
        />
      ) : null}
      <div className="tracker-actions">
        <button
          id={addStepId(issue)}
          type="button"
          onClick={() => editor.open({ kind: "step", issue, step: null }, addStepId(issue))}
        >
          Add step<span className="visually-hidden"> to #{issue.issueNumber}</span>
        </button>
        <button
          id={editId}
          type="button"
          onClick={() => editor.open({ kind: "issue", phaseId: phase.id, issue }, editId)}
        >
          Edit issue<span className="visually-hidden"> #{issue.issueNumber}</span>
        </button>
        <DeleteButton
          label={`issue #${issue.issueNumber}`}
          confirmText={`Delete #${issue.issueNumber} and its ${issue.steps.length} ${issue.steps.length === 1 ? "step" : "steps"}?`}
          onDelete={async () => {
            const deleted = await run(
              "delete-issue",
              { issueNumber: issue.issueNumber, updatedAt: issue.updatedAt },
              `Deleted issue #${issue.issueNumber}.`,
            );
            if (deleted) document.getElementById(addIssueId(phase))?.focus();
            return deleted;
          }}
        />
      </div>
    </article>
  );
}

function Step({
  step,
  issue,
  editor,
}: {
  step: BacklogStepView;
  issue: BacklogIssueView;
  editor: Editor;
}) {
  const { run, copyPrompt } = useTracker();
  const { editing } = editor;
  const checkboxId = `tracker-step-${step.id}`;
  const editId = `tracker-edit-step-${step.id}`;

  if (editing?.kind === "step" && editing.step?.id === step.id) {
    return (
      <li>
        <StepForm issue={issue} step={step} defaultOrder={step.sortOrder} onClose={editor.close} />
      </li>
    );
  }
  return (
    <li>
      <div className="tracker-step-head">
        <StepCheckbox step={step} id={checkboxId} />
        <label htmlFor={checkboxId}>{step.label}</label>
        <span className="muted">
          {step.completedAt !== null ? (
            <>
              Completed <TimeText iso={step.completedAt} />
            </>
          ) : (
            "Not complete"
          )}
        </span>
      </div>
      <div className="tracker-actions">
        {step.prompt !== null ? (
          <button type="button" onClick={() => void copyPrompt(step)}>
            Copy prompt<span className="visually-hidden"> for {step.label}</span>
          </button>
        ) : (
          <span className="muted">No prompt.</span>
        )}
        <button
          id={editId}
          type="button"
          onClick={() => editor.open({ kind: "step", issue, step }, editId)}
        >
          Edit step<span className="visually-hidden"> {step.label}</span>
        </button>
        <DeleteButton
          label={`step ${step.label}`}
          onDelete={async () => {
            const deleted = await run(
              "delete-step",
              { id: step.id, updatedAt: step.updatedAt },
              `Deleted step ${step.label}.`,
            );
            if (deleted) document.getElementById(addStepId(issue))?.focus();
            return deleted;
          }}
        />
      </div>
      {step.prompt !== null ? (
        <details>
          <summary>
            Show prompt<span className="visually-hidden"> for {step.label}</span>
          </summary>
          <p className="tracker-hint">Copying text from it also marks the step complete.</p>
          <pre
            onCopy={() => {
              if (step.completedAt === null) {
                void run(
                  "set-step-complete",
                  { id: step.id, complete: true },
                  `Copied from the prompt for ${step.label} and marked the step complete.`,
                );
              }
            }}
          >
            {step.prompt}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

/**
 * A step's completion checkbox. It shows the requested state until the
 * refreshed step arrives (its `updatedAt` changes) or the write fails.
 */
function StepCheckbox({ step, id }: { step: BacklogStepView; id: string }) {
  const { setStepComplete } = useTracker();
  const [requested, setRequested] = useState<{ checked: boolean; at: string } | null>(null);
  const checked =
    requested !== null && requested.at === step.updatedAt
      ? requested.checked
      : step.completedAt !== null;
  return (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => {
        const next = event.currentTarget.checked;
        setRequested({ checked: next, at: step.updatedAt });
        void setStepComplete(step, next).then((saved) => {
          if (!saved) setRequested(null);
        });
      }}
    />
  );
}
