import {
  type AgentSession,
  type Db,
  type Event as EventRow,
  effectiveSessionStatusSql,
  type FeedSnapshotContext,
  isClaimUsable,
  liveSessionCondition,
  MAX_PAGE_LIMIT,
  type Plan as PlanRow,
  planKey,
  progressOf,
  type ScopeOverlapItem,
  SESSION_STALE_AFTER_MS,
  type SessionStatus,
  sessionState,
  summarizeProjectOverlaps,
  type Transaction,
} from "@hivemind/db";
import {
  agentSession,
  apikey,
  event,
  member,
  organization,
  plan,
  project,
  projectApiKey,
  task,
  user,
} from "@hivemind/db/schema";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  max,
  ne,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { projectEvent } from "../event-projection";
import { describeEvent } from "./event-text";
import { loadHomeAnalytics } from "./home-analytics";
import { type HomeNames, loadHomeNames } from "./home-attribution";
import { loadRecentDecisions } from "./home-decisions";
import {
  ATTENTION_LABELS,
  type AttentionItem,
  type AttentionKind,
  HOME_ATTENTION_LIMIT,
  HOME_DECISION_LIMIT,
  HOME_EVENT_LIMIT,
  HOME_OVERLAP_LIMIT,
  HOME_PROJECT_LIMIT,
  HOME_TABLE_ROWS,
  type HomeAnalytics,
  type HomeCounts,
  type HomeDashboard,
  type HomeEventView,
  type HomeOverlap,
  type HomeParams,
  type HomePlanRow,
  type HomePlansSection,
  type HomeProject,
  type HomeRange,
  type HomeSessionRow,
  type HomeSessionState,
  type HomeSessionsSection,
  LEASE_ENDING_SECONDS,
  LIST_TABLE_ROWS,
  type PlanTab,
  type SessionTab,
  UNCLAIMED_PLAN_SECONDS,
} from "./home-types";
import { likePattern } from "./like-pattern";
import type { Attribution, SessionLabel, TaskRef } from "./queries";
import { runDashboardSnapshot } from "./snapshot";

// The signed-in home page's read (./home-types.ts). Like the Project pages
// (./queries.ts, docs/dashboard.md):
//
// - Everything is read in one snapshot (`runDashboardSnapshot`), and
//   liveness, usable claims and overlaps are M2's (`sessionState`,
//   `effectiveSessionStatusSql`, `liveSessionCondition`, `isClaimUsable`,
//   `summarizeProjectOverlaps`), judged at the snapshot's database `now`.
// - The readable Projects are those of the Organizations the User is a
//   current Member of, read from `member` inside the snapshot. Every other
//   read is limited to them (or to the selected one), so another
//   Organization's data is never read.
// - Lists are set-based across the Projects in scope and bounded; only the
//   overlap summary runs per Project, because M2 computes it per Project.
// - The filter text `q` is a case-insensitive substring, matched in SQL with
//   its LIKE wildcards escaped, except for Events, whose text exists only
//   once they are described (a bounded window is filtered in memory).

/**
 * How recently a claim must have lapsed to show as "Claim lapsed": an
 * expired lease or a holder that stopped being live, not yet reconciled, or
 * a time-driven `task.released` (`lease_expired`, `session_stale`,
 * `session_abandoned`) of a Task that is still unclaimed and not done.
 */
export const LAPSED_CLAIM_WINDOW_SECONDS = 60 * 60;

/** The newest Events in scope that the activity list filters; it shows at most `HOME_EVENT_LIMIT`. */
export const HOME_EVENT_WINDOW = 200;

/** Live Sessions and overlap pairs compared per Project, the bounds of M2's status read. */
const OVERLAP_SESSION_LIMIT = MAX_PAGE_LIMIT;
const OVERLAP_ITEM_LIMIT = MAX_PAGE_LIMIT;

const TERMINAL_PLAN_STATUSES = ["done", "abandoned"] as const;
const LAPSE_REASONS = ["lease_expired", "session_stale", "session_abandoned"];

interface ScopeProject {
  id: string;
  name: string;
  slug: string;
  organizationName: string;
}

type Context = FeedSnapshotContext;

/**
 * `/`: the signed-in home page's data, read in one snapshot across every
 * Project the User can read, or within the selected one. A selected Project
 * the User cannot read is treated as none (`params.projectId` comes back
 * null). The list views (`plans`, `sessions`) skip Events, attention,
 * analytics and decisions, which return empty; their `counts.blockedTasks`
 * and `counts.tasksDone` are then 0.
 */
export async function loadHomeDashboard(
  db: Db,
  viewer: { id: string; name: string },
  params: HomeParams,
): Promise<HomeDashboard> {
  const { data } = await runDashboardSnapshot(db, (context) =>
    readHomeDashboard(context, viewer, params),
  );
  return data;
}

