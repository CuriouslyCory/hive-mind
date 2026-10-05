import { randomUUID } from "node:crypto";
import { trackerBacklogPhase, trackerBacklogStep } from "@hivemind/db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "@hivemind/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getLatestScan,
  getTrackerSnapshot,
  runTrackerBatch,
  runTrackerCommand,
  type TrackerCommandInput,
  type TrackerCommandName,
  TrackerConflictError,
  TrackerInputError,
  TrackerNotFoundError,
  TrackerRuleError,
} from "../src/index.ts";

let testDb: TestDatabase;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

function run<N extends TrackerCommandName>(name: N, input: TrackerCommandInput<N>) {
  return runTrackerCommand(testDb.db, name, input);
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

// Issue numbers are unique per database, so each test takes its own.
let nextIssueNumber = 1000;

async function newPhase(title = "Phase", sortOrder = 0) {
  return (await run("save-phase", { title, description: null, sortOrder })).id;
}

async function newIssue(
  phaseId: string,
  values: Partial<TrackerCommandInput<"save-issue">> = {},
): Promise<number> {
  const issueNumber = values.issueNumber ?? nextIssueNumber++;
  await run("save-issue", {
    mode: "create",
    issueNumber,
    title: `Issue ${issueNumber}`,
    note: null,
    phaseId,
    sortOrder: 0,
    state: "open",
    githubUpdatedAt: null,
    ...values,
  });
  return issueNumber;
}

async function findIssueView(issueNumber: number) {
  const snapshot = await getTrackerSnapshot(testDb.db);
  const issue = snapshot.backlog
    .flatMap((phase) => phase.issues)
    .find((candidate) => candidate.issueNumber === issueNumber);
  if (!issue) throw new Error(`issue #${issueNumber} is not in the snapshot`);
  return issue;
}

async function findBlogIdea(id: string) {
  const idea = (await getTrackerSnapshot(testDb.db)).blogIdeas.find((each) => each.id === id);
  if (!idea) throw new Error("blog idea is not in the snapshot");
  return idea;
}

async function findPhaseView(id: string) {
  const phase = (await getTrackerSnapshot(testDb.db)).backlog.find((each) => each.id === id);
  if (!phase) throw new Error("phase is not in the snapshot");
  return phase;
}

const blogIdea = {
  title: "Idea",
  pitch: "Pitch",
  notes: null,
  prNumbers: [1],
  status: "idea",
  publishedAt: null,
  publishedUrl: null,
  sortOrder: 0,
} satisfies TrackerCommandInput<"save-blog-idea">;

describeDb("tracker snapshot", () => {
  // Its own database, so the ordering checks see only their own rows.
  let snapshotDb: TestDatabase;

  beforeAll(async () => {
    snapshotDb = await createTestDatabase();
  });

  afterAll(async () => {
    await snapshotDb?.drop();
  });

  function exec<N extends TrackerCommandName>(name: N, input: TrackerCommandInput<N>) {
    return runTrackerCommand(snapshotDb.db, name, input);
  }

  it("is empty for an empty database", async () => {
    expect(await getTrackerSnapshot(snapshotDb.db)).toEqual({
      readAt: expect.any(String),
      gitScan: null,
      backlogScan: null,
      changelog: [],
      blogIdeas: [],
      backlog: [],
      nextStep: null,
    });
  });

  it("orders every list and picks the newest scan of each kind", async () => {
    for (const [date, title] of [
      ["2026-09-01", "B"],
      ["2026-09-02", "Z"],
      ["2026-09-01", "A"],
    ] as const) {
      await exec("save-changelog-entry", {
        date,
        category: "Feature",
        title,
        summary: "Summary",
        prNumbers: [],
      });
    }
    for (const [title, sortOrder] of [
      ["Second", 1],
      ["Tie first", 2],
      ["First", 0],
      ["Tie second", 2],
    ] as const) {
      await exec("save-blog-idea", { ...blogIdea, title, sortOrder });
    }
    const later = (await exec("save-phase", { title: "Later", description: null, sortOrder: 1 }))
      .id;
    const first = (await exec("save-phase", { title: "First", description: "D", sortOrder: 0 })).id;
    for (const [issueNumber, sortOrder, phaseId] of [
      [2, 1, first],
      [1, 0, first],
      [3, 0, later],
    ] as const) {
      await exec("save-issue", {
        mode: "create",
        issueNumber,
        title: `Issue ${issueNumber}`,
        note: null,
        phaseId,
        sortOrder,
        state: "open",
        githubUpdatedAt: "2026-09-30T12:00:00+02:00",
        steps: [
          { key: "b", label: "B", prompt: null, sortOrder: 1 },
          { key: "a", label: "A", prompt: "Do A", sortOrder: 0 },
        ],
      });
    }
    await exec("record-scan", {
      kind: "backlog",
      throughAt: "2026-09-01T00:00:00Z",
      throughSha: null,
      note: "older",
    });
    await exec("record-scan", {
      kind: "backlog",
      throughAt: "2026-08-01T00:00:00Z",
      throughSha: null,
      note: "newer",
    });

    const snapshot = await getTrackerSnapshot(snapshotDb.db);
    expect(snapshot.changelog.map((entry) => [entry.date, entry.title])).toEqual([
      ["2026-09-02", "Z"],
      ["2026-09-01", "A"],
      ["2026-09-01", "B"],
    ]);
    expect(snapshot.blogIdeas.map((idea) => idea.title)).toEqual([
      "First",
      "Second",
      "Tie first",
      "Tie second",
    ]);
    expect(snapshot.backlog.map((phase) => phase.title)).toEqual(["First", "Later"]);
    expect(snapshot.backlog[0]?.issues.map((issue) => issue.issueNumber)).toEqual([1, 2]);
    expect(snapshot.backlog[0]?.issues[0]?.steps.map((step) => step.key)).toEqual(["a", "b"]);
    expect(snapshot.backlog[0]?.issues[0]?.githubUpdatedAt).toBe("2026-09-30T10:00:00.000Z");
    // The newest completed scan, not the newest cursor.
    expect(snapshot.backlogScan).toMatchObject({ kind: "backlog", note: "newer" });
    expect(snapshot.gitScan).toBeNull();
    expect(await getLatestScan(snapshotDb.db, "backlog")).toEqual(snapshot.backlogScan);
    expect(snapshot.nextStep).toMatchObject({
      phaseTitle: "First",
      issueNumber: 1,
      issueTitle: "Issue 1",
      step: { key: "a", prompt: "Do A", completedAt: null },
    });
  });

  it("moves nextStep past finished steps and closed issues", async () => {
    const steps = (await getTrackerSnapshot(snapshotDb.db)).backlog[0]?.issues.flatMap(
      (issue) => issue.steps,
    );
    // Issue #1's two steps.
    for (const step of steps?.slice(0, 2) ?? []) {
      await exec("set-step-complete", { id: step.id, complete: true });
    }
    let snapshot = await getTrackerSnapshot(snapshotDb.db);
    expect(snapshot.nextStep).toMatchObject({ issueNumber: 2, step: { key: "a" } });

    const issue2 = snapshot.backlog[0]?.issues[1];
    if (!issue2) throw new Error("issue #2 missing");
    await exec("save-issue", {
      mode: "update",
      issueNumber: 2,
      updatedAt: issue2.updatedAt,
      title: issue2.title,
      note: null,
      phaseId: snapshot.backlog[0]?.id ?? "",
      sortOrder: issue2.sortOrder,
      state: "closed",
      githubUpdatedAt: null,
    });
    snapshot = await getTrackerSnapshot(snapshotDb.db);
    expect(snapshot.nextStep).toMatchObject({ phaseTitle: "Later", issueNumber: 3 });
  });
});

describeDb("changelog entries", () => {
  it("creates, updates and deletes with optimistic concurrency", async () => {
    const entry = {
      date: "2026-09-03",
      category: " Fix ",
      title: "Title",
      summary: "Summary",
      prNumbers: [5, 4, 5],
    };
    const { id } = await run("save-changelog-entry", entry);
    const read = (await getTrackerSnapshot(testDb.db)).changelog.find((each) => each.id === id);
    expect(read).toMatchObject({ category: "Fix", prNumbers: [5, 4] });
    const updatedAt = read?.updatedAt ?? "";

    await run("save-changelog-entry", { ...entry, id, updatedAt, title: "Edited" });
    // The first write moved updatedAt, so a second write from the same read is refused.
    await expect(
      run("save-changelog-entry", { ...entry, id, updatedAt, title: "Stale" }),
    ).rejects.toThrow(TrackerConflictError);
    await expect(run("delete-changelog-entry", { id, updatedAt })).rejects.toThrow(
      TrackerConflictError,
    );
    // Without updatedAt the write is unconditional.
    await run("save-changelog-entry", { ...entry, id, title: "Blind" });
    await run("delete-changelog-entry", { id });

    await expect(run("delete-changelog-entry", { id })).rejects.toThrow(TrackerNotFoundError);
    await expect(run("save-changelog-entry", { ...entry, id, updatedAt })).rejects.toThrow(
      TrackerNotFoundError,
    );
  });
});

describeDb("blog ideas", () => {
  it("stores publication fields only while published, and dates a publish without one", async () => {
    const draft = await run("save-blog-idea", {
      ...blogIdea,
      status: "draft",
      publishedAt: "2026-09-01",
      publishedUrl: "https://example.com/post",
    });
    expect(await findBlogIdea(draft.id)).toMatchObject({
      status: "draft",
      publishedAt: null,
      publishedUrl: null,
    });

    const before = new Date().toISOString().slice(0, 10);
    const published = await run("save-blog-idea", { ...blogIdea, status: "published" });
    const publishedAt = (await findBlogIdea(published.id)).publishedAt;
    // Today's UTC date (or tomorrow's, if the test ran across midnight).
    expect([before, new Date().toISOString().slice(0, 10)]).toContain(publishedAt);

    const dated = await run("save-blog-idea", {
      ...blogIdea,
      status: "published",
      publishedAt: "2026-09-01",
      publishedUrl: "",
    });
    expect(await findBlogIdea(dated.id)).toMatchObject({
      publishedAt: "2026-09-01",
      publishedUrl: null,
    });
  });

  it("accepts a snapshot row back into save-blog-idea unchanged", async () => {
    const { id } = await run("save-blog-idea", {
      ...blogIdea,
      status: "published",
      publishedAt: "2026-09-04",
      publishedUrl: "https://example.com/post",
    });
    const read = await findBlogIdea(id);
    expect(read.publishedAt).toBe("2026-09-04");
    await run("save-blog-idea", { ...read, sortOrder: 3 });
    expect(await findBlogIdea(id)).toMatchObject({ publishedAt: "2026-09-04", sortOrder: 3 });
  });

  it("requires updatedAt to update or delete", async () => {
    const { id } = await run("save-blog-idea", blogIdea);
    await expect(run("save-blog-idea", { ...blogIdea, id })).rejects.toThrow(
      /updatedAt: Required when id is given/,
    );
    await expect(
      runTrackerCommand(testDb.db, "delete-blog-idea", { id } as unknown),
    ).rejects.toThrow(TrackerInputError);
  });

  it("locks a published idea except its publication date, URL and sort order", async () => {
    const { id } = await run("save-blog-idea", blogIdea);
    let read = await findBlogIdea(id);
    await run("save-blog-idea", {
      ...blogIdea,
      id,
      updatedAt: read.updatedAt,
      status: "published",
    });
    read = await findBlogIdea(id);
    const firstPublishedAt = read.publishedAt;
    expect(firstPublishedAt).not.toBeNull();

    const published = { ...blogIdea, id, status: "published" as const };
    for (const change of [
      { title: "New title" },
      { pitch: "New pitch" },
      { notes: "New notes" },
      { prNumbers: [1, 2] },
    ]) {
      await expect(
        run("save-blog-idea", { ...published, ...change, updatedAt: read.updatedAt }),
      ).rejects.toThrow(/published blog idea is locked/);
    }
    await expect(
      run("save-blog-idea", { ...published, status: "draft", updatedAt: read.updatedAt }),
    ).rejects.toThrow(TrackerRuleError);

    // Keeps the stored date when none is sent.
    await run("save-blog-idea", {
      ...published,
      sortOrder: 7,
      publishedUrl: "https://example.com/announcement",
      updatedAt: read.updatedAt,
    });
    read = await findBlogIdea(id);
    expect(read).toMatchObject({
      sortOrder: 7,
      publishedAt: firstPublishedAt,
      publishedUrl: "https://example.com/announcement",
    });
    await run("save-blog-idea", {
      ...published,
      publishedAt: "2026-01-02",
      updatedAt: read.updatedAt,
    });
    read = await findBlogIdea(id);
    expect(read.publishedAt).toBe("2026-01-02");

    await expect(run("delete-blog-idea", { id, updatedAt: read.updatedAt })).rejects.toThrow(
      /cannot be deleted/,
    );
    expect((await findBlogIdea(id)).status).toBe("published");
  });

  it("deletes an unpublished idea only if it is unchanged", async () => {
    const { id } = await run("save-blog-idea", blogIdea);
    const first = await findBlogIdea(id);
    await run("save-blog-idea", { ...blogIdea, id, updatedAt: first.updatedAt, title: "Edited" });
    await expect(run("delete-blog-idea", { id, updatedAt: first.updatedAt })).rejects.toThrow(
      TrackerConflictError,
    );
    await run("delete-blog-idea", { id, updatedAt: (await findBlogIdea(id)).updatedAt });
    await expect(run("delete-blog-idea", { id, updatedAt: first.updatedAt })).rejects.toThrow(
      TrackerNotFoundError,
    );
  });

  it("does not overwrite a publish that commits between an edit's read and its write", async () => {
    const { id } = await run("save-blog-idea", blogIdea);
    const read = await findBlogIdea(id);

    // Another writer publishes the idea and holds its transaction open.
    const publisher = await testDb.pool.connect();
    try {
      await publisher.query("begin");
      // updated_at is left as it was, so only the edit's status condition
      // can refuse it.
      await publisher.query(
        `update tracker_blog_idea
         set status = 'published', published_at = current_date
         where id = $1`,
        [id],
      );
      // The edit reads the committed row (still an idea), passes the rules,
      // then waits on the publisher's row lock.
      const edit = run("save-blog-idea", {
        ...blogIdea,
        id,
        updatedAt: read.updatedAt,
        title: "Edited while publishing",
      });
      edit.catch(() => {});
      await waitForLockWait();
      await publisher.query("commit");
      await expect(edit).rejects.toThrow(TrackerConflictError);
    } finally {
      publisher.release();
    }
    expect(await findBlogIdea(id)).toMatchObject({
      status: "published",
      title: "Idea",
      updatedAt: read.updatedAt,
    });
  });
});

/**
 * Waits until a backend in the test database is waiting on a lock. It polls
 * outside any transaction: pg_stat_activity is cached for a transaction's
 * duration, so a poll inside one would never see the change.
 */
async function waitForLockWait() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await testDb.pool.query<{ count: string }>(
      "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (Number(result.rows[0]?.count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no backend started waiting on a lock");
}

