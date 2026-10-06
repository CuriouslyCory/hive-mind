import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_ADR_FLOOR_ADVANCE,
  type ReserveAdrInput,
  reserveAdr,
  storeAdrContents,
  syncAdrs,
} from "../src/adr.ts";
import { getAdr, listAdrs, MAX_ADR_CHAIN_DEPTH, recentAdrs } from "../src/adr-read.ts";
import { MAX_ADR_SYNC_EVENT_CHANGES } from "../src/event.ts";
import type { Principal } from "../src/principal.ts";
import { adr, adrContent, MAX_ADR_SUPERSEDES, MAX_ADR_TITLE_LENGTH } from "../src/schema/adr.ts";
import { createTestDatabase, describeDb, type TestDatabase } from "../src/testing/harness.ts";
import {
  adrEvents,
  adrFile,
  adrFiles,
  adrRows,
  commitSha,
  projectAdrState,
  uploadAndSync,
} from "./support/adr.ts";
import {
  insertProject,
  insertProjectKey,
  insertProjectMember,
  insertSession,
} from "./support/fixtures.ts";

let testDb: TestDatabase;

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

async function setup() {
  const { project: row, user, organization } = await insertProject(testDb.db);
  const principal: Principal = { kind: "user", userId: user.id };
  const context = { projectId: row.id, principal };
  const reserve = (overrides: Partial<ReserveAdrInput> = {}) =>
    reserveAdr(testDb.db, {
      ...context,
      id: randomUUID(),
      title: "Use Postgres",
      slug: "use-postgres",
      gitBranch: "feat/db",
      ...overrides,
    });
  const reserved = async (overrides: Partial<ReserveAdrInput> = {}) => {
    const outcome = await reserve(overrides);
    if (outcome.status !== "created") throw new Error(`reserveAdr: ${outcome.status}`);
    return outcome.adr;
  };
  return { project: row, user, organization, principal, context, reserve, reserved };
}

async function setNextAdrNumber(projectId: string, next: number) {
  await testDb.db.execute(
    sql`update project set next_adr_number = ${next} where id = ${projectId}`,
  );
}

