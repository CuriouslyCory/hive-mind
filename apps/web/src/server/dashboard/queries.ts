import {
  ADR_STATUSES,
  type AdrStatus,
  MAX_STATUS_SECTION_ITEMS,
  parseAdrContent,
  parseAdrIdentifier,
} from "@hivemind/contract";
import {
  type AdrLink,
  type AdrState,
  type AdrSyncState,
  type AdrView,
  type CoordinationContext,
  type Db,
  type Event as EventRow,
  type FeedSnapshotContext,
  isScopeComplete,
  listEvents,
  type PlanProgress,
  type PlanStatus,
  type Principal,
  ProjectAccessLostError,
  planKey,
  planNumbers,
  readAdr,
  readAdrItems,
  readAdrSyncState,
  readPlan,
  readPlans,
  readPlanTasks,
  readProjectStatus,
  readRecentAdrs,
  readScopes,
  readSession,
  readSessions,
  recheckProjectAccess,
  type ScopeOverlapItem,
  type Scope as ScopeRow,
  type SessionState,
  type SessionStatus,
  sessionState,
  type TaskStatus,
  type Transaction,
} from "@hivemind/db";
import {
  agentSession,
  apikey,
  member,
  organization,
  project,
  projectApiKey,
  task,
  user,
} from "@hivemind/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  type CursorScope,
  decodeKeysetCursor,
  EPOCH_MS_POSITION,
  encodeKeysetCursor,
  INT4_POSITION,
  type PositionField,
  SEQ_POSITION,
  UUID_POSITION,
} from "../api/keyset";
import { after, decodeCursor, encodeCursor, positionOf } from "../api/pagination";
import { projectEvent } from "../event-projection";
import { describeEvent } from "./event-text";
import { type DashboardSnapshot, projectFeedCursor, runDashboardSnapshot } from "./snapshot";

// Display projections for the dashboard pages (issue #11, step 5). Each page
// loads everything it shows with one call here, in one snapshot
// (`runDashboardSnapshot`):
//
// - Authorization comes first and runs inside the snapshot: the signed-in
//   User must be a current Member of the Project's Organization, read from
//   `member` (M2's `recheckProjectAccess`). The login session's
//   `activeOrganizationId` is never consulted.
// - Child lookups (a Plan by key, a Session by id) always include the
//   Project, so a child of another Project and an absent child both return
//   `null`, as does an inaccessible Project; the page answers `notFound()`.
// - Coordination rules (Task progress, usable claims, effective Session
//   liveness, overlaps) come from M2's read functions in `@hivemind/db`,
//   judged at the snapshot's database `now`. Nothing here infers them from
//   timestamps or claim columns.
// - Every list is bounded and keyset-paged. Cursors are opaque, bound to the
//   list they came from (`../api/keyset`), and travel in search params; one
//   that does not decode, or names no row of its list, shows the first page.
// - A Session or Event attributed to a Project key shows the key, never the
//   key's creator or any User.

/** Rows per page of the dashboard's paged lists. */
export const DASHBOARD_PAGE_SIZE = 20;
/** Events per page of an activity list or Session timeline. */
export const DASHBOARD_EVENT_PAGE_SIZE = 50;
/** The longest cursor a search param may carry (the API's cursor bound). */
export const MAX_CURSOR_LENGTH = 512;
/** ADRs in the overview's "Recent ADRs". */
export const RECENT_ADR_COUNT = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Display types ------------------------------------------------------------

/** Who an Event, Plan or Session is attributed to. */
export type Attribution =
  | { kind: "user"; userId: string; name: string | null }
  | {
      kind: "project_key";
      keyId: string;
      /**
       * The key's name, or null once it is revoked. Never the key's secret
       * prefix (`apikey.start`): every Member sees attributions.
       */
      name: string | null;
      revoked: boolean;
    }
  | { kind: "system" };

export interface ProjectHeader {
  id: string;
  name: string;
  slug: string;
  repoUrl: string | null;
  organizationName: string;
}

/** A page of a list and the cursor of the next page, if there is one. */
export interface DashboardPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** A bounded list that is not paged: `complete` is false when more exist. */
export interface DashboardSection<T> {
  items: T[];
  complete: boolean;
}

export interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  organizationName: string;
}

export interface PlanSummary {
  id: string;
  key: string;
  title: string;
  status: PlanStatus;
  progress: PlanProgress;
}

export interface TaskRef {
  id: string;
  title: string;
  position: number;
  planKey: string;
}

export interface SessionSummary {
  id: string;
  agent: string;
  intent: string;
  /** The effective status at the snapshot's database time. */
  status: SessionStatus;
  owner: Attribution;
  machine: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  attachedPlanKey: string | null;
  attachedTask: TaskRef | null;
  scopeComplete: boolean;
  startedAt: Date;
  lastHeartbeatAt: Date;
  endedAt: Date | null;
}