describeDb("backlog phases", () => {
  it("updates with optimistic concurrency", async () => {
    const id = await newPhase();
    const read = await findPhaseView(id);
    await run("save-phase", {
      id,
      updatedAt: read.updatedAt,
      title: "Renamed",
      description: "",
      sortOrder: 3,
    });
    expect(await findPhaseView(id)).toMatchObject({
      title: "Renamed",
      description: null,
      sortOrder: 3,
    });
    await expect(
      run("save-phase", {
        id,
        updatedAt: read.updatedAt,
        title: "Stale",
        description: null,
        sortOrder: 0,
      }),
    ).rejects.toThrow(TrackerConflictError);
    await expect(
      run("save-phase", { id: randomUUID(), title: "Missing", description: null, sortOrder: 0 }),
    ).rejects.toThrow(TrackerNotFoundError);
  });

  it("refuses to delete a phase that still has issues", async () => {
    const id = await newPhase();
    const issueNumber = await newIssue(id);
    await expect(run("delete-phase", { id })).rejects.toThrow(
      /still has 1 issue; move or delete them first/,
    );
    await run("delete-issue", { issueNumber });
    const read = await findPhaseView(id);
    await run("save-phase", { id, title: "Moved on", description: null, sortOrder: 0 });
    await expect(run("delete-phase", { id, updatedAt: read.updatedAt })).rejects.toThrow(
      TrackerConflictError,
    );
    await run("delete-phase", { id });
    await expect(run("delete-phase", { id })).rejects.toThrow(TrackerNotFoundError);
  });
});

