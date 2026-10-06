import { and, asc, desc, eq, inArray, isNotNull, ne, or, type SQL, sql } from "drizzle-orm";
import {
  allocatePlanNumber,
  type CoordinationContext,
  type Transaction,
  withAuthorizedCoordinationLock,
  withCoordinationRead,
} from "./coordination.ts";
import { createOnce } from "./creation.ts";
import { insertEvent } from "./event.ts";
import { creationFingerprint } from "./fingerprint.ts";
import type { Db } from "./index.ts";
import { releaseClaims } from "./lifecycle.ts";
import { effectiveSessionStatus, isClaimUsable, type SessionLiveness } from "./liveness.ts";
import {
  type Actor,
  creatorColumns,
  type Principal,
  samePrincipal,
  sessionOwner,
} from "./principal.ts";
import {
  agentSession,
  type Plan,
  type PlanStatus,
  plan,
  type Task,
  type TaskStatus,
  task,
} from "./schema/coordination.ts";
import type { Event } from "./schema/event.ts";

// Plans, Tasks added to them and Plan log entries (issue #12 step 5;
// ADR-0014). Every mutation runs under the Project's coordination lock and
// writes its Event in the same transaction; reads use one database time.
// Results are plain outcome unions: apps/web maps them to API errors.
//
// The caller has already authorized the principal for the Project. These
// functions still check that the optional actor Session belongs to that
// principal in that Project, since the Session is a nested resource.

/** A Plan's Project-local key: `PLAN-` and its number. */
export function planKey(number: number): string {
  return `PLAN-${number}`;
}

const PLAN_KEY = /^PLAN-([1-9][0-9]{0,8})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Allowed Plan transitions. `done` and `abandoned` are terminal. */
export const PLAN_TRANSITIONS: { readonly [S in PlanStatus]: readonly PlanStatus[] } = {
  draft: ["active", "abandoned"],
  active: ["paused", "done", "abandoned"],
  paused: ["active", "done", "abandoned"],
  done: [],
  abandoned: [],
};

/** Statuses a Plan can be created in. */
export type InitialPlanStatus = Extract<PlanStatus, "draft" | "active">;

/** Statuses `setPlanStatus` can move a Plan to; a Plan never returns to `draft`. */
export type TargetPlanStatus = Exclude<PlanStatus, "draft">;

export function isTerminalPlanStatus(status: PlanStatus): boolean {
  return status === "done" || status === "abandoned";
}

/**
 * Text Postgres cannot store: `text` and `jsonb` reject NUL. The API's input
 * schemas already refuse control characters; this keeps any other caller
 * from reaching the database with one.
 */
export class UnstorableTextError extends Error {
  constructor(field: string) {
    super(`${field} contains a NUL character, which cannot be stored.`);
    this.name = "UnstorableTextError";
  }
}

export function assertStorableText(fields: Record<string, string | null | undefined>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value?.includes("\u0000")) throw new UnstorableTextError(field);
  }
}

export interface PlanProgress {
  total: number;
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
}

/** A Plan row with its Task counts by status, read in the same transaction. */
export interface PlanView {
  plan: Plan;
  progress: PlanProgress;
}

/** A claim as readers see it: only a usable one (see `isClaimUsable`). */
export interface UsableClaim {
  sessionId: string;
  claimedAt: Date;
  leaseExpiresAt: Date;
}

/** A Task row with its Plan's number and its claim if usable at the read's time. */
export interface TaskView {
  task: Task;
  planNumber: number;
  claim: UsableClaim | null;
}

/** Who writes a Plan change: the authorized principal and, optionally, its Session. */
export interface PlanWriter {
  projectId: string;
  principal: Principal;
  /** The actor Session; must be the principal's own in this Project and not ended or abandoned. */
  sessionId?: string | null;
}

/** The optional actor Session is not the principal's own Session in this Project. */
export type SessionNotFound = { status: "session_not_found" };
/** The optional actor Session is in this Project but owned by another principal. */
export type SessionForbidden = { status: "session_forbidden" };
/** The optional actor Session is ended or effectively abandoned. */
export type SessionEnded = { status: "session_ended" };
/** The Plan reference matches no Plan in the Project. */
export type PlanNotFound = { status: "plan_not_found" };
/** The Plan is done or abandoned, so it accepts no edits or new Tasks. */
export type PlanClosed = { status: "plan_closed"; planStatus: PlanStatus };