async function readHomeDashboard(
  context: Context,
  viewer: { id: string; name: string },
  params: HomeParams,
): Promise<HomeDashboard> {
  const { tx, now } = context;
  const readable = await readableProjects(tx, viewer.id);
  const selectedProject = readable.find((item) => item.id === params.projectId) ?? null;
  const scope = selectedProject ? [selectedProject] : readable;
  const scopeIds = scope.map((item) => item.id);
  const projectNames = new Map(readable.map((item) => [item.id, item.name]));
  const projectName = (id: string) => projectNames.get(id) ?? "";
  const isHome = params.view === "home";
  const rowLimit = isHome ? HOME_TABLE_ROWS : LIST_TABLE_ROWS;
  const pattern = params.q === "" ? null : likePattern(params.q);

  // Effectively live (active or idle) and buzzing (active) Sessions per
  // readable Project, for the rail and to find Projects that can overlap.
  const liveness = await readLiveness(context, readable);
  const toHomeProject = (item: ScopeProject): HomeProject => ({
    ...item,
    buzzingCount: liveness.get(item.id)?.buzzing ?? 0,
  });
  const projects = {
    items: readable.slice(0, HOME_PROJECT_LIMIT).map(toHomeProject),
    total: readable.length,
    buzzingTotal: [...liveness.values()].reduce((sum, entry) => sum + entry.buzzing, 0),
  };
  const selected = selectedProject ? toHomeProject(selectedProject) : null;
  const applied = { ...params, projectId: selected?.id ?? null };

  if (scope.length === 0) {
    const tab = tabOrActive(applied.sessionTab, 0);
    return {
      asOf: now,
      viewer: { name: viewer.name },
      params: { ...applied, sessionTab: tab },
      projects,
      selected,
      counts: {
        activePlans: 0,
        buzzing: 0,
        openTasks: 0,
        tasksDone: 0,
        blockedTasks: 0,
        overlaps: 0,
      },
      overlaps: [],
      attention: { items: [], total: 0 },
      sessions: {
        total: 0,
        counts: { active: 0, ended: 0, overlap: 0, all: 0 },
        tab,
        matching: 0,
        rows: [],
      },
      plans: {
        total: 0,
        counts: { all: 0, active: 0, paused: 0, done: 0 },
        tab: applied.planTab,
        matching: 0,
        rows: [],
      },
      events: [],
      analytics: emptyAnalytics(applied.range),
      decisions: [],
    };
  }

  // --- Overlaps (M2's summary, per Project with at least two live Sessions)
  const overlapProjects = scope
    .filter((item) => (liveness.get(item.id)?.live ?? 0) >= 2)
    .slice(0, HOME_PROJECT_LIMIT);
  const overlapItems: { projectId: string; item: ScopeOverlapItem }[] = [];
  for (const item of overlapProjects) {
    const summary = await summarizeProjectOverlaps(context, {
      projectId: item.id,
      sessionLimit: OVERLAP_SESSION_LIMIT,
      overlapLimit: OVERLAP_ITEM_LIMIT,
    });
    for (const overlap of summary.overlaps) {
      overlapItems.push({ projectId: item.id, item: overlap });
    }
  }
  const overlappingIds = new Set(
    overlapItems.flatMap(({ item }) => [item.sessionId, item.otherSessionId]),
  );
  const shownOverlaps = overlapItems.slice(0, HOME_OVERLAP_LIMIT);

  // --- Sessions and Plans tables
  const sessions = await readSessionsSection(context, {
    scopeIds,
    pattern,
    tab: applied.sessionTab,
    overlappingIds,
    limit: rowLimit,
  });
  const plans = await readPlansSection(tx, {
    scopeIds,
    pattern,
    tab: applied.planTab,
    limit: rowLimit,
  });

  // --- Home-only sections
  let attention: AttentionRead = { items: [], total: 0, blockedTotal: 0, holderIds: [] };
  let eventRows: EventCandidate[] = [];
  let analytics = emptyAnalytics(applied.range);
  let decisions: HomeDashboard["decisions"] = [];
  if (isHome) {
    attention = await readAttention(context, { scopeIds, q: applied.q, projectName });
    eventRows = await readEvents(tx, { scopeIds, q: applied.q, projectName });
    const inputProjects = scope.map((item) => ({ id: item.id, name: item.name }));
    analytics = await loadHomeAnalytics(tx, {
      projects: inputProjects,
      q: applied.q,
      range: applied.range,
      now,
      overlappingScopes: overlapItems.flatMap(({ projectId, item }) => [
        { projectId, scope: item.scope.value },
        { projectId, scope: item.otherScope.value },
      ]),
    });
    decisions = await loadRecentDecisions(tx, {
      projects: inputProjects,
      q: applied.q,
      limit: HOME_DECISION_LIMIT,
    });
  }

  // --- Records other records name: Sessions as labels, Plan keys, Tasks
  const labelRows = await readSessionRows(tx, scopeIds, [
    ...shownOverlaps.flatMap(({ item }) => [item.sessionId, item.otherSessionId]),
    ...attention.holderIds,
  ]);
  const eventTasks = await readTaskRefs(
    tx,
    scopeIds,
    eventRows.map(({ row }) => row.taskId),
  );
  const planNumbers = await readPlanNumbers(tx, scopeIds, [
    ...sessions.rows.map((row) => row.attachedPlanId),
    ...eventRows.map(({ row }) => row.planId),
  ]);

  // --- Names, once for every Attribution on the page
  const names = await loadHomeNames(tx, {
    userIds: [
      ...sessions.rows.map((row) => row.userId),
      ...[...labelRows.values()].map((row) => row.userId),
      ...plans.rows.map((row) => row.createdByUserId),
      ...eventRows.map(({ row }) => row.actorUserId),
    ],
    keys: [
      ...sessions.rows.map(sessionKey),
      ...[...labelRows.values()].map(sessionKey),
      ...plans.rows.map((row) =>
        row.createdByKeyId ? { projectId: row.projectId, keyId: row.createdByKeyId } : null,
      ),
      ...eventRows.map(({ row }) =>
        row.actorKeyId ? { projectId: row.projectId, keyId: row.actorKeyId } : null,
      ),
    ],
  });
  const label = (sessionId: string | null): SessionLabel | null => {
    const row = sessionId ? labelRows.get(sessionId) : undefined;
    if (!row) return null;
    return {
      id: row.id,
      agent: row.agent,
      owner: sessionOwner(row, names),
      status: sessionState(row, now).effectiveStatus,
    };
  };
  const keyOf = (planId: string | null) => {
    const number = planId ? planNumbers.get(planId) : undefined;
    return number === undefined ? null : planKey(number);
  };

  const sessionsSection: HomeSessionsSection = {
    total: sessions.counts.all,
    counts: sessions.counts,
    tab: sessions.tab,
    matching: sessions.counts[sessions.tab],
    rows: sessions.rows.map((row): HomeSessionRow => {
      const status = sessionState(row, now).effectiveStatus;
      return {
        id: row.id,
        projectId: row.projectId,
        projectName: projectName(row.projectId),
        intent: row.intent,
        agent: row.agent,
        owner: sessionOwner(row, names),
        machine: row.machine,
        status,
        state: homeSessionState(status),
        gitBranch: row.gitBranch,
        focusPlanKey: keyOf(row.attachedPlanId),
        lastHeartbeatAt: row.lastHeartbeatAt,
        endedAt: row.endedAt,
        overlapping: overlappingIds.has(row.id),
      };
    }),
  };

  const plansSection: HomePlansSection = {
    total: plans.counts.all,
    counts: plans.counts,
    tab: applied.planTab,
    matching: plans.counts[applied.planTab],
    rows: plans.rows.map(
      (row): HomePlanRow => ({
        id: row.id,
        projectId: row.projectId,
        projectName: projectName(row.projectId),
        key: planKey(row.number),
        title: row.title,
        status: row.status,
        progress: { ...(plans.progress.get(row.id) ?? emptyProgress()) },
        createdBy: planCreator(row, names),
        updatedAt: row.updatedAt,
      }),
    ),
  };

  const overlaps = shownOverlaps.map(
    ({ projectId, item }): HomeOverlap => ({
      projectId,
      projectName: projectName(projectId),
      path: item.witness ?? item.scope.value,
      session: label(item.sessionId),
      scope: item.scope.value,
      otherSession: label(item.otherSessionId),
      otherScope: item.otherScope.value,
      kind: item.kind,
    }),
  );

  const events = eventRows.map(
    ({ row, projected, text, actorAgent }): HomeEventView => ({
      id: projected.id,
      seq: projected.seq,
      type: projected.type,
      actor: eventActor(row, names),
      actorSessionId: row.actorSessionId,
      planKey: keyOf(row.planId),
      task: row.taskId ? (eventTasks.get(row.taskId) ?? null) : null,
      sessionId: row.sessionId,
      effectiveAt: row.effectiveAt,
      text: text.text,
      markdown: text.markdown,
      projectId: row.projectId,
      projectName: projectName(row.projectId),
      actorAgent,
    }),
  );

  const counts: HomeCounts = {
    activePlans: plans.counts.active,
    buzzing: sessions.buzzing,
    openTasks: plans.openTasks,
    tasksDone: analytics.throughput.tasksDone.value ?? 0,
    blockedTasks: attention.blockedTotal,
    overlaps: overlapItems.length,
  };

  return {
    asOf: now,
    viewer: { name: viewer.name },
    params: { ...applied, sessionTab: sessions.tab },
    projects,
    selected,
    counts,
    overlaps,
    attention: {
      items: attention.items.map((item) => item.build(label)),
      total: attention.total,
    },
    sessions: sessionsSection,
    plans: plansSection,
    events,
    analytics,
    decisions,
  };
}

