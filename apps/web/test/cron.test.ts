import { randomUUID } from "node:crypto";
import type { Db } from "@hivemind/db";
import { schema } from "@hivemind/db";
import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCronHandler } from "../src/server/cron";

const SECRET = "cron-secret-0123456789abcdef";
const URL = "http://localhost:3000/api/cron/coordination";

function get(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request(URL, { headers });
}

/** A database dependency that fails the test if the handler touches it. */
const untouchedDb = () => {
  throw new Error("The handler must not touch the database here.");
};

describe("cron route authentication", () => {
  it.each([undefined, ""])("fails closed with 500 when CRON_SECRET is %j", async (secret) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = createCronHandler({ cronSecret: () => secret, db: untouchedDb });
    const response = await handle(get(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Cron is not configured." });
    error.mockRestore();
  });

  it.each([
    undefined,
    "",
    `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}`,
    `Basic ${SECRET}`,
    SECRET,
    `Bearer ${SECRET} extra`,
  ])("rejects authorization %j with 401", async (authorization) => {
    const handle = createCronHandler({ cronSecret: () => SECRET, db: untouchedDb });
    const response = await handle(get(authorization));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports a failing environment read as 500 without running", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = createCronHandler({
      cronSecret: () => {
        throw new Error("Invalid environment variables");
      },
      db: untouchedDb,
    });
    expect((await handle(get(`Bearer ${SECRET}`))).status).toBe(500);
    error.mockRestore();
  });
});

let testDb: TestDatabase;

describeDb("cron route sweep", () => {
  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  async function staleSession(db: Db) {
    const slug = `org-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(schema.organization).values({ name: slug, slug }).returning();
    const [user] = await db
      .insert(schema.user)
      .values({ name: slug, email: `${slug}@example.com`, githubLogin: slug })
      .returning();
    if (!org || !user) throw new Error("setup");
    const [project] = await db
      .insert(schema.project)
      .values({ organizationId: org.id, slug: "app", name: "App" })
      .returning();
    if (!project) throw new Error("setup");
    const [session] = await db
      .insert(schema.agentSession)
      .values({
        projectId: project.id,
        ownerKind: "user",
        userId: user.id,
        agent: "claude-code",
        intent: "Test",
        lastHeartbeatAt: sql`clock_timestamp() - interval '6 minutes'`,
        creationFingerprint: "0".repeat(64),
      })
      .returning();
    if (!session) throw new Error("setup");
    return session;
  }

  it("runs one bounded sweep and returns its counts as uncached JSON", async () => {
    const session = await staleSession(testDb.db);
    const handle = createCronHandler({ cronSecret: () => SECRET, db: () => testDb.db });
    const response = await handle(get(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      projectsSwept: 1,
      projectsSkipped: 0,
      sessionsStale: 1,
      sessionsAbandoned: 0,
      claimsReleased: 0,
      moreWork: false,
    });
    const [row] = await testDb.db
      .select({ status: schema.agentSession.status })
      .from(schema.agentSession)
      .where(eq(schema.agentSession.id, session.id));
    expect(row?.status).toBe("stale");

    // A duplicate delivery changes nothing.
    const again = await handle(get(`Bearer ${SECRET}`));
    expect(await again.json()).toMatchObject({ projectsSwept: 0, sessionsStale: 0 });
  });
});
