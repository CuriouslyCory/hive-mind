"use client";

import type { BlogIdeaView, BlogStatus } from "@hivemind/tracker";
import { useTracker } from "./runner";
import {
  ConfirmButton,
  DeleteButton,
  EditorForm,
  Field,
  formNumber,
  formText,
  nextSortOrder,
  PrLinks,
  parsePrNumbers,
  TimeText,
  useEditor,
} from "./shared";

// The Blog tab (docs/tracker.md → Blog). A published idea is locked: its
// form disables every field but the publication date, URL and order, and it
// has no Delete button. `@hivemind/tracker` enforces the same rules.

const ADD_IDEA_ID = "tracker-add-idea";

const BLOG_STATUSES = ["idea", "draft", "published"] as const satisfies readonly BlogStatus[];

const STATUS_TEXT: Record<BlogStatus, string> = {
  idea: "Idea",
  draft: "Draft",
  published: "Published",
};

export function BlogTab({ ideas }: { ideas: readonly BlogIdeaView[] }) {
  const editor = useEditor<BlogIdeaView | "new">();
  return (
    <>
      <div className="tracker-toolbar">
        <p className="muted">
          Ideas for announcement posts. A published idea is locked and cannot be deleted.
        </p>
        <button
          id={ADD_IDEA_ID}
          type="button"
          onClick={() => editor.open("new", ADD_IDEA_ID)}
          aria-expanded={editor.editing === "new"}
        >
          Add idea
        </button>
      </div>
      {editor.editing === "new" ? (
        <IdeaForm idea={null} defaultOrder={nextSortOrder(ideas)} onClose={editor.close} />
      ) : null}
      {ideas.length === 0 ? <p>No blog ideas yet.</p> : null}
      {ideas.map((idea) => (
        <Idea
          key={idea.id}
          idea={idea}
          editing={editor.editing !== "new" && editor.editing?.id === idea.id}
          onEdit={(openerId) => editor.open(idea, openerId)}
          onClose={editor.close}
        />
      ))}
    </>
  );
}

function Idea({
  idea,
  editing,
  onEdit,
  onClose,
}: {
  idea: BlogIdeaView;
  editing: boolean;
  onEdit: (openerId: string) => void;
  onClose: () => void;
}) {
  const { run } = useTracker();
  const published = idea.status === "published";
  const editId = `tracker-edit-idea-${idea.id}`;
  return (
    <article className="tracker-item" aria-labelledby={`tracker-idea-${idea.id}`}>
      <h2 id={`tracker-idea-${idea.id}`} className="tracker-item-title">
        {idea.title}
      </h2>
      {editing ? (
        <IdeaForm idea={idea} defaultOrder={idea.sortOrder} onClose={onClose} />
      ) : (
        <>
          <p className="tracker-meta">
            <span className={`status tracker-blog-${idea.status}`}>
              <span className="visually-hidden">Status: </span>
              {STATUS_TEXT[idea.status]}
            </span>
            {idea.publishedAt ? (
              <>
                {" "}
                on <TimeText iso={idea.publishedAt} />
              </>
            ) : null}
            <span className="muted"> · order {idea.sortOrder}</span>
          </p>
          <p className="tracker-prose">{idea.pitch}</p>
          {idea.notes ? <p className="tracker-prose muted">{idea.notes}</p> : null}
          <PrLinks numbers={idea.prNumbers} />
          {idea.publishedUrl ? (
            <p>
              <a href={idea.publishedUrl}>Read the published post</a>
            </p>
          ) : null}
          <div className="tracker-actions">
            <button id={editId} type="button" onClick={() => onEdit(editId)}>
              {published ? "Edit publication details" : "Edit"}
              <span className="visually-hidden"> of {idea.title}</span>
            </button>
            {published ? null : (
              <>
                <MarkPublished idea={idea} />
                <DeleteButton
                  label={idea.title}
                  onDelete={async () => {
                    const deleted = await run(
                      "delete-blog-idea",
                      { id: idea.id, updatedAt: idea.updatedAt },
                      `Deleted ${idea.title}.`,
                    );
                    if (deleted) document.getElementById(ADD_IDEA_ID)?.focus();
                    return deleted;
                  }}
                />
              </>
            )}
          </div>
        </>
      )}
    </article>
  );
}

