import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";

describeDb("createDb", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.pool.query("create table tx_fixture (value integer not null)");
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  async function values(): Promise<number[]> {
    const rows = await testDb.db.execute<{ value: number }>(
      sql`select value from tx_fixture order by value`,
    );
    return rows.rows.map((row) => row.value);
  }

  it("commits an interactive transaction", async () => {
    await testDb.db.transaction(async (tx) => {
      await tx.execute(sql`insert into tx_fixture (value) values (1)`);
      const inside = await tx.execute<{ count: string }>(sql`select count(*) from tx_fixture`);
      expect(Number(inside.rows[0]?.count)).toBe(1);
      await tx.execute(sql`insert into tx_fixture (value) values (2)`);
    });
    expect(await values()).toEqual([1, 2]);
  });

  it("rolls back every statement when the callback throws", async () => {
    await expect(
      testDb.db.transaction(async (tx) => {
        await tx.execute(sql`insert into tx_fixture (value) values (3)`);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await values()).toEqual([1, 2]);
  });
});