describeDb("backlog issues", () => {
  it("gives a new issue the default steps unless it brings its own", async () => {
    const phaseId = await newPhase();
    const defaulted = await newIssue(phaseId);
    const view = await findIssueView(defaulted);
    expect(view.steps.map((step) => [step.key, step.label, step.sortOrder])).toEqual([
      ["plan", "Step 1 · Plan", 0],
      ["implement", "Step 2 · Implement + PR", 1],
    ]);
    expect(view.steps[0]?.prompt).toContain(
      `https://github.com/CuriouslyCory/hive-mind/issues/${defaulted}`,
    );

    const explicit = await newIssue(phaseId, {
      steps: [{ key: "only", label: "Only", prompt: " Prompt ", sortOrder: 0 }],
    });
    expect((await findIssueView(explicit)).steps).toMatchObject([
      { key: "only", prompt: "Prompt", completedAt: null },
    ]);
    const none = await newIssue(phaseId, { steps: [] });
    expect((await findIssueView(none)).steps).toEqual([]);
  });

  it("refuses to create a tracked issue or update an untracked one", async () => {
    const phaseId = await newPhase();
    const issueNumber = await newIssue(phaseId);
    await expect(newIssue(phaseId, { issueNumber })).rejects.toThrow(
      new TrackerRuleError(`Issue #${issueNumber} is already tracked.`),
    );
    await expect(
      newIssue(phaseId, { issueNumber: nextIssueNumber++, mode: "update" }),
    ).rejects.toThrow(/is not tracked/);
    await expect(newIssue(randomUUID())).rejects.toThrow(TrackerNotFoundError);
    await expect(
      newIssue(phaseId, {
        issueNumber,
        mode: "update",
        steps: [{ key: "a", label: "A", prompt: null, sortOrder: 0 }],
      }),
    ).rejects.toThrow(/steps: Only allowed with mode create/);
  });

  it("updates an issue with optimistic concurrency and can move it between phases", async () => {
    const phaseId = await newPhase();
    const otherPhaseId = await newPhase("Other");
    const issueNumber = await newIssue(phaseId);
    const read = await findIssueView(issueNumber);
    const update = {
      mode: "update" as const,
      issueNumber,
      title: "Moved",
      note: "Note",
      phaseId: otherPhaseId,
      sortOrder: 2,
      state: "open" as const,
      githubUpdatedAt: null,
    };
    await run("save-issue", { ...update, updatedAt: read.updatedAt });
    expect((await findPhaseView(otherPhaseId)).issues.map((issue) => issue.issueNumber)).toEqual([
      issueNumber,
    ]);
    await expect(run("save-issue", { ...update, updatedAt: read.updatedAt })).rejects.toThrow(
      TrackerConflictError,
    );
  });

  it("deletes an issue with its steps", async () => {
    const phaseId = await newPhase();
    const issueNumber = await newIssue(phaseId);
    const read = await findIssueView(issueNumber);
    await run("save-step", {
      issueNumber,
      key: "extra",
      label: "Extra",
      prompt: null,
      sortOrder: 2,
    });
    await expect(
      run("delete-issue", { issueNumber, updatedAt: "2020-01-01T00:00:00Z" }),
    ).rejects.toThrow(TrackerConflictError);
    expect(await run("delete-issue", { issueNumber, updatedAt: read.updatedAt })).toEqual({
      issueNumber,
    });
    const steps = await testDb.db
      .select()
      .from(trackerBacklogStep)
      .where(eq(trackerBacklogStep.issueId, read.id));
    expect(steps).toEqual([]);
    await expect(run("delete-issue", { issueNumber })).rejects.toThrow(TrackerNotFoundError);
  });
});

