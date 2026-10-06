import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAdrNumber } from "@hivemind/contract";
import { expect, type Page, test } from "@playwright/test";
import type { TestHelpers } from "better-auth/plugins";
import pg from "pg";
import { type CliCall, cliRunner, describe, okData } from "./cli-runner";
import { E2E_BASE_URL, e2eDatabaseUrl } from "./e2e-env";
import { type FieldAddingProxy, startFieldAddingProxy } from "./field-adding-proxy";
import {
  coordinationApi,
  expectInert,
  expectNotReloaded,
  HOSTILE,
  openLive,
  personalOrganizationId,
  signedInPage,
  testUsers,
  watchDialogs,
} from "./support";

// ADR reservations and ADR sync with the compiled CLI (issue #19, step 10): a
// repository whose origin holds three ADRs is synced; two linked worktrees
// reserve numbers at once; one supersedes an ADR, both merge, and a sync
// copies the result. The open dashboard pages follow every step without a
// reload. Agent A uses a login session token; agent B uses a Project key
// through a proxy that adds unknown fields to every JSON answer (ADR-0009).
// The device flow is covered by cli-flow and coordination-flow.

/** Built by `pnpm --filter @hivemind/cli build` (turbo runs it before test:e2e). */
const CLI_BINARY = fileURLToPath(new URL("../../../cli/dist/hivemind", import.meta.url));

/** The first `next dev` compile of a route can take tens of seconds. */
const ADR_LIVE = { timeout: 30_000 };

interface AdrNewData {
  adr: { number: number; state: string; reservation: { title: string; slug: string } | null };
  created: boolean;
  file: { path: string; status: string };
}
interface AdrChange {
  number: number;
  change: string;
  path: string;
  statusFrom: string | null;
  statusTo: string | null;
}
interface AdrSyncData {
  outcome: string;
  ref: string | null;
  commitSha: string | null;
  baseCommitSha: string | null;
  forced: boolean;
  fileCount: number;
  uploadedFileCount: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  changes: AdrChange[];
}

let pool: pg.Pool;
let users: TestHelpers;
let sandbox: string;
let home: string;
let proxy: FieldAddingProxy;
let runner: ReturnType<typeof cliRunner>;

test.beforeAll(async () => {
  if (!existsSync(CLI_BINARY)) {
    throw new Error(`${CLI_BINARY} is missing; run 'pnpm --filter @hivemind/cli build' first.`);
  }
  pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 2 });
  users = await testUsers(pool);
  proxy = await startFieldAddingProxy(E2E_BASE_URL);
  sandbox = mkdtempSync(join(tmpdir(), "hivemind-adr-e2e-"));
  home = join(sandbox, "home");
  mkdirSync(home);
  runner = cliRunner(CLI_BINARY, {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
});

test.afterAll(async () => {
  await pool?.end();
  await proxy?.close();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Runs git with only the sandbox's environment: no developer config (signing,
 * hooks), no inherited GIT_DIR, and a fixed author and committer.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
    encoding: "utf8",
  }).trim();
}

/** An ADR file in ADR-0001's format, with every section. */
function adrFile(status: string, title: string): string {
  return [
    "---",
    `status: ${status}`,
    "date: 2026-01-15",
    "---",
    "",
    `# ${title}`,
    "",
    "## Context",
    "",
    "Why a decision is needed. Link #1.",
    "",
    "## Decision",
    "",
    `We decided: ${title.toLowerCase()}.`,
    "",
    "## Consequences",
    "",
    "What becomes easier or harder.",
    "",
    "## Alternatives considered",
    "",
    "None worth recording.",
    "",
  ].join("\n");
}

/**
 * The element with `testId` on the page the browser shows. Next keeps a page
 * left by a client navigation in a hidden React Activity, so the DOM can hold
 * a second, hidden ADR page.
 */
function shown(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true });
}

function rowOf(page: Page, number: number) {
  return shown(page, "adr-list").locator(`[data-testid="adr-row"][data-adr-number="${number}"]`);
}