// --- Projects -----------------------------------------------------------------

/** The Projects of every Organization `userId` is a current Member of, by name. */
async function readableProjects(tx: Transaction, userId: string): Promise<ScopeProject[]> {
  return tx
    .select({
      id: project.id,
      name: project.name,
      slug: project.slug,
      organizationName: organization.name,
    })
    .from(project)
    .innerJoin(organization, eq(organization.id, project.organizationId))
    .where(
      exists(
        tx
          .select({ one: sql`1` })
          .from(member)
          .where(and(eq(member.organizationId, project.organizationId), eq(member.userId, userId))),
      ),
    )
    .orderBy(asc(project.name), asc(project.id));
}

async function readLiveness(
  { tx, now }: Context,
  readable: ScopeProject[],
): Promise<Map<string, { live: number; buzzing: number }>> {
  if (readable.length === 0) return new Map();
  const rows = await tx
    .select({
      projectId: agentSession.projectId,
      live: sql<number>`count(*)::int`,
      buzzing: sql<number>`(count(*) filter (where ${effectiveSessionStatusSql(now)} = 'active'))::int`,
    })
    .from(agentSession)
    .where(
      and(
        inArray(
          agentSession.projectId,
          readable.map((item) => item.id),
        ),
        liveSessionCondition(now),
      ),
    )
    .groupBy(agentSession.projectId);
  return new Map(rows.map((row) => [row.projectId, { live: row.live, buzzing: row.buzzing }]));
}

// --- Filter text ----------------------------------------------------------------

function planKeyLike(pattern: string): SQL {
  return sql`('PLAN-' || ${plan.number}) ilike ${pattern}`;
}