describeDb("backlog steps", () => {
  it("edits a step only through the issue it belongs to", async () => {
    const phaseId = await newPhase();
    const issueNumber = await newIssue(phaseId);
    const otherIssueNumber = await newIssue(phaseId);
    const [plan] = (await findIssueView(issueNumber)).steps;
    if (!plan) throw new Error("no plan step");
    const edit = { id: plan.id, key: "plan", label: "Plan it", prompt: "New", sortOrder: 0 };

    await expect(run("save-step", { ...edit, issueNumber: otherIssueNumber })).rejects.toThrow(
      new TrackerRuleError(`The step does not belong to issue #${otherIssueNumber}.`),
    );
    await expect(run("save-step", { ...edit, issueNumber, key: "implement" })).rejects.toThrow(
      /already has a step with key "implement"/,
    );
    await expect(
      run("save-step", { ...edit, issueNumber, id: undefined, key: "implement" }),
    ).rejects.toThrow(TrackerRuleError);
    await expect(run("save-step", { ...edit, issueNumber: 999_999 })).rejects.toThrow(
      TrackerNotFoundError,
    );
    await expect(run("save-step", { ...edit, issueNumber, id: randomUUID() })).rejects.toThrow(
      TrackerNotFoundError,
    );

    await run("save-step", { ...edit, issueNumber, updatedAt: plan.updatedAt });
    expect((await findIssueView(issueNumber)).steps[0]).toMatchObject({
      label: "Plan it",
      prompt: "New",
    });
    await expect(
      run("save-step", { ...edit, issueNumber, updatedAt: plan.updatedAt }),
    ).rejects.toThrow(TrackerConflictError);

    const { id } = await run("save-step", {
      issueNumber,
      key: "review",
      label: "Review",
      prompt: null,
      sortOrder: 5,
    });
    await expect(run("delete-step", { id, updatedAt: plan.updatedAt })).rejects.toThrow(
      TrackerConflictError,
    );
    await run("delete-step", { id });
    await expect(run("delete-step", { id })).rejects.toThrow(TrackerNotFoundError);
  });

  it("refuses a step key that another writer commits after the check", async () => {
    const phaseId = await newPhase();
    const issueNumber = await newIssue(phaseId);
    const issue = await findIssueView(issueNumber);
    const [plan] = issue.steps;
    if (!plan) throw new Error("no plan step");
    const duplicate = (key: string) =>
      new TrackerRuleError(`Issue #${issueNumber} already has a step with key "${key}".`);

    for (const [key, save] of [
      // A new step: the insert waits on the other writer's uncommitted row.
      [
        "raced-insert",
        () =>
          run("save-step", {
            issueNumber,
            key: "raced-insert",
            label: "L",
            prompt: null,
            sortOrder: 3,
          }),
      ],
      // A renamed step: the update fails the unique constraint once it commits.
      [
        "raced-rename",
        () =>
          run("save-step", {
            id: plan.id,
            issueNumber,
            key: "raced-rename",
            label: plan.label,
            prompt: plan.prompt,
            sortOrder: plan.sortOrder,
          }),
      ],
    ] as const) {
      const writer = await testDb.pool.connect();
      try {
        await writer.query("begin");
        await writer.query(
          "insert into tracker_backlog_step (issue_id, key, label) values ($1, $2, 'Other')",
          [issue.id, key],
        );
        const saved = save();
        saved.catch(() => {});
        await waitForLockWait();
        await writer.query("commit");
        await expect(saved).rejects.toThrow(duplicate(key));
      } finally {
        writer.release();
      }
    }
    // Only the other writer's rows were added, and the renamed step kept its key.
    expect((await findIssueView(issueNumber)).steps.map((step) => step.key).sort()).toEqual([
      "implement",
      "plan",
      "raced-insert",
      "raced-rename",
    ]);
  });

  it("sets and clears completion, keeping the first completion time", async () => {
    const phaseId = await newPhase();
    const issueNumber = await newIssue(phaseId);
    const [step] = (await findIssueView(issueNumber)).steps;
    if (!step) throw new Error("no step");

    const done = await run("set-step-complete", { id: step.id, complete: true });
    expect(done.completedAt).toEqual(expect.any(String));
    const updatedAt = (await findIssueView(issueNumber)).steps[0]?.updatedAt;
    expect(await run("set-step-complete", { id: step.id, complete: true })).toEqual(done);
    // Repeating it changed nothing, so an edit from the earlier read still applies.
    expect((await findIssueView(issueNumber)).steps[0]?.updatedAt).toBe(updatedAt);

    expect(await run("set-step-complete", { id: step.id, complete: false })).toEqual({
      id: step.id,
      completedAt: null,
    });
    await expect(run("set-step-complete", { id: randomUUID(), complete: true })).rejects.toThrow(
      TrackerNotFoundError,
    );
  });
});