test("two worktrees reserve, supersede, merge and sync ADRs while the dashboard follows live", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { run } = runner;

  // --- Setup: a User, a Project, a login session token for A and a Project
  // key for B; an origin with three ADRs, a clone and two linked worktrees.
  const { user, context, page } = await signedInPage(browser, users);
  const api = await coordinationApi(users, user.id);
  const organizationId = await personalOrganizationId(pool, user.id);
  const project = await api.createProject(organizationId, "ADR e2e");
  const { token: tokenA } = await users.login({ userId: user.id });
  const { secret: secretB } = await api.call<{ secret: string }>(
    "POST",
    `/projects/${project.id}/keys`,
    { name: "adr-b" },
  );

  // Each run gets its own directory, so a repeated run starts from scratch.
  const root = mkdtempSync(join(sandbox, "run-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const repo = join(root, "repo");
  const worktreeA = join(root, "wt-a");
  const worktreeB = join(root, "wt-b");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(
    join(seed, ".hivemind.json"),
    `${JSON.stringify({ version: 1, projectId: project.id })}\n`,
  );
  mkdirSync(join(seed, "docs", "adr"), { recursive: true });
  const seeded: [string, string, string][] = [
    ["0001-use-postgres.md", "accepted", "Use Postgres"],
    ["0002-use-sse.md", "accepted", "Use SSE"],
    ["0003-cache-in-memory.md", "proposed", "Cache in memory"],
  ];
  for (const [fileName, status, title] of seeded) {
    writeFileSync(join(seed, "docs", "adr", fileName), adrFile(status, title));
  }
  git(seed, "add", ".hivemind.json", "docs/adr");
  git(seed, "commit", "-q", "-m", "Bind to hive-mind and record three ADRs");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, repo);
  expect(git(repo, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
  git(repo, "worktree", "add", "-q", "-b", "adr-a", worktreeA, "origin/main");
  git(repo, "worktree", "add", "-q", "-b", "adr-b", worktreeB, "origin/main");

  const a: CliCall = { cwd: worktreeA, server: E2E_BASE_URL, env: { HIVEMIND_TOKEN: tokenA } };
  const b: CliCall = { cwd: worktreeB, server: proxy.origin, env: { HIVEMIND_TOKEN: secretB } };
  const inRepo = (agent: CliCall): CliCall => ({ ...agent, cwd: repo });
  const listPath = `/projects/${project.id}/adrs`;
  const list = shown(page, "adr-list");
  const reservations = shown(page, "adr-reservations");
  const banner = shown(page, "adr-sync-banner");

  // --- 1. The first sync copies origin's default branch, attributed to the User.
  const firstSha = git(repo, "rev-parse", "origin/HEAD");
  await test.step("sync the default branch", async () => {
    const synced = okData<AdrSyncData>(await run(["adr", "sync", "--json"], inRepo(a)));
    expect(synced).toMatchObject({
      outcome: "synced",
      ref: "refs/remotes/origin/HEAD",
      commitSha: firstSha,
      baseCommitSha: null,
      forced: false,
      fileCount: 3,
      uploadedFileCount: 3,
      added: 3,
      updated: 0,
      removed: 0,
      unchanged: 0,
    });
    expect(synced.changes.map((change) => [change.number, change.change]).sort()).toEqual([
      [1, "added"],
      [2, "added"],
      [3, "added"],
    ]);

    await openLive(page, listPath);
    await expect(list.getByTestId("adr-row")).toHaveCount(3);
    for (const [number, status] of [
      [1, "accepted"],
      [2, "accepted"],
      [3, "proposed"],
    ] as const) {
      await expect(rowOf(page, number)).toHaveAttribute("data-adr-status", status);
      await expect(rowOf(page, number)).toHaveAttribute("data-adr-state", "published");
    }
    await expect(banner).toContainText(`commit ${firstSha.slice(0, 7)}`);
    await expect(banner).toContainText(user.name);
    await expect(reservations).toContainText("No reserved numbers are waiting.");
  });

  // --- 2. Both worktrees reserve a number at once: distinct numbers, each
  // file written only in its own worktree, and the open list shows both.
  let numberA = 0;
  let numberB = 0;
  let fileA = "";
  await test.step("reserve numbers concurrently from two worktrees", async () => {
    const [newA, newB] = await Promise.all([
      run(["adr", "new", "--title", "Use queues", "--json"], a),
      run(["adr", "new", "--title", "Use caches", "--json"], b),
    ]);
    const reservedA = okData<AdrNewData>(newA);
    const reservedB = okData<AdrNewData>(newB);
    numberA = reservedA.adr.number;
    numberB = reservedB.adr.number;
    // The floor is the three existing files, so the counter starts at 4.
    expect([numberA, numberB].sort()).toEqual([4, 5]);
    for (const [reserved, number, slug] of [
      [reservedA, numberA, "use-queues"],
      [reservedB, numberB, "use-caches"],
    ] as const) {
      expect(reserved).toMatchObject({
        created: true,
        adr: { number, state: "reserved", reservation: { slug } },
        file: { path: `docs/adr/${String(number).padStart(4, "0")}-${slug}.md`, status: "created" },
      });
    }
    fileA = reservedA.file.path;
    const fileB = reservedB.file.path;
    expect(existsSync(join(worktreeA, fileA))).toBe(true);
    expect(existsSync(join(worktreeB, fileA))).toBe(false);
    expect(existsSync(join(worktreeB, fileB))).toBe(true);
    expect(existsSync(join(worktreeA, fileB))).toBe(false);
    for (const [path, title] of [
      [join(worktreeA, fileA), "Use queues"],
      [join(worktreeB, fileB), "Use caches"],
    ] as const) {
      const text = readFileSync(path, "utf8");
      expect(text).toContain("status: proposed");
      // The binary uses the system date, which this test does not pin.
      expect(text).toMatch(/^date: \d{4}-\d{2}-\d{2}$/m);
      expect(text).toContain(`# ${title}\n`);
    }

    // The CLI lists both reservations, through the field-adding proxy.
    const reserved = okData<{
      items: { number: number; state: string }[];
      lastSync: { commitSha: string } | null;
    }>(await run(["adr", "list", "--state", "reserved", "--json"], b));
    expect(reserved.items.map((item) => item.number)).toEqual([5, 4]);
    expect(reserved.lastSync?.commitSha).toBe(firstSha);

    // The open list shows both under "Reserved", with who reserved them.
    const rowA = reservations.locator(
      `[data-testid="adr-reservation"][data-adr-number="${numberA}"]`,
    );
    const rowB = reservations.locator(
      `[data-testid="adr-reservation"][data-adr-number="${numberB}"]`,
    );
    await expect(rowA).toContainText("Use queues", ADR_LIVE);
    await expect(rowB).toContainText("Use caches", ADR_LIVE);
    await expect(rowA).toContainText(user.name);
    await expect(rowA).toContainText("adr-a");
    await expect(rowB).toContainText("Project key adr-b");
    await expect(rowB).toContainText("adr-b");
    await expect(list.getByTestId("adr-row")).toHaveCount(3);
    await expectNotReloaded(page);
  });

  // --- 3. A supersedes ADR-0003 with its new ADR; both branches merge to
  // origin's main; B syncs the merged commit.
  const nameA = formatAdrNumber(numberA);
  const nameB = formatAdrNumber(numberB);
  const detailPage = await context.newPage();
  const overviewPage = await context.newPage();
  const dialogs = watchDialogs(detailPage);
  let secondSha = "";
  await test.step("supersede, merge and sync", async () => {
    const pathA = join(worktreeA, fileA);
    const template = readFileSync(pathA, "utf8");
    expect(template).toContain("What was decided.");
    writeFileSync(
      pathA,
      template.replace(
        "What was decided.",
        [
          "Queues replace the in-memory cache.",
          "",
          HOSTILE.markdown,
          "",
          "See [first](0001-use-postgres.md) for the database.",
        ].join("\n"),
      ),
    );
    const superseded = await run(["adr", "supersede", "3", "--by", String(numberA)], a);
    expect(superseded.status, describe(superseded)).toBe(0);
    expect(superseded.stdout).toContain(
      `ADR-0003 is now superseded by ${nameA}. Commit both files, merge them, then run 'hivemind adr sync'.`,
    );
    expect(readFileSync(join(worktreeA, "docs/adr/0003-cache-in-memory.md"), "utf8")).toContain(
      "status: superseded",
    );
    expect(readFileSync(pathA, "utf8")).toContain("supersedes: [3]");

    git(worktreeA, "add", "docs/adr");
    git(worktreeA, "commit", "-q", "-m", `Supersede ADR-0003 with ${nameA}`);
    git(worktreeA, "push", "-q", "origin", "adr-a:main");
    git(worktreeB, "add", "docs/adr");
    git(worktreeB, "commit", "-q", "-m", `Record ${nameB}`);
    git(worktreeB, "fetch", "-q", "origin");
    git(worktreeB, "rebase", "-q", "origin/main");
    git(worktreeB, "push", "-q", "origin", "adr-b:main");

    // Open before the sync, so they must change live.
    await openLive(detailPage, `${listPath}/3`);
    await openLive(overviewPage, `/projects/${project.id}`);
    await expect(shown(detailPage, "adr-detail")).toContainText(
      "This ADR supersedes no other ADR, and no ADR supersedes it.",
    );

    git(repo, "fetch", "-q", "origin");
    secondSha = git(repo, "rev-parse", "origin/HEAD");
    const synced = okData<AdrSyncData>(await run(["adr", "sync", "--json"], inRepo(b)));
    expect(synced).toMatchObject({
      outcome: "synced",
      commitSha: secondSha,
      baseCommitSha: firstSha,
      fileCount: 5,
      uploadedFileCount: 3,
      added: 2,
      updated: 1,
      removed: 0,
      unchanged: 2,
    });
    expect(synced.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 3,
          change: "updated",
          statusFrom: "proposed",
          statusTo: "superseded",
        }),
        expect.objectContaining({ number: numberA, change: "added", statusTo: "proposed" }),
        expect.objectContaining({ number: numberB, change: "added", statusTo: "proposed" }),
      ]),
    );
    expect(synced.changes).toHaveLength(3);
  });

  // --- 4. Every open page shows the sync without a reload.
  await test.step("the open pages follow the sync", async () => {
    await expect(rowOf(page, 3)).toHaveAttribute("data-adr-status", "superseded", ADR_LIVE);
    for (const number of [numberA, numberB]) {
      await expect(rowOf(page, number)).toHaveAttribute("data-adr-status", "proposed", ADR_LIVE);
      await expect(rowOf(page, number)).toHaveAttribute("data-adr-state", "published");
    }
    await expect(list.getByTestId("adr-row")).toHaveCount(5);
    await expect(reservations.getByTestId("adr-reservation")).toHaveCount(0);
    await expect(reservations).toContainText("No reserved numbers are waiting.");
    await expect(banner).toContainText(`commit ${secondSha.slice(0, 7)}`);
    await expect(banner).toContainText("Project key adr-b");

    const detail = shown(detailPage, "adr-detail");
    await expect(detail).toContainText(`Superseded by ${nameA}`, ADR_LIVE);
    await expect(detail.getByRole("link", { name: nameA, exact: true })).toBeVisible();

    const recent = shown(overviewPage, "recent-adrs");
    await expect(recent).toContainText(`${nameA}: Use queues`, ADR_LIVE);
    await expect(recent).toContainText(`${nameB}: Use caches`);

    for (const open of [page, detailPage, overviewPage]) await expectNotReloaded(open);
  });

  await test.step("filter the list by status", async () => {
    await page.getByRole("link", { name: "Superseded", exact: true }).click();
    await expect(page).toHaveURL(/\?status=superseded$/);
    await expect(list.getByTestId("adr-row")).toHaveCount(1);
    await expect(rowOf(page, 3)).toBeVisible();
    await expect(list.locator('strong[aria-current="page"]')).toHaveText("Superseded");

    await page.getByRole("link", { name: "Proposed", exact: true }).click();
    await expect(page).toHaveURL(/\?status=proposed$/);
    await expect(list.getByTestId("adr-row")).toHaveCount(2);
    await expect(rowOf(page, numberA)).toBeVisible();
    await expect(rowOf(page, numberB)).toBeVisible();
    await expectNotReloaded(page);
  });

  await test.step("follow the supersedes chain; the ADR text stays inert", async () => {
    const detail = shown(detailPage, "adr-detail");
    await detail.getByRole("link", { name: nameA, exact: true }).click();
    await expect(detailPage).toHaveURL(`${listPath}/${numberA}`);
    await expect(detail.getByRole("heading", { level: 1 })).toHaveText(`${nameA}: Use queues`);
    await expect(detail).toContainText("Supersedes ADR-0003");
    await expect(detail.getByRole("link", { name: "ADR-0003", exact: true })).toBeVisible();
    // Markdown renders; a relative link is text, not a link.
    await expect(detail.locator("strong", { hasText: "safe bold" })).toBeVisible();
    await expect(detail.getByRole("link", { name: "safe link" })).toHaveAttribute(
      "href",
      "https://example.com/docs",
    );
    await expect(detail).toContainText("See first for the database.");
    await expect(detail.getByRole("link", { name: "first", exact: true })).toHaveCount(0);
    await expectInert(detail);
    expect(dialogs).toEqual([]);
    await expectNotReloaded(detailPage);
  });

  // --- 5. A list page hidden by a client navigation shows a sync that
  // happened meanwhile when Back reveals it (AGENTS.md: restored data must be
  // refreshed).
  await test.step("Back shows the list refreshed after a sync while it was hidden", async () => {
    await page.getByRole("link", { name: "All", exact: true }).click();
    await expect(page).toHaveURL(listPath);
    await expect(list.getByTestId("adr-row")).toHaveCount(5);
    await rowOf(page, 1).getByRole("link", { name: "ADR-0001", exact: true }).click();
    await expect(page).toHaveURL(`${listPath}/1`);
    const detail = shown(page, "adr-detail");
    await expect(detail.getByRole("heading", { level: 1 })).toHaveText("ADR-0001: Use Postgres");

    git(repo, "pull", "-q", "--ff-only");
    const deprecated = okData<{ number: number; status: string; previousStatus: string }>(
      await run(["adr", "status", "1", "deprecated", "--json"], inRepo(a)),
    );
    expect(deprecated).toMatchObject({
      number: 1,
      status: "deprecated",
      previousStatus: "accepted",
      changed: true,
    });
    git(repo, "commit", "-q", "-am", "Deprecate ADR-0001");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "fetch", "-q", "origin");
    const thirdSha = git(repo, "rev-parse", "origin/HEAD");
    const synced = okData<AdrSyncData>(await run(["adr", "sync", "--json"], inRepo(b)));
    expect(synced).toMatchObject({ outcome: "synced", commitSha: thirdSha, updated: 1 });
    expect(synced.changes).toEqual([
      expect.objectContaining({
        number: 1,
        change: "updated",
        statusFrom: "accepted",
        statusTo: "deprecated",
      }),
    ]);
    // The shown page follows the sync first, so its Event has arrived.
    await expect(detail).toContainText("Deprecated", ADR_LIVE);

    await page.goBack();
    await expect(page).toHaveURL(listPath);
    await expect(rowOf(page, 1)).toHaveAttribute("data-adr-status", "deprecated", ADR_LIVE);
    await expect(banner).toContainText(`commit ${thirdSha.slice(0, 7)}`);
    await expectNotReloaded(page);
  });

  // --- 6. A Project with no sync says so, on the overview and the list.
  await test.step("a Project that was never synced", async () => {
    const unsynced = await api.createProject(organizationId, "ADR e2e unsynced");
    await overviewPage.goto(`/projects/${unsynced.id}`);
    const recent = shown(overviewPage, "recent-adrs");
    await expect(recent).toContainText("No ADRs synced yet.");
    await recent.getByRole("link", { name: "All ADRs" }).click();
    await expect(overviewPage).toHaveURL(`/projects/${unsynced.id}/adrs`);
    await expect(shown(overviewPage, "adr-sync-banner")).toHaveText(
      "No ADRs synced yet. Run hivemind adr sync on the default branch.",
    );
    await expect(shown(overviewPage, "adr-list")).toContainText("No ADRs yet.");
    await expect(shown(overviewPage, "adr-reservations")).toContainText(
      "No reserved numbers are waiting.",
    );
  });

  // --- B's commands all went through the field-adding proxy, and no
  // credential was printed or passed as an argument.
  expect(proxy.changedAnswers()).toBeGreaterThan(0);
  for (const entry of runner.transcript) {
    const text = `${entry.argv.join(" ")}\n${entry.stdout}\n${entry.stderr}`;
    expect(text).not.toContain(tokenA);
    expect(text).not.toContain(secretB);
  }
});
