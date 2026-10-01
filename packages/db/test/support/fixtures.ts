import { randomUUID } from "node:crypto";
import type { Db } from "../../src/index.ts";
import { creatorColumns, type Principal, sessionOwnerColumns } from "../../src/principal.ts";
import { organization, user } from "../../src/schema/auth.ts";
import { agentSession, plan, task } from "../../src/schema/coordination.ts";
import { project } from "../../src/schema/project.ts";

// Rows for database tests of the coordination schema. They insert directly,
// without the coordination lock or Events, so tests can set up any state.

/** A fingerprint-shaped value; tests that compare fingerprints compute real ones. */
export const FINGERPRINT = "0".repeat(64);

function first<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (!row) throw new Error(`${what} insert returned no row`);
  return row;
}

export async function insertUser(db: Db) {
  const login = `user-${randomUUID().slice(0, 8)}`;
  return first(
    await db
      .insert(user)
      .values({ name: login, email: `${login}@example.com`, githubLogin: login })
      .returning(),
    "user",
  );
}

/** An organization with one Project, and a User to act in it. */
export async function insertProject(db: Db) {
  const slug = `org-${randomUUID().slice(0, 8)}`;
  const org = first(await db.insert(organization).values({ name: slug, slug }).returning(), "org");
  const row = first(
    await db
      .insert(project)
      .values({ organizationId: org.id, slug: "app", name: "App" })
      .returning(),
    "project",
  );
  return { organization: org, project: row, user: await insertUser(db) };
}

export async function insertPlan(
  db: Db,
  projectId: string,
  principal: Principal,
  overrides: Partial<typeof plan.$inferInsert> = {},
) {
  return first(
    await db
      .insert(plan)
      .values({
        projectId,
        number: Math.floor(Math.random() * 1_000_000) + 1,
        title: "Plan",
        status: "active",
        ...creatorColumns(principal),
        creationFingerprint: FINGERPRINT,
        ...overrides,
      })
      .returning(),
    "plan",
  );
}

export async function insertTask(
  db: Db,
  projectId: string,
  planId: string,
  principal: Principal,
  overrides: Partial<typeof task.$inferInsert> = {},
) {
  return first(
    await db
      .insert(task)
      .values({
        projectId,
        planId,
        title: "Task",
        position: 1,
        ...creatorColumns(principal),
        creationFingerprint: FINGERPRINT,
        ...overrides,
      })
      .returning(),
    "task",
  );
}

export async function insertSession(
  db: Db,
  projectId: string,
  principal: Principal,
  overrides: Partial<typeof agentSession.$inferInsert> = {},
) {
  return first(
    await db
      .insert(agentSession)
      .values({
        projectId,
        ...sessionOwnerColumns(principal),
        agent: "claude-code",
        intent: "Test",
        creationFingerprint: FINGERPRINT,
        ...overrides,
      })
      .returning(),
    "session",
  );
}
