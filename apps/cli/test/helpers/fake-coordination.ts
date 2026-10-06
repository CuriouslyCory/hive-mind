import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  compareTouchedPaths,
  isDeclaredScopePattern,
  isTouchedPath,
  MAX_COLLECTION_BATCH_PATHS,
  MAX_TOUCHED_SCOPES_PER_SESSION,
  taskClaimConflictMessage,
  touchedPathsContentHash,
} from "@hivemind/contract";
import { sendJson, sendOrpcError } from "./api-server.ts";
import { createFakeAdrs, type FakeAdrs } from "./fake-adrs.ts";

/**
 * In-memory coordination routes for the fake backend (fake-backend.ts):
 * Plans, Tasks, Sessions, Scopes, collections, Events and status under
 * `/api/v1/projects/{id}/...`, answering with the contract's DTO shapes. It
 * models what the CLI depends on (creation replay by caller UUID, claim
 * conflicts with the holder in the message, `--steal`, Session ownership,
 * collection manifest/batch/finalize checks including the content hash and
 * batch order) and simplifies the rest: liveness is the stored status, and
 * overlaps are equal declared globs. The real rules are tested in packages/db
 * and apps/web.
 */

export type FakeOwner = { kind: "user"; userId: string } | { kind: "key"; keyId: string };

interface PlanRow {
  id: string;
  projectId: string;
  key: string;
  title: string;
  status: string;
  ownerUserId: string | null;
  createdBy: { kind: "user"; userId: string } | { kind: "project_key"; keyId: string };
  createdAt: string;
  updatedAt: string;
  body: string | null;
}

interface TaskRow {
  id: string;
  projectId: string;
  planId: string;
  title: string;
  status: string;
  position: number;
  claim: { sessionId: string; claimedAt: string; leaseExpiresAt: string } | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  id: string;
  projectId: string;
  owner: FakeOwner;
  agent: string;
  intent: string;
  status: string;
  hostname: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  attachedPlanId: string | null;
  attachedTaskId: string | null;
  summary: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt: string | null;
  updatedAt: string;
  currentCollectionId: string | null;
  historicalScopeComplete: boolean;
}

interface ScopeRow {
  id: string;
  projectId: string;
  sessionId: string;
  source: "declared" | "touched";
  value: string;
  createdAt: string;
}

export interface CollectionRow {
  collectionId: string;
  sessionId: string;
  manifest: {
    pathCount: number;
    batchCount: number;
    omittedPathCount: number;
    contentHash: string;
  } | null;
  batches: Map<number, string[]>;
  finalized: boolean;
  collectionComplete: boolean;
  overCapacity: boolean;
}

