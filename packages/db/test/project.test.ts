import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/index.ts";
import { runMigrations } from "../src/migrate.ts";
import { createOrReuseProject, type ProjectInput } from "../src/project.ts";
import { apikey, member, organization, user } from "../src/schema/auth.ts";
import { project } from "../src/schema/project.ts";
import { projectApiKey } from "../src/schema/project-api-key.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { journal, migrateFrom, migrationsFolderWith } from "./support/migrations.ts";

/** The migrations M0 shipped. Upgrades start from a database with exactly these. */
const M0_MIGRATIONS = ["0000_auth", "0001_account_provider_unique"];

async function insertOrganization(db: Db, slug = `org-${randomUUID().slice(0, 8)}`) {
  const [row] = await db.insert(organization).values({ name: slug, slug }).returning();
  if (!row) throw new Error("organization insert returned no row");
  return row;
}

async function insertApiKey(db: Db, organizationId: string) {
  const [row] = await db
    .insert(apikey)
    .values({ referenceId: organizationId, key: randomUUID(), prefix: "hm_" })
    .returning();
  if (!row) throw new Error("apikey insert returned no row");
  return row;
}

async function tableNames(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  return result.rows.map((row) => row.table_name).sort();
}

describeDb("migrations for Project and API keys", () => {
  it("create the new tables on a clean database", async () => {
    const testDb = await createTestDatabase();
    try {
      expect(await tableNames(testDb.pool)).toEqual(
        expect.arrayContaining(["apikey", "device_code", "project", "project_api_key"]),
      );
    } finally {
      await testDb.drop();
    }
  });

  it("upgrade a database with M0's schema and data", async () => {
    const testDb = await createTestDatabase({ migrate: false });
    const m0Folder = migrationsFolderWith(M0_MIGRATIONS);
    try {
      await migrateFrom(testDb.url, m0Folder);
      expect(await tableNames(testDb.pool)).not.toContain("project");

      // M0 data: a user with their personal organization.
      const [existingUser] = await testDb.db
        .insert(user)
        .values({ name: "Mona", email: "mona@example.com", githubLogin: "mona" })
        .returning();
      const existingOrganization = await insertOrganization(testDb.db, "mona");
      if (!existingUser) throw new Error("user insert returned no row");
      await testDb.db.insert(member).values({
        organizationId: existingOrganization.id,
        userId: existingUser.id,
        role: "owner",
      });

      await runMigrations(testDb.url);

      const applied = await testDb.pool.query<{ count: string }>(
        "select count(*) from drizzle.__drizzle_migrations",
      );
      expect(Number(applied.rows[0]?.count)).toBe(journal.entries.length);
      const members = await testDb.db.select().from(member);
      expect(members).toMatchObject([
        { organizationId: existingOrganization.id, userId: existingUser.id, role: "owner" },
      ]);
      const result = await createOrReuseProject(testDb.db, {
        organizationId: existingOrganization.id,
        slug: "hive-mind",
        name: "Hive Mind",
        repoUrl: null,
      });
      expect(result.status).toBe("created");
    } finally {
      rmSync(m0Folder, { recursive: true });
      await testDb.drop();
    }
  });
});