export interface ScopeView {
  id: string;
  source: "declared" | "touched";
  value: string;
  createdAt: Date;
}

export interface LiveSessionSummary extends SessionSummary {
  declaredScopes: ScopeView[];
  touchedScopeCount: number;
  claimCount: number;
}

/** A Session as other records name it (a claim holder, one side of an overlap). */
export interface SessionLabel {
  id: string;
  agent: string;
  owner: Attribution;
  status: SessionStatus;
}

export interface OverlapView {
  session: SessionLabel | null;
  otherSession: SessionLabel | null;
  sessionId: string;
  otherSessionId: string;
  scope: string;
  otherScope: string;
  kind: "overlap" | "possible";
  witness: string | null;
}

export interface EventView {
  id: string;
  seq: string;
  type: string;
  actor: Attribution;
  actorSessionId: string | null;
  planKey: string | null;
  task: TaskRef | null;
  sessionId: string | null;
  effectiveAt: Date;
  /** Escaped plain text. */
  text: string;
  /** Markdown for the markdown renderer (a Plan log entry), or null. */
  markdown: string | null;
}

export interface TaskRow {
  id: string;
  position: number;
  title: string;
  status: TaskStatus;
  blockedReason: string | null;
  /** The usable claim at the snapshot's time (M2's `TaskView`), or null. */
  claim: { holder: SessionLabel | null; sessionId: string; leaseExpiresAt: Date } | null;
}

/** What every Project page shows and needs, besides its own data. */
export interface ProjectPageBase {
  project: ProjectHeader;
  /** The snapshot's database time; relative times and liveness are as of it. */
  asOf: Date;
  /**
   * Where the page's live updates start: the snapshot's feed fence as the
   * Project's opaque stream cursor (`projectFeedCursor`).
   */
  feedCursor: string;
}

export interface ProjectOverview extends ProjectPageBase {
  activePlans: DashboardPage<PlanSummary>;
  liveSessions: DashboardSection<LiveSessionSummary>;
  recentSessions: DashboardPage<SessionSummary>;
  overlaps: DashboardSection<OverlapView>;
  /** The published ADRs a sync changed most recently, at most `RECENT_ADR_COUNT`. */
  recentAdrs: AdrSummary[];
}

export interface PlanDetail extends ProjectPageBase {
  plan: PlanSummary & {
    body: string | null;
    createdBy: Attribution;
    ownerName: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  tasks: DashboardPage<TaskRow>;
  activity: DashboardPage<EventView>;
  sessions: DashboardPage<SessionSummary>;
}

export interface SessionDetail extends ProjectPageBase {
  session: SessionSummary & { summary: string | null };
  scopes: DashboardPage<ScopeView>;
  events: DashboardPage<EventView>;
}

/** What hive-mind's copy of the ADRs is as of: the Project's last ADR sync. */
export interface AdrSyncView {
  commitSha: string;
  syncedAt: Date;
  syncedBy: Attribution;
}

/** An ADR number as a list shows it. `state` is never shown as a status. */
export interface AdrSummary {
  number: number;
  /** The file's H1, or the reserved title while no file was synced. */
  title: string;
  /** From the synced file; null while only reserved. */
  status: AdrStatus | null;
  state: AdrState;
  /** When a sync last changed the row. */
  syncedAt: Date | null;
}

/** A number reserved with `adr new` whose file has not been synced yet. */
export interface AdrReservationView {
  number: number;
  title: string;
  slug: string;
  gitBranch: string | null;
  reservedBy: Attribution;
  reservedAt: Date;
}

/** Pages on the ADR list: every ADR page carries the last sync. */
export interface AdrPageBase extends ProjectPageBase {
  /** Null when the Project's ADRs were never synced. */
  lastSync: AdrSyncView | null;
}

export interface AdrList extends AdrPageBase {
  /** The `?status=` filter applied, or null for every status. */
  status: AdrStatus | null;
  /** Published ADRs with the status, highest number first. */
  adrs: DashboardPage<AdrSummary>;
  /** ADRs an earlier sync found and a later one did not, highest number first. */
  removed: DashboardPage<AdrSummary>;
  /** Reserved numbers with no synced file, whatever the filter, highest first. */
  reservations: DashboardPage<AdrReservationView>;
}

export interface AdrDetail extends AdrPageBase {
  adr: AdrSummary & {
    slug: string;
    /** The synced file's path; null while only reserved. */
    path: string | null;
    date: string | null;
    /** The sync head commit at which this copy's content last changed. */
    commitSha: string | null;
    /** The file after its frontmatter, for the markdown renderer; null while only reserved. */
    body: string | null;
    reservation: AdrReservationView | null;
    /** A file took this number though it was reserved for another ADR. */
    reservationTaken: boolean;
  };
  /** What this ADR supersedes, then what those supersede, with depth. */
  supersedes: AdrLink[];
  /** Published ADRs that supersede this one, then their successors, with depth. */
  supersededBy: AdrLink[];
  /** The links continue past `MAX_ADR_CHAIN_DEPTH` in at least one direction. */
  chainTruncated: boolean;
}

// --- Cursors ------------------------------------------------------------------

/** A search param value as one bounded string, or undefined. */
export function cursorParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_LENGTH
    ? value
    : undefined;
}

