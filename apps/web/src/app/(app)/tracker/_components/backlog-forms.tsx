"use client";

import type {
  BacklogIssueView,
  BacklogPhaseView,
  BacklogStepView,
  IssueState,
} from "@hivemind/tracker";
import { useTracker } from "./runner";
import { EditorForm, Field, formNumber, formText } from "./shared";

// The Backlog tab's add and edit forms. Each closes itself on success and
// stays open, with the server's message in the status line, on failure.

export function PhaseForm({
  phase,
  defaultOrder,
  onClose,
}: {
  phase: BacklogPhaseView | null;
  defaultOrder: number;
  onClose: () => void;
}) {
  const { run } = useTracker();
  return (
    <EditorForm
      title={phase ? "Edit phase" : "New phase"}
      submitLabel="Save phase"
      onCancel={onClose}
      onSave={async (data) => {
        const saved = await run(
          "save-phase",
          {
            id: phase?.id,
            updatedAt: phase?.updatedAt,
            title: formText(data, "title"),
            description: formText(data, "description"),
            sortOrder: formNumber(data, "sortOrder"),
          },
          phase ? "Phase saved." : "Phase added.",
        );
        if (saved) onClose();
        return saved;
      }}
    >
      <Field label="Phase title">
        {(props) => <input {...props} name="title" required defaultValue={phase?.title ?? ""} />}
      </Field>
      <Field label="Order">
        {(props) => (
          <input
            {...props}
            name="sortOrder"
            type="number"
            min={0}
            max={10_000}
            required
            defaultValue={defaultOrder}
          />
        )}
      </Field>
      <Field label="Why this phase comes here" wide>
        {(props) => (
          <textarea
            {...props}
            name="description"
            rows={2}
            defaultValue={phase?.description ?? ""}
          />
        )}
      </Field>
    </EditorForm>
  );
}

const ISSUE_STATES = ["open", "closed"] as const satisfies readonly IssueState[];

export function IssueForm({
  issue,
  phaseId,
  phases,
  defaultOrder,
  onClose,
}: {
  issue: BacklogIssueView | null;
  phaseId: string;
  phases: readonly BacklogPhaseView[];
  defaultOrder: number;
  onClose: () => void;
}) {
  const { run } = useTracker();
  return (
    <EditorForm
      title={issue ? `Edit issue #${issue.issueNumber}` : "New issue"}
      submitLabel="Save issue"
      onCancel={onClose}
      onSave={async (data) => {
        const state = ISSUE_STATES.find((value) => value === formText(data, "state")) ?? "open";
        const fields = {
          issueNumber: issue ? issue.issueNumber : formNumber(data, "issueNumber"),
          title: formText(data, "title"),
          note: formText(data, "note"),
          phaseId: formText(data, "phaseId"),
          sortOrder: formNumber(data, "sortOrder"),
          state,
          githubUpdatedAt: formText(data, "githubUpdatedAt").trim() || null,
        };
        const saved = await run(
          "save-issue",
          issue
            ? { mode: "update", updatedAt: issue.updatedAt, ...fields }
            : { mode: "create", ...fields },
          issue ? `Issue #${issue.issueNumber} saved.` : `Issue #${fields.issueNumber} added.`,
        );
        if (saved) onClose();
        return saved;
      }}
    >
      <Field
        label="GitHub issue number"
        hint={
          issue
            ? "The issue number cannot change."
            : "New issues get the default Plan and Implement steps."
        }
      >
        {(props) => (
          <input
            {...props}
            name="issueNumber"
            type="number"
            min={1}
            required
            readOnly={issue !== null}
            defaultValue={issue?.issueNumber ?? ""}
          />
        )}
      </Field>
      <Field label="Title">
        {(props) => <input {...props} name="title" required defaultValue={issue?.title ?? ""} />}
      </Field>
      <Field label="Phase">
        {(props) => (
          <select {...props} name="phaseId" defaultValue={phaseId}>
            {phases.map((phase) => (
              <option key={phase.id} value={phase.id}>
                {phase.title}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Order within the phase">
        {(props) => (
          <input
            {...props}
            name="sortOrder"
            type="number"
            min={0}
            max={10_000}
            required
            defaultValue={defaultOrder}
          />
        )}
      </Field>
      <Field label="GitHub state">
        {(props) => (
          <select {...props} name="state" defaultValue={issue?.state ?? "open"}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        )}
      </Field>
      <Field label="GitHub updatedAt" hint="ISO 8601 time with offset; empty if unknown.">
        {(props) => (
          <input
            {...props}
            name="githubUpdatedAt"
            placeholder="2026-10-02T04:44:37Z"
            defaultValue={issue?.githubUpdatedAt ?? ""}
          />
        )}
      </Field>
      <Field label="Context or dependency" wide>
        {(props) => <textarea {...props} name="note" rows={2} defaultValue={issue?.note ?? ""} />}
      </Field>
    </EditorForm>
  );
}

export function StepForm({
  issue,
  step,
  defaultOrder,
  onClose,
}: {
  issue: BacklogIssueView;
  step: BacklogStepView | null;
  defaultOrder: number;
  onClose: () => void;
}) {
  const { run } = useTracker();
  return (
    <EditorForm
      title={step ? `Edit step of #${issue.issueNumber}` : `New step for #${issue.issueNumber}`}
      submitLabel="Save step"
      onCancel={onClose}
      onSave={async (data) => {
        const saved = await run(
          "save-step",
          {
            id: step?.id,
            updatedAt: step?.updatedAt,
            issueNumber: issue.issueNumber,
            key: formText(data, "key"),
            label: formText(data, "label"),
            prompt: formText(data, "prompt"),
            sortOrder: formNumber(data, "sortOrder"),
          },
          step ? "Step saved." : "Step added.",
        );
        if (saved) onClose();
        return saved;
      }}
    >
      <Field label="Step key" hint="Unique within the issue, for example plan.">
        {(props) => <input {...props} name="key" required defaultValue={step?.key ?? ""} />}
      </Field>
      <Field label="Order">
        {(props) => (
          <input
            {...props}
            name="sortOrder"
            type="number"
            min={0}
            max={10_000}
            required
            defaultValue={defaultOrder}
          />
        )}
      </Field>
      <Field label="Step label" wide>
        {(props) => <input {...props} name="label" required defaultValue={step?.label ?? ""} />}
      </Field>
      <Field
        label="Prompt"
        hint="Written to be pasted as the first message of a fresh Claude Code conversation."
        wide
      >
        {(props) => (
          <textarea
            {...props}
            name="prompt"
            rows={10}
            className="tracker-mono"
            defaultValue={step?.prompt ?? ""}
          />
        )}
      </Field>
    </EditorForm>
  );
}