/** `column` names a Project in scope whose name matches. */
function projectNameLike(
  tx: Transaction,
  column: AnyColumn,
  scopeIds: string[],
  pattern: string,
): SQL {
  return inArray(
    column,
    tx
      .select({ id: project.id })
      .from(project)
      .where(and(inArray(project.id, scopeIds), ilike(project.name, pattern))),
  );
}

/** The User named by `userId` matches. */
function userNameLike(tx: Transaction, userId: AnyColumn, pattern: string): SQL {
  return exists(
    tx
      .select({ one: sql`1` })
      .from(user)
      .where(and(eq(user.id, userId), ilike(user.name, pattern))),
  );
}

/** The Project key `keyId`, through its binding to `projectId`, has a matching name. */
function keyNameLike(
  tx: Transaction,
  projectId: AnyColumn,
  keyId: AnyColumn,
  pattern: string,
): SQL {
  return exists(
    tx
      .select({ one: sql`1` })
      .from(projectApiKey)
      .innerJoin(apikey, eq(apikey.id, projectApiKey.keyId))
      .where(
        and(
          eq(projectApiKey.projectId, projectId),
          eq(projectApiKey.keyId, keyId),
          ilike(apikey.name, pattern),
        ),
      ),
  );
}

// --- Sessions -------------------------------------------------------------------

function homeSessionState(status: SessionStatus): HomeSessionState {
  if (status === "active") return "buzzing";
  if (status === "ended" || status === "abandoned") return "ended";
  return "resting";
}

/** The requested tab, or `active` when it is `overlap` and no Session overlaps. */
function tabOrActive(tab: SessionTab, overlapping: number): SessionTab {
  return tab === "overlap" && overlapping === 0 ? "active" : tab;
}

function sessionKey(row: AgentSession): { projectId: string; keyId: string } | null {
  return row.ownerKind === "key" && row.keyId
    ? { projectId: row.projectId, keyId: row.keyId }
    : null;
}

function sessionOwner(row: AgentSession, names: HomeNames): Attribution {
  if (row.ownerKind === "key" && row.keyId) return names.key(row.projectId, row.keyId);
  if (row.userId) return names.user(row.userId);
  // agent_session's owner check constraint rules this out.
  throw new Error(`Session ${row.id} has no owner.`);
}

/** Sessions matching `pattern` on intent, agent, owner, machine, branch, Plan key or Project name. */
function sessionMatches(tx: Transaction, scopeIds: string[], pattern: string): SQL {
  return or(
    ilike(agentSession.intent, pattern),
    ilike(agentSession.agent, pattern),
    ilike(agentSession.machine, pattern),
    ilike(agentSession.gitBranch, pattern),
    userNameLike(tx, agentSession.userId, pattern),
    keyNameLike(tx, agentSession.projectId, agentSession.keyId, pattern),
    exists(
      tx
        .select({ one: sql`1` })
        .from(plan)
        .where(
          and(
            eq(plan.id, agentSession.attachedPlanId),
            eq(plan.projectId, agentSession.projectId),
            planKeyLike(pattern),
          ),
        ),
    ),
    projectNameLike(tx, agentSession.projectId, scopeIds, pattern),
  ) as SQL;
}

interface SessionsRead {
  counts: Record<SessionTab, number>;
  buzzing: number;
  tab: SessionTab;
  rows: AgentSession[];
}

async function readSessionsSection(
  { tx, now }: Context,
  input: {
    scopeIds: string[];
    pattern: string | null;
    tab: SessionTab;
    overlappingIds: Set<string>;
    limit: number;
  },
): Promise<SessionsRead> {
  const effective = effectiveSessionStatusSql(now);
  const ended = sql`(${effective} in ('ended', 'abandoned'))`;
  const overlapping =
    input.overlappingIds.size === 0
      ? sql`false`
      : inArray(agentSession.id, [...input.overlappingIds]);
  const where = and(
    inArray(agentSession.projectId, input.scopeIds),
    input.pattern === null ? undefined : sessionMatches(tx, input.scopeIds, input.pattern),
  );
  const [row] = await tx
    .select({
      all: sql<number>`count(*)::int`,
      ended: sql<number>`(count(*) filter (where ${ended}))::int`,
      buzzing: sql<number>`(count(*) filter (where ${effective} = 'active'))::int`,
      overlap: sql<number>`(count(*) filter (where ${overlapping}))::int`,
    })
    .from(agentSession)
    .where(where);
  const all = row?.all ?? 0;
  const endedCount = row?.ended ?? 0;
  const counts: Record<SessionTab, number> = {
    active: all - endedCount,
    ended: endedCount,
    overlap: row?.overlap ?? 0,
    all,
  };
  const tab = tabOrActive(input.tab, counts.overlap);
  const tabCondition: Record<SessionTab, SQL | undefined> = {
    active: not(ended),
    ended,
    overlap: overlapping,
    all: undefined,
  };
  const rows = await tx
    .select()
    .from(agentSession)
    .where(and(where, tabCondition[tab]))
    // Live first, by last heartbeat; then ended, by end time.
    .orderBy(
      sql`${ended} asc`,
      sql`case when ${ended} then coalesce(${agentSession.endedAt}, ${agentSession.lastHeartbeatAt}) else ${agentSession.lastHeartbeatAt} end desc`,
      desc(agentSession.id),
    )
    .limit(input.limit);
  return { counts, buzzing: row?.buzzing ?? 0, tab, rows };
}