describeDb("project and project_api_key constraints", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  async function insertProject(organizationId: string, slug = "app") {
    const [row] = await testDb.db
      .insert(project)
      .values({ organizationId, slug, name: slug })
      .returning();
    if (!row) throw new Error("project insert returned no row");
    return row;
  }

  it("requires the organization to exist", async () => {
    await expect(insertProject(randomUUID())).rejects.toMatchObject({
      cause: { code: "23503", constraint: "project_organization_id_organization_id_fk" },
    });
  });

  it("allows a slug once per organization", async () => {
    const [first, second] = [
      await insertOrganization(testDb.db),
      await insertOrganization(testDb.db),
    ];
    await insertProject(first.id, "shared");

    await expect(insertProject(first.id, "shared")).rejects.toMatchObject({
      cause: { code: "23505", constraint: "project_organization_id_slug_unique" },
    });
    await expect(insertProject(second.id, "shared")).resolves.toBeDefined();
  });

  it("keeps an organization that has Projects from being deleted", async () => {
    const owner = await insertOrganization(testDb.db);
    await insertProject(owner.id);

    await expect(
      testDb.db.delete(organization).where(eq(organization.id, owner.id)),
    ).rejects.toMatchObject({
      // restrict_violation, from ON DELETE RESTRICT.
      cause: { code: "23001", constraint: "project_organization_id_organization_id_fk" },
    });
  });

  it("requires an API key's owner to be an organization", async () => {
    await expect(insertApiKey(testDb.db, randomUUID())).rejects.toMatchObject({
      cause: { code: "23503", constraint: "apikey_reference_id_organization_id_fk" },
    });
  });

  it("binds a key to a Project of the organization that owns it", async () => {
    const owner = await insertOrganization(testDb.db);
    const key = await insertApiKey(testDb.db, owner.id);
    const target = await insertProject(owner.id);

    await testDb.db
      .insert(projectApiKey)
      .values({ keyId: key.id, projectId: target.id, organizationId: owner.id });

    expect(
      await testDb.db.select().from(projectApiKey).where(eq(projectApiKey.keyId, key.id)),
    ).toMatchObject([{ projectId: target.id, organizationId: owner.id }]);
  });

  it("binds a key to only one Project", async () => {
    const owner = await insertOrganization(testDb.db);
    const key = await insertApiKey(testDb.db, owner.id);
    const [first, second] = [
      await insertProject(owner.id, "first"),
      await insertProject(owner.id, "second"),
    ];
    await testDb.db
      .insert(projectApiKey)
      .values({ keyId: key.id, projectId: first.id, organizationId: owner.id });

    await expect(
      testDb.db
        .insert(projectApiKey)
        .values({ keyId: key.id, projectId: second.id, organizationId: owner.id }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "project_api_key_pkey" } });
  });

  it("rejects binding a key to another organization's Project", async () => {
    const [keyOwner, projectOwner] = [
      await insertOrganization(testDb.db),
      await insertOrganization(testDb.db),
    ];
    const key = await insertApiKey(testDb.db, keyOwner.id);
    const target = await insertProject(projectOwner.id);

    // Whichever organization the binding claims, one foreign key fails.
    await expect(
      testDb.db
        .insert(projectApiKey)
        .values({ keyId: key.id, projectId: target.id, organizationId: keyOwner.id }),
    ).rejects.toMatchObject({ cause: { code: "23503", constraint: "project_api_key_project_fk" } });
    await expect(
      testDb.db
        .insert(projectApiKey)
        .values({ keyId: key.id, projectId: target.id, organizationId: projectOwner.id }),
    ).rejects.toMatchObject({ cause: { code: "23503", constraint: "project_api_key_key_fk" } });
  });

  it("drops the binding when the plugin deletes its key", async () => {
    const owner = await insertOrganization(testDb.db);
    const key = await insertApiKey(testDb.db, owner.id);
    const target = await insertProject(owner.id);
    await testDb.db
      .insert(projectApiKey)
      .values({ keyId: key.id, projectId: target.id, organizationId: owner.id });

    await testDb.db.delete(apikey).where(eq(apikey.id, key.id));

    expect(
      await testDb.db.select().from(projectApiKey).where(eq(projectApiKey.keyId, key.id)),
    ).toEqual([]);
  });

  it("keeps a Project with bound keys from being deleted", async () => {
    const owner = await insertOrganization(testDb.db);
    const key = await insertApiKey(testDb.db, owner.id);
    const target = await insertProject(owner.id);
    await testDb.db
      .insert(projectApiKey)
      .values({ keyId: key.id, projectId: target.id, organizationId: owner.id });

    await expect(testDb.db.delete(project).where(eq(project.id, target.id))).rejects.toMatchObject({
      cause: { code: "23001", constraint: "project_api_key_project_fk" },
    });
  });

  it("keeps a bound key from moving to another organization", async () => {
    const [owner, other] = [
      await insertOrganization(testDb.db),
      await insertOrganization(testDb.db),
    ];
    const key = await insertApiKey(testDb.db, owner.id);
    const target = await insertProject(owner.id);
    await testDb.db
      .insert(projectApiKey)
      .values({ keyId: key.id, projectId: target.id, organizationId: owner.id });

    await expect(
      testDb.db.update(apikey).set({ referenceId: other.id }).where(eq(apikey.id, key.id)),
    ).rejects.toMatchObject({ cause: { code: "23503", constraint: "project_api_key_key_fk" } });
  });
});