describeDb("scans", () => {
  it("needs a SHA for a Git history scan and refuses one for a backlog scan", async () => {
    const throughAt = "2026-09-01T00:00:00Z";
    await expect(
      run("record-scan", { kind: "git_history", throughAt, throughSha: null, note: null }),
    ).rejects.toThrow(/needs throughSha/);
    await expect(
      run("record-scan", { kind: "backlog", throughAt, throughSha: SHA, note: null }),
    ).rejects.toThrow(/has no throughSha/);
    for (const throughSha of [SHA.toUpperCase(), SHA.slice(0, 7)]) {
      await expect(
        run("record-scan", { kind: "git_history", throughAt, throughSha, note: null }),
      ).rejects.toThrow(/throughSha: Expected a full 40-character lowercase commit SHA/);
    }
  });

  it("refuses a cursor more than five minutes ahead and records completion as now", async () => {
    const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    await expect(
      run("record-scan", {
        kind: "git_history",
        throughAt: ahead(10),
        throughSha: SHA,
        note: null,
      }),
    ).rejects.toThrow(/in the future/);
    await run("record-scan", {
      kind: "git_history",
      throughAt: ahead(1),
      throughSha: SHA,
      note: null,
    });

    const before = Date.now();
    await run("record-scan", {
      kind: "git_history",
      throughAt: "2026-01-01T00:00:00-05:00",
      throughSha: SHA,
      note: " Reviewed through #20 ",
    });
    const scan = await getLatestScan(testDb.db, "git_history");
    expect(scan).toMatchObject({
      throughAt: "2026-01-01T05:00:00.000Z",
      throughSha: SHA,
      note: "Reviewed through #20",
    });
    expect(Date.parse(scan?.completedAt ?? "")).toBeGreaterThanOrEqual(before - 1_000);
  });
});