/** Sessions of the Projects in scope by id. */
async function readSessionRows(
  tx: Transaction,
  scopeIds: string[],
  sessionIds: (string | null)[],
): Promise<Map<string, AgentSession>> {
  const ids = unique(sessionIds);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(agentSession)
    .where(and(inArray(agentSession.projectId, scopeIds), inArray(agentSession.id, ids)));
  return new Map(rows.map((row) => [row.id, row]));
}

// --- Plans ----------------------------------------------------------------------

function planCreator(row: PlanRow, names: HomeNames): Attribution {
  if (row.createdByKind === "project_key" && row.createdByKeyId) {
    return names.key(row.projectId, row.createdByKeyId);
  }
  if (row.createdByUserId) return names.user(row.createdByUserId);
  return { kind: "system" };
}

/** Plans matching `pattern` on key, title, Project name, creator name or status. */
function planMatches(tx: Transaction, scopeIds: string[], pattern: string): SQL {
  return or(
    planKeyLike(pattern),
    ilike(plan.title, pattern),
    ilike(plan.status, pattern),
    projectNameLike(tx, plan.projectId, scopeIds, pattern),
    userNameLike(tx, plan.createdByUserId, pattern),
    keyNameLike(tx, plan.projectId, plan.createdByKeyId, pattern),
  ) as SQL;
}

interface PlansRead {
  counts: Record<PlanTab, number>;
  openTasks: number;
  rows: PlanRow[];
  progress: Map<string, ReturnType<typeof emptyProgress>>;
}

async function readPlansSection(
  tx: Transaction,
  input: { scopeIds: string[]; pattern: string | null; tab: PlanTab; limit: number },
): Promise<PlansRead> {
  const where = and(
    inArray(plan.projectId, input.scopeIds),
    input.pattern === null ? undefined : planMatches(tx, input.scopeIds, input.pattern),
  );
  const [row] = await tx
    .select({
      all: sql<number>`count(*)::int`,
      active: sql<number>`(count(*) filter (where ${plan.status} = 'active'))::int`,
      paused: sql<number>`(count(*) filter (where ${plan.status} = 'paused'))::int`,
      done: sql<number>`(count(*) filter (where ${plan.status} = 'done'))::int`,
    })
    .from(plan)
    .where(where);
  const counts: Record<PlanTab, number> = {
    all: row?.all ?? 0,
    active: row?.active ?? 0,
    paused: row?.paused ?? 0,
    done: row?.done ?? 0,
  };
  const [open] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(task)
    .where(
      and(
        inArray(task.projectId, input.scopeIds),
        ne(task.status, "done"),
        inArray(
          task.planId,
          tx
            .select({ id: plan.id })
            .from(plan)
            .where(and(where, notInArray(plan.status, [...TERMINAL_PLAN_STATUSES]))),
        ),
      ),
    );
  const rows = await tx
    .select()
    .from(plan)
    .where(and(where, input.tab === "all" ? undefined : eq(plan.status, input.tab)))
    .orderBy(desc(plan.updatedAt), desc(plan.id))
    .limit(input.limit);
  const progress = await progressOf(
    tx,
    rows.map((item) => item.id),
  );
  return { counts, openTasks: open?.count ?? 0, rows, progress };
}

/** PLAN-N numbers of Plans in scope, by id. */
async function readPlanNumbers(
  tx: Transaction,
  scopeIds: string[],
  planIds: (string | null)[],
): Promise<Map<string, number>> {
  const ids = unique(planIds);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: plan.id, number: plan.number })
    .from(plan)
    .where(and(inArray(plan.projectId, scopeIds), inArray(plan.id, ids)));
  return new Map(rows.map((row) => [row.id, row.number]));
}

/** Tasks of the Projects in scope by id, with their Plan's key. */
async function readTaskRefs(
  tx: Transaction,
  scopeIds: string[],
  taskIds: (string | null)[],
): Promise<Map<string, TaskRef>> {
  const ids = unique(taskIds);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: task.id, title: task.title, position: task.position, number: plan.number })
    .from(task)
    .innerJoin(plan, eq(plan.id, task.planId))
    .where(and(inArray(task.projectId, scopeIds), inArray(task.id, ids)));
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, title: row.title, position: row.position, planKey: planKey(row.number) },
    ]),
  );
}

// --- Needs attention ------------------------------------------------------------

/** An attention item before its holder's label (and so its owner's name) is known. */
interface PendingAttention {
  build(label: (sessionId: string | null) => SessionLabel | null): AttentionItem;
}

interface AttentionRead {
  /** At most `HOME_ATTENTION_LIMIT`, most urgent first. */
  items: PendingAttention[];
  total: number;
  /** Blocked Tasks matching the filter, for the summary cell. */
  blockedTotal: number;
  holderIds: (string | null)[];
}

const totalOver = sql<number>`(count(*) over ())::int`;

/**
 * Advisory items, most urgent kind first (lease ending, claim lapsed,
 * blocked Task, unclaimed Plan, paused Plan). Within a kind: leases ending
 * soonest first, everything else most recent first. Each kind is one
 * bounded query that also counts all its matches.
 */
