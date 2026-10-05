"use client";

import type { ChangelogEntryView, TrackerScanView } from "@hivemind/tracker";
import { useTracker } from "./runner";
import { ScanCard } from "./scan-card";
import {
  DateText,
  DeleteButton,
  EditorForm,
  Field,
  formText,
  PrLinks,
  parsePrNumbers,
  useEditor,
} from "./shared";

// The Changelog tab (docs/tracker.md → Changelog): entries grouped by UTC
// merge date, newest first, as the snapshot orders them.

const ADD_ENTRY_ID = "tracker-add-entry";

function groupByDate(entries: readonly ChangelogEntryView[]): [string, ChangelogEntryView[]][] {
  const groups = new Map<string, ChangelogEntryView[]>();
  for (const entry of entries) {
    const group = groups.get(entry.date);
    if (group) group.push(entry);
    else groups.set(entry.date, [entry]);
  }
  return [...groups];
}

export function ChangelogTab({
  entries,
  scan,
}: {
  entries: readonly ChangelogEntryView[];
  scan: TrackerScanView | null;
}) {
  const editor = useEditor<ChangelogEntryView | "new">();

  return (
    <>
      <ScanCard kind="git_history" scan={scan} />
      <div className="tracker-toolbar">
        <p className="muted">Entries share a date when their PRs merged on that UTC day.</p>
        <button
          id={ADD_ENTRY_ID}
          type="button"
          onClick={() => editor.open("new", ADD_ENTRY_ID)}
          aria-expanded={editor.editing === "new"}
        >
          Add entry
        </button>
      </div>
      {editor.editing === "new" ? <EntryForm entry={null} onClose={editor.close} /> : null}
      {entries.length === 0 ? (
        <p>
          No changelog entries yet. Run <code>/tracker-git-scan</code> to backfill them.
        </p>
      ) : null}
      {groupByDate(entries).map(([date, dayEntries]) => (
        <section key={date} aria-labelledby={`tracker-day-${date}`}>
          <h2 id={`tracker-day-${date}`} className="tracker-day">
            <DateText date={date} />
          </h2>
          {dayEntries.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              editing={editor.editing !== "new" && editor.editing?.id === entry.id}
              onEdit={(openerId) => editor.open(entry, openerId)}
              onClose={editor.close}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function Entry({
  entry,
  editing,
  onEdit,
  onClose,
}: {
  entry: ChangelogEntryView;
  editing: boolean;
  onEdit: (openerId: string) => void;
  onClose: () => void;
}) {
  const { run } = useTracker();
  const editId = `tracker-edit-entry-${entry.id}`;
  return (
    <article className="tracker-item" aria-labelledby={`tracker-entry-${entry.id}`}>
      <h3 id={`tracker-entry-${entry.id}`}>{entry.title}</h3>
      {editing ? (
        <EntryForm entry={entry} onClose={onClose} />
      ) : (
        <>
          <p className="tracker-meta">
            <span className="status">
              <span className="visually-hidden">Category: </span>
              {entry.category}
            </span>
          </p>
          <p className="tracker-prose">{entry.summary}</p>
          <PrLinks numbers={entry.prNumbers} />
          <div className="tracker-actions">
            <button id={editId} type="button" onClick={() => onEdit(editId)}>
              Edit<span className="visually-hidden"> {entry.title}</span>
            </button>
            <DeleteButton
              label={entry.title}
              onDelete={async () => {
                const deleted = await run(
                  "delete-changelog-entry",
                  { id: entry.id, updatedAt: entry.updatedAt },
                  `Deleted ${entry.title}.`,
                );
                if (deleted) document.getElementById(ADD_ENTRY_ID)?.focus();
                return deleted;
              }}
            />
          </div>
        </>
      )}
    </article>
  );
}

function EntryForm({ entry, onClose }: { entry: ChangelogEntryView | null; onClose: () => void }) {
  const { run } = useTracker();
  return (
    <EditorForm
      title={entry ? "Edit entry" : "New changelog entry"}
      submitLabel="Save entry"
      onCancel={onClose}
      onSave={async (data) => {
        const saved = await run(
          "save-changelog-entry",
          {
            id: entry?.id,
            updatedAt: entry?.updatedAt,
            date: formText(data, "date"),
            category: formText(data, "category"),
            title: formText(data, "title"),
            summary: formText(data, "summary"),
            prNumbers: parsePrNumbers(formText(data, "prNumbers")),
          },
          entry ? "Changelog entry saved." : "Changelog entry added.",
        );
        if (saved) onClose();
        return saved;
      }}
    >
      <Field label="UTC merge date">
        {(props) => (
          <input {...props} name="date" type="date" required defaultValue={entry?.date ?? ""} />
        )}
      </Field>
      <Field label="Category" hint="One of the categories defined in /tracker-git-scan.">
        {(props) => (
          <input {...props} name="category" required defaultValue={entry?.category ?? ""} />
        )}
      </Field>
      <Field label="Title" wide>
        {(props) => <input {...props} name="title" required defaultValue={entry?.title ?? ""} />}
      </Field>
      <Field label="What changed for users" wide>
        {(props) => (
          <textarea
            {...props}
            name="summary"
            required
            rows={4}
            defaultValue={entry?.summary ?? ""}
          />
        )}
      </Field>
      <Field label="PR numbers" hint="Separated by commas or spaces." wide>
        {(props) => (
          <input {...props} name="prNumbers" defaultValue={entry?.prNumbers.join(", ") ?? ""} />
        )}
      </Field>
    </EditorForm>
  );
}
