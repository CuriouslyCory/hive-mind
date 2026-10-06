"use client";

import { pullUrl } from "@hivemind/tracker/constants";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { buttonClassName } from "../../../../design-system/button";
import { formatUtc } from "../../_components/format";

// Pieces the tracker's tabs share: forms, fields, times and PR links.

/** A form field's text value, or "" when it is absent. */
export function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

/** A number field's value; NaN when empty, so the server reports the field. */
export function formNumber(data: FormData, name: string): number {
  const value = formText(data, name).trim();
  return value === "" ? Number.NaN : Number(value);
}

/** "12, #14 15" as [12, 14, 15]. Anything else becomes NaN, which the server reports. */
export function parsePrNumbers(raw: string): number[] {
  return raw
    .split(/[\s,]+/)
    .map((part) => part.replace(/^#/, ""))
    .filter((part) => part !== "")
    .map(Number);
}

/** The order for a new row: after the last one. */
export function nextSortOrder(rows: readonly { sortOrder: number }[]): number {
  if (rows.length === 0) return 0;
  return Math.min(10_000, Math.max(...rows.map((row) => row.sortOrder)) + 1);
}

/** A stored time as UTC to the minute; the same text on the server and in the browser. */
export function TimeText({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {formatUtc(new Date(iso))}
    </time>
  );
}

const dayFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

/** A calendar date stored as `YYYY-MM-DD`, as "October 2, 2026". */
export function DateText({ date }: { date: string }) {
  return <time dateTime={date}>{dayFormat.format(new Date(`${date}T00:00:00Z`))}</time>;
}

export function PrLinks({ numbers }: { numbers: readonly number[] }) {
  if (numbers.length === 0) return null;
  return (
    <p className="tracker-prs">
      {numbers.map((number, index) => (
        <Fragment key={number}>
          {index > 0 ? ", " : null}
          <a href={pullUrl(number)}>PR #{number}</a>
        </Fragment>
      ))}
    </p>
  );
}

export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
}

/** A labelled form control, with an optional hint tied to it by `aria-describedby`. */
export function Field({
  label,
  hint,
  wide = false,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={wide ? "tracker-field tracker-field-wide" : "tracker-field"}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": hint ? hintId : undefined })}
      {hint ? (
        <p id={hintId} className="tracker-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const FIRST_CONTROL = "input:not([readonly]):not([disabled]), textarea:not([disabled]), select";

/**
 * An add or edit form. It moves focus to its first editable field when it
 * opens, and ignores a second submit while the first is saving. `onSave`
 * resolves true when the form can close.
 */
export function EditorForm({
  title,
  submitLabel,
  onSave,
  onCancel,
  children,
}: {
  title: string;
  submitLabel: string;
  onSave: (data: FormData) => Promise<boolean>;
  onCancel: () => void;
  children: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>(FIRST_CONTROL)?.focus();
  }, []);

  return (
    <form
      ref={formRef}
      className="tracker-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        void onSave(new FormData(event.currentTarget)).finally(() => setSaving(false));
      }}
    >
      <fieldset>
        <legend>{title}</legend>
        {children}
        <div className="tracker-actions">
          <button type="submit" className={buttonClassName({ variant: "primary" })}>
            {saving ? "Saving…" : submitLabel}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

/**
 * Which row a tab is adding or editing, if any. Closing the form returns
 * focus to the button that opened it.
 */
export function useEditor<T>() {
  const [editing, setEditing] = useState<T | null>(null);
  const opener = useRef<string | null>(null);
  const focusAfterClose = useRef<string | null>(null);

  useEffect(() => {
    if (editing !== null || focusAfterClose.current === null) return;
    document.getElementById(focusAfterClose.current)?.focus();
    focusAfterClose.current = null;
  }, [editing]);

  return {
    editing,
    /** Opens the form for `value`; `openerId` is the button that opened it. */
    open(value: T, openerId: string) {
      opener.current = openerId;
      setEditing(value);
    },
    close() {
      focusAfterClose.current = opener.current;
      setEditing(null);
    },
  };
}

/**
 * A button that asks once more in place, rather than in a dialog, before an
 * action that cannot be undone. `context` names the row, for screen readers.
 * The confirm button is disabled while the action runs, so a double click
 * sends it once; `aria-disabled` rather than `disabled` keeps it focused.
 */
export function ConfirmButton({
  label,
  context,
  confirmText,
  confirmLabel,
  onConfirm,
}: {
  label: string;
  context: string;
  confirmText: string;
  confirmLabel: string;
  /** Resolves true when the action succeeded. */
  onConfirm: () => Promise<boolean>;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const questionId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasArmed = useRef(false);

  useEffect(() => {
    if (armed) confirmRef.current?.focus();
    else if (wasArmed.current) triggerRef.current?.focus();
    wasArmed.current = armed;
  }, [armed]);

  if (!armed) {
    return (
      <button ref={triggerRef} type="button" onClick={() => setArmed(true)}>
        {label}
        <span className="hm-sr-only"> {context}</span>
      </button>
    );
  }
  return (
    <span className="tracker-confirm">
      <span id={questionId}>{confirmText}</span>{" "}
      <button
        ref={confirmRef}
        type="button"
        className={buttonClassName({ variant: "danger" })}
        aria-describedby={questionId}
        aria-disabled={pending}
        onClick={() => {
          if (pendingRef.current) return;
          pendingRef.current = true;
          setPending(true);
          void onConfirm()
            .then((done) => {
              if (!done) setArmed(false);
            })
            .finally(() => {
              pendingRef.current = false;
              setPending(false);
            });
        }}
      >
        {confirmLabel}
        <span className="hm-sr-only"> {context}</span>
      </button>{" "}
      <button type="button" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

/** Delete, confirmed in place. `label` names what is deleted. */
export function DeleteButton({
  label,
  onDelete,
  confirmText,
}: {
  label: string;
  onDelete: () => Promise<boolean>;
  confirmText?: string;
}) {
  return (
    <ConfirmButton
      label="Delete"
      context={label}
      confirmText={confirmText ?? `Delete ${label}?`}
      confirmLabel="Yes, delete"
      onConfirm={onDelete}
    />
  );
}