async function readAttention(
  context: Context,
  input: {
    scopeIds: string[];
    /** The filter; an item matches on its subject or on its kind's label. */
    q: string;
    projectName: (id: string) => string;
  },
): Promise<AttentionRead> {
  const { tx, now } = context;
  const { scopeIds, q, projectName } = input;
  const pattern = q === "" ? null : likePattern(q);
  // Every item of a kind whose label contains the filter matches, as the
  // design's filter does (it searches the label with the item's fields).
  const labelMatches = (kind: AttentionKind) =>
    ATTENTION_LABELS[kind].toLowerCase().includes(q.toLowerCase());
  const limit = HOME_ATTENTION_LIMIT;
  const lapsedSince = new Date(now.getTime() - LAPSED_CLAIM_WINDOW_SECONDS * 1000);
  const base = (projectId: string, number: number) => ({
    projectId,
    projectName: projectName(projectId),
    planKey: planKey(number),
  });
  const taskMatches = (kind: AttentionKind) =>
    pattern === null || labelMatches(kind)
      ? undefined
      : or(
          ilike(task.title, pattern),
          kind === "blocked_task" ? ilike(task.blockReason, pattern) : undefined,
          planKeyLike(pattern),
          projectNameLike(tx, task.projectId, scopeIds, pattern),
        );
  const planSubjectMatches = (kind: AttentionKind) =>
    pattern === null || labelMatches(kind)
      ? undefined
      : or(
          ilike(plan.title, pattern),
          planKeyLike(pattern),
          projectNameLike(tx, plan.projectId, scopeIds, pattern),
        );
  const openPlan = notInArray(plan.status, [...TERMINAL_PLAN_STATUSES]);

  // Usable claims whose lease ends within LEASE_ENDING_SECONDS.
  const leaseEndingRows = await tx
    .select({
      task,
      number: plan.number,
      holderStatus: agentSession.status,
      holderLastHeartbeatAt: agentSession.lastHeartbeatAt,
      total: totalOver,
    })
    .from(task)
    .innerJoin(plan, eq(plan.id, task.planId))
    .innerJoin(agentSession, eq(agentSession.id, task.claimedBySessionId))
    .where(
      and(
        inArray(task.projectId, scopeIds),
        gt(task.leaseExpiresAt, now),
        lte(task.leaseExpiresAt, new Date(now.getTime() + LEASE_ENDING_SECONDS * 1000)),
        liveSessionCondition(now),
        taskMatches("lease_ending"),
      ),
    )
    .orderBy(asc(task.leaseExpiresAt), asc(task.id))
    .limit(limit);
  const leaseEnding = leaseEndingRows.filter((row) =>
    isClaimUsable(
      row.task,
      { status: row.holderStatus, lastHeartbeatAt: row.holderLastHeartbeatAt },
      now,
    ),
  );

  // Claims that stopped being usable (expired lease, or a holder no longer
  // live) and that nothing has reconciled yet.
  const expiredRows = await tx
    .select({
      task,
      number: plan.number,
      holder: agentSession,
      total: totalOver,
    })
    .from(task)
    .innerJoin(plan, eq(plan.id, task.planId))
    .innerJoin(agentSession, eq(agentSession.id, task.claimedBySessionId))
    .where(
      and(
        inArray(task.projectId, scopeIds),
        ne(task.status, "done"),
        openPlan,
        gt(task.leaseExpiresAt, lapsedSince),
        or(lte(task.leaseExpiresAt, now), not(liveSessionCondition(now))),
        taskMatches("claim_lapsed"),
      ),
    )
    .orderBy(desc(task.leaseExpiresAt), desc(task.id))
    .limit(limit);
  const expired = expiredRows.filter(
    (row) => !isClaimUsable(row.task, row.holder, now) && row.task.leaseExpiresAt !== null,
  );

  // Tasks whose latest claim change in the window is a time-driven release,
  // and that are still unclaimed and not done.
  const latest = tx
    .selectDistinctOn([event.taskId], {
      taskId: event.taskId,
      sessionId: event.sessionId,
      effectiveAt: event.effectiveAt,
      type: event.type,
      reason: sql<string | null>`${event.payload} ->> 'reason'`.as("reason"),
      projectId: event.projectId,
      title: task.title,
      number: plan.number,
    })
    .from(event)
    .innerJoin(task, eq(task.id, event.taskId))
    .innerJoin(plan, eq(plan.id, task.planId))
    .where(
      and(
        inArray(event.projectId, scopeIds),
        inArray(event.type, ["task.claimed", "task.released"]),
        gte(event.effectiveAt, lapsedSince),
        isNull(task.claimedBySessionId),
        ne(task.status, "done"),
        openPlan,
        taskMatches("claim_lapsed"),
      ),
    )
    .orderBy(event.taskId, desc(event.seq))
    .as("latest_claim_change");
  const releasedRows = await tx
    .select({
      taskId: latest.taskId,
      sessionId: latest.sessionId,
      effectiveAt: latest.effectiveAt,
      projectId: latest.projectId,
      title: latest.title,
      number: latest.number,
      total: totalOver,
    })
    .from(latest)
    .where(and(eq(latest.type, "task.released"), inArray(latest.reason, LAPSE_REASONS)))
    .orderBy(desc(latest.effectiveAt), desc(latest.taskId))
    .limit(limit);

  const blockedRows = await tx
    .select({
      projectId: task.projectId,
      title: task.title,
      reason: task.blockReason,
      blockedAt: task.blockedAt,
      number: plan.number,
      total: totalOver,
    })
    .from(task)
    .innerJoin(plan, eq(plan.id, task.planId))
    .where(
      and(
        inArray(task.projectId, scopeIds),
        eq(task.status, "blocked"),
        openPlan,
        taskMatches("blocked_task"),
      ),
    )
    .orderBy(sql`${task.blockedAt} desc nulls last`, desc(task.id))
    .limit(limit);

  // Raw SQL naming `plan` is used only in WHERE and ORDER BY: Drizzle drops
  // table qualifiers from a single-table query's select list, which would
  // break these correlated subqueries there.
  const hasOpenTask = exists(
    tx
      .select({ one: sql`1` })
      .from(task)
      .where(and(eq(task.planId, plan.id), ne(task.status, "done"))),
  );
  const idleSince = sql`greatest(${plan.updatedAt}, (select max(${event.effectiveAt}) from ${event} where ${event.planId} = ${plan.id} and ${event.type} = 'task.claimed'))`;
  const unclaimedRows = await tx
    .select({ plan, total: totalOver })
    .from(plan)
    .where(
      and(
        inArray(plan.projectId, scopeIds),
        eq(plan.status, "active"),
        hasOpenTask,
        // No Task of the Plan has a usable claim: an unexpired lease held by
        // an effectively live Session.
        not(
          exists(
            tx
              .select({ one: sql`1` })
              .from(task)
              .innerJoin(agentSession, eq(agentSession.id, task.claimedBySessionId))
              .where(
                and(
                  eq(task.planId, plan.id),
                  gt(task.leaseExpiresAt, now),
                  liveSessionCondition(now),
                ),
              ),
          ),
        ),
        sql`${idleSince} <= ${new Date(now.getTime() - UNCLAIMED_PLAN_SECONDS * 1000)}`,
        planSubjectMatches("unclaimed_plan"),
      ),
    )
    .orderBy(sql`${idleSince} desc`, desc(plan.id))
    .limit(limit);

  const pausedRows = await tx
    .select({ plan, total: totalOver })
    .from(plan)
    .where(
      and(
        inArray(plan.projectId, scopeIds),
        eq(plan.status, "paused"),
        hasOpenTask,
        planSubjectMatches("paused_plan"),
      ),
    )
    .orderBy(sql`${plan.pausedAt} desc nulls last`, desc(plan.id))
    .limit(limit);

  // Open Task counts (M2's progress) and last claims of the Plans shown.
  const shownPlanIds = [...unclaimedRows, ...pausedRows].map((row) => row.plan.id);
  const progress = await progressOf(tx, shownPlanIds);
  const openTasks = (planId: string) => {
    const counts = progress.get(planId);
    return counts ? counts.total - counts.done : 0;
  };
  const lastClaims =
    unclaimedRows.length === 0
      ? []
      : await tx
          .select({ planId: event.planId, at: max(event.effectiveAt) })
          .from(event)
          .where(
            and(
              inArray(event.projectId, scopeIds),
              inArray(
                event.planId,
                unclaimedRows.map((row) => row.plan.id),
              ),
              eq(event.type, "task.claimed"),
            ),
          )
          .groupBy(event.planId);
  const lastClaimOf = new Map(lastClaims.map((row) => [row.planId, row.at]));
  const idleSinceOf = (row: PlanRow): Date => {
    const claimed = lastClaimOf.get(row.id);
    return claimed && claimed > row.updatedAt ? claimed : row.updatedAt;
  };

  const pending: PendingAttention[] = [
    ...leaseEnding.map((row) => ({
      build: (label: (id: string | null) => SessionLabel | null): AttentionItem => ({
        ...base(row.task.projectId, row.number),
        kind: "lease_ending",
        taskTitle: row.task.title,
        holder: label(row.task.claimedBySessionId),
        leaseExpiresAt: row.task.leaseExpiresAt ?? now,
      }),
    })),
    ...mergeLapsed(
      expired.map((row) => ({
        at: lapsedAt(row.task.leaseExpiresAt ?? now, row.holder, now),
        projectId: row.task.projectId,
        number: row.number,
        title: row.task.title,
        holderId: row.task.claimedBySessionId,
      })),
      releasedRows.map((row) => ({
        at: row.effectiveAt,
        projectId: row.projectId,
        number: row.number,
        title: row.title,
        holderId: row.sessionId,
      })),
    ).map((row) => ({
      build: (label: (id: string | null) => SessionLabel | null): AttentionItem => ({
        ...base(row.projectId, row.number),
        kind: "claim_lapsed",
        taskTitle: row.title,
        holder: label(row.holderId),
        lapsedAt: row.at,
      }),
    })),
    ...blockedRows.map((row) => ({
      build: (): AttentionItem => ({
        ...base(row.projectId, row.number),
        kind: "blocked_task",
        taskTitle: row.title,
        reason: row.reason ?? "",
        blockedAt: row.blockedAt,
      }),
    })),
    ...unclaimedRows.map(({ plan: row }) => ({
      build: (): AttentionItem => ({
        ...base(row.projectId, row.number),
        kind: "unclaimed_plan",
        planTitle: row.title,
        openTaskCount: openTasks(row.id),
        idleSince: idleSinceOf(row),
      }),
    })),
    ...pausedRows.map(({ plan: row }) => ({
      build: (): AttentionItem => ({
        ...base(row.projectId, row.number),
        kind: "paused_plan",
        planTitle: row.title,
        openTaskCount: openTasks(row.id),
        pausedAt: row.pausedAt,
      }),
    })),
  ];
  const totalOf = (rows: { total: number }[]) => rows[0]?.total ?? 0;
  const blockedTotal = totalOf(blockedRows);
  const total =
    totalOf(leaseEndingRows) -
    (leaseEndingRows.length - leaseEnding.length) +
    totalOf(expiredRows) -
    (expiredRows.length - expired.length) +
    totalOf(releasedRows) +
    blockedTotal +
    totalOf(unclaimedRows) +
    totalOf(pausedRows);
  return {
    items: pending.slice(0, limit),
    total,
    blockedTotal,
    holderIds: [
      ...leaseEnding.map((row) => row.task.claimedBySessionId),
      ...expired.map((row) => row.task.claimedBySessionId),
      ...releasedRows.map((row) => row.sessionId),
    ],
  };
}