describeDb("ADR reservations", () => {
  it("reserves a number with an adr.reserved Event", async () => {
    const { project, principal, reserve } = await setup();
    const id = randomUUID();

    const outcome = await reserve({ id, floor: 0 });

    expect(outcome).toMatchObject({
      status: "created",
      adr: {
        id,
        number: 1,
        state: "reserved",
        slug: "use-postgres",
        path: null,
        reservedTitle: "Use Postgres",
        reservedSlug: "use-postgres",
        gitBranch: "feat/db",
        reservedByKind: "user",
        reservedByUserId: principal.kind === "user" ? principal.userId : null,
        reservedByKeyId: null,
      },
    });
    const events = await adrEvents(testDb.db, project.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "adr.reserved",
      payloadVersion: 1,
      payload: { adrId: id, number: 1, title: "Use Postgres", slug: "use-postgres", floor: 0 },
      actorKind: "user",
      planId: null,
      taskId: null,
      sessionId: null,
    });
    expect((await projectAdrState(testDb.db, project.id)).nextAdrNumber).toBe(2);
  });

  it("replays a retry with the same id without advancing the counter", async () => {
    const { project, reserve } = await setup();
    const id = randomUUID();
    const first = await reserve({ id, floor: 0 });
    const before = await projectAdrState(testDb.db, project.id);

    // A retry may recompute its floor; the floor is not part of the request's
    // identity, and a replay does not apply it.
    const again = await reserve({ id, floor: 5 });

    expect(first.status).toBe("created");
    expect(again).toEqual({ status: "replay", adr: first.status === "created" && first.adr });
    expect(await projectAdrState(testDb.db, project.id)).toEqual(before);
    expect(await adrEvents(testDb.db, project.id)).toHaveLength(1);
    const next = await reserve();
    expect(next).toMatchObject({ status: "created", adr: { number: 2 } });
  });

  it("refuses an id reused with other input, by another principal or in another Project", async () => {
    const { project, reserve } = await setup();
    const id = randomUUID();
    await reserve({ id });
    const member = await insertProjectMember(testDb.db, project.id);
    const other = await setup();

    expect(await reserve({ id, title: "Something else" })).toEqual({ status: "conflict" });
    expect(await reserve({ id, gitBranch: "main" })).toEqual({ status: "conflict" });
    expect(await reserve({ id, principal: { kind: "user", userId: member.id } })).toEqual({
      status: "conflict",
    });
    expect(await other.reserve({ id })).toEqual({ status: "id_not_found" });
    expect(await adrRows(testDb.db, project.id)).toHaveLength(1);
    expect((await projectAdrState(testDb.db, project.id)).nextAdrNumber).toBe(2);
  });

  it("records a Project key's reservation and the actor Session", async () => {
    const { project, reserve } = await setup();
    const key = await insertProjectKey(testDb.db, project.id);
    const session = await insertSession(testDb.db, project.id, key);

    const outcome = await reserve({ principal: key, sessionId: session.id, gitBranch: null });

    expect(outcome).toMatchObject({
      status: "created",
      adr: {
        reservedByKind: "project_key",
        reservedByKeyId: key.keyId,
        reservedByUserId: null,
        reservedSessionId: session.id,
        gitBranch: null,
      },
    });
    const [reservedEvent] = await adrEvents(testDb.db, project.id);
    expect(reservedEvent).toMatchObject({
      actorKind: "project_key",
      actorKeyId: key.keyId,
      actorSessionId: session.id,
    });
  });

  it("refuses another principal's Session and an ended Session", async () => {
    const { project, principal, reserve } = await setup();
    const key = await insertProjectKey(testDb.db, project.id);
    const keySession = await insertSession(testDb.db, project.id, key);
    const ended = await insertSession(testDb.db, project.id, principal, {
      status: "ended",
      endedAt: new Date(),
    });

    expect(await reserve({ sessionId: keySession.id })).toEqual({ status: "session_forbidden" });
    expect(await reserve({ sessionId: ended.id })).toEqual({ status: "session_ended" });
    expect(await reserve({ sessionId: randomUUID() })).toEqual({ status: "session_not_found" });
    expect(await adrRows(testDb.db, project.id)).toEqual([]);
    expect(await adrEvents(testDb.db, project.id)).toEqual([]);
  });

  it.each([
    ["a blank title", { title: "  " }],
    ["a title over 200 characters", { title: "x".repeat(201) }],
    ["an uppercase slug", { slug: "Use-Postgres" }],
    ["a slug with a double hyphen", { slug: "use--postgres" }],
    ["a negative floor", { floor: -1 }],
    ["a floor past 9999", { floor: 10_000 }],
  ] as const)("refuses %s", async (_case, change) => {
    const { project, reserve } = await setup();
    expect(await reserve(change)).toMatchObject({ status: "invalid" });
    expect(await adrRows(testDb.db, project.id)).toEqual([]);
  });

  it("accepts a 200-character title", async () => {
    const { reserve } = await setup();
    expect(await reserve({ title: "x".repeat(200) })).toMatchObject({ status: "created" });
  });

  describe("seeding", () => {
    it("starts above the floor, and ignores a floor below the counter", async () => {
      const { project, reserve } = await setup();
      expect(await reserve({ floor: 14 })).toMatchObject({ adr: { number: 15 } });
      expect(await reserve({ floor: 3 })).toMatchObject({ adr: { number: 16 } });
      expect(await reserve()).toMatchObject({ adr: { number: 17 } });
      // The Event records the floor the client sent, not the counter.
      const events = await adrEvents(testDb.db, project.id);
      expect(events.map((e) => (e.payload as { number: number; floor: number }).floor)).toEqual([
        14, 3, 0,
      ]);
    });

    it("starts above the highest existing number even if the counter is behind it", async () => {
      const { project, reserved } = await setup();
      await reserved();
      // A counter behind the rows cannot happen through these functions; a
      // reservation still never reuses a number.
      await setNextAdrNumber(project.id, 1);
      expect(await reserved()).toMatchObject({ number: 2 });
    });

    it(`allows a floor that moves the counter by ${MAX_ADR_FLOOR_ADVANCE}, and refuses more`, async () => {
      const one = await setup();
      expect(await one.reserve({ floor: MAX_ADR_FLOOR_ADVANCE })).toMatchObject({
        adr: { number: MAX_ADR_FLOOR_ADVANCE + 1 },
      });

      const two = await setup();
      await two.reserved();
      const before = await projectAdrState(testDb.db, two.project.id);
      const refused = await two.reserve({ floor: MAX_ADR_FLOOR_ADVANCE + 2 });
      expect(refused).toMatchObject({
        status: "floor_too_high",
        floor: MAX_ADR_FLOOR_ADVANCE + 2,
        nextNumber: 2,
        message: expect.stringContaining("hivemind adr sync"),
      });
      expect(await projectAdrState(testDb.db, two.project.id)).toEqual(before);
      expect(await adrRows(testDb.db, two.project.id)).toHaveLength(1);
      expect(await adrEvents(testDb.db, two.project.id)).toHaveLength(1);
    });

    it("refuses a reservation past 9999", async () => {
      const { project, reserve } = await setup();
      await setNextAdrNumber(project.id, 9999);
      expect(await reserve()).toMatchObject({ status: "created", adr: { number: 9999 } });

      const refused = await reserve();
      expect(refused).toMatchObject({ status: "numbers_exhausted" });
      expect((await projectAdrState(testDb.db, project.id)).nextAdrNumber).toBe(10_000);
      expect(await adrRows(testDb.db, project.id)).toHaveLength(1);

      const other = await setup();
      await setNextAdrNumber(other.project.id, 9950);
      expect(await other.reserve({ floor: 9999 })).toMatchObject({ status: "numbers_exhausted" });
    });
  });
});