function decodePosition(
  scope: CursorScope,
  cursor: string | undefined,
  fields: readonly PositionField[],
): string[] | null {
  if (cursor === undefined) return null;
  try {
    return decodeKeysetCursor(scope, cursor, fields);
  } catch {
    // A cursor from another list, an old link or a hand-edited URL: start over.
    return null;
  }
}

// --- Authorization and attribution ------------------------------------------------

/**
 * The Project's header if `userId` is a current Member of its Organization,
 * else null (absent and inaccessible alike).
 */
async function readableProject(
  context: CoordinationContext,
  userId: string,
  projectId: string,
): Promise<ProjectHeader | null> {
  if (!UUID.test(projectId)) return null;
  try {
    await recheckProjectAccess(context.tx, projectId, { kind: "user", userId }, context.now);
  } catch (error) {
    if (error instanceof ProjectAccessLostError) return null;
    throw error;
  }
  const [row] = await context.tx
    .select({
      id: project.id,
      name: project.name,
      slug: project.slug,
      repoUrl: project.repoUrl,
      organizationName: organization.name,
    })
    .from(project)
    .innerJoin(organization, eq(organization.id, project.organizationId))
    .where(eq(project.id, projectId))
    .limit(1);
  return row ?? null;
}

function pageBase(header: ProjectHeader, context: FeedSnapshotContext): ProjectPageBase {
  return {
    project: header,
    asOf: context.now,
    feedCursor: projectFeedCursor(header.id, context.fence),
  };
}

interface AttributionIds {
  userIds: Iterable<string | null>;
  keyIds: Iterable<string | null>;
}

interface Attributions {
  user(userId: string): Attribution;
  key(keyId: string): Attribution;
}

/**
 * Display names for Users and Project keys. Keys are looked up only among
 * this Project's bound keys; a revoked key (its binding is gone) shows as
 * revoked by id.
 */
async function loadAttributions(
  tx: Transaction,
  projectId: string,
  ids: AttributionIds,
): Promise<Attributions> {
  const userIds = unique(ids.userIds);
  const keyIds = unique(ids.keyIds);
  const users =
    userIds.length === 0
      ? []
      : await tx
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, userIds));
  const keys =
    keyIds.length === 0
      ? []
      : await tx
          .select({ id: apikey.id, name: apikey.name })
          .from(projectApiKey)
          .innerJoin(apikey, eq(apikey.id, projectApiKey.keyId))
          .where(and(eq(projectApiKey.projectId, projectId), inArray(projectApiKey.keyId, keyIds)));
  const userNames = new Map(users.map((row) => [row.id, row.name]));
  const keyRows = new Map(keys.map((row) => [row.id, row]));
  return {
    user: (userId) => ({ kind: "user", userId, name: userNames.get(userId) ?? null }),
    key: (keyId) => {
      const row = keyRows.get(keyId);
      return {
        kind: "project_key",
        keyId,
        name: row?.name ?? null,
        revoked: row === undefined,
      };
    },
  };
}

function unique(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value): value is string => value !== null))];
}

function sessionOwner(session: SessionState, names: Attributions): Attribution {
  if (session.ownerKind === "key" && session.keyId) return names.key(session.keyId);
  if (session.userId) return names.user(session.userId);
  // agent_session's owner check constraint rules this out.
  throw new Error(`Session ${session.id} has no owner.`);
}

function eventActor(row: EventRow, names: Attributions): Attribution {
  if (row.actorKind === "project_key" && row.actorKeyId) return names.key(row.actorKeyId);
  if (row.actorKind === "user" && row.actorUserId) return names.user(row.actorUserId);
  return { kind: "system" };
}