/** Publishes an idea dated now. Asks first: a published idea is locked for good. */
function MarkPublished({ idea }: { idea: BlogIdeaView }) {
  const { run } = useTracker();
  return (
    <ConfirmButton
      label="Mark published"
      context={idea.title}
      confirmText="Publishing locks this idea for good. Mark it published?"
      confirmLabel="Yes, mark published"
      onConfirm={() =>
        run(
          "save-blog-idea",
          {
            id: idea.id,
            updatedAt: idea.updatedAt,
            title: idea.title,
            pitch: idea.pitch,
            notes: idea.notes,
            prNumbers: idea.prNumbers,
            status: "published",
            publishedAt: null,
            publishedUrl: idea.publishedUrl,
            sortOrder: idea.sortOrder,
          },
          `Marked ${idea.title} published.`,
        )
      }
    />
  );
}

function IdeaForm({
  idea,
  defaultOrder,
  onClose,
}: {
  idea: BlogIdeaView | null;
  defaultOrder: number;
  onClose: () => void;
}) {
  const { run } = useTracker();
  const locked = idea?.status === "published" ? idea : null;
  return (
    <EditorForm
      title={idea ? (locked ? "Edit publication details" : "Edit idea") : "New blog idea"}
      submitLabel="Save idea"
      onCancel={onClose}
      onSave={async (data) => {
        const status = BLOG_STATUSES.find((value) => value === formText(data, "status")) ?? "idea";
        const saved = await run(
          "save-blog-idea",
          {
            id: idea?.id,
            updatedAt: idea?.updatedAt,
            // Disabled fields are not submitted; a locked idea sends what it has.
            title: locked ? locked.title : formText(data, "title"),
            pitch: locked ? locked.pitch : formText(data, "pitch"),
            notes: locked ? locked.notes : formText(data, "notes"),
            prNumbers: locked ? locked.prNumbers : parsePrNumbers(formText(data, "prNumbers")),
            status: locked ? "published" : status,
            publishedAt: formText(data, "publishedAt") || null,
            publishedUrl: formText(data, "publishedUrl"),
            sortOrder: formNumber(data, "sortOrder"),
          },
          idea ? "Blog idea saved." : "Blog idea added.",
        );
        if (saved) onClose();
        return saved;
      }}
    >
      {locked ? (
        <p className="tracker-field-wide tracker-hint">
          Published: only the publication date, URL and order can change.
        </p>
      ) : null}
      <Field label="Working title" wide>
        {(props) => (
          <input
            {...props}
            name="title"
            required
            disabled={locked !== null}
            defaultValue={idea?.title ?? ""}
          />
        )}
      </Field>
      <Field label="Reader promise" wide>
        {(props) => (
          <textarea
            {...props}
            name="pitch"
            required
            rows={3}
            disabled={locked !== null}
            defaultValue={idea?.pitch ?? ""}
          />
        )}
      </Field>
      <Field label="Editorial notes" wide>
        {(props) => (
          <textarea
            {...props}
            name="notes"
            rows={3}
            disabled={locked !== null}
            defaultValue={idea?.notes ?? ""}
          />
        )}
      </Field>
      <Field label="PR numbers" hint="Separated by commas or spaces." wide>
        {(props) => (
          <input
            {...props}
            name="prNumbers"
            disabled={locked !== null}
            defaultValue={idea?.prNumbers.join(", ") ?? ""}
          />
        )}
      </Field>
      <Field label="Status" hint="Published is final.">
        {(props) => (
          <select
            {...props}
            name="status"
            disabled={locked !== null}
            defaultValue={idea?.status ?? "idea"}
          >
            {BLOG_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_TEXT[value]}
              </option>
            ))}
          </select>
        )}
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
      <Field
        label="Published date"
        hint="Published ideas only; empty means today or the stored date."
      >
        {(props) => (
          <input
            {...props}
            name="publishedAt"
            type="date"
            defaultValue={idea?.publishedAt?.slice(0, 10) ?? ""}
          />
        )}
      </Field>
      <Field label="Published URL" hint="Published ideas only.">
        {(props) => (
          <input
            {...props}
            name="publishedUrl"
            type="url"
            placeholder="https://"
            defaultValue={idea?.publishedUrl ?? ""}
          />
        )}
      </Field>
    </EditorForm>
  );
}