describeDb("ADR content", () => {
  it("stores parsed files once per Project", async () => {
    const { project, context } = await setup();
    const files = adrFiles(2);

    const first = await storeAdrContents(testDb.db, {
      ...context,
      items: files.map((f) => f.content),
    });
    const second = await storeAdrContents(testDb.db, {
      ...context,
      items: [...files, adrFile(3, "three")].map((f) => f.content),
    });

    const [one, two] = files.map((f) => f.content.sha256);
    expect(first).toEqual({ status: "ok", stored: [one, two], existing: [] });
    expect(second).toMatchObject({ status: "ok", existing: [one, two] });
    const rows = await testDb.db
      .select()
      .from(adrContent)
      .where(eq(adrContent.projectId, project.id));
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.contentSha256 === one)).toMatchObject({
      title: "Decision 1",
      status: "accepted",
      date: "2026-10-05",
      supersedes: [],
      warnings: [],
    });
    expect(await adrEvents(testDb.db, project.id)).toEqual([]);
  });

  it("refuses a batch with a hash that does not match its content, storing nothing", async () => {
    const { project, context } = await setup();
    const good = adrFile(1, "one").content;
    const bad = { ...adrFile(2, "two").content, contentMd: "tampered" };

    const outcome = await storeAdrContents(testDb.db, { ...context, items: [good, bad] });

    expect(outcome).toEqual({
      status: "invalid",
      problems: [{ sha256: bad.sha256, message: "sha256 does not match the content." }],
    });
    const rows = await testDb.db
      .select()
      .from(adrContent)
      .where(eq(adrContent.projectId, project.id));
    expect(rows).toEqual([]);
  });

  // The API's output schemas bound these, so a stored row must fit them.
  it.each([
    ["a title over 200 characters", { title: "x".repeat(MAX_ADR_TITLE_LENGTH + 1) }],
    ["a blank title", { title: "\u3000" }],
    [
      "more than 64 superseded ADRs",
      { supersedes: Array.from({ length: MAX_ADR_SUPERSEDES + 1 }, (_, i) => i + 1) },
    ],
  ] as const)("refuses %s", async (_case, change) => {
    const { context } = await setup();
    const item = { ...adrFile(1, "one").content, ...change };
    const outcome = await storeAdrContents(testDb.db, { ...context, items: [item] });
    expect(outcome).toMatchObject({ status: "invalid", problems: [{ sha256: item.sha256 }] });
  });

  it("accepts the largest title and supersedes list", async () => {
    const { context } = await setup();
    const item = {
      ...adrFile(1, "one").content,
      title: "x".repeat(MAX_ADR_TITLE_LENGTH),
      supersedes: Array.from({ length: MAX_ADR_SUPERSEDES }, (_, i) => i + 1),
    };
    expect(await storeAdrContents(testDb.db, { ...context, items: [item] })).toMatchObject({
      status: "ok",
    });
  });
});

