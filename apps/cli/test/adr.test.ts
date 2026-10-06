import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  anyCliEnvelopeSchema,
  exitCodeForEnvelope,
  MAX_ADR_FILE_BYTES,
  MAX_ADR_UPLOAD_BODY_BYTES,
  parseAdrContent,
  renderAdrTemplate,
  rewriteAdrFrontmatter,
} from "@hivemind/contract";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCredentialManager } from "../src/credentials/manager.ts";
import { commandHarness, FAKE_TODAY, fakeClock } from "./helpers/commands.ts";
import {
  type FakeBackend,
  type FakeProject,
  ORG_A,
  startFakeBackend,
  USER_TOKEN,
} from "./helpers/fake-backend.ts";
import { adrText, type GitRepos, gitFixture } from "./helpers/git-fixture.ts";
import { expectGolden } from "./helpers/golden.ts";

/**
 * `hivemind adr new/list/show/status/supersede/sync` in-process, against the
 * fake backend and real git repositories with a bare origin (issue #19 step
 * 8). The crash between `adr supersede`'s renames is injected in
 * adr-supersede-crash.test.ts.
 */

const harness = commandHarness();
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "hivemind-adr-")));
const fixture = gitFixture(scratch);
afterAll(() => {
  harness.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const ENV = { PATH: process.env.PATH, HOME: scratch };

let api: FakeBackend;
let project: FakeProject;
beforeEach(async () => {
  api = await startFakeBackend();
  await createCredentialManager({ env: {}, interactive: false, file: harness.file }).save(
    api.origin,
    USER_TOKEN,
  );
  project = api.addProject(ORG_A.id, "adr");
});
afterEach(async () => {
  await api.close();
});

type RunOptions = Parameters<typeof harness.run>[1] & { cwd: string };

function run(argv: string[], options: RunOptions) {
  return harness.run([...argv, "--server", api.origin], { env: ENV, ...options });
}

async function json(argv: string[], options: RunOptions) {
  const result = await run([...argv, "--json"], options);
  const lines = result.stdout.split("\n");
  expect(lines, result.stdout + result.stderr).toHaveLength(2);
  const envelope = anyCliEnvelopeSchema.parse(JSON.parse(lines[0] as string));
  expect(result.code).toBe(exitCodeForEnvelope(envelope));
  const data = (envelope.ok ? envelope.data : undefined) as Record<string, unknown> | undefined;
  const error = envelope.ok ? undefined : envelope.error;
  return { ...result, envelope, data, error };
}

const adrRequests = () => api.requests.filter((request) => request.url.includes("/adrs"));
const posts = (suffix: string) =>
  api.requests.filter(
    (request) =>
      request.method === "POST" && new URL(request.url, "http://x").pathname.endsWith(suffix),
  );
const bodyOf = (request: { body: string } | undefined) =>
  JSON.parse(request?.body ?? "{}") as Record<string, unknown>;

function template(title: string, date = FAKE_TODAY): string {
  const rendered = renderAdrTemplate({ title, date });
  if (!rendered.ok) throw new Error("bad template");
  return rendered.contents;
}

const THREE = {
  "docs/adr/0001-a.md": adrText("A"),
  "docs/adr/0002-b.md": adrText("B"),
  "docs/adr/0003-c.md": adrText("C", { status: "proposed" }),
};

function repo(files: Record<string, string> = THREE, dir?: string): GitRepos {
  return fixture.origin(files, { projectId: project.id, ...(dir === undefined ? {} : { dir }) });
}

/** A git repository with no `.hivemind.json` and no origin: what local-only commands get in an unbound repo. */
function unboundRepo(files: Record<string, string>): string {
  const dir = join(scratch, `unbound-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  fixture.git(dir, "init", "-q", "-b", "main");
  fixture.write(dir, files);
  return dir;
}

const read = (path: string) => readFileSync(path, "utf8");

// ---------------------------------------------------------------------------

describe("adr new", () => {
  it("reserves first, then writes the template beside .hivemind.json", async () => {
    const repos = repo();
    const nested = join(repos.work, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const created = await json(["adr", "new", "--title", "Use queues"], { cwd: nested });
    expect(created.code, created.stderr).toBe(0);
    expectGolden(created.envelope, "cli.adr-new.json");
    expect(bodyOf(posts("/adrs").at(-1))).toMatchObject({
      floor: 3,
      title: "Use queues",
      slug: "use-queues",
      gitBranch: "main",
    });
    expect(created.data).toMatchObject({
      created: true,
      adr: { number: 4, state: "reserved" },
      file: { path: "docs/adr/0004-use-queues.md", status: "created" },
    });
    expect(read(join(repos.work, "docs/adr/0004-use-queues.md"))).toBe(template("Use queues"));

    const human = await run(["adr", "new", "--title", "Second one"], { cwd: nested });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toBe("../../docs/adr/0005-second-one.md\n");
    expect(human.stderr).toMatch(/^Reserved ADR-0005 \([0-9a-f-]{36}\)\.\n$/);
  });

  it("sends a floor from the working tree and from the default branch", async () => {
    const repos = repo({ "docs/adr/0001-a.md": adrText("A") });
    fixture.write(repos.work, { "docs/adr/0007-local.md": "untracked\n" });
    await json(["adr", "new", "--title", "Seven"], { cwd: repos.work });
    expect(bodyOf(posts("/adrs").at(-1)).floor).toBe(7);

    // The default branch has 0003; this clone's main does not.
    const other = repo({ "docs/adr/0001-a.md": adrText("A"), "docs/adr/0002-b.md": adrText("B") });
    fixture.commit(other.seed, { "docs/adr/0003-c.md": adrText("C") });
    fixture.git(other.seed, "push", "-q", "origin", "main");
    fixture.git(other.work, "fetch", "-q", "origin");
    await json(["adr", "new", "--title", "Three"], { cwd: other.work });
    expect(bodyOf(posts("/adrs").at(-1)).floor).toBe(3);
  });

  it("attributes the reservation to HIVEMIND_SESSION", async () => {
    const repos = repo();
    const sessionId = randomUUID();
    await json(["adr", "new", "--title", "Sessioned"], {
      cwd: repos.work,
      env: { ...ENV, HIVEMIND_SESSION: sessionId },
    });
    expect(bodyOf(posts("/adrs").at(-1)).sessionId).toBe(sessionId);
  });

  it("replays with --id: the same number, the file left as it is, nothing new reserved", async () => {
    const repos = repo();
    const first = await json(["adr", "new", "--title", "Once"], { cwd: repos.work });
    const adrId = String(bodyOf(posts("/adrs").at(-1)).adrId);
    const path = join(repos.work, "docs/adr/0004-once.md");
    const bytes = read(path);
    const replay = await json(["adr", "new", "--title", "Once", "--id", adrId], {
      cwd: repos.work,
    });
    expect(replay.code, replay.stderr).toBe(0);
    expect(replay.data).toMatchObject({
      created: false,
      adr: { number: 4 },
      file: { status: "unchanged" },
    });
    expect(replay.stderr).toContain(`Found existing reservation ADR-0004 (${adrId}).`);
    expect(first.data).toMatchObject({ adr: { number: 4 } });
    expect(read(path)).toBe(bytes);
    const next = await json(["adr", "new", "--title", "Next"], { cwd: repos.work });
    expect(next.data).toMatchObject({ adr: { number: 5 } });
  });

  it("never overwrites a different file, and never writes a second file with the number", async () => {
    const repos = repo();
    const path = join(repos.work, "docs/adr/0004-use-queues.md");
    writeFileSync(path, "my own draft\n");
    api.coordination.adrs.forceNextNumber = 4;
    const refused = await json(["adr", "new", "--title", "Use queues"], { cwd: repos.work });
    expect(refused.code).toBe(2);
    expect(refused.error?.code).toBe("CONFLICT");
    expect(refused.error?.message).toContain("ADR-0004");
    expect(refused.error?.message).toContain("docs/adr/0004-use-queues.md");
    expect(refused.error?.message).toContain("--id");
    expect(read(path)).toBe("my own draft\n");

    const dir = join(repos.work, "docs/adr");
    const before = readdirSync(dir).sort();
    api.coordination.adrs.forceNextNumber = 4;
    const human = await run(["adr", "new", "--title", "Something else"], { cwd: repos.work });
    expect(human.code).toBe(2);
    expect(human.stderr).toContain("docs/adr/0004-use-queues.md already has that number");
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("names the id when the answer is lost, writes nothing, and a retry with --id writes it", async () => {
    const repos = repo();
    const lost = async (input: URL | Request | string, init?: RequestInit) => {
      const response = await globalThis.fetch(input, init);
      if (init?.method === "POST" && String(input).endsWith("/adrs")) {
        return new Response("<html>gateway</html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    const dir = join(repos.work, "docs/adr");
    const before = readdirSync(dir).sort();
    const result = await run(["adr", "new", "--title", "Lost"], { cwd: repos.work, fetch: lost });
    expect(result.code).toBe(1);
    const adrId = String(bodyOf(posts("/adrs").at(-1)).adrId);
    expect(result.stderr).toContain(`--id ${adrId}`);
    expect(result.stderr).toContain("hivemind adr list --state reserved");
    expect(readdirSync(dir).sort()).toEqual(before);

    const retried = await json(["adr", "new", "--title", "Lost", "--id", adrId], {
      cwd: repos.work,
    });
    expect(retried.data).toMatchObject({ created: false, file: { status: "created" } });
    expect(read(join(dir, "0004-lost.md"))).toBe(template("Lost"));
  });

  it("has no offline fallback", async () => {
    const repos = repo();
    const offline = "http://127.0.0.1:1";
    await createCredentialManager({ env: {}, interactive: false, file: harness.file }).save(
      offline,
      USER_TOKEN,
    );
    const before = readdirSync(join(repos.work, "docs/adr")).sort();
    const result = await harness.run(["adr", "new", "--title", "Offline", "--server", offline], {
      cwd: repos.work,
      env: ENV,
    });
    expect(result.code).toBe(1);
    expect(readdirSync(join(repos.work, "docs/adr")).sort()).toEqual(before);
  });

  it("passes on a floor refusal as CONFLICT", async () => {
    const repos = repo();
    api.coordination.adrs.reserveConflict =
      "The floor 250 is more than 100 past the next ADR number, 4. Run `hivemind adr sync` on the default branch first.";
    const result = await json(["adr", "new", "--title", "Far"], { cwd: repos.work });
    expect(result.code).toBe(2);
    expect(result.error?.message).toContain("adr sync");
  });

  it("checks the title and slug before any request", async () => {
    const repos = repo();
    for (const argv of [
      ["adr", "new"],
      ["adr", "new", "--title", "x".repeat(201)],
      ["adr", "new", "--title", " padded"],
      ["adr", "new", "--title", "Ends with #"],
      ["adr", "new", "--title", "Fine", "--slug", "Bad"],
      ["adr", "new", "--title", "日本語"],
      ["adr", "new", "--title", "Fine", "--id", "nope"],
    ]) {
      const result = await json(argv, { cwd: repos.work });
      expect(result.code, argv.join(" ")).toBe(1);
      expect(result.error?.code).toBe("USAGE_ERROR");
    }
    expect(adrRequests()).toHaveLength(0);
  });

  it("needs .hivemind.json", async () => {
    const dir = unboundRepo({});
    const result = await json(["adr", "new", "--title", "Unbound"], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.error?.message).toContain(".hivemind.json");
    expect(adrRequests()).toHaveLength(0);
  });

  it("never waits on an open stdin", async () => {
    const repos = repo();
    const open = new PassThrough();
    const result = await json(["adr", "new", "--title", "No stdin"], {
      cwd: repos.work,
      stdin: open,
    });
    expect(result.code).toBe(0);
    open.destroy();
  });
});

// ---------------------------------------------------------------------------

describe("adr list and adr show", () => {
  /** A repository synced by a Project key, as CI does it (and as the fixtures show). */
  async function synced(): Promise<GitRepos> {
    const repos = repo();
    const key = await json(["key", "create", "--name", "ci"], { cwd: repos.work });
    const result = await json(["adr", "sync"], {
      cwd: repos.work,
      env: { ...ENV, HIVEMIND_TOKEN: String(key.data?.secret) },
    });
    expect(result.code, result.stderr).toBe(0);
    return repos;
  }

  it("lists the copy with the commit it is as of", async () => {
    const empty = repo();
    const none = await run(["adr", "list"], { cwd: empty.work });
    expect(none.stdout).toBe(
      "No ADRs.\nNo ADRs synced yet. Run 'hivemind adr sync' on the default branch.\n",
    );

    const repos = await synced();
    await json(["adr", "new", "--title", "Reserved one"], { cwd: repos.work });
    const sha = repos.head(repos.work, "origin/HEAD");
    const listed = await json(["adr", "list"], { cwd: repos.work });
    expectGolden(listed.envelope, "cli.adr-list.json");
    const human = await run(["adr", "list"], { cwd: repos.work });
    const lines = human.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "ADR-0004  reserved  -  Reserved one",
      "ADR-0003  published  proposed  C",
    ]);
    expect(lines.at(-1)).toMatch(new RegExp(`^As of commit ${sha.slice(0, 7)}, synced \\S+Z\\.$`));

    const accepted = await json(["adr", "list", "--status", "accepted"], { cwd: repos.work });
    expect(accepted.data).toMatchObject({ items: [{ number: 2 }, { number: 1 }] });
    expect(accepted.data?.items).toHaveLength(2);
    expect((await json(["adr", "list", "--state", "nope"], { cwd: repos.work })).code).toBe(1);
  });

  it("marks a reservation a file took, and escapes server text", async () => {
    const repos = await synced();
    const row = api.coordination.adrs.rows.get(project.id)?.get(3);
    if (!row) throw new Error("expected ADR-0003");
    row.reservation = {
      title: "Use keyset pages",
      slug: "use-keyset-pages",
      gitBranch: null,
      reservedBy: { kind: "user", userId: randomUUID() },
      sessionId: null,
      reservedAt: new Date().toISOString(),
    };
    row.reservationTaken = true;
    row.title = "Evil\u001b[2J\nforged";
    const human = await run(["adr", "list"], { cwd: repos.work });
    expect(human.stdout).toContain(
      "Evil\\x1b[2J\\nforged  (reserved for 'Use keyset pages': needs a new number)",
    );
    expect(human.stdout).not.toContain("\u001b");
    const shown = await run(["adr", "show", "3"], { cwd: repos.work });
    expect(shown.stdout).toContain("the reserved ADR needs a new number");
    expect(shown.stdout).not.toContain("\u001b");
  });

  it("shows an ADR by any identifier form, and says when the local file differs", async () => {
    const repos = await synced();
    for (const id of ["3", "0003", "ADR-0003", "adr-0003"]) {
      const shown = await json(["adr", "show", id], { cwd: repos.work });
      expect(shown.data, id).toMatchObject({
        adr: { number: 3, title: "C" },
        local: { match: "same", path: "docs/adr/0003-c.md" },
      });
    }
    const same = await run(["adr", "show", "3"], { cwd: repos.work });
    expect(same.stdout).toContain("ADR-0003  C\nstate published  status proposed  date 2026-01-01");
    expect(same.stdout).toContain("# C\n");
    expect(same.stdout).not.toContain("local file");

    fixture.write(repos.work, { "docs/adr/0002-b.md": adrText("B", { status: "deprecated" }) });
    const differs = await json(["adr", "show", "2"], { cwd: repos.work });
    expectGolden(differs.envelope, "cli.adr-show.json");
    expect(differs.data).toMatchObject({
      local: { match: "differs", path: "docs/adr/0002-b.md" },
    });
    const nested = join(repos.work, "src");
    mkdirSync(nested);
    const human = await run(["adr", "show", "ADR-0002"], { cwd: nested });
    const sha = repos.head(repos.work, "origin/HEAD").slice(0, 7);
    expect(human.stdout).toMatch(
      new RegExp(
        `The local file \\.\\./docs/adr/0002-b\\.md differs from this copy\\.\\nAs of commit ${sha}, synced \\S+\\.\\n$`,
      ),
    );

    fixture.write(repos.work, { "docs/adr/0003-c.md": null });
    const missing = await json(["adr", "show", "3"], { cwd: repos.work });
    expect(missing.data).toMatchObject({ local: { match: "missing", path: null } });

    const notFound = await json(["adr", "show", "99"], { cwd: repos.work });
    expect(notFound.code).toBe(4);
    expect((await json(["adr", "show", "ADR-15x"], { cwd: repos.work })).code).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("adr status", () => {
  it("rewrites status and date only, locally, with no request", async () => {
    const dir = unboundRepo({
      "docs/adr/0002-b.md": adrText("B", { status: "proposed" }),
      "docs/adr/0017-adr-numbers-and-repo-sync.md": adrText("ADR numbers and repo sync", {
        status: "proposed",
      }),
    });
    const path = join(dir, "docs/adr/0002-b.md");
    const before = read(path);
    const changed = await json(["adr", "status", "2", "deprecated"], { cwd: dir });
    expect(changed.code, changed.stderr).toBe(0);
    expect(changed.data).toEqual({
      number: 2,
      path: "docs/adr/0002-b.md",
      status: "deprecated",
      previousStatus: "proposed",
      date: FAKE_TODAY,
      changed: true,
    });
    const after = read(path);
    expect(after).toBe(
      before.replace(
        "status: proposed\ndate: 2026-01-01",
        `status: deprecated\ndate: ${FAKE_TODAY}`,
      ),
    );
    expect(api.requests).toHaveLength(0);

    const golden = await json(["adr", "status", "ADR-0017", "accepted"], { cwd: dir });
    expectGolden(golden.envelope, "cli.adr-status.json");

    const again = await run(["adr", "status", "0002", "deprecated"], {
      cwd: dir,
      clock: fakeClock("2026-12-31"),
    });
    expect(again.stdout).toBe("ADR-0002 is already deprecated.\n");
    expect(read(path)).toBe(after);
    const human = await run(["adr", "status", "2", "accepted"], { cwd: dir });
    expect(human.stdout).toBe(
      "ADR-0002 is now accepted. Commit the change, merge it, then run 'hivemind adr sync'.\n",
    );
  });

  it("keeps a CRLF body byte for byte and drops the BOM from the frontmatter", async () => {
    const body =
      "\r\n# T\r\n\r\n## Context\r\n\r\nWhy.\r\n\r\n## Decision\r\n\r\nWhat.\r\n\r\n## Consequences\r\n\r\nSo.\r\n";
    const dir = unboundRepo({
      "docs/adr/0005-t.md": `﻿---\r\nstatus: proposed\r\ndate: 2026-01-01\r\n---\r\n${body}`,
    });
    const result = await json(["adr", "status", "5", "accepted"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    const bytes = readFileSync(join(dir, "docs/adr/0005-t.md"));
    expect(bytes.toString("utf8")).toBe(`---\nstatus: accepted\ndate: ${FAKE_TODAY}\n---\n${body}`);
    expect(bytes[0]).toBe(0x2d);
  });

  it("refuses superseded, a missing ADR, duplicates and an invalid file", async () => {
    const dir = unboundRepo({
      "docs/adr/0001-a.md": adrText("A"),
      "docs/adr/0003-c.md": adrText("C"),
      "docs/adr/0003-d.md": adrText("D"),
      "docs/adr/0004-bad.md": "---\nstatus: accepted\ndate: 2026-01-01\nauthor: me\n---\n\n# Bad\n",
    });
    const superseded = await json(["adr", "status", "1", "superseded"], { cwd: dir });
    expect(superseded.code).toBe(1);
    expect(superseded.error?.message).toContain("hivemind adr supersede");
    expect((await json(["adr", "status", "1", "done"], { cwd: dir })).code).toBe(1);
    expect((await json(["adr", "status", "9", "accepted"], { cwd: dir })).code).toBe(4);
    expect((await json(["adr", "status", "3", "accepted"], { cwd: dir })).code).toBe(2);
    const invalid = await json(["adr", "status", "4", "deprecated"], { cwd: dir });
    expect(invalid.code).toBe(1);
    expect(invalid.error?.code).toBe("ADR_INVALID");
    expect(invalid.error?.message).toContain("docs/adr/0004-bad.md: ADR_FRONTMATTER_UNKNOWN_KEY");

    const nowhere = join(scratch, `nowhere-${randomUUID()}`);
    mkdirSync(nowhere);
    const outside = await json(["adr", "status", "1", "accepted"], { cwd: nowhere });
    expect(outside.code).toBe(1);
    expect(outside.error?.code).toBe("USAGE_ERROR");
  });
});

// ---------------------------------------------------------------------------

describe("adr supersede", () => {
  const files = () => ({
    "docs/adr/0001-a.md": adrText("A"),
    "docs/adr/0002-b.md": adrText("B"),
    "docs/adr/0004-d.md": adrText("D", { status: "proposed", date: "2026-02-02" }),
  });

  it("writes both files, bodies unchanged, with no request", async () => {
    const dir = unboundRepo(files());
    const result = await json(["adr", "supersede", "2", "--by", "4"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expectGolden(result.envelope, "cli.adr-supersede.json");
    expect(result.data).toEqual({
      superseded: {
        number: 2,
        path: "docs/adr/0002-b.md",
        status: "superseded",
        previousStatus: "accepted",
        date: FAKE_TODAY,
        changed: true,
      },
      superseding: { number: 4, path: "docs/adr/0004-d.md", supersedes: [2], changed: true },
      changed: true,
    });
    expect(read(join(dir, "docs/adr/0002-b.md"))).toBe(
      adrText("B", { status: "superseded", date: FAKE_TODAY }),
    );
    expect(read(join(dir, "docs/adr/0004-d.md"))).toBe(
      adrText("D", { status: "proposed", date: "2026-02-02", supersedes: [2] }),
    );
    expect(api.requests).toHaveLength(0);
  });

  it("is idempotent: a rerun on another day changes nothing", async () => {
    const dir = unboundRepo(files());
    const first = await run(["adr", "supersede", "ADR-0002", "--by", "ADR-0004"], { cwd: dir });
    expect(first.stdout).toBe(
      "ADR-0002 is now superseded by ADR-0004. Commit both files, merge them, then run 'hivemind adr sync'.\n",
    );
    const snapshot = [read(join(dir, "docs/adr/0002-b.md")), read(join(dir, "docs/adr/0004-d.md"))];
    const again = await json(["adr", "supersede", "2", "--by", "4"], {
      cwd: dir,
      clock: fakeClock("2026-10-06"),
    });
    expect(again.code).toBe(0);
    expect(again.data).toMatchObject({
      changed: false,
      superseded: { changed: false, date: FAKE_TODAY },
    });
    expect([read(join(dir, "docs/adr/0002-b.md")), read(join(dir, "docs/adr/0004-d.md"))]).toEqual(
      snapshot,
    );
  });

  it("refuses a cycle, a target superseded by another ADR, a missing ADR and itself", async () => {
    const dir = unboundRepo({
      "docs/adr/0001-a.md": adrText("A"),
      "docs/adr/0002-b.md": adrText("B", { supersedes: [1] }),
      "docs/adr/0003-c.md": adrText("C", { supersedes: [4] }),
      "docs/adr/0004-d.md": adrText("D"),
      "docs/adr/0005-e.md": adrText("E"),
    });
    const snapshot = () =>
      readdirSync(join(dir, "docs/adr")).map((name) => read(join(dir, "docs/adr", name)));
    const before = snapshot();
    const cycle = await json(["adr", "supersede", "2", "--by", "1"], { cwd: dir });
    expect(cycle.code).toBe(2);
    expect(cycle.error?.message).toContain("cycle");
    const taken = await json(["adr", "supersede", "4", "--by", "5"], { cwd: dir });
    expect(taken.code).toBe(2);
    expect(taken.error?.message).toContain("ADR-0004 is already superseded by ADR-0003");
    expect((await json(["adr", "supersede", "9", "--by", "5"], { cwd: dir })).code).toBe(4);
    expect((await json(["adr", "supersede", "5", "--by", "9"], { cwd: dir })).code).toBe(4);
    expect((await json(["adr", "supersede", "5", "--by", "5"], { cwd: dir })).code).toBe(1);
    expect((await json(["adr", "supersede", "5"], { cwd: dir })).code).toBe(1);
    expect(snapshot()).toEqual(before);

    const superseded = unboundRepo({
      "docs/adr/0001-a.md": adrText("A", { status: "superseded" }),
      "docs/adr/0002-b.md": adrText("B", { supersedes: [1] }),
      "docs/adr/0003-c.md": adrText("C"),
    });
    const newer = await json(["adr", "supersede", "3", "--by", "1"], { cwd: superseded });
    expect(newer.code).toBe(2);
    expect(newer.error?.message).toContain("ADR-0001 is superseded itself");
  });

  it("finishes a run that stopped after <old> was renamed (SIGKILL: no cleanup ran)", async () => {
    const old = rewriteAdrFrontmatter(adrText("B"), { status: "superseded", date: FAKE_TODAY });
    if (!old.ok) throw new Error("rewrite failed");
    const dir = unboundRepo({
      ...files(),
      "docs/adr/0002-b.md": old.contents,
      "docs/adr/.0004-d.md.a1b2c3d4e5f6.tmp": "partial",
    });
    const result = await json(["adr", "supersede", "2", "--by", "4"], {
      cwd: dir,
      clock: fakeClock("2026-10-07"),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.data).toMatchObject({
      changed: true,
      superseded: { changed: false },
      superseding: { changed: true },
    });
    expect(read(join(dir, "docs/adr/0002-b.md"))).toBe(old.contents);
    expect(parseAdrContent(read(join(dir, "docs/adr/0004-d.md")))).toMatchObject({
      ok: true,
      adr: { supersedes: [2], date: "2026-02-02" },
    });
    const check = await json(["adr", "sync", "--check"], { cwd: dir });
    expect(check.code, check.stderr).toBe(0);
    expect(check.data).toMatchObject({ outcome: "checked", fileCount: 3 });
  });

  it("finishes a run that stopped after <new> was renamed", async () => {
    const dir = unboundRepo({
      ...files(),
      "docs/adr/0004-d.md": adrText("D", {
        status: "proposed",
        date: "2026-02-02",
        supersedes: [2],
      }),
    });
    const newer = read(join(dir, "docs/adr/0004-d.md"));
    const result = await json(["adr", "supersede", "2", "--by", "4"], { cwd: dir });
    expect(result.code, result.stderr).toBe(0);
    expect(result.data).toMatchObject({
      superseded: { changed: true },
      superseding: { changed: false },
    });
    expect(read(join(dir, "docs/adr/0004-d.md"))).toBe(newer);
    expect(read(join(dir, "docs/adr/0002-b.md"))).toBe(
      adrText("B", { status: "superseded", date: FAKE_TODAY }),
    );
  });
});

// ---------------------------------------------------------------------------

describe("adr sync", () => {
  const syncBody = () => bodyOf(posts("/adrs/sync").at(-1));
  const fileNames = () =>
    (syncBody().entries as { fileName: string }[]).map((entry) => entry.fileName);

  it("reads origin/HEAD by default, and a second run sends nothing", async () => {
    const repos = repo();
    expect(fixture.git(repos.work, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(
      "refs/remotes/origin/main",
    );
    const result = await json(["adr", "sync"], { cwd: repos.work });
    expect(result.code, result.stderr).toBe(0);
    expectGolden(result.envelope, "cli.adr-sync.json");
    const head = repos.head(repos.work, "origin/HEAD");
    expect(syncBody()).toMatchObject({
      commitSha: head,
      baseCommitSha: null,
      forced: false,
      directory: "docs/adr",
    });
    expect(fileNames()).toEqual(["0001-a.md", "0002-b.md", "0003-c.md"]);
    expect(result.data).toMatchObject({
      outcome: "synced",
      ref: "refs/remotes/origin/HEAD",
      commitSha: head,
      baseCommitSha: null,
      fileCount: 3,
      uploadedFileCount: 3,
      added: 3,
    });

    const before = api.requests.length;
    const again = await run(["adr", "sync"], { cwd: repos.work });
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(`Already synced at commit ${head.slice(0, 7)}.\n`);
    expect(api.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
  });

  it("prints what changed, and never fetches", async () => {
    const repos = repo();
    const first = await run(["adr", "sync"], { cwd: repos.work });
    const c0 = repos.head(repos.work, "origin/HEAD");
    expect(first.stdout).toBe(
      `Synced commit ${c0.slice(0, 7)} (first sync): 3 added, 0 updated, 0 removed, 0 unchanged.\n  ADR-0001 added (accepted)\n  ADR-0002 added (accepted)\n  ADR-0003 added (proposed)\n`,
    );

    // origin moves on; this clone has not fetched, so there is nothing new.
    const c1 = fixture.commit(repos.seed, {
      "docs/adr/0001-a.md": adrText("A", { status: "deprecated" }),
      "docs/adr/0003-c.md": null,
    });
    fixture.git(repos.seed, "push", "-q", "origin", "main");
    const stale = await run(["adr", "sync"], { cwd: repos.work });
    expect(stale.stdout).toBe(`Already synced at commit ${c0.slice(0, 7)}.\n`);
    expect(api.requests.some((request) => request.body.includes(c1))).toBe(false);

    fixture.git(repos.work, "fetch", "-q", "origin");
    const second = await run(["adr", "sync"], { cwd: repos.work });
    expect(second.stdout).toBe(
      `Synced commit ${c1.slice(0, 7)} (was ${c0.slice(0, 7)}): 0 added, 1 updated, 1 removed, 1 unchanged.\n  ADR-0001 updated (accepted -> deprecated)\n  ADR-0003 removed (proposed)\n`,
    );
    expect(api.coordination.adrs.rows.get(project.id)?.get(3)?.state).toBe("removed");
  });

  it("--ref reads another commit; the default never sees an unmerged branch", async () => {
    const repos = repo();
    fixture.git(repos.work, "switch", "-q", "-c", "feature");
    fixture.commit(repos.work, { "docs/adr/0005-x.md": adrText("X") });
    await json(["adr", "sync"], { cwd: repos.work });
    expect(fileNames()).not.toContain("0005-x.md");
    const head = await json(["adr", "sync", "--ref", "HEAD"], { cwd: repos.work });
    expect(head.code, head.stderr).toBe(0);
    expect(head.data).toMatchObject({ ref: "HEAD", commitSha: repos.head(repos.work) });
    expect(fileNames()).toContain("0005-x.md");
    const nope = await json(["adr", "sync", "--ref", "nope"], { cwd: repos.work });
    expect(nope.code).toBe(1);
    expect(nope.error?.message).toContain("--ref nope");
    const dashed = await json(["adr", "sync", "--ref=--output=x"], { cwd: repos.work });
    expect(dashed.code).toBe(1);
  });

  it("never syncs the working tree: edits, staged changes and untracked files stay local", async () => {
    const repos = repo();
    fixture.write(repos.work, {
      "docs/adr/0001-a.md": adrText("A", { status: "deprecated" }),
      "docs/adr/0002-b.md": adrText("B", { status: "deprecated" }),
      "docs/adr/0004-new.md": adrText("New"),
    });
    fixture.git(repos.work, "add", "docs/adr/0002-b.md");
    const result = await json(["adr", "sync"], { cwd: repos.work });
    expect(result.code, result.stderr).toBe(0);
    expect(fileNames()).toEqual(["0001-a.md", "0002-b.md", "0003-c.md"]);
    const uploaded = [...api.coordination.adrs.contents.values()];
    expect(uploaded).toContain(
      `${fixture.git(repos.work, "cat-file", "-p", "HEAD:docs/adr/0001-a.md")}\n`,
    );
    expect(uploaded).toContain(adrText("A"));
    expect(uploaded).toContain(adrText("B"));
    expect(uploaded.some((content) => content.includes("deprecated"))).toBe(false);
    expect(uploaded.some((content) => content.includes("# New"))).toBe(false);
  });

  it("refuses a copy that is not an ancestor, unless --force (force-push, fetched)", async () => {
    const repos = repo();
    const c1 = fixture.commit(repos.seed, { "docs/adr/0004-d.md": adrText("D") });
    fixture.git(repos.seed, "push", "-q", "origin", "main");
    fixture.git(repos.work, "fetch", "-q", "origin");
    await json(["adr", "sync"], { cwd: repos.work });
    fixture.git(repos.seed, "reset", "-q", "--hard", "HEAD~1");
    fixture.commit(repos.seed, { "docs/adr/0005-e.md": adrText("E") });
    fixture.git(repos.seed, "push", "-q", "-f", "origin", "main");
    fixture.git(repos.work, "fetch", "-q", "origin");

    const before = posts("/adrs/sync").length + posts("/adrs/contents").length;
    const refused = await json(["adr", "sync"], { cwd: repos.work });
    expect(refused.code).toBe(2);
    expect(refused.error?.code).toBe("CONFLICT");
    expect(refused.error?.message).toContain(
      `The ADR copy is at ${c1.slice(0, 7)}, which is not an ancestor of`,
    );
    expect(refused.error?.message).toContain("--force");
    expect(posts("/adrs/sync").length + posts("/adrs/contents").length).toBe(before);

    const forced = await json(["adr", "sync", "--force"], { cwd: repos.work });
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.data).toMatchObject({ outcome: "synced", forced: true, baseCommitSha: c1 });
    expect(syncBody()).toMatchObject({ forced: true, baseCommitSha: c1 });
    expect(fileNames()).toEqual(["0001-a.md", "0002-b.md", "0003-c.md", "0005-e.md"]);

    // A clone made after another force-push does not have the copy's commit
    // at all (file:// copies only reachable objects).
    fixture.git(repos.seed, "reset", "-q", "--hard", "HEAD~1");
    fixture.commit(repos.seed, { "docs/adr/0007-g.md": adrText("G") });
    fixture.git(repos.seed, "push", "-q", "-f", "origin", "main");
    const other = join(scratch, `other-${randomUUID()}`);
    fixture.git(scratch, "clone", "-q", `file://${repos.origin}`, other);
    // The copy is at the forced commit, which `other` never saw.
    const unknown = await json(["adr", "sync"], { cwd: other });
    expect(unknown.code).toBe(2);
    expect(unknown.error?.message).toContain("which this clone does not have");
    expect(unknown.error?.message).toContain("fetch-depth: 0");
    expect(unknown.error?.message).toContain("--force");
  });

  it("exits 0 for a commit the copy is already past, sending nothing", async () => {
    const repos = repo();
    const c1 = fixture.commit(repos.seed, { "docs/adr/0004-d.md": adrText("D") });
    const c2 = fixture.commit(repos.seed, { "docs/adr/0005-e.md": adrText("E") });
    fixture.git(repos.seed, "push", "-q", "origin", "main");
    fixture.git(repos.work, "fetch", "-q", "origin");
    expect((await json(["adr", "sync", "--ref", c2], { cwd: repos.work })).code).toBe(0);
    const before = api.requests.length;
    const older = await json(["adr", "sync", "--ref", c1], { cwd: repos.work });
    expect(older.code).toBe(0);
    expect(older.data).toMatchObject({
      outcome: "already_synced_past",
      commitSha: c1,
      baseCommitSha: c2,
    });
    const human = await run(["adr", "sync", "--ref", c1], { cwd: repos.work });
    expect(human.stdout).toBe(
      `Already synced past this commit: the copy is at ${c2.slice(0, 7)}, which contains ${c1.slice(0, 7)}.\n`,
    );
    expect(api.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
  });

  it("says to fetch the full history in a shallow clone", async () => {
    const repos = repo();
    await json(["adr", "sync"], { cwd: repos.work });
    fixture.commit(repos.seed, { "docs/adr/0004-d.md": adrText("D") });
    fixture.commit(repos.seed, { "docs/adr/0005-e.md": adrText("E") });
    fixture.git(repos.seed, "push", "-q", "origin", "main");
    const shallow = join(scratch, `shallow-${randomUUID()}`);
    fixture.git(scratch, "clone", "-q", "--depth", "1", `file://${repos.origin}`, shallow);
    const result = await json(["adr", "sync"], { cwd: shallow });
    expect(result.code).toBe(2);
    expect(result.error?.message).toContain("fetch-depth: 0");
  });

  it("explains a missing origin/HEAD", async () => {
    const repos = repo();
    fixture.git(repos.work, "remote", "set-head", "origin", "-d");
    const result = await json(["adr", "sync"], { cwd: repos.work });
    expect(result.code).toBe(1);
    expect(result.error?.message).toContain("git remote set-head origin --auto");
    expect(result.error?.message).toContain("--ref");
    expect(adrRequests()).toHaveLength(0);
  });

  it("refuses duplicate numbers (exit 2) and invalid files (exit 1) before any request", async () => {
    const dup = repo({ ...THREE, "docs/adr/0003-d.md": adrText("D") });
    const duplicated = await json(["adr", "sync"], { cwd: dup.work });
    expect(duplicated.code).toBe(2);
    expect(duplicated.error?.message).toContain(
      "ADR-0003 (docs/adr/0003-c.md, docs/adr/0003-d.md)",
    );

    const bad = repo({
      ...THREE,
      "docs/adr/0004-bad.md": "---\nstatus: accepted\ndate: 2026-01-01\nauthor: me\n---\n\n# Bad\n",
      "docs/adr/notes.md": adrText("Notes"),
      "docs/adr/sub/0009-ignored.md": "not read",
      "docs/adr/README.txt": "ignored",
    });
    const invalid = await json(["adr", "sync"], { cwd: bad.work });
    expect(invalid.code).toBe(1);
    expect(invalid.error?.code).toBe("ADR_INVALID");
    expect(invalid.error?.message).toContain("docs/adr/0004-bad.md: ADR_FRONTMATTER_UNKNOWN_KEY");
    expect(invalid.error?.message).toContain("docs/adr/notes.md: ADR_FILE_NAME_INVALID");
    expect(invalid.error?.message).not.toContain("0009-ignored");
    const human = await run(["adr", "sync"], { cwd: join(bad.work, "docs") });
    expect(human.stderr).toContain("adr/0004-bad.md: ADR_FRONTMATTER_UNKNOWN_KEY: ");
    expect(human.stderr).toContain("2 problems in 2 ADR files (listed above)");
    expect(adrRequests()).toHaveLength(0);
  });

  it("uploads only content the copy lacks, in batches within the body limit", async () => {
    const big = (n: number, extra = "") =>
      adrText(`Big ${n}`, { body: `${String(n).repeat(60 * 1024)}${extra}` });
    const files = Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((n) => [`docs/adr/000${n}-big.md`, big(n)]),
    );
    const repos = repo(files);
    expect((await json(["adr", "sync"], { cwd: repos.work })).code).toBe(0);
    const batches = posts("/adrs/contents");
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const batch of batches) {
      expect(Buffer.byteLength(batch.body)).toBeLessThanOrEqual(MAX_ADR_UPLOAD_BODY_BYTES);
    }
    expect(batches.flatMap((batch) => bodyOf(batch).files as unknown[])).toHaveLength(6);

    fixture.commit(repos.seed, { "docs/adr/0003-big.md": big(3, "changed") });
    fixture.git(repos.seed, "push", "-q", "origin", "main");
    fixture.git(repos.work, "fetch", "-q", "origin");
    const before = batches.length;
    const second = await json(["adr", "sync"], { cwd: repos.work });
    expect(second.data).toMatchObject({ uploadedFileCount: 1, updated: 1, unchanged: 5 });
    const uploaded = posts("/adrs/contents").slice(before);
    expect(uploaded).toHaveLength(1);
    expect((bodyOf(uploaded[0]).files as { content: string }[])[0]?.content).toBe(
      big(3, "changed"),
    );
  });

  it("reads a file of exactly 64 KiB and refuses a larger one without reading it", async () => {
    const empty = adrText("Big", { body: "" });
    const exact = adrText("Big", {
      body: "x".repeat(MAX_ADR_FILE_BYTES - Buffer.byteLength(empty)),
    });
    expect(Buffer.byteLength(exact)).toBe(MAX_ADR_FILE_BYTES);
    const repos = repo({ "docs/adr/0001-big.md": exact });
    const ok = await json(["adr", "sync"], { cwd: repos.work });
    expect(ok.code, ok.stderr).toBe(0);
    expect([...api.coordination.adrs.contents.values()]).toContain(exact);

    const tooBig = repo({ "docs/adr/0001-big.md": `${exact}y` });
    const refused = await json(["adr", "sync"], { cwd: tooBig.work });
    expect(refused.code).toBe(1);
    expect(refused.error?.message).toContain(
      "docs/adr/0001-big.md: ADR_TOO_LARGE: The file is 65537 bytes",
    );
  });

  it("lists a directory whose tree listing is larger than 64 KiB", async () => {
    const slug = "a".repeat(90);
    const files = Object.fromEntries(
      Array.from({ length: 450 }, (_, index) => [
        `docs/adr/${String(index + 1).padStart(4, "0")}-${slug}.md`,
        adrText("Same"),
      ]),
    );
    const repos = repo(files);
    const result = await json(["adr", "sync"], { cwd: repos.work });
    expect(result.code, result.stderr).toBe(0);
    expect(result.data).toMatchObject({ fileCount: 450, uploadedFileCount: 1, added: 450 });
  }, 60_000);

  it("syncs a binding below the repository root with its own directory", async () => {
    const repos = repo(THREE, "packages/app");
    const nested = join(repos.bound, "src");
    mkdirSync(nested, { recursive: true });
    const result = await json(["adr", "sync"], { cwd: nested });
    expect(result.code, result.stderr).toBe(0);
    expect(syncBody()).toMatchObject({ directory: "packages/app/docs/adr" });
    expect(fileNames()).toEqual(["0001-a.md", "0002-b.md", "0003-c.md"]);
    const created = await json(["adr", "new", "--title", "Nested"], { cwd: nested });
    expect(created.data).toMatchObject({
      file: { path: "packages/app/docs/adr/0004-nested.md" },
    });
  });

  it("--dry-run reads the copy and sends nothing", async () => {
    const repos = repo();
    await json(["adr", "sync"], { cwd: repos.work });
    fixture.commit(repos.seed, {
      "docs/adr/0001-a.md": adrText("A", { status: "deprecated" }),
      "docs/adr/0002-b.md": null,
      "docs/adr/0004-d.md": adrText("D"),
    });
    fixture.git(repos.seed, "push", "-q", "origin", "main");
    fixture.git(repos.work, "fetch", "-q", "origin");
    const before = api.requests.length;
    const dry = await json(["adr", "sync", "--dry-run"], { cwd: repos.work });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.data).toMatchObject({
      outcome: "dry_run",
      added: 1,
      updated: 1,
      removed: 1,
      unchanged: 1,
      uploadedFileCount: 0,
      changes: [
        { number: 1, change: "updated", statusFrom: "accepted", statusTo: "deprecated" },
        { number: 2, change: "removed", path: "docs/adr/0002-b.md", statusTo: null },
        { number: 4, change: "added", statusFrom: null, statusTo: "accepted" },
      ],
    });
    const human = await run(["adr", "sync", "--dry-run"], { cwd: repos.work });
    expect(human.stdout).toMatch(
      /^Dry run: would sync commit [0-9a-f]{7} \(was [0-9a-f]{7}\): 1 added/,
    );
    expect(human.stdout.trimEnd().split("\n").at(-1)).toBe("Nothing was sent.");
    expect(api.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
  });

  it("adds a rerun hint when another sync finished first", async () => {
    const repos = repo();
    const racing = async (input: URL | Request | string, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).endsWith("/adrs/sync")) {
        api.coordination.adrs.syncs.set(project.id, {
          commitSha: "f".repeat(40),
          syncedAt: new Date().toISOString(),
          syncedBy: { kind: "user", userId: randomUUID() },
          manifest: "[]",
        });
      }
      return globalThis.fetch(input, init);
    };
    const result = await json(["adr", "sync"], { cwd: repos.work, fetch: racing });
    expect(result.code).toBe(2);
    expect(result.error?.message).toContain("Another ADR sync finished first");
    expect(result.error?.message).toContain("run 'hivemind adr sync' again");
  });

  it("recovers from a lost answer by running again, with no --id", async () => {
    const repos = repo();
    const lost = async (input: URL | Request | string, init?: RequestInit) => {
      const response = await globalThis.fetch(input, init);
      if (init?.method === "POST" && String(input).endsWith("/adrs/sync")) {
        return new Response("FUNCTION_INVOCATION_TIMEOUT", { status: 504 });
      }
      return response;
    };
    const failed = await json(["adr", "sync"], { cwd: repos.work, fetch: lost });
    expect(failed.code).toBe(1);
    expect(failed.error?.message).toContain("Running 'hivemind adr sync' again is safe");
    const again = await json(["adr", "sync"], { cwd: repos.work });
    expect(again.data).toMatchObject({ outcome: "up_to_date" });
    expect(posts("/adrs/sync")).toHaveLength(1);
  });

  it("--check validates the working tree with no server and no login", async () => {
    const dir = unboundRepo({
      ...THREE,
      "docs/adr/0003-c.md": adrText("C", { supersedes: [7] }),
      "docs/adr/.0003-c.md.a1b2c3d4e5f6.tmp": "leftover",
    });
    const noLogin = { PATH: process.env.PATH, HOME: join(scratch, "no-home") };
    const offline = ["--server", "http://127.0.0.1:1"];
    const checked = await harness.run(["adr", "sync", "--check", "--json", ...offline], {
      cwd: dir,
      env: noLogin,
    });
    expect(checked.code, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({
      data: {
        outcome: "checked",
        ref: null,
        commitSha: null,
        fileCount: 3,
        warnings: {
          items: [{ number: 3, path: "docs/adr/0003-c.md", code: "ADR_SUPERSEDES_MISSING_TARGET" }],
          complete: true,
        },
      },
    });
    const human = await harness.run(["adr", "sync", "--check", ...offline], {
      cwd: dir,
      env: noLogin,
    });
    expect(human.stdout).toBe(
      "Checked 3 ADR files in docs/adr/: no errors, 1 warning.\nwarning: ADR-0003 docs/adr/0003-c.md: ADR-0003 supersedes ADR-0007, which does not exist.\n",
    );

    fixture.write(dir, {
      "docs/adr/0004-bad.md": "---\nstatus: maybe\ndate: 2026-01-01\n---\n\n# Bad\n",
    });
    const invalid = await harness.run(["adr", "sync", "--check", "--json"], {
      cwd: dir,
      env: noLogin,
    });
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain("ADR_STATUS_INVALID");
    fixture.write(dir, {
      "docs/adr/0004-bad.md": null,
      "docs/adr/0001-again.md": adrText("Again"),
    });
    const duplicated = await harness.run(["adr", "sync", "--check"], { cwd: dir, env: noLogin });
    expect(duplicated.code).toBe(2);
    const combined = await harness.run(["adr", "sync", "--check", "--force"], {
      cwd: dir,
      env: noLogin,
    });
    expect(combined.code).toBe(1);
    expect(api.requests).toHaveLength(0);
  });
});