/** Tasks of the Project by id, with their Plan's key. */
async function loadTaskRefs(
  tx: Transaction,
  projectId: string,
  taskIds: Iterable<string | null>,
): Promise<Map<string, TaskRef>> {
  const ids = unique(taskIds);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: task.id, title: task.title, position: task.position, planId: task.planId })
    .from(task)
    .where(and(eq(task.projectId, projectId), inArray(task.id, ids)));
  const numbers = await planNumbers(
    tx,
    projectId,
    rows.map((row) => row.planId),
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        title: row.title,
        position: row.position,
        planKey: planKey(numbers.get(row.planId) ?? 0),
      },
    ]),
  );
}

/** Sessions of the Project by id, as labels with effective status. */
async function loadSessionLabels(
  context: CoordinationContext,
  projectId: string,
  sessionIds: Iterable<string | null>,
): Promise<Map<string, SessionLabel>> {
  const ids = unique(sessionIds);
  if (ids.length === 0) return new Map();
  const rows = await context.tx
    .select()
    .from(agentSession)
    .where(and(eq(agentSession.projectId, projectId), inArray(agentSession.id, ids)));
  const states = rows.map((row) => sessionState(row, context.now));
  const names = await loadAttributions(context.tx, projectId, {
    userIds: states.map((state) => state.userId),
    keyIds: states.map((state) => state.keyId),
  });
  return new Map(
    states.map((state) => [
      state.id,
      {
        id: state.id,
        agent: state.agent,
        owner: sessionOwner(state, names),
        status: state.effectiveStatus,
      },
    ]),
  );
}

/** Session summaries for display, with owners, Plan keys and attached Tasks. */
async function summarizeSessions(
  context: CoordinationContext,
  projectId: string,
  sessions: readonly SessionState[],
): Promise<SessionSummary[]> {
  const { tx } = context;
  const names = await loadAttributions(tx, projectId, {
    userIds: sessions.map((session) => session.userId),
    keyIds: sessions.map((session) => session.keyId),
  });
  const numbers = await planNumbers(
    tx,
    projectId,
    sessions.map((session) => session.attachedPlanId),
  );
  const tasks = await loadTaskRefs(
    tx,
    projectId,
    sessions.map((session) => session.attachedTaskId),
  );
  return sessions.map((session) => {
    const number = session.attachedPlanId ? numbers.get(session.attachedPlanId) : undefined;
    return {
      id: session.id,
      agent: session.agent,
      intent: session.intent,
      status: session.effectiveStatus,
      owner: sessionOwner(session, names),
      machine: session.machine,
      gitBranch: session.gitBranch,
      gitCommit: session.gitCommit,
      attachedPlanKey: number === undefined ? null : planKey(number),
      attachedTask: session.attachedTaskId ? (tasks.get(session.attachedTaskId) ?? null) : null,
      scopeComplete: isScopeComplete(session),
      startedAt: session.createdAt,
      lastHeartbeatAt: session.lastHeartbeatAt,
      endedAt: session.endedAt,
    };
  });
}

/** Events for display: text from projected Events only, with attributions. */
async function viewEvents(
  context: CoordinationContext,
  projectId: string,
  rows: readonly EventRow[],
): Promise<EventView[]> {
  const { tx } = context;
  const names = await loadAttributions(tx, projectId, {
    userIds: rows.map((row) => row.actorUserId),
    keyIds: rows.map((row) => row.actorKeyId),
  });
  const numbers = await planNumbers(
    tx,
    projectId,
    rows.map((row) => row.planId),
  );
  const tasks = await loadTaskRefs(
    tx,
    projectId,
    rows.map((row) => row.taskId),
  );
  return rows.map((row) => {
    // Through the shared projection, so an Event this build cannot read
    // renders as unavailable and its stored payload never reaches the page.
    const event = projectEvent(row);
    const number = row.planId ? numbers.get(row.planId) : undefined;
    const { text, markdown } = describeEvent(event.type, event.payload);
    return {
      id: event.id,
      seq: event.seq,
      type: event.type,
      actor: eventActor(row, names),
      actorSessionId: row.actorSessionId,
      planKey: number === undefined ? null : planKey(number),
      task: row.taskId ? (tasks.get(row.taskId) ?? null) : null,
      sessionId: row.sessionId,
      effectiveAt: row.effectiveAt,
      text,
      markdown,
    };
  });
}

function principalAttribution(principal: Principal, names: Attributions): Attribution {
  return principal.kind === "user" ? names.user(principal.userId) : names.key(principal.keyId);
}

/** The ids `loadAttributions` needs to name `principals`. */
function principalIds(principals: readonly (Principal | null | undefined)[]): AttributionIds {
  return {
    userIds: principals.map((p) => (p?.kind === "user" ? p.userId : null)),
    keyIds: principals.map((p) => (p?.kind === "project_key" ? p.keyId : null)),
  };
}

