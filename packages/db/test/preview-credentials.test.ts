import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { account, deviceCode, session, verification } from "../src/schema/auth.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import { insertProject, insertProjectKey } from "./support/fixtures.ts";

const script = path.join(import.meta.dirname, "..", "src", "preview-credentials.ts");

/** Runs the script as the Vercel build does: under plain Node, with `VERCEL_ENV` set or not. */
async function runScript(url: string, vercelEnv: string | undefined): Promise<string> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, DATABASE_URL_UNPOOLED: url };
  if (vercelEnv) env.VERCEL_ENV = vercelEnv;
  const { stdout } = await promisify(execFile)(process.execPath, [script], { env });
  return stdout.trim();
}

describeDb("preview credentials", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const { db } = testDb;
    const { project, user: member } = await insertProject(db);
    await insertProjectKey(db, project.id);
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.insert(session).values({ userId: member.id, token: "raw-token", expiresAt });
    await db.insert(account).values({
      userId: member.id,
      providerId: "github",
      accountId: "583231",
      accessToken: "encrypted-access",
      refreshToken: "encrypted-refresh",
      idToken: "encrypted-id",
      accessTokenExpiresAt: expiresAt,
      refreshTokenExpiresAt: expiresAt,
      scope: "read:user",
    });
    await db.insert(verification).values({ identifier: "state", value: "value", expiresAt });
    await db
      .insert(deviceCode)
      .values({ deviceCode: "device", userCode: "USER-CODE", expiresAt, status: "pending" });
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  async function counts(): Promise<Record<string, number>> {
    const result = await testDb.pool.query<Record<string, string>>(`
      select
        (select count(*) from session) as session,
        (select count(*) from verification) as verification,
        (select count(*) from device_code) as device_code,
        (select count(*) from apikey) as apikey,
        (select count(*) from project_api_key) as project_api_key,
        (select count(*) from account) as account,
        (select count(*) from account where access_token is not null) as account_tokens,
        (select count(*) from "user") as "user",
        (select count(*) from organization) as organization,
        (select count(*) from member) as member,
        (select count(*) from project) as project
    `);
    return Object.fromEntries(
      Object.entries(result.rows[0] ?? {}).map(([table, count]) => [table, Number(count)]),
    );
  }

  // Runs first: the preview test below deletes the rows these check.
  it.each([undefined, "production", "development"])(
    "changes nothing when VERCEL_ENV is %s",
    async (vercelEnv) => {
      const before = await counts();
      expect(before).toMatchObject({ session: 1, apikey: 1, account_tokens: 1 });

      expect(await runScript(testDb.url, vercelEnv)).toBe(
        "preview credentials left alone: not a preview build",
      );
      expect(await counts()).toEqual(before);
    },
  );

  it("on a preview build, deletes credentials and keeps users, organizations and Projects", async () => {
    expect(await runScript(testDb.url, "preview")).toBe("preview credentials cleared");

    expect(await counts()).toEqual({
      session: 0,
      verification: 0,
      device_code: 0,
      apikey: 0,
      project_api_key: 0,
      account: 1,
      account_tokens: 0,
      user: 1,
      organization: 1,
      member: 1,
      project: 1,
    });
    const [row] = await testDb.db.select().from(account);
    expect(row).toMatchObject({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      password: null,
      scope: "read:user",
    });
  });

  it("succeeds again on a preview database branch that was already cleared", async () => {
    expect(await runScript(testDb.url, "preview")).toBe("preview credentials cleared");
  });
});

it("refuses a preview build without a direct connection URL", async () => {
  await expect(
    promisify(execFile)(process.execPath, [script], {
      env: { PATH: process.env.PATH, VERCEL_ENV: "preview" },
    }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining("DATABASE_URL_UNPOOLED is not set") });
});