/**
 * When an unreconciled claim stopped being usable: its lease's expiry, or
 * earlier, when its holder stopped being live (ended, or its heartbeat
 * crossed the stale threshold).
 */
function lapsedAt(leaseExpiresAt: Date, holder: AgentSession, now: Date): Date {
  if (leaseExpiresAt.getTime() <= now.getTime()) return leaseExpiresAt;
  const notLiveSince =
    holder.endedAt ?? new Date(holder.lastHeartbeatAt.getTime() + SESSION_STALE_AFTER_MS);
  return notLiveSince.getTime() < leaseExpiresAt.getTime() ? notLiveSince : leaseExpiresAt;
}

function mergeLapsed<T extends { at: Date }>(a: T[], b: T[]): T[] {
  return [...a, ...b].sort((x, y) => y.at.getTime() - x.at.getTime());
}

// --- Events ---------------------------------------------------------------------

interface EventCandidate {
  row: EventRow;
  projected: ReturnType<typeof projectEvent>;
  text: ReturnType<typeof describeEvent>;
  actorAgent: string | null;
}

/**
 * The newest Events in scope matching `q` on their described text, type,
 * actor agent or Project name: the newest `HOME_EVENT_WINDOW` are read and
 * filtered here, because their text exists only once described. Without a
 * filter, only the `HOME_EVENT_LIMIT` shown are read.
 *
 * The newest are found per Project, each through `event_project_id_seq_idx`
 * (at most `limit` index entries per Project), and merged by `seq`. A single
 * `project_id in (…) order by seq desc` could instead walk the global
 * `event_seq_unique` index through every tenant's newer Events.
 */