describeDb("ADR sync", () => {
  it("copies a commit's files, raises the counter and records the sync", async () => {
    const { project, principal, context, reserve } = await setup();
    const sha = commitSha();
    const files = adrFiles(14);

    const outcome = await uploadAndSync(testDb.db, context, files, { commitSha: sha });

    expect(outcome).toMatchObject({
      status: "ok",
      replay: false,
      summary: {
        lastSync: { commitSha: sha, syncedAt: expect.any(Date), syncedBy: principal },
        previousCommitSha: null,
        forced: false,
        added: 14,
        updated: 0,
        removed: 0,
        unchanged: 0,
        nextNumber: 15,
      },
    });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.summary.notices).toEqual(
      files.map((f) => ({
        code: "ADR_NUMBER_UNRESERVED",
        number: f.entry.number,
        path: f.entry.path,
      })),
    );
    expect(outcome.summary.files).toEqual(
      files.map((f) => ({
        number: f.entry.number,
        path: f.entry.path,
        status: "accepted",
        supersedes: [],
      })),
    );
    expect(outcome.summary.changes[0]).toEqual({
      number: 1,
      path: "docs/adr/0001-decision-1.md",
      change: "added",
      statusFrom: null,
      statusTo: "accepted",
    });
    const rows = await adrRows(testDb.db, project.id);
    expect(rows.map((row) => [row.number, row.state, row.slug, row.commitSha])).toEqual(
      files.map((f) => [f.entry.number, "published", f.entry.slug, sha]),
    );
    const state = await projectAdrState(testDb.db, project.id);
    expect(state).toMatchObject({
      nextAdrNumber: 15,
      adrSyncedCommitSha: sha,
      adrSyncedByKind: "user",
      adrSyncedByUserId: principal.kind === "user" ? principal.userId : null,
      adrSyncedByKeyId: null,
    });
    expect(state.adrSyncedAt).toBeInstanceOf(Date);
    const events = await adrEvents(testDb.db, project.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("adr.synced");
    // Exactly the Event catalog's payload: no paths, titles or content.
    expect(events[0]?.payload).toEqual({
      commitSha: sha,
      previousCommitSha: null,
      forced: false,
      added: 14,
      updated: 0,
      removed: 0,
      truncated: false,
      changes: files.map((f) => ({
        number: f.entry.number,
        change: "added",
        statusFrom: null,
        statusTo: "accepted",
      })),
    });
    expect(await reserve()).toMatchObject({ status: "created", adr: { number: 15 } });
  });

  it("records a Project key as the syncing principal and leaves updated_at alone", async () => {
    const { project } = await setup();
    const key = await insertProjectKey(testDb.db, project.id);
    const before = await projectAdrState(testDb.db, project.id);

    await uploadAndSync(testDb.db, { projectId: project.id, principal: key }, adrFiles(1));

    expect(await projectAdrState(testDb.db, project.id)).toMatchObject({
      adrSyncedByKind: "project_key",
      adrSyncedByKeyId: key.keyId,
      adrSyncedByUserId: null,
      updatedAt: before.updatedAt,
    });
  });

  it("marks files missing from the next commit removed, and restores them on the same row", async () => {
    const { project, context } = await setup();
    const files = adrFiles(3);
    const first = commitSha();
    const second = commitSha();
    await uploadAndSync(testDb.db, context, files, { commitSha: first });
    const [one, two, three] = files;
    if (!one || !two || !three) throw new Error("unreachable");
    const originalTwo = (await adrRows(testDb.db, project.id))[1];

    const removal = await uploadAndSync(testDb.db, context, [one, three], {
      commitSha: second,
      baseCommitSha: first,
    });

    expect(removal).toMatchObject({
      status: "ok",
      summary: {
        added: 0,
        updated: 0,
        removed: 1,
        unchanged: 2,
        changes: [
          {
            number: 2,
            path: two.entry.path,
            change: "removed",
            statusFrom: "accepted",
            statusTo: null,
          },
        ],
      },
    });
    const rows = await adrRows(testDb.db, project.id);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      id: originalTwo?.id,
      state: "removed",
      path: two.entry.path,
      contentSha256: two.entry.sha256,
      commitSha: first,
    });

    const third = commitSha();
    const restored = await uploadAndSync(testDb.db, context, files, {
      commitSha: third,
      baseCommitSha: second,
    });
    expect(restored).toMatchObject({
      status: "ok",
      summary: {
        added: 1,
        removed: 0,
        unchanged: 2,
        changes: [
          {
            number: 2,
            path: two.entry.path,
            change: "restored",
            statusFrom: null,
            statusTo: "accepted",
          },
        ],
      },
    });
    expect((await adrRows(testDb.db, project.id))[1]).toMatchObject({
      id: originalTwo?.id,
      state: "published",
      commitSha: third,
    });
  });

  it("records updates, moving commit_sha only when the content changes", async () => {
    const { project, context } = await setup();
    const first = commitSha();
    await uploadAndSync(testDb.db, context, [adrFile(1, "one"), adrFile(2, "two")], {
      commitSha: first,
    });
    const second = commitSha();

    const outcome = await uploadAndSync(
      testDb.db,
      context,
      [adrFile(1, "one", { status: "deprecated" }), adrFile(2, "renamed")],
      { commitSha: second, baseCommitSha: first },
    );

    expect(outcome).toMatchObject({
      status: "ok",
      summary: {
        added: 0,
        updated: 2,
        removed: 0,
        unchanged: 0,
        changes: [
          { number: 1, change: "updated", statusFrom: "accepted", statusTo: "deprecated" },
          {
            number: 2,
            path: "docs/adr/0002-renamed.md",
            change: "updated",
            statusFrom: "accepted",
            statusTo: "accepted",
          },
        ],
      },
    });
    const [one, two] = await adrRows(testDb.db, project.id);
    expect(one).toMatchObject({ commitSha: second, state: "published" });
    expect(two).toMatchObject({
      commitSha: first,
      slug: "renamed",
      path: "docs/adr/0002-renamed.md",
    });
  });

  it("accepts files below the repository root and an empty commit", async () => {
    const { project, context } = await setup();
    const file = adrFile(1, "nested");
    const nested = { ...file, entry: { ...file.entry, path: `services/api/${file.entry.path}` } };
    const first = commitSha();
    expect(await uploadAndSync(testDb.db, context, [nested], { commitSha: first })).toMatchObject({
      status: "ok",
      summary: { added: 1 },
    });

    const empty = await uploadAndSync(testDb.db, context, [], { baseCommitSha: first });
    expect(empty).toMatchObject({ status: "ok", summary: { removed: 1 } });
    expect((await adrRows(testDb.db, project.id))[0]?.state).toBe("removed");
  });

  it("lists at most 100 changes in the Event and counts all of them", async () => {
    const { project, context } = await setup();
    const files = adrFiles(MAX_ADR_SYNC_EVENT_CHANGES + 20);

    const outcome = await uploadAndSync(testDb.db, context, files);

    expect(outcome).toMatchObject({ status: "ok", summary: { added: files.length } });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.summary.changes).toHaveLength(files.length);
    const [synced] = await adrEvents(testDb.db, project.id);
    const payload = synced?.payload as { changes: { number: number }[]; truncated: boolean };
    expect(payload.truncated).toBe(true);
    expect(payload.changes.map((c) => c.number)).toEqual(
      files.slice(0, MAX_ADR_SYNC_EVENT_CHANGES).map((f) => f.entry.number),
    );
  });

  describe("all or nothing", () => {
    async function expectNothingApplied(projectId: string, before: unknown) {
      expect(await adrRows(testDb.db, projectId)).toEqual([]);
      expect(await adrEvents(testDb.db, projectId)).toEqual([]);
      expect(await projectAdrState(testDb.db, projectId)).toEqual(before);
    }

    it("applies nothing when one file was not uploaded", async () => {
      const { project, context } = await setup();
      const files = adrFiles(3);
      const missing = adrFile(4, "never-uploaded");
      await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
      const before = await projectAdrState(testDb.db, project.id);

      const outcome = await syncAdrs(testDb.db, {
        ...context,
        commitSha: commitSha(),
        baseCommitSha: null,
        forced: false,
        entries: [...files, missing].map((f) => f.entry),
      });

      expect(outcome).toEqual({
        status: "invalid",
        problems: [
          {
            reason: "missing_content",
            path: missing.entry.path,
            message: expect.stringContaining(missing.entry.sha256),
          },
        ],
      });
      await expectNothingApplied(project.id, before);
    });

    it("does not use another Project's upload", async () => {
      const { project, context } = await setup();
      const other = await setup();
      const file = adrFile(1, "one");
      await storeAdrContents(testDb.db, { ...other.context, items: [file.content] });
      const before = await projectAdrState(testDb.db, project.id);

      const outcome = await syncAdrs(testDb.db, {
        ...context,
        commitSha: commitSha(),
        baseCommitSha: null,
        forced: false,
        entries: [file.entry],
      });

      expect(outcome).toMatchObject({
        status: "invalid",
        problems: [{ reason: "missing_content" }],
      });
      await expectNothingApplied(project.id, before);
    });

    it("applies nothing when one entry is invalid, listing every problem", async () => {
      const { project, context } = await setup();
      const files = adrFiles(2);
      await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
      const before = await projectAdrState(testDb.db, project.id);
      const [one, two] = files.map((f) => f.entry);
      if (!one || !two) throw new Error("unreachable");

      const outcome = await syncAdrs(testDb.db, {
        ...context,
        commitSha: "HEAD",
        baseCommitSha: null,
        forced: false,
        entries: [
          one,
          { ...two, path: "docs/adr/0000-zero.md", number: 0, slug: "zero" },
          { ...two, path: "docs/adr/0003-Upper.md", number: 3, slug: "Upper" },
          { ...two, path: "docs/adr/../adr/0004-dots.md", number: 4, slug: "dots" },
          { ...two, path: "docs/adr/0005-five.md", number: 6, slug: "five" },
          { ...two, path: "docs/adr/0007-seven.md", number: 7, slug: "seven", sha256: "ABC" },
          one,
        ],
      });

      expect(outcome).toMatchObject({ status: "invalid" });
      if (outcome.status !== "invalid") throw new Error("unreachable");
      expect(outcome.problems.map((p) => [p.reason, p.path])).toEqual([
        ["invalid_commit_sha", null],
        ["invalid_path", "docs/adr/0000-zero.md"],
        ["invalid_path", "docs/adr/0003-Upper.md"],
        ["invalid_path", "docs/adr/../adr/0004-dots.md"],
        ["number_mismatch", "docs/adr/0005-five.md"],
        ["invalid_sha256", "docs/adr/0007-seven.md"],
        ["duplicate_path", one.path],
      ]);
      await expectNothingApplied(project.id, before);
    });

    it("refuses two files with one number as a conflict, listing them", async () => {
      const { project, context } = await setup();
      const files = [adrFile(1, "one"), adrFile(2, "two"), adrFile(2, "other-two")];
      await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
      const before = await projectAdrState(testDb.db, project.id);

      const outcome = await syncAdrs(testDb.db, {
        ...context,
        commitSha: commitSha(),
        baseCommitSha: null,
        forced: false,
        entries: files.map((f) => f.entry),
      });

      expect(outcome).toEqual({
        status: "duplicate_numbers",
        duplicates: [{ number: 2, paths: ["docs/adr/0002-other-two.md", "docs/adr/0002-two.md"] }],
      });
      await expectNothingApplied(project.id, before);
    });
  });

  describe("compare and set", () => {
    it("refuses a stale base, even when forced, and records forced on success", async () => {
      const { project, context } = await setup();
      const first = commitSha();
      await uploadAndSync(testDb.db, context, adrFiles(1), { commitSha: first });
      const before = await projectAdrState(testDb.db, project.id);

      const stale = await uploadAndSync(testDb.db, context, adrFiles(2), { baseCommitSha: null });
      const forcedStale = await uploadAndSync(testDb.db, context, adrFiles(2), {
        baseCommitSha: commitSha(),
        forced: true,
      });

      expect(stale).toEqual({ status: "stale_base", currentCommitSha: first });
      expect(forcedStale).toEqual({ status: "stale_base", currentCommitSha: first });
      expect(await projectAdrState(testDb.db, project.id)).toEqual(before);
      expect(await adrRows(testDb.db, project.id)).toHaveLength(1);

      const second = commitSha();
      const forced = await uploadAndSync(testDb.db, context, adrFiles(2), {
        commitSha: second,
        baseCommitSha: first,
        forced: true,
      });
      expect(forced).toMatchObject({
        status: "ok",
        summary: { forced: true, previousCommitSha: first },
      });
      const events = await adrEvents(testDb.db, project.id);
      expect(events.at(-1)?.payload).toMatchObject({
        commitSha: second,
        previousCommitSha: first,
        forced: true,
        added: 1,
      });
    });

    it("answers a repeat of the synced commit with the same files as a replay, writing nothing", async () => {
      const { project, principal, context } = await setup();
      const sha = commitSha();
      const files = adrFiles(3);
      await uploadAndSync(testDb.db, context, files, { commitSha: sha });
      const before = await projectAdrState(testDb.db, project.id);
      const rows = await adrRows(testDb.db, project.id);

      // The lost answer's retry still names the old base.
      const replay = await uploadAndSync(testDb.db, context, files, { commitSha: sha });

      expect(replay).toEqual({
        status: "ok",
        replay: true,
        summary: {
          lastSync: { commitSha: sha, syncedAt: before.adrSyncedAt, syncedBy: principal },
          previousCommitSha: sha,
          forced: false,
          added: 0,
          updated: 0,
          removed: 0,
          unchanged: 3,
          changes: [],
          notices: [],
          files: [],
          nextNumber: 4,
        },
      });
      expect(await projectAdrState(testDb.db, project.id)).toEqual(before);
      expect(await adrRows(testDb.db, project.id)).toEqual(rows);
      expect(await adrEvents(testDb.db, project.id)).toHaveLength(1);

      const different = await uploadAndSync(testDb.db, context, adrFiles(2), { commitSha: sha });
      expect(different).toEqual({ status: "commit_mismatch", currentCommitSha: sha });
    });
  });

  describe("reserved numbers", () => {
    it("lets a hand-numbered file take a reserved number, keeping the reservation", async () => {
      const { project, principal, context, reserved } = await setup();
      const reservation = await reserved({ title: "Use Postgres", slug: "use-postgres" });
      const intruder = adrFile(reservation.number, "use-redis", { title: "Use Redis" });

      const outcome = await uploadAndSync(testDb.db, context, [intruder]);

      expect(outcome).toMatchObject({
        status: "ok",
        summary: {
          added: 1,
          changes: [{ number: 1, change: "added", statusFrom: null, statusTo: "accepted" }],
          notices: [
            {
              code: "ADR_RESERVATION_TAKEN",
              number: 1,
              path: intruder.entry.path,
              reservation: { title: "Use Postgres", slug: "use-postgres" },
            },
          ],
        },
      });
      const [row] = await adrRows(testDb.db, project.id);
      expect(row).toMatchObject({
        id: reservation.id,
        state: "published",
        slug: "use-redis",
        path: intruder.entry.path,
        reservedTitle: "Use Postgres",
        reservedSlug: "use-postgres",
        reservedByKind: "user",
        reservedByUserId: principal.kind === "user" ? principal.userId : null,
        creationFingerprint: reservation.creationFingerprint,
      });
      const read = await getAdr(testDb.db, { projectId: project.id, number: 1 });
      expect(read?.adr).toMatchObject({
        title: "Use Redis",
        reservationTaken: true,
        reservation: { title: "Use Postgres", slug: "use-postgres" },
      });
    });

    it("syncs its own file quietly, notes a renamed slug, and leaves unsynced reservations reserved", async () => {
      const { project, context, reserved } = await setup();
      const own = await reserved({ title: "Use Postgres", slug: "use-postgres" });
      const renamed = await reserved({ title: "Cache reads", slug: "cache-reads" });
      const pending = await reserved({ title: "Not merged yet", slug: "not-merged-yet" });

      const outcome = await uploadAndSync(testDb.db, context, [
        adrFile(own.number, "use-postgres", { title: "Use Postgres" }),
        adrFile(renamed.number, "read-cache", { title: "Cache reads" }),
      ]);

      expect(outcome).toMatchObject({
        status: "ok",
        summary: {
          added: 2,
          notices: [
            {
              code: "ADR_SLUG_DIFFERS_FROM_RESERVATION",
              number: renamed.number,
              path: "docs/adr/0002-read-cache.md",
              slug: "read-cache",
              reservation: { title: "Cache reads", slug: "cache-reads" },
            },
          ],
          nextNumber: 4,
        },
      });
      const rows = await adrRows(testDb.db, project.id);
      expect(rows.map((row) => [row.number, row.state])).toEqual([
        [own.number, "published"],
        [renamed.number, "published"],
        [pending.number, "reserved"],
      ]);

      const later = await uploadAndSync(testDb.db, context, [], {
        baseCommitSha: (await projectAdrState(testDb.db, project.id)).adrSyncedCommitSha,
      });
      expect(later).toMatchObject({ status: "ok", summary: { removed: 2 } });
      expect((await adrRows(testDb.db, project.id))[2]?.state).toBe("reserved");
    });
  });

  it("never lowers the counter when the highest ADR is removed", async () => {
    const { project, context, reserve } = await setup();
    const files = adrFiles(3);
    const first = commitSha();
    await uploadAndSync(testDb.db, context, files, { commitSha: first });

    const removal = await uploadAndSync(testDb.db, context, files.slice(0, 2), {
      baseCommitSha: first,
    });

    expect(removal).toMatchObject({ status: "ok", summary: { removed: 1, nextNumber: 4 } });
    expect((await projectAdrState(testDb.db, project.id)).nextAdrNumber).toBe(4);
    expect(await reserve()).toMatchObject({ status: "created", adr: { number: 4 } });
  });

  it("records the caller's own Session as the actor of adr.synced", async () => {
    const { project, principal, context } = await setup();
    const session = await insertSession(testDb.db, project.id, principal);
    const file = adrFile(1, "one");
    await storeAdrContents(testDb.db, { ...context, items: [file.content] });

    const outcome = await syncAdrs(testDb.db, {
      ...context,
      sessionId: session.id,
      commitSha: commitSha(),
      baseCommitSha: null,
      forced: false,
      entries: [file.entry],
    });

    expect(outcome).toMatchObject({ status: "ok", replay: false });
    const [synced] = await adrEvents(testDb.db, project.id);
    expect(synced).toMatchObject({
      type: "adr.synced",
      actorKind: "user",
      actorUserId: principal.kind === "user" ? principal.userId : null,
      actorSessionId: session.id,
    });
  });

  it("keeps nothing when the Event insert fails", async () => {
    const { project, context, reserve } = await setup();
    const files = adrFiles(3);
    const first = commitSha();
    await uploadAndSync(testDb.db, context, files.slice(0, 2), { commitSha: first });
    await storeAdrContents(testDb.db, { ...context, items: files.map((f) => f.content) });
    const rows = await adrRows(testDb.db, project.id);
    const state = await projectAdrState(testDb.db, project.id);
    const events = await adrEvents(testDb.db, project.id);
    // project.id is a generated uuid, so it is safe to inline.
    await testDb.db.execute(
      sql.raw(`
        create function adr_test_fail_event() returns trigger language plpgsql as $$
        begin raise exception 'adr test: event insert refused'; end $$;
        create trigger adr_test_fail_event before insert on event for each row
        when (new.project_id = '${project.id}' and new.type in ('adr.synced', 'adr.reserved'))
        execute function adr_test_fail_event();
      `),
    );
    const refused = { cause: { message: "adr test: event insert refused" } };
    try {
      await expect(
        uploadAndSync(testDb.db, context, files, { commitSha: commitSha(), baseCommitSha: first }),
      ).rejects.toMatchObject(refused);
      await expect(reserve({ floor: 0 })).rejects.toMatchObject(refused);

      expect(await adrRows(testDb.db, project.id)).toEqual(rows);
      expect(await projectAdrState(testDb.db, project.id)).toEqual(state);
      expect(await adrEvents(testDb.db, project.id)).toEqual(events);
    } finally {
      await testDb.db.execute(
        sql.raw(`
          drop trigger adr_test_fail_event on event;
          drop function adr_test_fail_event();
        `),
      );
    }
  });

  it("refuses a Session the principal does not own, applying nothing", async () => {
    const { project, context } = await setup();
    const key = await insertProjectKey(testDb.db, project.id);
    const session = await insertSession(testDb.db, project.id, key);
    const file = adrFile(1, "one");
    await storeAdrContents(testDb.db, { ...context, items: [file.content] });

    const outcome = await syncAdrs(testDb.db, {
      ...context,
      sessionId: session.id,
      commitSha: commitSha(),
      baseCommitSha: null,
      forced: false,
      entries: [file.entry],
    });

    expect(outcome).toEqual({ status: "session_forbidden" });
    expect(await adrRows(testDb.db, project.id)).toEqual([]);
  });
});

