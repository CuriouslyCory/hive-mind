import { normalizeDeclaredPattern, ScopeMatchContext, type Transaction } from "@hivemind/db";
import { type SQL, sql } from "drizzle-orm";
import {
  ACTIVE_GAP_SECONDS,
  HOME_AGENT_LIMIT,
  HOME_HOT_PATH_LIMIT,
  type HomeAgentRow,
  type HomeAnalytics,
  type HomeHotPath,
  type HomeRange,
  type HomeThroughput,
} from "./home-types";
import { likePattern } from "./like-pattern";

export interface HomeAnalyticsInput {
  /** The Projects in scope: every readable one, or the selected one. Never empty. */
  projects: { id: string; name: string }[];
  /** The filter text (./home-types.ts `HomeParams.q`); empty means none. */
  q: string;
  range: HomeRange;
  /** The snapshot's database time. */
  now: Date;
  /** The Scopes of current overlaps, to flag hot paths. */
  overlappingScopes: { projectId: string; scope: string }[];
}

// The home page's Throughput, Agents and Hot paths panels (docs/dashboard.md),
// read with three set-based statements over every Project in scope, inside
// the caller's snapshot. Every boundary derives from the snapshot's `now`:
//
// - The range is `count` buckets of one `unit` (an hour for 24h, a UTC day
//   for 7d and 30d) ending with the bucket that holds `now`, so the last one
//   is partial. The previous range is the `count` whole buckets before it.
//   Boundaries are computed in SQL with `date_trunc(unit, now, 'UTC')`.
// - Throughput counts Events by type through
//   `event_project_id_type_effective_at_idx`; a done Task's time is measured
//   from the Task's latest `task.claimed` Event before its `task.done`
//   (`event_task_id_seq_idx`).
// - Agents sum each Session's heartbeat gaps shorter than
//   `ACTIVE_GAP_SECONDS` (from `session.started` and `session.heartbeat`
//   Events), clipped to the range.
// - Hot paths count touched-path collection batches
//   (`scope_collection_batch_project_id_created_at_idx`), which outlive their
//   Session, so history survives it.

const RANGE_SHAPE: Record<HomeRange, { unit: "hour" | "day"; count: number }> = {
  "24h": { unit: "hour", count: 24 },
  "7d": { unit: "day", count: 7 },
  "30d": { unit: "day", count: 30 },
};

/** Throughput, agents and hot paths for the home page. */
export async function loadHomeAnalytics(
  tx: Transaction,
  input: HomeAnalyticsInput,
): Promise<HomeAnalytics> {
  const { unit, count } = RANGE_SHAPE[input.range];
  const context: QueryContext = {
    projectIds: sql`${sql.param(input.projects.map((project) => project.id))}::uuid[]`,
    projectNames: sql`${sql.param(input.projects.map((project) => project.name))}::text[]`,
    pattern: input.q === "" ? null : likePattern(input.q),
    bounds: boundsSql(input.now, unit, count),
  };
  const throughput = await readThroughput(tx, context, input.range, unit);
  const agents = await readAgents(tx, context);
  const hotPaths = await readHotPaths(tx, context, input.overlappingScopes);
  return { throughput, agents, hotPaths };
}

interface QueryContext {
  /** The Project ids, as one uuid[] parameter. */
  projectIds: SQL;
  /** Their names, in the same order, as one text[] parameter. */
  projectNames: SQL;
  /** The ILIKE pattern for `q`, or null when there is no filter. */
  pattern: string | null;
  /** A CTE body yielding one row: cur_start, cur_end, prev_start, step, n. */
  bounds: SQL;
}

function boundsSql(now: Date, unit: "hour" | "day", count: number): SQL {
  const step = unit === "hour" ? "1 hour" : "1 day";
  return sql`
    select
      cur_start,
      cur_start + n * step as cur_end,
      cur_start - n * step as prev_start,
      step,
      n
    from (
      select
        date_trunc(${unit}, ${now.toISOString()}::timestamptz, 'UTC')
          - (${count}::int - 1) * ${step}::interval as cur_start,
        ${step}::interval as step,
        ${count}::int as n
    ) as shape
  `;
}

/** Epoch milliseconds of a timestamptz, as int8 text (read back with `fromMillis`). */
function millis(expression: SQL): SQL {
  return sql`floor(extract(epoch from ${expression}) * 1000)::bigint::text`;
}

function fromMillis(value: string): Date {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms)) throw new Error(`Not an epoch millisecond value: ${value}`);
  return new Date(ms);
}

// --- Throughput ----------------------------------------------------------------