describeDb("createOrReuseProject", () => {
  let testDb: TestDatabase;
  /** Pools of one connection each, so concurrent calls use separate connections. */
  let pools: pg.Pool[];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    pools = Array.from({ length: 8 }, () => new pg.Pool({ connectionString: testDb.url, max: 1 }));
  });

  afterAll(async () => {
    await Promise.all((pools ?? []).map((pool) => pool.end()));
    await testDb?.drop();
  });

  async function newInput(overrides: Partial<ProjectInput> = {}): Promise<ProjectInput> {
    const owner = await insertOrganization(testDb.db);
    return {
      organizationId: owner.id,
      slug: "hive-mind",
      name: "Hive Mind",
      repoUrl: "https://github.com/CuriouslyCory/hive-mind",
      ...overrides,
    };
  }

  async function projectsOf(organizationId: string) {
    return testDb.db.select().from(project).where(eq(project.organizationId, organizationId));
  }

  /** Waits until a backend of the test database is blocked on a lock. */
  async function waitForLockWait(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await testDb.pool.query<{ count: string }>(
        `select count(*) from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (Number(result.rows[0]?.count) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No connection waited on a lock.");
  }

  it("creates the Project, then returns it for the same input", async () => {
    const input = await newInput();

    const created = await createOrReuseProject(testDb.db, input);
    const again = await createOrReuseProject(testDb.db, input);

    expect(created).toMatchObject({ status: "created", project: input });
    expect(again).toEqual({ status: "existing", project: created.project });
  });

  it("returns one Project to concurrent calls on separate connections", async () => {
    const input = await newInput();

    const results = await Promise.all(
      pools.map((pool) => createOrReuseProject(createDb(pool), input)),
    );

    expect(new Set(results.map((result) => result.project.id)).size).toBe(1);
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "existing")).toHaveLength(7);
    expect(await projectsOf(input.organizationId)).toHaveLength(1);
  });

  it("waits for an uncommitted create of the same slug, then returns it", async () => {
    const input = await newInput();
    const [first, second] = pools.map((pool) => createDb(pool));
    if (!first || !second) throw new Error("missing pool");

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstResult: Awaited<ReturnType<typeof createOrReuseProject>> | undefined;
    const transaction = first.transaction(async (tx) => {
      firstResult = await createOrReuseProject(tx, input);
      await held;
    });
    // Let the transaction insert before the second call starts.
    while (!firstResult) await new Promise((resolve) => setTimeout(resolve, 5));

    const pending = createOrReuseProject(second, input);
    await waitForLockWait();
    release();
    await transaction;

    const secondResult = await pending;
    expect(firstResult.status).toBe("created");
    expect(secondResult).toEqual({ status: "existing", project: firstResult.project });
  });

  it("creates the Project if a concurrent create of the same slug rolls back", async () => {
    const input = await newInput();
    const [first, second] = pools.map((pool) => createDb(pool));
    if (!first || !second) throw new Error("missing pool");

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted = false;
    const rolledBack = new Error("roll back");
    const transaction = first
      .transaction(async (tx) => {
        await createOrReuseProject(tx, input);
        inserted = true;
        await held;
        throw rolledBack;
      })
      .catch((error: unknown) => {
        if (error !== rolledBack) throw error;
      });
    while (!inserted) await new Promise((resolve) => setTimeout(resolve, 5));

    const pending = createOrReuseProject(second, input);
    await waitForLockWait();
    release();
    await transaction;

    expect(await pending).toMatchObject({ status: "created", project: input });
    expect(await projectsOf(input.organizationId)).toHaveLength(1);
  });

  describe("conflicts", () => {
    it.each([
      ["a different name", { name: "Other" }],
      ["a different repo URL", { repoUrl: "https://github.com/someone/else" }],
      ["no repo URL where one is set", { repoUrl: null }],
    ] as const)("with %s, and changes nothing", async (_case, change) => {
      const input = await newInput();
      const { project: existing } = await createOrReuseProject(testDb.db, input);

      const result = await createOrReuseProject(testDb.db, { ...input, ...change });

      expect(result).toEqual({ status: "conflict", project: existing });
      expect(await projectsOf(input.organizationId)).toEqual([existing]);
    });

    it("lets exactly one of two concurrent, different creates win", async () => {
      const input = await newInput();
      const [first, second] = pools.map((pool) => createDb(pool));
      if (!first || !second) throw new Error("missing pool");

      const results = await Promise.all([
        createOrReuseProject(first, input),
        createOrReuseProject(second, { ...input, name: "Other" }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["conflict", "created"]);
      expect(new Set(results.map((result) => result.project.id)).size).toBe(1);
      expect(await projectsOf(input.organizationId)).toHaveLength(1);
    });

    it("does not reuse a Project of another organization", async () => {
      const input = await newInput();
      const other = await insertOrganization(testDb.db);
      const { project: existing } = await createOrReuseProject(testDb.db, input);

      const result = await createOrReuseProject(testDb.db, {
        ...input,
        organizationId: other.id,
      });

      expect(result.status).toBe("created");
      expect(result.project.id).not.toBe(existing.id);
    });
  });
});
