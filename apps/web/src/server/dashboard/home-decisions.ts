import { planKey, type Transaction } from "@hivemind/db";
import { agentSession, event, plan } from "@hivemind/db/schema";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { projectEvent } from "../event-projection";
import { loadHomeNames } from "./home-attribution";
import type { HomeDecision } from "./home-types";
import type { Attribution } from "./queries";

// The home page's Decisions panel: the newest `plan.decision_recorded` Events
// across the Projects in scope. Rows are read newest first through
// `event_project_id_type_effective_at_idx` (Project, type, effective time),
// and every row goes through the shared projection (ADR-0015): a stored
// decision this build cannot read, such as a newer payload version, is left
// out rather than shown as `event.unavailable`.

export interface HomeDecisionsInput {
  /** The Projects in scope. Never empty. */
  projects: { id: string; name: string }[];
  /** The filter text; empty means none. */
  q: string;
  limit: number;
}

const DECISION_TYPE = "plan.decision_recorded";

/** `value` as a case-insensitive substring pattern for `ilike ... escape '\'`. */
function containsPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * The filter on a decision's text, its Plan's key, its actor's agent or its
 * Project's name. Project names come from `projects`, which the caller read,
 * so they are matched here and only the matching ids reach the query.
 */
function queryCondition(q: string, projects: HomeDecisionsInput["projects"]): SQL | undefined {
  if (q === "") return undefined;
  const pattern = containsPattern(q);
  const needle = q.toLowerCase();
  const namedIds = projects
    .filter((project) => project.name.toLowerCase().includes(needle))
    .map((project) => project.id);
  return or(
    sql`${event.payload} ->> 'text' ilike ${pattern} escape '\\'`,
    sql`concat('PLAN-', ${plan.number}) ilike ${pattern} escape '\\'`,
    sql`${agentSession.agent} ilike ${pattern} escape '\\'`,
    namedIds.length > 0 ? inArray(event.projectId, namedIds) : undefined,
  );
}

/** The newest recorded decisions in scope, newest first, at most `input.limit`. */
export async function loadRecentDecisions(
  tx: Transaction,
  input: HomeDecisionsInput,
): Promise<HomeDecision[]> {
  if (input.projects.length === 0 || input.limit <= 0) return [];
  const projectNames = new Map(input.projects.map((project) => [project.id, project.name]));
  const filter = queryCondition(input.q.trim(), input.projects);

  // The keyset position is the database's own text of `effective_at`, since a
  // JavaScript Date would drop its microseconds.
  const read = (after: { effectiveAt: string; seq: string } | null) =>
    tx
      .select({
        row: event,
        position: sql<string>`${event.effectiveAt}::text`,
        planNumber: plan.number,
        agent: agentSession.agent,
      })
      .from(event)
      .innerJoin(plan, and(eq(plan.id, event.planId), eq(plan.projectId, event.projectId)))
      .leftJoin(
        agentSession,
        and(eq(agentSession.id, event.actorSessionId), eq(agentSession.projectId, event.projectId)),
      )
      .where(
        and(
          inArray(event.projectId, [...projectNames.keys()]),
          eq(event.type, DECISION_TYPE),
          filter,
          after
            ? sql`(${event.effectiveAt}, ${event.seq}) < (${after.effectiveAt}::timestamptz, ${after.seq}::bigint)`
            : undefined,
        ),
      )
      .orderBy(desc(event.effectiveAt), desc(event.seq))
      .limit(input.limit);

  // Unreadable rows are skipped, so a batch can come up short of the limit;
  // the next batch continues after the last row read.
  const found: { decision: Omit<HomeDecision, "actor">; row: typeof event.$inferSelect }[] = [];
  let after: { effectiveAt: string; seq: string } | null = null;
  while (found.length < input.limit) {
    const batch = await read(after);
    for (const { row, planNumber, agent } of batch) {
      const projected = projectEvent(row);
      if (projected.type !== DECISION_TYPE) continue;
      found.push({
        row,
        decision: {
          id: projected.id,
          projectId: projected.projectId,
          projectName: projectNames.get(projected.projectId) ?? "",
          planKey: planKey(planNumber),
          text: projected.payload.text,
          actorAgent: agent,
          at: row.effectiveAt,
        },
      });
      if (found.length === input.limit) break;
    }
    const last = batch.at(-1);
    if (batch.length < input.limit || !last) break;
    after = { effectiveAt: last.position, seq: last.row.seq };
  }

  const names = await loadHomeNames(tx, {
    userIds: found.map(({ row }) => row.actorUserId),
    keys: found.map(({ row }) =>
      row.actorKeyId ? { projectId: row.projectId, keyId: row.actorKeyId } : null,
    ),
  });
  const actorOf = (row: typeof event.$inferSelect): Attribution => {
    if (row.actorKind === "project_key" && row.actorKeyId) {
      return names.key(row.projectId, row.actorKeyId);
    }
    if (row.actorKind === "user" && row.actorUserId) return names.user(row.actorUserId);
    return { kind: "system" };
  };
  return found.map(({ decision, row }) => ({ ...decision, actor: actorOf(row) }));
}