describeDb("batches", () => {
  async function phaseTitled(title: string) {
    return testDb.db.select().from(trackerBacklogPhase).where(eq(trackerBacklogPhase.title, title));
  }

  it("runs every command in one transaction and returns their results", async () => {
    const phaseId = await newPhase();
    const issueNumber = nextIssueNumber++;
    const results = await runTrackerBatch(testDb.db, [
      { command: "save-phase", input: { title: "Batch ok", description: null, sortOrder: 0 } },
      {
        command: "save-issue",
        input: {
          mode: "create",
          issueNumber,
          title: "Batched",
          note: null,
          phaseId,
          sortOrder: 0,
          state: "open",
          githubUpdatedAt: null,
        },
      },
      { command: "delete-issue", input: { issueNumber } },
    ]);
    expect(results).toEqual([
      { id: expect.any(String) },
      { id: expect.any(String) },
      { issueNumber },
    ]);
    expect(await phaseTitled("Batch ok")).toHaveLength(1);
  });

  it("writes nothing when a later command fails, and names its index", async () => {
    await expect(
      runTrackerBatch(testDb.db, [
        { command: "save-phase", input: { title: "Rolled back", description: null, sortOrder: 0 } },
        { command: "save-phase", input: { title: "", description: null, sortOrder: 0 } },
      ]),
    ).rejects.toThrow(
      expect.objectContaining({
        name: "TrackerInputError",
        message: expect.stringMatching(/^Batch command 1 \(save-phase\): Invalid input: title:/),
      }),
    );
    await expect(
      runTrackerBatch(testDb.db, [
        { command: "save-phase", input: { title: "Rolled back", description: null, sortOrder: 0 } },
        { command: "delete-issue", input: { issueNumber: 999_998 } },
      ]),
    ).rejects.toThrow(/^Batch command 1 \(delete-issue\): Issue #999998 is not tracked\.$/);
    expect(await phaseTitled("Rolled back")).toEqual([]);
  });

  it("validates the batch itself", async () => {
    await expect(runTrackerBatch(testDb.db, [])).rejects.toThrow(TrackerInputError);
    await expect(runTrackerBatch(testDb.db, [{ command: "snapshot", input: {} }])).rejects.toThrow(
      /0\.command:/,
    );
  });
});

describeDb("input validation", () => {
  it("reports every failing field path as a TrackerInputError", async () => {
    const error = await run("save-changelog-entry", {
      date: "2026-13-01",
      category: "",
      title: "x".repeat(251),
      summary: "Summary",
      prNumbers: [0],
      extra: true,
    } as TrackerCommandInput<"save-changelog-entry">).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrackerInputError);
    const message = (error as Error).message;
    for (const path of [
      "date:",
      "category:",
      "title:",
      "prNumbers.0:",
      "(input): Unrecognized key",
    ]) {
      expect(message).toContain(path);
    }
  });

  it("refuses NUL in text as an input error, not a database error", async () => {
    const input = { title: "Phase\u0000", description: "Notes\u0000", sortOrder: 0 };
    const error = await run("save-phase", input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrackerInputError);
    expect((error as Error).message).toContain("title: Must not contain NUL");
    expect((error as Error).message).toContain("description: Must not contain NUL");
  });

  it("refuses issue and PR numbers beyond a Postgres integer", async () => {
    const tooLarge = 2_147_483_648;
    await expect(run("delete-issue", { issueNumber: tooLarge })).rejects.toThrow(
      /^Invalid input: issueNumber:/,
    );
    await expect(
      run("save-changelog-entry", {
        date: "2026-09-01",
        category: "Fix",
        title: "Title",
        summary: "Summary",
        prNumbers: [1, tooLarge],
      }),
    ).rejects.toThrow(/^Invalid input: prNumbers\.1:/);
    // The largest integer is still accepted.
    await expect(run("delete-issue", { issueNumber: tooLarge - 1 })).rejects.toThrow(
      TrackerNotFoundError,
    );
  });

  it("refuses updatedAt on a create", async () => {
    const updatedAt = new Date().toISOString();
    const phaseId = await newPhase();
    const issueNumber = await newIssue(phaseId);
    for (const [name, input] of [
      [
        "save-changelog-entry",
        { date: "2026-09-01", category: "Fix", title: "T", summary: "S", prNumbers: [] },
      ],
      ["save-phase", { title: "T", description: null, sortOrder: 0 }],
      ["save-step", { issueNumber, key: "k", label: "L", prompt: null, sortOrder: 0 }],
      ["save-blog-idea", blogIdea],
    ] as const) {
      await expect(runTrackerCommand(testDb.db, name, { ...input, updatedAt })).rejects.toThrow(
        new TrackerInputError("Invalid input: updatedAt: Only allowed with id"),
      );
    }
  });

  it("refuses unknown commands and malformed ids", async () => {
    await expect(
      runTrackerCommand(testDb.db, "drop-everything" as TrackerCommandName, {}),
    ).rejects.toThrow(new TrackerInputError('Unknown command: "drop-everything"'));
    await expect(run("delete-step", { id: "not-a-uuid" })).rejects.toThrow(/^Invalid input: id:/);
    await expect(run("delete-step", { id: randomUUID(), updatedAt: "yesterday" })).rejects.toThrow(
      /updatedAt:/,
    );
  });
});

describe("TrackerError kinds", () => {
  it("names each kind", () => {
    expect(new TrackerInputError("x").kind).toBe("input");
    expect(new TrackerConflictError("x").kind).toBe("conflict");
    expect(new TrackerNotFoundError("x").kind).toBe("not_found");
    expect(new TrackerRuleError("x")).toMatchObject({ kind: "rule", name: "TrackerRuleError" });
  });
});