interface EventRow {
  id: string;
  projectId: string;
  seq: string;
  writerXid: string;
  payloadVersion: 1;
  actor:
    | { kind: "user"; userId: string }
    | { kind: "project_key"; keyId: string }
    | { kind: "system" };
  actorSessionId: string | null;
  planId: string | null;
  taskId: string | null;
  sessionId: string | null;
  effectiveAt: string;
  createdAt: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface FakeCoordination {
  plans: Map<string, PlanRow>;
  tasks: Map<string, TaskRow>;
  sessions: Map<string, SessionRow>;
  scopes: Map<string, ScopeRow>;
  collections: Map<string, CollectionRow>;
  events: EventRow[];
  /** ADR reservations, content and syncs (fake-adrs.ts). */
  adrs: FakeAdrs;
  handle(request: CoordinationRequest, response: ServerResponse): void | Promise<void>;
}

export interface CoordinationRequest {
  method: string;
  projectId: string;
  /** Path segments after `projects/{id}/`. */
  parts: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  owner: FakeOwner;
}

const now = () => new Date().toISOString();
const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

function page<T>(items: T[], query: URLSearchParams) {
  const limit = Number(query.get("limit") ?? 50);
  const offset = Number(query.get("cursor")?.slice(1) ?? 0);
  const slice = items.slice(offset, offset + limit);
  return {
    items: slice,
    nextCursor: offset + limit < items.length ? `o${offset + limit}` : null,
  };
}

export function createFakeCoordination(): FakeCoordination {
  const plans = new Map<string, PlanRow>();
  const tasks = new Map<string, TaskRow>();
  const sessions = new Map<string, SessionRow>();
  const scopes = new Map<string, ScopeRow>();
  const collections = new Map<string, CollectionRow>();
  const events: EventRow[] = [];
  const fingerprints = new Map<string, string>();
  const planNumbers = new Map<string, number>();
  let seq = 0;

  const actorOf = (owner: FakeOwner): Exclude<EventRow["actor"], { kind: "system" }> =>
    owner.kind === "user"
      ? { kind: "user", userId: owner.userId }
      : { kind: "project_key", keyId: owner.keyId };
  const sameOwner = (a: FakeOwner, b: FakeOwner) => JSON.stringify(a) === JSON.stringify(b);
  const live = (session: SessionRow) => session.status === "active" || session.status === "idle";

  const planDto = (plan: PlanRow, withBody = true) => {
    const own = [...tasks.values()].filter((task) => task.planId === plan.id);
    const count = (status: string) => own.filter((task) => task.status === status).length;
    const { body, ...summary } = plan;
    return {
      ...summary,
      progress: {
        total: own.length,
        todo: count("todo"),
        inProgress: count("in_progress"),
        blocked: count("blocked"),
        done: count("done"),
      },
      ...(withBody ? { body } : {}),
    };
  };
  const taskDto = (task: TaskRow) => ({
    ...task,
    planKey: plans.get(task.planId)?.key ?? "PLAN-1",
  });
  const sessionDto = (session: SessionRow) => {
    const { currentCollectionId, historicalScopeComplete, ...rest } = session;
    const current = currentCollectionId ? collections.get(currentCollectionId) : undefined;
    return {
      ...rest,
      attachedPlanKey: session.attachedPlanId
        ? (plans.get(session.attachedPlanId)?.key ?? null)
        : null,
      scopeComplete: historicalScopeComplete && (current ? current.collectionComplete : true),
    };
  };
  const collectionDto = (row: CollectionRow) => {
    const session = sessions.get(row.sessionId) as SessionRow;
    return {
      collectionId: row.collectionId,
      sessionId: row.sessionId,
      pathCount: row.manifest?.pathCount ?? null,
      batchCount: row.manifest?.batchCount ?? null,
      omittedPathCount: row.manifest?.omittedPathCount ?? null,
      receivedBatchCount: row.batches.size,
      finalized: row.finalized,
      collectionComplete: row.collectionComplete,
      historicalScopeComplete: session.historicalScopeComplete,
      scopeComplete: session.historicalScopeComplete && row.collectionComplete,
    };
  };
  const addEvent = (
    type: string,
    owner: FakeOwner,
    fields: Partial<Pick<EventRow, "id" | "actorSessionId" | "planId" | "taskId" | "sessionId">>,
    payload: Record<string, unknown> = {},
  ): EventRow => {
    seq++;
    const event: EventRow = {
      id: fields.id ?? randomUUID(),
      projectId: "",
      seq: String(seq),
      writerXid: String(1000 + seq),
      payloadVersion: 1,
      actor: actorOf(owner),
      actorSessionId: fields.actorSessionId ?? null,
      planId: fields.planId ?? null,
      taskId: fields.taskId ?? null,
      sessionId: fields.sessionId ?? null,
      effectiveAt: now(),
      createdAt: now(),
      type,
      payload,
    };
    events.push(event);
    return event;
  };

  /**
   * Creation replay: the same id, input and principal returns the existing
   * record; anything else with that id is CONFLICT.
   */
  const replay = (
    kind: string,
    id: string,
    owner: FakeOwner,
    input: unknown,
  ): "new" | "replay" | "conflict" => {
    const fingerprint = JSON.stringify([owner, input]);
    const stored = fingerprints.get(`${kind}:${id}`);
    if (stored === undefined) {
      fingerprints.set(`${kind}:${id}`, fingerprint);
      return "new";
    }
    return stored === fingerprint ? "replay" : "conflict";
  };
  const adrs = createFakeAdrs(replay);

  const handle = (request: CoordinationRequest, response: ServerResponse): void | Promise<void> => {
    const { method, projectId, parts, query, body, owner } = request;
    const notFound = () => sendOrpcError(response, 404, "NOT_FOUND", "Not found.");
    const conflict = (message = "The request conflicts with existing data.") =>
      sendOrpcError(response, 409, "CONFLICT", message);
    const badRequest = () => sendOrpcError(response, 400, "BAD_REQUEST", "Input validation failed");
    const ok = (value: unknown) => sendJson(response, 200, value);

    const findPlan = (ref: string | undefined) =>
      [...plans.values()].find(
        (plan) => plan.projectId === projectId && (plan.id === ref || plan.key === ref),
      );
    /** The caller's own Session in this Project (404 otherwise). */
    const ownSession = (id: unknown) => {
      const session = typeof id === "string" ? sessions.get(id) : undefined;
      return session && session.projectId === projectId && sameOwner(session.owner, owner)
        ? session
        : undefined;
    };
    const actorSession = (): { ok: boolean; id: string | null } => {
      if (body.sessionId === undefined) return { ok: true, id: null };
      const session = ownSession(body.sessionId);
      return session ? { ok: true, id: session.id } : { ok: false, id: null };
    };

    const [group, ref, sub, subId, action] = parts;
    if (group === "adrs") return adrs.handle(request, response);

    // ---- Plans ----------------------------------------------------------
    if (group === "plans" && ref === undefined) {
      if (method === "GET") {
        const status = query.get("status");
        const items = [...plans.values()]
          .filter((plan) => plan.projectId === projectId && (!status || plan.status === status))
          .reverse()
          .map((plan) => planDto(plan, false));
        return ok(page(items, query));
      }
      const actor = actorSession();
      if (!actor.ok) return notFound();
      const planId = String(body.planId);
      const outcome = replay("plan", planId, owner, {
        title: body.title,
        body: body.body,
        status: body.status,
      });
      if (outcome === "conflict") return conflict();
      if (outcome === "replay")
        return ok({ plan: planDto(plans.get(planId) as PlanRow), created: false });
      const number = (planNumbers.get(projectId) ?? 0) + 1;
      planNumbers.set(projectId, number);
      const plan: PlanRow = {
        id: planId,
        projectId,
        key: `PLAN-${number}`,
        title: String(body.title),
        status: typeof body.status === "string" ? body.status : "draft",
        ownerUserId: owner.kind === "user" ? owner.userId : null,
        createdBy: actorOf(owner),
        createdAt: now(),
        updatedAt: now(),
        body: typeof body.body === "string" ? body.body : null,
      };
      plans.set(plan.id, plan);
      addEvent("plan.created", owner, { planId, actorSessionId: actor.id });
      return ok({ plan: planDto(plan), created: true });
    }
    if (group === "plans") {
      const plan = findPlan(ref);
      if (!plan) return notFound();
      if (sub === undefined && method === "GET") return ok(planDto(plan));
      if (sub === undefined && method === "PATCH") {
        if (!actorSession().ok) return notFound();
        const before = JSON.stringify([plan.title, plan.body]);
        if (typeof body.title === "string") plan.title = body.title;
        if (body.body !== undefined) plan.body = body.body as string | null;
        const changed = before !== JSON.stringify([plan.title, plan.body]);
        if (changed) addEvent("plan.updated", owner, { planId: plan.id });
        return ok({ plan: planDto(plan), changed });
      }
      if (sub === "status") {
        if (!actorSession().ok) return notFound();
        const target = String(body.status);
        if (plan.status === target)
          return ok({ plan: planDto(plan), changed: false, releasedClaimCount: 0 });
        const allowed: Record<string, string[]> = {
          draft: ["active", "abandoned"],
          active: ["paused", "done", "abandoned"],
          paused: ["active", "done", "abandoned"],
        };
        if (!allowed[plan.status]?.includes(target))
          return conflict("The Plan cannot move to that status.");
        plan.status = target;
        addEvent("plan.status_changed", owner, { planId: plan.id });
        return ok({ plan: planDto(plan), changed: true, releasedClaimCount: 0 });
      }
      if (sub === "log" && method === "GET") {
        const items = events.filter((event) => event.planId === plan.id).reverse();
        return ok(page(items, query));
      }
      if (sub === "log") {
        const actor = actorSession();
        if (!actor.ok) return notFound();
        const eventId = String(body.eventId);
        const outcome = replay("log", eventId, owner, { plan: plan.id, message: body.message });
        if (outcome === "conflict") return conflict();
        if (outcome === "replay") {
          return ok({ event: events.find((event) => event.id === eventId), created: false });
        }
        const event = addEvent(
          "plan.log_appended",
          owner,
          { id: eventId, planId: plan.id, actorSessionId: actor.id },
          { message: body.message },
        );
        return ok({ event, created: true });
      }
      if (sub === "decisions" && method === "POST") {
        const actor = actorSession();
        if (!actor.ok) return notFound();
        const eventId = String(body.eventId);
        const text = String(body.text).trim();
        const outcome = replay("decision", eventId, owner, { plan: plan.id, text });
        if (outcome === "conflict") return conflict();
        if (outcome === "replay") {
          return ok({ event: events.find((event) => event.id === eventId), created: false });
        }
        const event = addEvent(
          "plan.decision_recorded",
          owner,
          { id: eventId, planId: plan.id, actorSessionId: actor.id },
          { text },
        );
        return ok({ event, created: true });
      }
      if (sub === "tasks" && method === "GET") {
        const status = query.get("status");
        const items = [...tasks.values()]
          .filter((task) => task.planId === plan.id && (!status || task.status === status))
          .map(taskDto);
        return ok(page(items, query));
      }
      if (sub === "tasks") {
        const actor = actorSession();
        if (!actor.ok) return notFound();
        const taskId = String(body.taskId);
        const outcome = replay("task", taskId, owner, { plan: plan.id, title: body.title });
        if (outcome === "conflict") return conflict();
        if (outcome === "replay")
          return ok({ task: taskDto(tasks.get(taskId) as TaskRow), created: false });
        const task: TaskRow = {
          id: taskId,
          projectId,
          planId: plan.id,
          title: String(body.title),
          status: "todo",
          position: [...tasks.values()].filter((other) => other.planId === plan.id).length,
          claim: null,
          blockedReason: null,
          createdAt: now(),
          updatedAt: now(),
        };
        tasks.set(taskId, task);
        addEvent("task.added", owner, { planId: plan.id, taskId, actorSessionId: actor.id });
        return ok({ task: taskDto(task), created: true });
      }
      return notFound();
    }

    // ---- Task work --------------------------------------------------------
    if (group === "tasks" && ref && sub) {
      const task = tasks.get(ref);
      if (!task || task.projectId !== projectId) return notFound();
      const session = ownSession(body.sessionId);
      if (!session) return notFound();
      if (!live(session)) return conflict("The Session is not live.");
      const plan = plans.get(task.planId) as PlanRow;
      const holder = task.claim ? sessions.get(task.claim.sessionId) : undefined;
      const heldByOther =
        task.claim !== null &&
        task.claim.sessionId !== session.id &&
        holder !== undefined &&
        live(holder);
      const mine = task.claim?.sessionId === session.id;
      if (sub === "claim") {
        if (plan.status !== "active" || task.status === "done")
          return conflict("The Task cannot be claimed now.");
        if (mine) return ok({ task: taskDto(task), changed: false, stolenFromSessionId: null });
        if (heldByOther && body.steal !== true) {
          return conflict(
            taskClaimConflictMessage({ sessionId: holder.id, intent: holder.intent }),
          );
        }
        const stolen = heldByOther ? holder.id : null;
        task.claim = { sessionId: session.id, claimedAt: now(), leaseExpiresAt: later(300) };
        if (stolen !== null) {
          addEvent(
            "task.released",
            owner,
            {
              taskId: task.id,
              planId: plan.id,
              sessionId: stolen,
              actorSessionId: session.id,
            },
            { reason: "stolen" },
          );
        }
        addEvent(
          "task.claimed",
          owner,
          {
            taskId: task.id,
            planId: plan.id,
            sessionId: session.id,
            actorSessionId: session.id,
          },
          { stolenFromSessionId: stolen },
        );
        return ok({ task: taskDto(task), changed: true, stolenFromSessionId: stolen });
      }
      if (sub === "release") {
        if (task.claim === null) return ok({ task: taskDto(task), changed: false });
        if (!mine) return conflict("Another Session holds the claim.");
        task.claim = null;
        return ok({ task: taskDto(task), changed: true });
      }
      if (!mine) return conflict("The Task is not claimed by this Session.");
      if (sub === "start") {
        if (task.status === "in_progress") return ok({ task: taskDto(task), changed: false });
        task.status = "in_progress";
      } else if (sub === "block") {
        task.status = "blocked";
        task.blockedReason = String(body.reason);
      } else if (sub === "done") {
        task.status = "done";
        task.claim = null;
      } else return notFound();
      return ok({ task: taskDto(task), changed: true });
    }

    // ---- Sessions ------------------------------------------------------------
    if (group === "sessions" && ref === undefined) {
      if (method === "GET") {
        const status = query.get("status");
        const terminal = (row: SessionRow) => row.status === "ended" || row.status === "abandoned";
        const items = [...sessions.values()]
          .filter((row) => row.projectId === projectId)
          .filter(
            (row) =>
              !status ||
              (status === "live"
                ? live(row)
                : status === "terminal"
                  ? terminal(row)
                  : row.status === status),
          )
          .reverse()
          .map(sessionDto);
        return ok(page(items, query));
      }
      const sessionId = String(body.sessionId);
      const input = { ...body };
      const outcome = replay("session", sessionId, owner, input);
      if (outcome === "conflict") return conflict();
      if (outcome === "replay") {
        return ok({ session: sessionDto(sessions.get(sessionId) as SessionRow), created: false });
      }
      const session: SessionRow = {
        id: sessionId,
        projectId,
        owner,
        agent: String(body.agent),
        intent: String(body.intent),
        status: "active",
        hostname: typeof body.hostname === "string" ? body.hostname : null,
        gitBranch: typeof body.gitBranch === "string" ? body.gitBranch : null,
        gitCommit: typeof body.gitCommit === "string" ? body.gitCommit : null,
        attachedPlanId: null,
        attachedTaskId: null,
        summary: null,
        startedAt: now(),
        lastHeartbeatAt: now(),
        endedAt: null,
        updatedAt: now(),
        currentCollectionId: null,
        historicalScopeComplete: true,
      };
      sessions.set(sessionId, session);
      addEvent("session.started", owner, { sessionId, actorSessionId: sessionId });
      return ok({ session: sessionDto(session), created: true });
    }
    if (group === "sessions" && ref) {
      const any = sessions.get(ref);
      if (!any || any.projectId !== projectId) return notFound();
      if (method === "GET") {
        if (sub === undefined) return ok(sessionDto(any));
        if (sub === "claims") {
          return ok(
            page(
              [...tasks.values()].filter((task) => task.claim?.sessionId === any.id).map(taskDto),
              query,
            ),
          );
        }
        if (sub === "events") {
          return ok(
            page(
              events
                .filter((event) => event.sessionId === any.id || event.actorSessionId === any.id)
                .reverse(),
              query,
            ),
          );
        }
        if (sub === "scopes") {
          const source = query.get("source");
          return ok(
            page(
              [...scopes.values()].filter(
                (scope) => scope.sessionId === any.id && (!source || scope.source === source),
              ),
              query,
            ),
          );
        }
        if (sub === "overlaps") {
          const mine = [...scopes.values()].filter(
            (scope) => scope.sessionId === any.id && scope.source === "declared",
          );
          const items = [];
          for (const scope of mine) {
            for (const other of scopes.values()) {
              const otherSession = sessions.get(other.sessionId) as SessionRow;
              if (other.sessionId === any.id || !live(otherSession) || other.value !== scope.value)
                continue;
              items.push({
                sessionId: any.id,
                otherSessionId: other.sessionId,
                scope: { id: scope.id, source: scope.source, value: scope.value },
                otherScope: { id: other.id, source: other.source, value: other.value },
                kind: "overlap",
                witness: scope.value
                  .replaceAll("**", "x")
                  .replaceAll("*", "x")
                  .replaceAll("?", "x"),
              });
            }
          }
          const compared = [
            any,
            ...[...sessions.values()].filter((row) => row.id !== any.id && live(row)),
          ];
          const incomplete = compared
            .filter((row) => !sessionDto(row).scopeComplete)
            .map((row) => row.id);
          return ok({
            ...page(items, query),
            complete: incomplete.length === 0,
            incompleteSessionIds: incomplete,
          });
        }
        return notFound();
      }
      const session = ownSession(ref);
      if (!session) return notFound();
      const terminal = session.status === "ended" || session.status === "abandoned";
      if (sub === undefined && method === "PATCH") {
        if (terminal) return conflict("The Session has ended.");
        const before = JSON.stringify(session);
        for (const field of [
          "agent",
          "intent",
          "hostname",
          "gitBranch",
          "gitCommit",
          "status",
        ] as const) {
          if (body[field] !== undefined)
            (session as unknown as Record<string, unknown>)[field] = body[field];
        }
        const changed = before !== JSON.stringify(session);
        return ok({ session: sessionDto(session), changed });
      }
      if (sub === "heartbeat") {
        if (terminal) return conflict("The Session has ended.");
        const previousStatus = session.status;
        const previous = session.currentCollectionId
          ? collections.get(session.currentCollectionId)
          : undefined;
        if (previous && !previous.finalized) session.historicalScopeComplete = false;
        if (typeof body.status === "string") session.status = body.status;
        else if (session.status === "stale") session.status = "active";
        session.lastHeartbeatAt = now();
        const renewed = [...tasks.values()].filter((task) => task.claim?.sessionId === session.id);
        const leaseExpiresAt = later(300);
        for (const task of renewed) if (task.claim) task.claim.leaseExpiresAt = leaseExpiresAt;
        const collection: CollectionRow = {
          collectionId: randomUUID(),
          sessionId: session.id,
          manifest: null,
          batches: new Map(),
          finalized: false,
          collectionComplete: false,
          overCapacity: false,
        };
        collections.set(collection.collectionId, collection);
        session.currentCollectionId = collection.collectionId;
        addEvent("session.heartbeat", owner, { sessionId: session.id, actorSessionId: session.id });
        return ok({
          session: sessionDto(session),
          previousStatus,
          renewedClaims: { items: renewed.map((task) => task.id), complete: true },
          releasedClaims: { items: [], complete: true },
          leaseExpiresAt: renewed.length > 0 ? leaseExpiresAt : null,
          collectionId: collection.collectionId,
          historicalScopeComplete: session.historicalScopeComplete,
        });
      }
      if (sub === "attach") {
        if (terminal) return conflict("The Session has ended.");
        const planRef = body.planRef as string | null;
        const plan = planRef === null ? undefined : findPlan(planRef);
        if (planRef !== null && !plan) return notFound();
        const taskId = body.taskId as string | undefined;
        if (taskId !== undefined && tasks.get(taskId)?.planId !== plan?.id) return notFound();
        const before = [session.attachedPlanId, session.attachedTaskId].join();
        session.attachedPlanId = plan?.id ?? null;
        session.attachedTaskId = taskId ?? null;
        return ok({
          session: sessionDto(session),
          changed: before !== [session.attachedPlanId, session.attachedTaskId].join(),
        });
      }
      if (sub === "end") {
        if (session.status === "ended") {
          if (session.summary === body.summary) {
            return ok({
              session: sessionDto(session),
              changed: false,
              releasedClaims: { items: [], complete: true },
            });
          }
          return conflict("The Session already ended with another summary.");
        }
        const released = [...tasks.values()].filter((task) => task.claim?.sessionId === session.id);
        for (const task of released) task.claim = null;
        session.status = "ended";
        session.summary = String(body.summary);
        session.endedAt = now();
        addEvent("session.ended", owner, { sessionId: session.id, actorSessionId: session.id });
        return ok({
          session: sessionDto(session),
          changed: true,
          releasedClaims: { items: released.map((task) => task.id), complete: true },
        });
      }
      if (sub === "scopes" && method === "POST") {
        if (terminal) return conflict("The Session has ended.");
        const pattern = String(body.pattern);
        if (!isDeclaredScopePattern(pattern)) return badRequest();
        const existing = [...scopes.values()].find(
          (scope) =>
            scope.sessionId === session.id &&
            scope.source === "declared" &&
            scope.value === pattern,
        );
        if (existing) return ok({ scope: existing, created: false });
        const scope: ScopeRow = {
          id: randomUUID(),
          projectId,
          sessionId: session.id,
          source: "declared",
          value: pattern,
          createdAt: now(),
        };
        scopes.set(scope.id, scope);
        return ok({ scope, created: true });
      }
      if (sub === "scopes" && method === "DELETE" && subId) {
        if (terminal) return conflict("The Session has ended.");
        const scope = scopes.get(subId);
        if (!scope || scope.sessionId !== session.id)
          return ok({ id: subId, sessionId: session.id, removed: false });
        if (scope.source === "touched") return conflict("Touched Scopes cannot be removed.");
        scopes.delete(subId);
        return ok({ id: subId, sessionId: session.id, removed: true });
      }
      if (sub === "collections" && subId && action) {
        if (!live(session)) return conflict("The Session is not live.");
        const collection = collections.get(subId);
        if (!collection || collection.sessionId !== session.id) return notFound();
        if (session.currentCollectionId !== subId)
          return conflict("A newer heartbeat replaced this collection.");
        if (action === "manifest") {
          const manifest = {
            pathCount: Number(body.pathCount),
            batchCount: Number(body.batchCount),
            omittedPathCount: Number(body.omittedPathCount),
            contentHash: String(body.contentHash),
          };
          if (
            manifest.batchCount > manifest.pathCount ||
            manifest.batchCount < Math.ceil(manifest.pathCount / MAX_COLLECTION_BATCH_PATHS) ||
            !/^[0-9a-f]{64}$/.test(manifest.contentHash)
          ) {
            return badRequest();
          }
          if (collection.manifest) {
            if (JSON.stringify(collection.manifest) !== JSON.stringify(manifest))
              return conflict("A different manifest is registered.");
            return ok({ collection: collectionDto(collection), changed: false });
          }
          collection.manifest = manifest;
          if (manifest.omittedPathCount > 0) session.historicalScopeComplete = false;
          return ok({ collection: collectionDto(collection), changed: true });
        }
        if (!collection.manifest) return conflict("No manifest is registered.");
        if (action === "batches") {
          const index = Number(body.batchIndex);
          const paths = body.paths as string[];
          if (
            !Array.isArray(paths) ||
            paths.length < 1 ||
            paths.length > MAX_COLLECTION_BATCH_PATHS ||
            !paths.every(isTouchedPath) ||
            !paths.every(
              (path, i) => i === 0 || compareTouchedPaths(paths[i - 1] as string, path) < 0,
            ) ||
            !(index >= 0 && index < collection.manifest.batchCount)
          ) {
            return badRequest();
          }
          const accepted = collection.batches.get(index);
          if (accepted) {
            if (JSON.stringify(accepted) !== JSON.stringify(paths))
              return conflict("Different paths at this batch index.");
            return ok({
              collection: collectionDto(collection),
              changed: false,
              storedPathCount: paths.length,
              overCapacityPathCount: 0,
            });
          }
          collection.batches.set(index, paths);
          let stored = 0;
          let over = 0;
          for (const path of paths) {
            const touched = [...scopes.values()].filter(
              (scope) => scope.sessionId === session.id && scope.source === "touched",
            );
            if (touched.some((scope) => scope.value === path)) {
              stored++;
              continue;
            }
            if (touched.length >= MAX_TOUCHED_SCOPES_PER_SESSION) {
              over++;
              continue;
            }
            const scope: ScopeRow = {
              id: randomUUID(),
              projectId,
              sessionId: session.id,
              source: "touched",
              value: path,
              createdAt: now(),
            };
            scopes.set(scope.id, scope);
            stored++;
          }
          if (over > 0) {
            collection.overCapacity = true;
            session.historicalScopeComplete = false;
          }
          return ok({
            collection: collectionDto(collection),
            changed: true,
            storedPathCount: stored,
            overCapacityPathCount: over,
          });
        }
        if (action === "finalize") {
          if (collection.finalized)
            return ok({ collection: collectionDto(collection), changed: false });
          if (collection.batches.size !== collection.manifest.batchCount)
            return conflict("Batches are missing.");
          const paths = [...collection.batches.values()].flat();
          return touchedPathsContentHash(paths).then((hash) => {
            const manifest = collection.manifest as NonNullable<CollectionRow["manifest"]>;
            if (hash !== manifest.contentHash || paths.length !== manifest.pathCount) {
              return conflict("The uploaded paths do not match the manifest.");
            }
            collection.finalized = true;
            collection.collectionComplete =
              manifest.omittedPathCount === 0 && !collection.overCapacity;
            return ok({ collection: collectionDto(collection), changed: true });
          });
        }
      }
      return notFound();
    }

    // ---- Events and status ---------------------------------------------------
    if (group === "events" && method === "GET") return ok(page([...events].reverse(), query));
    if (group === "status" && method === "GET") {
      const selected = query.get("sessionId");
      if (selected !== null && sessions.get(selected)?.projectId !== projectId) return notFound();
      const own = [...sessions.values()].filter((row) => row.projectId === projectId);
      const liveSessions = own.filter(live).map((row) => {
        const rows = [...scopes.values()].filter((scope) => scope.sessionId === row.id);
        return {
          session: sessionDto(row),
          declaredScopes: rows.filter((scope) => scope.source === "declared"),
          touchedScopeCount: rows.filter((scope) => scope.source === "touched").length,
          claimCount: [...tasks.values()].filter((task) => task.claim?.sessionId === row.id).length,
        };
      });
      return ok({
        projectId,
        asOf: now(),
        selectedSessionId: selected,
        activePlans: [...plans.values()]
          .filter((plan) => plan.projectId === projectId && plan.status === "active")
          .map((plan) => planDto(plan, false)),
        liveSessions,
        myClaims:
          selected === null
            ? []
            : [...tasks.values()].filter((task) => task.claim?.sessionId === selected).map(taskDto),
        recentTerminalSessions: own.filter((row) => !live(row)).map(sessionDto),
        overlaps: [],
        complete: {
          activePlans: true,
          liveSessions: true,
          myClaims: true,
          recentTerminalSessions: true,
          overlaps: liveSessions.every((entry) => entry.session.scopeComplete),
        },
      });
    }
    return notFound();
  };

  return { plans, tasks, sessions, scopes, collections, events, adrs, handle };
}
