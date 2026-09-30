import { afterAll, beforeAll, expect, it } from "vitest";
import { account, user } from "../src/schema/auth.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";

describeDb("account", () => {
  let testDb: TestDatabase;
  let userId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const [row] = await testDb.db
      .insert(user)
      .values({ name: "The Octocat", email: "octocat@example.com" })
      .returning({ id: user.id });
    if (!row) throw new Error("user insert returned no row");
    userId = row.id;
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it("rejects a second row for the same provider account", async () => {
    await testDb.db.insert(account).values({ providerId: "github", accountId: "583231", userId });

    await expect(
      testDb.db.insert(account).values({ providerId: "github", accountId: "583231", userId }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "account_provider_id_account_id_idx" },
    });
  });

  it("allows the same account id from another provider", async () => {
    await expect(
      testDb.db.insert(account).values({ providerId: "gitlab", accountId: "583231", userId }),
    ).resolves.toBeDefined();
  });
});