async function readEvents(
  tx: Transaction,
  input: { scopeIds: string[]; q: string; projectName: (id: string) => string },
): Promise<EventCandidate[]> {
  const limit = input.q === "" ? HOME_EVENT_LIMIT : HOME_EVENT_WINDOW;
  const newest = sql`
    select newest.seq
    from unnest(${sql.param(input.scopeIds)}::uuid[]) as p(id)
      cross join lateral (
        select e.seq from event e
        where e.project_id = p.id
        order by e.seq desc
        limit ${limit}
      ) as newest
    order by newest.seq desc
    limit ${limit}
  `;
  const rows = await tx
    .select()
    .from(event)
    .where(and(inArray(event.projectId, input.scopeIds), sql`${event.seq} in (${newest})`))
    .orderBy(desc(event.seq));
  const actorIds = unique(rows.map((row) => row.actorSessionId));
  const agents =
    actorIds.length === 0
      ? []
      : await tx
          .select({ id: agentSession.id, agent: agentSession.agent })
          .from(agentSession)
          .where(
            and(
              inArray(agentSession.projectId, input.scopeIds),
              inArray(agentSession.id, actorIds),
            ),
          );
  const agentOf = new Map(agents.map((row) => [row.id, row.agent]));
  const needle = input.q.toLowerCase();
  const shown: EventCandidate[] = [];
  for (const row of rows) {
    // Through the shared projection, so an Event this build cannot read
    // shows as unavailable and its stored payload never reaches the page.
    const projected = projectEvent(row);
    const text = describeEvent(projected.type, projected.payload);
    const actorAgent = row.actorSessionId ? (agentOf.get(row.actorSessionId) ?? null) : null;
    const haystack = [
      text.text,
      projected.type,
      actorAgent ?? "",
      input.projectName(row.projectId),
    ];
    if (needle !== "" && !haystack.some((value) => value.toLowerCase().includes(needle))) continue;
    shown.push({ row, projected, text, actorAgent });
    if (shown.length === HOME_EVENT_LIMIT) break;
  }
  return shown;
}

function eventActor(row: EventRow, names: HomeNames): Attribution {
  if (row.actorKind === "project_key" && row.actorKeyId) {
    return names.key(row.projectId, row.actorKeyId);
  }
  if (row.actorKind === "user" && row.actorUserId) return names.user(row.actorUserId);
  return { kind: "system" };
}

// --- Empty values ---------------------------------------------------------------

function unique(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value): value is string => value !== null))];
}

function emptyProgress() {
  return { total: 0, todo: 0, inProgress: 0, blocked: 0, done: 0 };
}

/** Analytics with nothing in them, for the list views and a User with no Projects. */
function emptyAnalytics(range: HomeRange): HomeAnalytics {
  const none = { value: 0, previous: 0 };
  return {
    throughput: {
      range,
      unit: range === "24h" ? "hour" : "day",
      buckets: [],
      tasksDone: none,
      sessionsStarted: none,
      plansFinished: none,
      medianTaskMinutes: { value: null, previous: null },
    },
    agents: [],
    hotPaths: [],
  };
}