/**
 * Creation outcomes (see `createOnce`): `conflict` is the UUID reused with
 * other input or by another principal; `id_not_found` is the UUID taken in
 * another Project, answered like an absent resource.
 */
export type CreationFailure = { status: "conflict" } | { status: "id_not_found" };

// An outcome that ends a coordination transaction early. Throwing it rolls
// the transaction back (and, inside `createOnce`, its savepoint), so nothing
// written so far is kept; `returningOutcome` turns it back into a value.
class Outcome<T> extends Error {
  constructor(readonly outcome: T) {
    super("coordination outcome");
  }
}

async function returningOutcome<T, O>(run: () => Promise<T>): Promise<T | O> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Outcome) return error.outcome as O;
    throw error;
  }
}

/** The Plan named by `ref` (PLAN-N or UUID) in the Project, if any. */
export async function resolvePlan(
  tx: Db | Transaction,
  projectId: string,
  ref: string,
): Promise<Plan | undefined> {
  const key = PLAN_KEY.exec(ref);
  let condition: SQL;
  if (key) condition = eq(plan.number, Number(key[1]));
  else if (UUID.test(ref)) condition = eq(plan.id, ref.toLowerCase());
  else return undefined;
  const [row] = await tx
    .select()
    .from(plan)
    .where(and(eq(plan.projectId, projectId), condition))
    .limit(1);
  return row;
}

const EMPTY_PROGRESS: PlanProgress = { total: 0, todo: 0, inProgress: 0, blocked: 0, done: 0 };

const PROGRESS_FIELD: { readonly [S in TaskStatus]: keyof PlanProgress } = {
  todo: "todo",
  in_progress: "inProgress",
  blocked: "blocked",
  done: "done",
};

export async function progressOf(
  tx: Db | Transaction,
  planIds: string[],
): Promise<Map<string, PlanProgress>> {
  const progress = new Map<string, PlanProgress>();
  for (const id of planIds) progress.set(id, { ...EMPTY_PROGRESS });
  if (planIds.length === 0) return progress;
  const rows = await tx
    .select({ planId: task.planId, status: task.status, count: sql<number>`count(*)::int` })
    .from(task)
    .where(inArray(task.planId, planIds))
    .groupBy(task.planId, task.status);
  for (const row of rows) {
    const counts = progress.get(row.planId);
    if (!counts) continue;
    counts[PROGRESS_FIELD[row.status]] += row.count;
    counts.total += row.count;
  }
  return progress;
}

async function viewOf(tx: Db | Transaction, row: Plan): Promise<PlanView> {
  const progress = await progressOf(tx, [row.id]);
  return { plan: row, progress: progress.get(row.id) ?? { ...EMPTY_PROGRESS } };
}

/**
 * Checks the actor Session: it must exist in the Project (else
 * `session_not_found`, like any foreign nested id) and be owned by the
 * principal (else `session_forbidden`: a visible Session the caller may not
 * act through, ADR-0014), and, when `open` is set, not be ended or
 * effectively abandoned at `now`.
 */
async function checkActorSession(
  tx: Transaction,
  writer: PlanWriter,
  now: Date,
  { open }: { open: boolean },
): Promise<SessionNotFound | SessionForbidden | SessionEnded | null> {
  if (!writer.sessionId) return null;
  const [row] = await tx
    .select()
    .from(agentSession)
    .where(and(eq(agentSession.id, writer.sessionId), eq(agentSession.projectId, writer.projectId)))
    .limit(1);
  if (!row) return { status: "session_not_found" };
  if (!samePrincipal(sessionOwner(row), writer.principal)) return { status: "session_forbidden" };
  if (open) {
    const status = effectiveSessionStatus(row, now);
    if (status === "ended" || status === "abandoned") return { status: "session_ended" };
  }
  return null;
}

function actorOf(writer: PlanWriter): Actor {
  return { ...writer.principal, sessionId: writer.sessionId ?? null };
}

export type CreatePlanOutcome =
  | { status: "created"; plan: PlanView }
  | { status: "replay"; plan: PlanView }
  | CreationFailure
  | SessionNotFound
  | SessionForbidden
  | SessionEnded;

/**
 * Creates a Plan under the caller's UUID with the next PLAN-N key, or
 * recognizes a retry of the same creation (`replay`, the Plan as it is now,
 * no Event). The number is allocated only after the replay check, so a retry
 * never consumes one.
 */