interface ThroughputRow extends Record<string, unknown> {
  bucket_starts: string[];
  bucket_counts: number[];
  done_cur: number;
  done_prev: number;
  started_cur: number;
  started_prev: number;
  plans_cur: number;
  plans_prev: number;
  median_cur: number | null;
  median_prev: number | null;
}

async function readThroughput(
  tx: Transaction,
  context: QueryContext,
  range: HomeRange,
  unit: "hour" | "day",
): Promise<HomeThroughput> {
  const result = await tx.execute<ThroughputRow>(sql`
    with b as (${context.bounds}),
    ev as (
      select e.type, e.task_id, e.seq, e.effective_at, e.payload->>'to' as to_status,
        e.effective_at >= b.cur_start as cur
      from event e cross join b
      where e.project_id = any(${context.projectIds})
        and e.type in ('task.done', 'session.started', 'plan.status_changed')
        and e.effective_at >= b.prev_start
        and e.effective_at < b.cur_end
    ),
    task_minutes as (
      select ev.cur, extract(epoch from ev.effective_at - claim.effective_at) / 60 as minutes
      from ev cross join lateral (
        select c.effective_at
        from event c
        where c.task_id = ev.task_id and c.seq < ev.seq and c.type = 'task.claimed'
        order by c.seq desc
        limit 1
      ) as claim
      where ev.type = 'task.done'
    ),
    buckets as (
      select i, b.cur_start + i * b.step as start, (
        select count(*) from ev
        where ev.type = 'task.done'
          and ev.effective_at >= b.cur_start + i * b.step
          and ev.effective_at < b.cur_start + (i + 1) * b.step
      )::int as tasks_done
      from b cross join generate_series(0, b.n - 1) as i
    )
    select
      (select array_agg(${millis(sql`start`)} order by i) from buckets) as bucket_starts,
      (select array_agg(tasks_done order by i) from buckets) as bucket_counts,
      count(*) filter (where type = 'task.done' and cur)::int as done_cur,
      count(*) filter (where type = 'task.done' and not cur)::int as done_prev,
      count(*) filter (where type = 'session.started' and cur)::int as started_cur,
      count(*) filter (where type = 'session.started' and not cur)::int as started_prev,
      count(*) filter (where type = 'plan.status_changed' and to_status = 'done' and cur)::int
        as plans_cur,
      count(*) filter (where type = 'plan.status_changed' and to_status = 'done' and not cur)::int
        as plans_prev,
      (select percentile_cont(0.5) within group (order by minutes) from task_minutes where cur)
        as median_cur,
      (select percentile_cont(0.5) within group (order by minutes) from task_minutes where not cur)
        as median_prev
    from ev
  `);
  const row = result.rows[0];
  if (!row) throw new Error("The throughput read returned no row.");
  const median = (value: number | null) => (value === null ? null : Number(value));
  return {
    range,
    unit,
    buckets: row.bucket_starts.map((start, index) => ({
      start: fromMillis(start),
      tasksDone: row.bucket_counts[index] ?? 0,
    })),
    tasksDone: { value: row.done_cur, previous: row.done_prev },
    sessionsStarted: { value: row.started_cur, previous: row.started_prev },
    plansFinished: { value: row.plans_cur, previous: row.plans_prev },
    medianTaskMinutes: { value: median(row.median_cur), previous: median(row.median_prev) },
  };
}

// --- Agents --------------------------------------------------------------------

interface AgentRow extends Record<string, unknown> {
  agent: string;
  machines: string[] | null;
  project_count: number;
  sessions: number;
  tasks_done: number;
  active_minutes: number;
  last_seen_ms: string;
}