describeDb("ADR reads", () => {
  async function seeded() {
    const base = await setup();
    const sha = commitSha();
    await uploadAndSync(
      testDb.db,
      base.context,
      [
        adrFile(1, "one", { status: "superseded", title: "One" }),
        adrFile(2, "two", { status: "superseded", supersedes: [1], title: "Two" }),
        adrFile(3, "three", { status: "accepted", supersedes: [2, 9], title: "Three" }),
        adrFile(4, "four", { status: "proposed", title: "Four" }),
        adrFile(5, "five", { status: "deprecated", title: "Five" }),
      ],
      { commitSha: sha },
    );
    const reservation = await base.reserved({ title: "Reserved one", slug: "reserved-one" });
    return { ...base, sha, reservation };
  }

  it("lists numbers highest first, filtered by status or state, in keyset pages", async () => {
    const { project, principal, sha, reservation } = await seeded();
    const projectId = project.id;

    const all = await listAdrs(testDb.db, { projectId, limit: 4 });
    expect(all.items.map((item) => item.number)).toEqual([reservation.number, 5, 4, 3]);
    expect(all.hasMore).toBe(true);
    expect(all.sync).toEqual({
      commitSha: sha,
      syncedAt: expect.any(Date),
      syncedBy: principal,
    });
    const rest = await listAdrs(testDb.db, { projectId, limit: 4, beforeNumber: 3 });
    expect(rest.items.map((item) => item.number)).toEqual([2, 1]);
    expect(rest.hasMore).toBe(false);

    const superseded = await listAdrs(testDb.db, { projectId, limit: 10, status: "superseded" });
    expect(superseded.items.map((item) => item.number)).toEqual([2, 1]);
    const reserved = await listAdrs(testDb.db, { projectId, limit: 10, state: "reserved" });
    expect(reserved.items).toEqual([
      expect.objectContaining({
        projectId,
        number: reservation.number,
        state: "reserved",
        title: "Reserved one",
        status: null,
        path: null,
        contentSha256: null,
        reservationTaken: false,
        reservation: expect.objectContaining({
          title: "Reserved one",
          slug: "reserved-one",
          gitBranch: "feat/db",
          principal,
        }),
      }),
    ]);
    expect(Object.keys(all.items[0] ?? {})).not.toContain("contentMd");
  });

  it("reports no sync state before the first sync", async () => {
    const { project, reserved } = await setup();
    await reserved();
    const page = await listAdrs(testDb.db, { projectId: project.id, limit: 10 });
    expect(page.sync).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  it("reads one ADR with its file and both directions of the chain, marking missing targets", async () => {
    const { project, sha } = await seeded();

    const three = await getAdr(testDb.db, { projectId: project.id, number: 3 });

    expect(three?.adr).toMatchObject({
      number: 3,
      title: "Three",
      status: "accepted",
      supersedes: [2, 9],
      commitSha: sha,
      contentMd: expect.stringContaining("# Three"),
    });
    expect(three?.supersedes).toEqual([
      { number: 2, depth: 1, found: true, title: "Two", status: "superseded", state: "published" },
      { number: 9, depth: 1, found: false, title: null, status: null, state: null },
      { number: 1, depth: 2, found: true, title: "One", status: "superseded", state: "published" },
    ]);
    expect(three?.supersededBy).toEqual([]);
    expect(three?.chainTruncated).toBe(false);

    const one = await getAdr(testDb.db, { projectId: project.id, number: 1 });
    expect(one?.supersedes).toEqual([]);
    expect(one?.supersededBy.map((link) => [link.number, link.depth])).toEqual([
      [2, 1],
      [3, 2],
    ]);
    expect(await getAdr(testDb.db, { projectId: project.id, number: 42 })).toBeUndefined();
  });

  it("bounds the chain's depth and survives a cycle", async () => {
    const { project, context } = await setup();
    const length = MAX_ADR_CHAIN_DEPTH + 3;
    const files = Array.from({ length }, (_, i) =>
      adrFile(i + 1, `link-${i + 1}`, { supersedes: i === 0 ? [length] : [i] }),
    );
    await uploadAndSync(testDb.db, context, files);

    const last = await getAdr(testDb.db, { projectId: project.id, number: length });

    expect(last?.supersedes).toHaveLength(MAX_ADR_CHAIN_DEPTH);
    expect(last?.supersedes.at(-1)?.depth).toBe(MAX_ADR_CHAIN_DEPTH);
    expect(last?.chainTruncated).toBe(true);
    expect(last?.supersededBy.map((link) => link.number)).toEqual(
      Array.from({ length: MAX_ADR_CHAIN_DEPTH }, (_, i) => i + 1),
    );
  });

  it("lists recently synced published ADRs first", async () => {
    const { project, context, sha } = await seeded();
    await uploadAndSync(
      testDb.db,
      context,
      [
        adrFile(1, "one", { status: "superseded", title: "One" }),
        adrFile(2, "two", { status: "superseded", supersedes: [1], title: "Two" }),
        adrFile(3, "three", { status: "accepted", supersedes: [2, 9], title: "Three" }),
        adrFile(4, "four", { status: "accepted", title: "Four" }),
      ],
      { baseCommitSha: sha },
    );

    const recent = await recentAdrs(testDb.db, { projectId: project.id, limit: 3 });

    expect(recent.map((item) => [item.number, item.status])).toEqual([
      [4, "accepted"],
      [3, "accepted"],
      [2, "superseded"],
    ]);
  });

  it("orders recent ADRs by their last sync, then by number", async () => {
    const { project, context } = await setup();
    const files = adrFiles(5);
    const first = commitSha();
    await uploadAndSync(testDb.db, context, files, { commitSha: first });
    const changed = [adrFile(1, "decision-1", { body: "Changed." }), ...files.slice(1)];

    await uploadAndSync(testDb.db, context, changed, { baseCommitSha: first });

    const recent = await recentAdrs(testDb.db, { projectId: project.id, limit: 3 });
    expect(recent.map((item) => item.number)).toEqual([1, 5, 4]);
  });

  it("returns nothing for another Project's numbers", async () => {
    const { project } = await seeded();
    const other = await setup();
    expect(await getAdr(testDb.db, { projectId: other.project.id, number: 1 })).toBeUndefined();
    const page = await listAdrs(testDb.db, { projectId: other.project.id, limit: 10 });
    expect(page.items).toEqual([]);
    expect(
      (await listAdrs(testDb.db, { projectId: project.id, limit: 10 })).items.length,
    ).toBeGreaterThan(0);
  });
});

describeDb("ADR schema", () => {
  async function violation(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
    } catch (error) {
      return (error as { cause?: { constraint?: string } }).cause?.constraint;
    }
    return undefined;
  }

  it("rejects rows that break the number, reservation and copy rules", async () => {
    const { project: row, context } = await setup();
    const file = adrFile(1, "one");
    await storeAdrContents(testDb.db, { ...context, items: [file.content] });
    const published = {
      projectId: row.id,
      state: "published" as const,
      slug: "one",
      path: file.entry.path,
      contentSha256: file.entry.sha256,
      commitSha: commitSha(),
      syncedAt: new Date(),
    };
    const insert = (values: Partial<typeof adr.$inferInsert>) => () =>
      testDb.db.insert(adr).values({ ...published, number: 1, ...values });

    expect(await violation(insert({ number: 0 }))).toBe("adr_number_check");
    expect(await violation(insert({ number: 10_000 }))).toBe("adr_number_check");
    expect(await violation(insert({ state: "reserved" }))).toBe("adr_copy_check");
    expect(await violation(insert({ commitSha: "HEAD" }))).toBe("adr_copy_check");
    expect(await violation(insert({ slug: "Bad" }))).toBe("adr_slug_check");
    expect(await violation(insert({ contentSha256: "f".repeat(64) }))).toBe(
      "adr_content_sha256_fk",
    );
    expect(await violation(insert({ reservedTitle: "Orphan" }))).toBe("adr_reservation_check");
    expect(
      await violation(
        insert({
          state: "reserved",
          path: null,
          contentSha256: null,
          commitSha: null,
          syncedAt: null,
        }),
      ),
    ).toBe("adr_unreserved_check");
    expect(
      await violation(() =>
        testDb.db.execute(sql`update project set next_adr_number = 0 where id = ${row.id}`),
      ),
    ).toBe("project_next_adr_number_check");
    expect(
      await violation(() =>
        testDb.db.execute(
          sql`update project set adr_synced_commit_sha = ${commitSha()} where id = ${row.id}`,
        ),
      ),
    ).toBe("project_adr_synced_check");
    expect(await violation(insert({}))).toBeUndefined();
  });
});