export async function createPlan(
  db: Db,
  input: PlanWriter & {
    id: string;
    title: string;
    body?: string | null;
    status?: InitialPlanStatus;
  },
): Promise<CreatePlanOutcome> {
  const body = input.body ?? "";
  const status = input.status ?? "draft";
  assertStorableText({ title: input.title, body });
  const fingerprint = creationFingerprint({
    title: input.title,
    body,
    status,
    sessionId: input.sessionId ?? null,
  });
  return returningOutcome(() =>
    withAuthorizedCoordinationLock(db, input, async ({ tx, now }) => {
      const foreign = await checkActorSession(tx, input, now, { open: false });
      if (foreign) return foreign;
      const outcome = await createOnce(
        tx,
        {
          kind: "plan",
          projectId: input.projectId,
          id: input.id,
          principal: input.principal,
          fingerprint,
        },
        async (sp) => {
          const ended = await checkActorSession(sp, input, now, { open: true });
          if (ended) throw new Outcome(ended);
          const number = await allocatePlanNumber(sp, input.projectId);
          const [row] = await sp
            .insert(plan)
            .values({
              id: input.id,
              projectId: input.projectId,
              number,
              title: input.title,
              body,
              status,
              ownerUserId: input.principal.kind === "user" ? input.principal.userId : null,
              ...creatorColumns(input.principal),
              creationFingerprint: fingerprint,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!row) throw new Error("plan insert returned no row");
          await insertEvent(sp, {
            projectId: input.projectId,
            type: "plan.created",
            payload: { key: planKey(number), title: row.title, status: row.status },
            actor: actorOf(input),
            planId: row.id,
            now,
          });
          return row;
        },
      );
      if (outcome.status === "conflict") return { status: "conflict" } as const;
      if (outcome.status === "not_found") return { status: "id_not_found" } as const;
      return { status: outcome.status, plan: await viewOf(tx, outcome.row) };
    }),
  );
}

/** The Plan with its progress, or undefined if `ref` names no Plan of the Project. */
export async function getPlan(
  db: Db,
  projectId: string,
  ref: string,
): Promise<PlanView | undefined> {
  return withCoordinationRead(db, ({ tx }) => readPlan(tx, projectId, ref));
}

/** `getPlan` inside the caller's read transaction. */
export async function readPlan(
  tx: Db | Transaction,
  projectId: string,
  ref: string,
): Promise<PlanView | undefined> {
  const row = await resolvePlan(tx, projectId, ref);
  return row && viewOf(tx, row);
}

export interface ListPlansInput {
  projectId: string;
  status?: PlanStatus;
  limit: number;
  beforeNumber?: number;
}

/**
 * A page of the Project's Plans, newest (highest number) first. `beforeNumber`
 * continues after the last Plan of the previous page.
 */
export async function listPlans(
  db: Db,
  input: ListPlansInput,
): Promise<{ items: PlanView[]; hasMore: boolean }> {
  return withCoordinationRead(db, ({ tx }) => readPlans(tx, input));
}

/** `listPlans` inside the caller's read transaction. */
export async function readPlans(
  tx: Db | Transaction,
  input: ListPlansInput,
): Promise<{ items: PlanView[]; hasMore: boolean }> {
  const conditions: SQL[] = [eq(plan.projectId, input.projectId)];
  if (input.status) conditions.push(eq(plan.status, input.status));
  if (input.beforeNumber !== undefined) {
    conditions.push(sql`${plan.number} < ${input.beforeNumber}`);
  }
  const rows = await tx
    .select()
    .from(plan)
    .where(and(...conditions))
    .orderBy(desc(plan.number))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const progress = await progressOf(
    tx,
    page.map((row) => row.id),
  );
  return {
    items: page.map((row) => ({ plan: row, progress: progress.get(row.id) ?? EMPTY_PROGRESS })),
    hasMore: rows.length > input.limit,
  };
}

export type UpdatePlanOutcome =
  | { status: "ok"; plan: PlanView; changed: boolean }
  | PlanNotFound
  | PlanClosed
  | SessionNotFound
  | SessionForbidden
  | SessionEnded;

/**
 * Edits a Plan's title and/or body (`body: null` clears it). Values equal to
 * the current ones are a no-op without an Event; done and abandoned Plans are
 * `plan_closed`.
 */
export async function updatePlan(
  db: Db,
  input: PlanWriter & { ref: string; title?: string; body?: string | null },
): Promise<UpdatePlanOutcome> {
  assertStorableText({ title: input.title, body: input.body });
  return withAuthorizedCoordinationLock(db, input, async ({ tx, now }) => {
    const row = await resolvePlan(tx, input.projectId, input.ref);
    if (!row) return { status: "plan_not_found" } as const;
    const session = await checkActorSession(tx, input, now, { open: true });
    if (session) return session;
    if (isTerminalPlanStatus(row.status)) {
      return { status: "plan_closed", planStatus: row.status } as const;
    }

    const title = input.title !== undefined && input.title !== row.title ? input.title : null;
    const body = input.body === undefined ? undefined : (input.body ?? "");
    const bodyChanged = body !== undefined && body !== row.body;
    if (title === null && !bodyChanged) {
      return { status: "ok", plan: await viewOf(tx, row), changed: false } as const;
    }

    const [updated] = await tx
      .update(plan)
      .set({ ...(title !== null && { title }), ...(bodyChanged && { body }), updatedAt: now })
      .where(eq(plan.id, row.id))
      .returning();
    if (!updated) throw new Error("plan update returned no row");
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "plan.updated",
      payload: { title, bodyChanged },
      actor: actorOf(input),
      planId: row.id,
      now,
    });
    return { status: "ok", plan: await viewOf(tx, updated), changed: true } as const;
  });
}

