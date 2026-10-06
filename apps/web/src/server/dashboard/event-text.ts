import {
  formatAdrNumber,
  MAX_ADR_NUMBER,
  MIN_ADR_NUMBER,
  UNAVAILABLE_EVENT_TYPE,
} from "@hivemind/contract";

// Plain-text descriptions of Events for the dashboard (issue #11, "Shared
// content"). Callers pass Events through the shared projection first
// (server/event-projection.ts, ADR-0015), so an Event this build cannot read
// arrives as `event.unavailable` and shows a fixed text. Each known type
// still reads only the payload fields its catalog entry
// (packages/db/src/event.ts) defines, each checked for its type; a missing or
// mistyped field is left out rather than shown raw. The result is rendered as
// React-escaped text, except `markdown`, which goes through the dashboard's
// markdown renderer. Payloads are never spread into HTML or props.

export interface EventText {
  /** A one-line description, shown as escaped text. */
  text: string;
  /** Markdown to render below it (a Plan log entry), or null. */
  markdown: string | null;
}

type Payload = Record<string, unknown>;

function asPayload(value: unknown): Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

function str(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function num(payload: Payload, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(payload: Payload, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** At most this many touched paths are listed in one Event's text. */
const MAX_LISTED_PATHS = 16;

function quoted(value: string | null): string {
  return value === null ? "" : ` "${value}"`;
}

function change(from: string | null, to: string | null): string {
  if (from && to) return ` from ${from} to ${to}`;
  if (to) return ` to ${to}`;
  return "";
}

/** The description of an Event of `type` with `payload`, as stored. */
export function describeEvent(type: string, rawPayload: unknown): EventText {
  const payload = asPayload(rawPayload);
  const text = (value: string): EventText => ({ text: value, markdown: null });
  switch (type) {
    case "plan.created":
      return text(`Created Plan ${str(payload, "key") ?? ""}${quoted(str(payload, "title"))}`);
    case "plan.updated": {
      const parts: string[] = [];
      const title = str(payload, "title");
      if (title !== null) parts.push(`renamed the Plan to "${title}"`);
      if (payload.bodyChanged === true) parts.push("edited the Plan body");
      return text(parts.length > 0 ? capitalize(parts.join(" and ")) : "Updated the Plan");
    }
    case "plan.status_changed":
      return text(`Changed the Plan status${change(str(payload, "from"), str(payload, "to"))}`);
    case "plan.log_appended":
      return { text: "Added a log entry", markdown: str(payload, "message") };
    case "task.added": {
      const position = num(payload, "position");
      return text(
        `Added Task${position === null ? "" : ` ${position}`}${quoted(str(payload, "title"))}`,
      );
    }
    case "task.claimed":
      return text(
        str(payload, "stolenFromSessionId")
          ? "Claimed the Task, taking it over from another Session"
          : "Claimed the Task",
      );
    case "task.released": {
      const reason = str(payload, "reason");
      return text(`Released the Task claim${reason ? ` (${reason.replaceAll("_", " ")})` : ""}`);
    }
    case "task.started":
      return text("Started the Task");
    case "task.blocked": {
      const reason = str(payload, "reason");
      return text(`Blocked the Task${reason ? `: ${reason}` : ""}`);
    }
    case "task.done":
      return text("Finished the Task");
    case "session.started": {
      const intent = str(payload, "intent");
      return text(`Started the Session${intent ? `: ${intent}` : ""}`);
    }
    case "session.updated": {
      const fields = strings(payload, "fields");
      return text(`Updated the Session${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`);
    }
    case "session.attached":
      return text("Changed the Session's focus");
    case "session.heartbeat":
      return text(`Heartbeat${change(str(payload, "from"), str(payload, "to"))}`);
    case "session.status_changed":
      return text(`The Session became ${str(payload, "to") ?? "inactive"}`);
    case "session.ended":
      return text("Ended the Session");
    case "scope.added":
      return text(`Declared Scope ${str(payload, "pattern") ?? ""}`.trimEnd());
    case "scope.removed":
      return text(`Removed declared Scope ${str(payload, "pattern") ?? ""}`.trimEnd());
    case "scope.touched": {
      const paths = strings(payload, "paths");
      const listed = paths.slice(0, MAX_LISTED_PATHS).join(", ");
      return text(
        paths.length === 0
          ? "Touched paths"
          : `Touched ${paths.length} ${paths.length === 1 ? "path" : "paths"}: ${listed}`,
      );
    }
    case "scope.collection_finalized": {
      const count = num(payload, "pathCount");
      return text(
        `Finished collecting touched paths${count === null ? "" : ` (${count} ${count === 1 ? "path" : "paths"})`}`,
      );
    }
    case "scope.coverage_lost": {
      const reason = str(payload, "reason");
      return text(
        `Touched-path coverage became incomplete${reason ? ` (${reason.replaceAll("_", " ")})` : ""}`,
      );
    }
    case "adr.reserved":
      return text(`Reserved ${adrKey(num(payload, "number"))}${quoted(str(payload, "title"))}`);
    case "adr.synced": {
      const commit = str(payload, "commitSha");
      const counts = (["added", "updated", "removed"] as const)
        .map((key) => {
          const count = num(payload, key);
          return count === null ? null : `${count} ${key}`;
        })
        .filter((part) => part !== null);
      return text(
        `Synced ADRs${commit ? ` at ${commit.slice(0, 7)}` : ""}${counts.length > 0 ? `: ${counts.join(", ")}` : ""}${payload.forced === true ? " (forced)" : ""}`,
      );
    }
    case UNAVAILABLE_EVENT_TYPE:
      return text("Event details unavailable");
    default:
      return text(`Event ${type}`);
  }
}

/** `ADR-0017` for 17, or "an ADR" when the number is missing or not an ADR number. */
function adrKey(number: number | null): string {
  return number !== null &&
    Number.isInteger(number) &&
    number >= MIN_ADR_NUMBER &&
    number <= MAX_ADR_NUMBER
    ? formatAdrNumber(number)
    : "an ADR";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