function toAdrSyncView(sync: AdrSyncState | null, names: Attributions): AdrSyncView | null {
  return (
    sync && {
      commitSha: sync.commitSha,
      syncedAt: sync.syncedAt,
      syncedBy: principalAttribution(sync.syncedBy, names),
    }
  );
}

function toAdrSummary(view: AdrView): AdrSummary {
  return {
    number: view.number,
    title: view.title,
    status: view.status,
    state: view.state,
    syncedAt: view.syncedAt,
  };
}

function toAdrReservationView(view: AdrView, names: Attributions): AdrReservationView | null {
  const reservation = view.reservation;
  return (
    reservation && {
      number: view.number,
      title: reservation.title,
      slug: reservation.slug,
      gitBranch: reservation.gitBranch,
      reservedBy: principalAttribution(reservation.principal, names),
      reservedAt: reservation.reservedAt,
    }
  );
}

/**
 * The file after its frontmatter, which is shown separately and never
 * rendered as markdown. Null for a stored file this build cannot parse.
 */
function adrBody(contentMd: string | null): string | null {
  if (contentMd === null) return null;
  const parsed = parseAdrContent(contentMd);
  return parsed.ok ? parsed.adr.body : null;
}

/** A page of the Project's ADRs matching `filter`, highest number first. */
async function adrPage(
  tx: Transaction,
  projectId: string,
  filter: { status?: AdrStatus; state: AdrState },
  scope: CursorScope,
  cursor: string | undefined,
): Promise<DashboardPage<AdrView>> {
  const position = decodePosition(scope, cursor, [INT4_POSITION]);
  const page = await readAdrItems(tx, {
    projectId,
    ...filter,
    limit: DASHBOARD_PAGE_SIZE,
    beforeNumber: position ? Number(position[0]) : undefined,
  });
  const last = page.items.at(-1);
  return {
    items: page.items,
    nextCursor: page.hasMore && last ? encodeKeysetCursor(scope, [String(last.number)]) : null,
  };
}

function toScopeView(row: ScopeRow): ScopeView {
  return { id: row.id, source: row.source, value: row.value, createdAt: row.createdAt };
}

function toPlanSummary(view: {
  plan: { id: string; number: number; title: string; status: PlanStatus };
  progress: PlanProgress;
}): PlanSummary {
  return {
    id: view.plan.id,
    key: planKey(view.plan.number),
    title: view.plan.title,
    status: view.plan.status,
    progress: { ...view.progress },
  };
}

/** A page of Events matching `filter`, newest first, continued by seq. */
async function eventPage(
  context: CoordinationContext,
  projectId: string,
  filter: Parameters<typeof listEvents>[1]["filter"],
  scope: CursorScope,
  cursor: string | undefined,
): Promise<DashboardPage<EventView>> {
  const position = decodePosition(scope, cursor, [SEQ_POSITION]);
  const page = await listEvents(context.tx, {
    projectId,
    filter,
    limit: DASHBOARD_EVENT_PAGE_SIZE,
    beforeSeq: position?.[0],
  });
  const last = page.items.at(-1);
  return {
    items: await viewEvents(context, projectId, page.items),
    nextCursor: page.hasMore && last ? encodeKeysetCursor(scope, [last.seq]) : null,
  };
}

/** A page of Sessions, newest first, continued by Session id (M2's `listSessions`). */
async function sessionPage(
  context: CoordinationContext,
  projectId: string,
  filter: { filter?: "terminal"; attachedPlanId?: string },
  scope: CursorScope,
  cursor: string | undefined,
): Promise<DashboardPage<SessionSummary>> {
  const position = decodePosition(scope, cursor, [UUID_POSITION]);
  const input = { projectId, ...filter, limit: DASHBOARD_PAGE_SIZE };
  let page = await readSessions(context, { ...input, after: position?.[0] });
  // A cursor naming no Session of this list: show the first page.
  if (page.status === "invalid_cursor") page = await readSessions(context, input);
  if (page.status !== "ok") throw new Error("The first page of Sessions has no cursor.");
  return {
    items: await summarizeSessions(context, projectId, page.items),
    nextCursor: page.next ? encodeKeysetCursor(scope, [page.next]) : null,
  };
}

// --- Pages --------------------------------------------------------------------

/**
 * `/`: a page of the Projects in the User's Organizations, oldest first,
 * with each Organization's name.
 */