export type SetPlanStatusOutcome =
  | { status: "ok"; plan: PlanView; changed: boolean; releasedClaimCount: number }
  | { status: "invalid_transition"; from: PlanStatus; to: TargetPlanStatus }
  /** `done` while Tasks are not done or still hold a claim. */
  | { status: "unfinished_tasks"; count: number }
  | PlanNotFound
  | SessionNotFound
  | SessionForbidden
  | SessionEnded;

/**
 * Moves a Plan along `PLAN_TRANSITIONS`. The current status is a no-op
 * without an Event. `done` requires every Task done and none claimed;
 * `abandoned` releases every remaining claim on its Tasks, usable or not,
 * with a `task.released` Event each.
 */
export async function setPlanStatus(
  db: Db,
  input: PlanWriter & { ref: string; status: TargetPlanStatus },
): Promise<SetPlanStatusOutcome> {
  return withAuthorizedCoordinationLock(db, input, async ({ tx, now }) => {
    const row = await resolvePlan(tx, input.projectId, input.ref);
    if (!row) return { status: "plan_not_found" } as const;
    const session = await checkActorSession(tx, input, now, { open: true });
    if (session) return session;
    if (row.status === input.status) {
      return { status: "ok", plan: await viewOf(tx, row), changed: false, releasedClaimCount: 0 };
    }
    if (!PLAN_TRANSITIONS[row.status].includes(input.status)) {
      return { status: "invalid_transition", from: row.status, to: input.status } as const;
    }

    if (input.status === "done") {
      // A done Task cannot hold a claim (task_done_unclaimed_check), so the
      // claim condition is a safeguard rather than a separate case.
      const [unfinished] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(task)
        .where(
          and(
            eq(task.planId, row.id),
            or(ne(task.status, "done"), isNotNull(task.claimedBySessionId)),
          ),
        );
      const count = unfinished?.count ?? 0;
      if (count > 0) return { status: "unfinished_tasks", count } as const;
    }

    const [updated] = await tx
      .update(plan)
      .set({
        status: input.status,
        pausedAt: input.status === "paused" ? now : null,
        updatedAt: now,
      })
      .where(eq(plan.id, row.id))
      .returning();
    if (!updated) throw new Error("plan update returned no row");
    await insertEvent(tx, {
      projectId: input.projectId,
      type: "plan.status_changed",
      payload: { from: row.status, to: input.status },
      actor: actorOf(input),
      planId: row.id,
      now,
    });

    let releasedClaimCount = 0;
    if (input.status === "abandoned") {
      // Already-expired claims are recorded as lease expiries by the system,
      // like every other release path; live ones as released by the abandon.
      const released = await releaseClaims(tx, {
        projectId: input.projectId,
        now,
        where: and(eq(task.planId, row.id), isNotNull(task.claimedBySessionId)) as SQL,
        reason: "plan_abandoned",
        actor: actorOf(input),
      });
      releasedClaimCount = released.length;
    }
    return { status: "ok", plan: await viewOf(tx, updated), changed: true, releasedClaimCount };
  });
}

