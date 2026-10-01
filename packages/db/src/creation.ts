import { eq } from "drizzle-orm";
import type { Transaction } from "./coordination.ts";
import { type Principal, samePrincipal, sessionOwner } from "./principal.ts";
import {
  type AgentSession,
  agentSession,
  type Plan,
  plan,
  type Task,
  task,
} from "./schema/coordination.ts";
import { type Event, event } from "./schema/event.ts";

// Creation replay (issue #12, "Transaction, identity and Event invariants").
// Plan, Task and Session creation and Plan log appends take a UUID the client
// generated once, so a client that lost the response can retry safely. The
// server stores a fingerprint of the original input and the authenticated
// principal with the record, and a retry is recognized by comparing them,
// never the record's current (possibly edited) fields.

/** What a caller-supplied UUID creates. A Plan log entry is a `plan.log_appended` Event. */
export type CreationKind = "plan" | "task" | "session" | "plan_log";

export interface CreationRows {
  plan: Plan;
  task: Task;
  session: AgentSession;
  plan_log: Event;
}

export interface CreationRequest<K extends CreationKind> {
  kind: K;
  projectId: string;
  /** The caller's UUID for the new record. */
  id: string;
  /** The authenticated caller, derived by the server. */
  principal: Principal;
  /** `creationFingerprint` (src/fingerprint.ts) of the creation input. */
  fingerprint: string;
}

export type CreationOutcome<R> =
  /** The UUID was free; `create` ran and returned this row. */
  | { status: "created"; row: R }
  /**
   * The same principal already created this record from the same input in
   * this Project. Return it with `created: false` and write no Event.
   */
  | { status: "replay"; row: R }
  /**
   * The UUID is taken in this Project by a different principal, different
   * input, or a different kind of record. A generic 409.
   */
  | { status: "conflict" }
  /**
   * The UUID is taken in another Project. Answer exactly as for an absent
   * resource, disclosing nothing about that record.
   */
  | { status: "not_found" };

interface StoredCreation {
  projectId: string;
  /** Whether the stored record is the kind of creation requested. */
  sameAction: boolean;
  principal: Principal | null;
  fingerprint: string | null;
}

async function findCreation<K extends CreationKind>(
  tx: Transaction,
  kind: K,
  id: string,
): Promise<{ row: CreationRows[K]; stored: StoredCreation } | undefined> {
  if (kind === "plan" || kind === "task") {
    const table = kind === "plan" ? plan : task;
    const [row] = await tx.select().from(table).where(eq(table.id, id)).limit(1);
    if (!row) return undefined;
    return {
      row: row as CreationRows[K],
      stored: {
        projectId: row.projectId,
        sameAction: true,
        principal:
          row.createdByKind === "user" && row.createdByUserId
            ? { kind: "user", userId: row.createdByUserId }
            : row.createdByKind === "project_key" && row.createdByKeyId
              ? { kind: "project_key", keyId: row.createdByKeyId }
              : null,
        fingerprint: row.creationFingerprint,
      },
    };
  }
  if (kind === "session") {
    const [row] = await tx.select().from(agentSession).where(eq(agentSession.id, id)).limit(1);
    if (!row) return undefined;
    return {
      row: row as CreationRows[K],
      stored: {
        projectId: row.projectId,
        sameAction: true,
        principal: sessionOwner(row),
        fingerprint: row.creationFingerprint,
      },
    };
  }
  const [row] = await tx.select().from(event).where(eq(event.id, id)).limit(1);
  if (!row) return undefined;
  return {
    row: row as CreationRows[K],
    stored: {
      projectId: row.projectId,
      sameAction: row.type === "plan.log_appended",
      principal:
        row.actorKind === "user" && row.actorUserId
          ? { kind: "user", userId: row.actorUserId }
          : row.actorKind === "project_key" && row.actorKeyId
            ? { kind: "project_key", keyId: row.actorKeyId }
            : null,
      fingerprint: row.creationFingerprint,
    },
  };
}

function judge<R>(
  request: CreationRequest<CreationKind>,
  found: { row: R; stored: StoredCreation },
): CreationOutcome<R> {
  const { stored } = found;
  // Checked first, so nothing about another Project's record shapes the answer.
  if (stored.projectId !== request.projectId) return { status: "not_found" };
  const same =
    stored.sameAction &&
    stored.principal !== null &&
    samePrincipal(stored.principal, request.principal) &&
    stored.fingerprint === request.fingerprint;
  return same ? { status: "replay", row: found.row } : { status: "conflict" };
}

const PRIMARY_KEYS: Record<CreationKind, string> = {
  plan: "plan_pkey",
  task: "task_pkey",
  session: "agent_session_pkey",
  plan_log: "event_pkey",
};

/** Whether `error` (or the driver error Drizzle wraps in `cause`) violated `constraint`. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { code?: unknown }).code === "23505" &&
      (candidate as { constraint?: unknown }).constraint === constraint,
  );
}

/**
 * Creates a record under a caller-supplied UUID, or recognizes a retry of an
 * earlier creation. Looks the UUID up first; if it is free, runs `create`,
 * which must insert the record with `request.id`, its fingerprint and
 * principal, together with its Event. Run it inside `withCoordinationLock` for
 * `request.projectId`, before allocating anything (such as a Plan number) that
 * a replay must not consume.
 *
 * `create` runs in a savepoint. If a transaction for another Project inserts
 * the same UUID concurrently, the insert fails on the primary key once that
 * transaction commits; the savepoint is rolled back (with any Event `create`
 * wrote) and the UUID is looked up again, which then answers `not_found`.
 */
export async function createOnce<K extends CreationKind>(
  tx: Transaction,
  request: CreationRequest<K>,
  create: (tx: Transaction) => Promise<CreationRows[K]>,
): Promise<CreationOutcome<CreationRows[K]>> {
  const existing = await findCreation(tx, request.kind, request.id);
  if (existing) return judge(request, existing);

  try {
    const row = await tx.transaction((savepoint) => create(savepoint));
    return { status: "created", row };
  } catch (error) {
    if (!isUniqueViolation(error, PRIMARY_KEYS[request.kind])) throw error;
    const winner = await findCreation(tx, request.kind, request.id);
    if (!winner) throw error;
    return judge(request, winner);
  }
}