export async function loadProjectList(
  db: Db,
  userId: string,
  cursor: string | undefined,
): Promise<DashboardSnapshot<DashboardPage<ProjectListItem>>> {
  let position: ReturnType<typeof decodeCursor> | null = null;
  if (cursor !== undefined) {
    try {
      position = decodeCursor(cursor);
    } catch {
      position = null;
    }
  }
  return runDashboardSnapshot(db, async ({ tx }) => {
    const rows = await tx
      .select({
        id: project.id,
        name: project.name,
        slug: project.slug,
        organizationName: organization.name,
        position: positionOf(project.createdAt),
      })
      .from(project)
      .innerJoin(
        member,
        and(eq(member.organizationId, project.organizationId), eq(member.userId, userId)),
      )
      .innerJoin(organization, eq(organization.id, project.organizationId))
      .where(position ? after(project.createdAt, project.id, position) : undefined)
      .orderBy(asc(project.createdAt), asc(project.id))
      .limit(DASHBOARD_PAGE_SIZE + 1);
    const items = rows.slice(0, DASHBOARD_PAGE_SIZE);
    const last = items.at(-1);
    return {
      items: items.map(({ position: _position, ...item }) => item),
      nextCursor:
        rows.length > DASHBOARD_PAGE_SIZE && last
          ? encodeCursor({ createdAt: last.position, id: last.id })
          : null,
    };
  });
}

export interface OverviewCursors {
  /** Active Plans page. */
  plans?: string;
  /** Recent (ended or abandoned) Sessions page. */
  recent?: string;
}

/**
 * `/projects/[projectId]`: active Plans with progress, live Sessions with
 * declared Scopes, recent Sessions, overlap warnings and recent ADRs. Null
 * when the Project is absent or the User cannot read it.
 */
export async function loadProjectOverview(
  db: Db,
  userId: string,
  projectId: string,
  cursors: OverviewCursors = {},
): Promise<DashboardSnapshot<ProjectOverview | null>> {
  return runDashboardSnapshot(db, async (context) => {
    const header = await readableProject(context, userId, projectId);
    if (!header) return null;

    const plansScope = ["dashboard.activePlans", projectId];
    const plansPosition = decodePosition(plansScope, cursors.plans, [INT4_POSITION]);
    const plans = await readPlans(context.tx, {
      projectId,
      status: "active",
      limit: DASHBOARD_PAGE_SIZE,
      beforeNumber: plansPosition ? Number(plansPosition[0]) : undefined,
    });
    const lastPlan = plans.items.at(-1);

    // M2's status read: live Sessions with declared Scopes and usable claim
    // counts, and overlap results, at this snapshot's `now`.
    const status = await readProjectStatus(context, {
      projectId,
      sectionLimit: MAX_STATUS_SECTION_ITEMS,
    });
    if (status.status !== "ok") throw new Error("The status read needs no Session.");
    const liveSummaries = await summarizeSessions(
      context,
      projectId,
      status.liveSessions.items.map((entry) => entry.session),
    );
    const liveSessions = liveSummaries.map((summary, index) => {
      const entry = status.liveSessions.items[index];
      return {
        ...summary,
        declaredScopes: entry?.declaredScopes.map(toScopeView) ?? [],
        touchedScopeCount: entry?.touchedScopeCount ?? 0,
        claimCount: entry?.claimCount ?? 0,
      };
    });

    const recentSessions = await sessionPage(
      context,
      projectId,
      { filter: "terminal" },
      ["dashboard.recentSessions", projectId],
      cursors.recent,
    );

    const recentAdrs = await readRecentAdrs(context.tx, { projectId, limit: RECENT_ADR_COUNT });

    const overlapItems = status.overlaps.items;
    const labels = await loadSessionLabels(
      context,
      projectId,
      overlapItems.flatMap((item) => [item.sessionId, item.otherSessionId]),
    );

    return {
      ...pageBase(header, context),
      activePlans: {
        items: plans.items.map(toPlanSummary),
        nextCursor:
          plans.hasMore && lastPlan
            ? encodeKeysetCursor(plansScope, [String(lastPlan.plan.number)])
            : null,
      },
      liveSessions: { items: liveSessions, complete: status.liveSessions.complete },
      recentSessions,
      overlaps: {
        items: overlapItems.map((item) => toOverlapView(item, labels)),
        complete: status.overlaps.complete,
      },
      recentAdrs: recentAdrs.map(toAdrSummary),
    };
  });
}

function toOverlapView(item: ScopeOverlapItem, labels: Map<string, SessionLabel>): OverlapView {
  return {
    session: labels.get(item.sessionId) ?? null,
    otherSession: labels.get(item.otherSessionId) ?? null,
    sessionId: item.sessionId,
    otherSessionId: item.otherSessionId,
    scope: item.scope.value,
    otherScope: item.otherScope.value,
    kind: item.kind,
    witness: item.witness,
  };
}

export interface PlanCursors {
  tasks?: string;
  activity?: string;
  sessions?: string;
}

/**
 * `/projects/[projectId]/plans/[planKey]`: the Plan with its body and
 * progress, a page of its Tasks by position with usable claims, a page of
 * its activity (Events) and a page of the Sessions attached to it. Null when
 * the Project is unreadable or `ref` names no Plan of it.
 */