async function readAgents(tx: Transaction, context: QueryContext): Promise<HomeAgentRow[]> {
  const filter =
    context.pattern === null
      ? sql`true`
      : sql`(s.agent ilike ${context.pattern} escape '\\'
          or s.machine ilike ${context.pattern} escape '\\'
          or p.name ilike ${context.pattern} escape '\\')`;
  // Each Session's start and heartbeats, from one gap before the range so a
  // gap that crosses the range start counts its part inside the range.
  const result = await tx.execute<AgentRow>(sql`
    with b as (${context.bounds}),
    projects as (
      select * from unnest(${context.projectIds}, ${context.projectNames})
        as p(id, name)
    ),
    beats as (
      select e.session_id, e.project_id, e.type, e.effective_at,
        lag(e.effective_at) over (
          partition by e.session_id order by e.effective_at, e.seq
        ) as previous_at
      from event e cross join b
      where e.project_id = any(${context.projectIds})
        and e.type in ('session.started', 'session.heartbeat')
        and e.effective_at >= b.cur_start - make_interval(secs => ${ACTIVE_GAP_SECONDS})
        and e.effective_at < b.cur_end
    ),
    session_beats as (
      select beats.session_id, beats.project_id,
        coalesce(sum(
          extract(epoch from beats.effective_at - greatest(beats.previous_at, b.cur_start))
        ) filter (
          where beats.effective_at >= b.cur_start
            and beats.effective_at - beats.previous_at
              < make_interval(secs => ${ACTIVE_GAP_SECONDS})
        ), 0) as active_seconds,
        count(*) filter (
          where beats.type = 'session.started' and beats.effective_at >= b.cur_start
        ) as started
      from beats cross join b
      group by beats.session_id, beats.project_id
      having bool_or(beats.effective_at >= b.cur_start)
    ),
    session_done as (
      select e.actor_session_id as session_id, e.project_id, count(*) as tasks_done
      from event e cross join b
      where e.project_id = any(${context.projectIds})
        and e.type = 'task.done'
        and e.effective_at >= b.cur_start
        and e.effective_at < b.cur_end
        and e.actor_session_id is not null
      group by e.actor_session_id, e.project_id
    ),
    activity as (
      select session_id, project_id,
        coalesce(session_beats.active_seconds, 0) as active_seconds,
        coalesce(session_beats.started, 0) as started,
        coalesce(session_done.tasks_done, 0) as tasks_done
      from session_beats full join session_done using (session_id, project_id)
    )
    select s.agent,
      array_agg(distinct s.machine order by s.machine) filter (where s.machine is not null)
        as machines,
      count(distinct s.project_id)::int as project_count,
      sum(a.started)::int as sessions,
      sum(a.tasks_done)::int as tasks_done,
      round(sum(a.active_seconds) / 60)::int as active_minutes,
      ${millis(sql`max(s.last_heartbeat_at)`)} as last_seen_ms
    from activity a
    join agent_session s on s.id = a.session_id and s.project_id = a.project_id
    join projects p on p.id = s.project_id
    where ${filter}
    group by s.agent
    order by sum(a.active_seconds) desc, s.agent
    limit ${HOME_AGENT_LIMIT}
  `);
  return result.rows.map((row) => ({
    agent: row.agent,
    machines: row.machines ?? [],
    projectCount: row.project_count,
    sessions: row.sessions,
    tasksDone: row.tasks_done,
    activeMinutes: row.active_minutes,
    lastSeenAt: fromMillis(row.last_seen_ms),
  }));
}

// --- Hot paths -----------------------------------------------------------------

interface HotPathRow extends Record<string, unknown> {
  project_id: string;
  project_name: string;
  path: string;
  touches: number;
  sessions: number;
}

async function readHotPaths(
  tx: Transaction,
  context: QueryContext,
  overlappingScopes: HomeAnalyticsInput["overlappingScopes"],
): Promise<HomeHotPath[]> {
  const filter =
    context.pattern === null
      ? sql`true`
      : sql`(t.path ilike ${context.pattern} escape '\\'
          or p.name ilike ${context.pattern} escape '\\')`;
  const result = await tx.execute<HotPathRow>(sql`
    with b as (${context.bounds}),
    projects as (
      select * from unnest(${context.projectIds}, ${context.projectNames})
        as p(id, name)
    ),
    touched as (
      select batch.project_id, batch.session_id, batch.id as batch_id, path
      from scope_collection_batch batch
        cross join b
        cross join lateral unnest(batch.paths) as path
      where batch.project_id = any(${context.projectIds})
        and batch.created_at >= b.cur_start
        and batch.created_at < b.cur_end
    )
    select t.project_id, p.name as project_name, t.path,
      count(distinct t.batch_id)::int as touches,
      count(distinct t.session_id)::int as sessions
    from touched t
    join projects p on p.id = t.project_id
    where ${filter}
    group by t.project_id, p.name, t.path
    order by touches desc, sessions desc, t.path, t.project_id
    limit ${HOME_HOT_PATH_LIMIT}
  `);
  const matcher = new ScopeMatchContext();
  return result.rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    path: row.path,
    touches: row.touches,
    sessions: row.sessions,
    overlapping: overlappingScopes.some(
      (entry) =>
        entry.projectId === row.project_id && scopeMatchesPath(matcher, entry.scope, row.path),
    ),
  }));
}

/**
 * Whether a stored Scope (a declared glob or a touched path) matches a
 * touched path. A comparison the matcher could not decide counts as a match,
 * as an undecided overlap is shown as possible, never as disjoint.
 */
function scopeMatchesPath(matcher: ScopeMatchContext, scope: string, path: string): boolean {
  if (scope === path) return true;
  const declared = normalizeDeclaredPattern(scope);
  if (declared.status !== "valid") return false;
  const comparison = matcher.compare(
    { source: "declared", value: declared.pattern },
    { source: "touched", value: path },
  );
  return comparison.status !== "disjoint";
}