export type AppendPlanLogOutcome =
  | { status: "created"; event: Event }
  | { status: "replay"; event: Event }
  | CreationFailure
  | PlanNotFound
  | SessionNotFound
  | SessionForbidden
  | SessionEnded;

/**
 * Appends a Plan log entry: a `plan.log_appended` Event whose UUID is the
 * caller's entry ID. Allowed in every Plan status, terminal ones included.
 * A retry with the same ID, Plan, message, Session and principal returns the
 * stored Event without writing another.
 */
export async function appendPlanLog(
  db: Db,
  input: PlanWriter & { ref: string; eventId: string; message: string },
): Promise<AppendPlanLogOutcome> {
  assertStorableText({ message: input.message });
  return returningOutcome(() =>
    withAuthorizedCoordinationLock(db, input, async ({ tx, now }) => {
      const row = await resolvePlan(tx, input.projectId, input.ref);
      if (!row) return { status: "plan_not_found" } as const;
      const foreign = await checkActorSession(tx, input, now, { open: false });
      if (foreign) return foreign;
      const fingerprint = creationFingerprint({
        planId: row.id,
        message: input.message,
        sessionId: input.sessionId ?? null,
      });
      const outcome = await createOnce(
        tx,
        {
          kind: "plan_log",
          projectId: input.projectId,
          id: input.eventId,
          principal: input.principal,
          fingerprint,
        },
        async (sp) => {
          const ended = await checkActorSession(sp, input, now, { open: true });
          if (ended) throw new Outcome(ended);
          return insertEvent(sp, {
            id: input.eventId,
            projectId: input.projectId,
            type: "plan.log_appended",
            payload: { message: input.message },
            actor: actorOf(input),
            planId: row.id,
            creationFingerprint: fingerprint,
            now,
          });
        },
      );
      if (outcome.status === "conflict") return { status: "conflict" } as const;
      if (outcome.status === "not_found") return { status: "id_not_found" } as const;
      return { status: outcome.status, event: outcome.row };
    }),
  );
}