export async function loadPlanDetail(
  db: Db,
  userId: string,
  projectId: string,
  ref: string,
  cursors: PlanCursors = {},
): Promise<DashboardSnapshot<PlanDetail | null>> {
  return runDashboardSnapshot(db, async (context) => {
    const header = await readableProject(context, userId, projectId);
    if (!header) return null;
    const view = await readPlan(context.tx, projectId, ref);
    if (!view) return null;
    const planId = view.plan.id;

    const tasksScope = ["dashboard.planTasks", projectId, planId];
    const taskPosition = decodePosition(tasksScope, cursors.tasks, [INT4_POSITION, UUID_POSITION]);
    const tasks = await readPlanTasks(context, {
      projectId,
      ref: planId,
      limit: DASHBOARD_PAGE_SIZE,
      after: taskPosition
        ? { position: Number(taskPosition[0]), id: taskPosition[1] ?? "" }
        : undefined,
    });
    if (!tasks) return null;
    const holders = await loadSessionLabels(
      context,
      projectId,
      tasks.items.map((item) => item.claim?.sessionId ?? null),
    );
    const lastTask = tasks.items.at(-1)?.task;

    const activity = await eventPage(
      context,
      projectId,
      { kind: "plan", planId },
      ["dashboard.planEvents", projectId, planId],
      cursors.activity,
    );
    const sessions = await sessionPage(
      context,
      projectId,
      { attachedPlanId: planId },
      ["dashboard.planSessions", projectId, planId],
      cursors.sessions,
    );
    const names = await loadAttributions(context.tx, projectId, {
      userIds: [view.plan.createdByUserId, view.plan.ownerUserId],
      keyIds: [view.plan.createdByKeyId],
    });
    const createdBy =
      view.plan.createdByKind === "project_key" && view.plan.createdByKeyId
        ? names.key(view.plan.createdByKeyId)
        : view.plan.createdByUserId
          ? names.user(view.plan.createdByUserId)
          : ({ kind: "system" } as const);
    const owner = view.plan.ownerUserId ? names.user(view.plan.ownerUserId) : null;

    return {
      ...pageBase(header, context),
      plan: {
        ...toPlanSummary(view),
        body: view.plan.body === "" ? null : view.plan.body,
        createdBy,
        ownerName: owner?.kind === "user" ? owner.name : null,
        createdAt: view.plan.createdAt,
        updatedAt: view.plan.updatedAt,
      },
      tasks: {
        items: tasks.items.map(({ task: row, claim }) => ({
          id: row.id,
          position: row.position,
          title: row.title,
          status: row.status,
          blockedReason: row.status === "blocked" ? row.blockReason : null,
          claim: claim && {
            holder: holders.get(claim.sessionId) ?? null,
            sessionId: claim.sessionId,
            leaseExpiresAt: claim.leaseExpiresAt,
          },
        })),
        nextCursor:
          tasks.hasMore && lastTask
            ? encodeKeysetCursor(tasksScope, [String(lastTask.position), lastTask.id])
            : null,
      },
      activity,
      sessions,
    };
  });
}

export interface SessionCursors {
  events?: string;
  scopes?: string;
}

/**
 * `/projects/[projectId]/sessions/[sessionId]`: the Session with its intent,
 * effective status and end summary, a page of its Scopes (declared and
 * touched, oldest first) and a page of its Event timeline (newest first).
 * Null when the Project is unreadable or the id names no Session of it.
 */
export async function loadSessionDetail(
  db: Db,
  userId: string,
  projectId: string,
  sessionId: string,
  cursors: SessionCursors = {},
): Promise<DashboardSnapshot<SessionDetail | null>> {
  return runDashboardSnapshot(db, async (context) => {
    const header = await readableProject(context, userId, projectId);
    if (!header || !UUID.test(sessionId)) return null;
    const found = await readSession(context, { projectId, sessionId });
    if (found.status !== "ok") return null;
    const [summary] = await summarizeSessions(context, projectId, [found.session]);
    if (!summary) return null;

    const scopesScope = ["dashboard.sessionScopes", projectId, found.session.id];
    const scopePosition = decodePosition(scopesScope, cursors.scopes, [
      EPOCH_MS_POSITION,
      UUID_POSITION,
    ]);
    const scopes = await readScopes(context, {
      projectId,
      sessionId: found.session.id,
      limit: DASHBOARD_PAGE_SIZE,
      after: scopePosition
        ? { createdAt: new Date(Number(scopePosition[0])), id: scopePosition[1] ?? "" }
        : null,
    });
    if (scopes.status !== "ok") return null;

    const events = await eventPage(
      context,
      projectId,
      { kind: "session", sessionId: found.session.id },
      ["dashboard.sessionEvents", projectId, found.session.id],
      cursors.events,
    );

    return {
      ...pageBase(header, context),
      session: { ...summary, summary: found.session.summary },
      scopes: {
        items: scopes.items.map(toScopeView),
        nextCursor: scopes.nextCursor
          ? encodeKeysetCursor(scopesScope, [
              String(scopes.nextCursor.createdAt.getTime()),
              scopes.nextCursor.id,
            ])
          : null,
      },
      events,
    };
  });
}