/** The claim on `row` if usable at `now`; `holder` is the claiming Session's row. */
export function usableClaim(
  row: Pick<Task, "claimedBySessionId" | "claimedAt" | "leaseExpiresAt">,
  holder: SessionLiveness | null,
  now: Date,
): UsableClaim | null {
  if (!row.claimedBySessionId || !row.claimedAt || !row.leaseExpiresAt) return null;
  if (!isClaimUsable({ leaseExpiresAt: row.leaseExpiresAt }, holder, now)) return null;
  return {
    sessionId: row.claimedBySessionId,
    claimedAt: row.claimedAt,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

/** Tasks with their claim holder's liveness columns, for `usableClaim`. */
export function selectTaskViews(tx: Db | Transaction) {
  return tx
    .select({
      task,
      planNumber: plan.number,
      holderStatus: agentSession.status,
      holderLastHeartbeatAt: agentSession.lastHeartbeatAt,
    })
    .from(task)
    .innerJoin(plan, eq(plan.id, task.planId))
    .leftJoin(agentSession, eq(agentSession.id, task.claimedBySessionId));
}

type TaskViewRow = Awaited<ReturnType<ReturnType<typeof selectTaskViews>["where"]>>[number];

export function toTaskView(row: TaskViewRow, now: Date): TaskView {
  const holder =
    row.holderStatus && row.holderLastHeartbeatAt
      ? { status: row.holderStatus, lastHeartbeatAt: row.holderLastHeartbeatAt }
      : null;
  return { task: row.task, planNumber: row.planNumber, claim: usableClaim(row.task, holder, now) };
}

/** One Task as a `TaskView` at `now`, read in the caller's transaction. */
export async function loadTaskView(
  tx: Db | Transaction,
  taskId: string,
  now: Date,
): Promise<TaskView> {
  const [row] = await selectTaskViews(tx).where(eq(task.id, taskId));
  if (!row) throw new Error(`task ${taskId} not found`);
  return toTaskView(row, now);
}

/**
 * The PLAN-N numbers of the given Plans of a Project, by Plan UUID (for the
 * `attachedPlanKey` of Session DTOs). A Plan's number never changes.
 */
export async function planNumbers(
  tx: Db | Transaction,
  projectId: string,
  planIds: readonly (string | null)[],
): Promise<Map<string, number>> {
  const ids = [...new Set(planIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: plan.id, number: plan.number })
    .from(plan)
    .where(and(eq(plan.projectId, projectId), inArray(plan.id, ids)));
  return new Map(rows.map((row) => [row.id, row.number]));
}

export type AddTaskOutcome =
  | { status: "created"; task: TaskView }
  | { status: "replay"; task: TaskView }
  | CreationFailure
  | PlanNotFound
  | PlanClosed
  | SessionNotFound
  | SessionForbidden
  | SessionEnded;

/**
 * Adds a `todo` Task at the end of a Plan that is not done or abandoned, under
 * the caller's UUID. A retry of the same addition returns the Task as it is
 * now (`replay`), even if the Plan has closed since, and writes no Event.
 */
export async function addTask(
  db: Db,
  input: PlanWriter & { ref: string; taskId: string; title: string },
): Promise<AddTaskOutcome> {
  assertStorableText({ title: input.title });
  return returningOutcome(() =>
    withAuthorizedCoordinationLock(db, input, async ({ tx, now }) => {
      const row = await resolvePlan(tx, input.projectId, input.ref);
      if (!row) return { status: "plan_not_found" } as const;
      const foreign = await checkActorSession(tx, input, now, { open: false });
      if (foreign) return foreign;
      const fingerprint = creationFingerprint({
        planId: row.id,
        title: input.title,
        sessionId: input.sessionId ?? null,
      });
      const outcome = await createOnce(
        tx,
        {
          kind: "task",
          projectId: input.projectId,
          id: input.taskId,
          principal: input.principal,
          fingerprint,
        },
        async (sp) => {
          if (isTerminalPlanStatus(row.status)) {
            throw new Outcome({ status: "plan_closed", planStatus: row.status } as const);
          }
          const ended = await checkActorSession(sp, input, now, { open: true });
          if (ended) throw new Outcome(ended);
          const [last] = await sp
            .select({ position: sql<number>`coalesce(max(${task.position}), 0)::int` })
            .from(task)
            .where(eq(task.planId, row.id));
          const position = (last?.position ?? 0) + 1;
          const [created] = await sp
            .insert(task)
            .values({
              id: input.taskId,
              projectId: input.projectId,
              planId: row.id,
              title: input.title,
              position,
              ...creatorColumns(input.principal),
              creationFingerprint: fingerprint,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!created) throw new Error("task insert returned no row");
          await insertEvent(sp, {
            projectId: input.projectId,
            type: "task.added",
            payload: { title: created.title, position },
            actor: actorOf(input),
            planId: row.id,
            taskId: created.id,
            now,
          });
          return created;
        },
      );
      if (outcome.status === "conflict") return { status: "conflict" } as const;
      if (outcome.status === "not_found") return { status: "id_not_found" } as const;
      const [view] = await selectTaskViews(tx).where(eq(task.id, outcome.row.id));
      if (!view) throw new Error("task read returned no row");
      return { status: outcome.status, task: toTaskView(view, now) };
    }),
  );
}

/**
 * A page of a Plan's Tasks by position, then UUID, with claims judged at one
 * database time. `after` continues after the previous page's last Task.
 * Undefined when `ref` names no Plan of the Project.
 */
export async function listPlanTasks(
  db: Db,
  input: ListPlanTasksInput,
): Promise<{ items: TaskView[]; hasMore: boolean } | undefined> {
  return withCoordinationRead(db, (context) => readPlanTasks(context, input));
}

export interface ListPlanTasksInput {
  projectId: string;
  ref: string;
  status?: TaskStatus;
  limit: number;
  after?: { position: number; id: string };
}

/** `listPlanTasks` inside the caller's read transaction, judging claims at its `now`. */
export async function readPlanTasks(
  { tx, now }: CoordinationContext,
  input: ListPlanTasksInput,
): Promise<{ items: TaskView[]; hasMore: boolean } | undefined> {
  const row = await resolvePlan(tx, input.projectId, input.ref);
  if (!row) return undefined;
  const conditions: SQL[] = [eq(task.planId, row.id), eq(task.projectId, input.projectId)];
  if (input.status) conditions.push(eq(task.status, input.status));
  if (input.after) {
    conditions.push(
      sql`(${task.position}, ${task.id}) > (${input.after.position}, ${input.after.id}::uuid)`,
    );
  }
  const rows = await selectTaskViews(tx)
    .where(and(...conditions))
    .orderBy(asc(task.position), asc(task.id))
    .limit(input.limit + 1);
  return {
    items: rows.slice(0, input.limit).map((view) => toTaskView(view, now)),
    hasMore: rows.length > input.limit,
  };
}