/** A `?status=` value as an ADR status; anything else means no filter. */
export function adrStatusParam(value: string | string[] | undefined): AdrStatus | undefined {
  return typeof value === "string" && (ADR_STATUSES as readonly string[]).includes(value)
    ? (value as AdrStatus)
    : undefined;
}

export interface AdrListCursors {
  /** Published ADRs page. */
  adrs?: string;
  /** Removed ADRs page. */
  removed?: string;
  /** Reserved numbers page. */
  reserved?: string;
}

export interface AdrListOptions extends AdrListCursors {
  /** The `?status=` filter; a value that is not an ADR status is ignored. */
  status?: string;
}

/**
 * `/projects/[projectId]/adrs`: the Project's ADRs with their status, the
 * removed ones, and the reserved numbers with no synced file, with the last
 * sync. A `status` that is not an ADR status shows every status. Null when
 * the Project is absent or the User cannot read it.
 */
export async function loadAdrList(
  db: Db,
  userId: string,
  projectId: string,
  options: AdrListOptions = {},
): Promise<DashboardSnapshot<AdrList | null>> {
  const status = adrStatusParam(options.status) ?? null;
  return runDashboardSnapshot(db, async (context) => {
    const header = await readableProject(context, userId, projectId);
    if (!header) return null;
    const { tx } = context;
    const filter = status === null ? {} : { status };
    const published = await adrPage(
      tx,
      projectId,
      { ...filter, state: "published" },
      ["dashboard.adrs", projectId, status ?? ""],
      options.adrs,
    );
    const removed = await adrPage(
      tx,
      projectId,
      { ...filter, state: "removed" },
      ["dashboard.removedAdrs", projectId, status ?? ""],
      options.removed,
    );
    const reserved = await adrPage(
      tx,
      projectId,
      { state: "reserved" },
      ["dashboard.reservedAdrs", projectId],
      options.reserved,
    );
    const sync = await readAdrSyncState(tx, projectId);
    const names = await loadAttributions(
      tx,
      projectId,
      principalIds([sync?.syncedBy, ...reserved.items.map((view) => view.reservation?.principal)]),
    );
    return {
      ...pageBase(header, context),
      lastSync: toAdrSyncView(sync, names),
      status,
      adrs: { items: published.items.map(toAdrSummary), nextCursor: published.nextCursor },
      removed: { items: removed.items.map(toAdrSummary), nextCursor: removed.nextCursor },
      reservations: {
        items: reserved.items.flatMap((view) => toAdrReservationView(view, names) ?? []),
        nextCursor: reserved.nextCursor,
      },
    };
  });
}

/**
 * `/projects/[projectId]/adrs/[number]`: one ADR by number (`3`, `0003` or
 * `ADR-0003`) with its metadata, its file's text after the frontmatter, its
 * reservation and its supersedes links both ways (bounded depth), with the
 * last sync. Null when the Project is unreadable or the number names no ADR
 * of it.
 */
export async function loadAdrDetail(
  db: Db,
  userId: string,
  projectId: string,
  ref: string,
): Promise<DashboardSnapshot<AdrDetail | null>> {
  const number = parseAdrIdentifier(ref);
  return runDashboardSnapshot(db, async (context) => {
    const header = await readableProject(context, userId, projectId);
    if (!header || number === null) return null;
    const found = await readAdr(context.tx, { projectId, number });
    if (!found) return null;
    const { adr: view } = found;
    const names = await loadAttributions(
      context.tx,
      projectId,
      principalIds([found.sync?.syncedBy, view.reservation?.principal]),
    );
    return {
      ...pageBase(header, context),
      lastSync: toAdrSyncView(found.sync, names),
      adr: {
        ...toAdrSummary(view),
        slug: view.slug,
        path: view.path,
        date: view.date,
        commitSha: view.commitSha,
        body: adrBody(view.contentMd),
        reservation: toAdrReservationView(view, names),
        reservationTaken: view.reservationTaken,
      },
      supersedes: found.supersedes,
      supersededBy: found.supersededBy,
      chainTruncated: found.chainTruncated,
    };
  });
}
