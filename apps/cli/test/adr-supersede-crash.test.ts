import { execFileSync } from "node:child_process";
import type { PathLike } from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { commandHarness } from "./helpers/commands.ts";
import { adrText } from "./helpers/git-fixture.ts";

// A rename into docs/adr/ fails with EIO once `afterRenames` renames there
// have succeeded, as if the process died between `adr supersede`'s two
// renames; everything else is the real fs. The mock is file-wide, so this
// lives apart from adr.test.ts.
const crash = vi.hoisted(() => ({ afterRenames: Number.POSITIVE_INFINITY, seen: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename = async (from: PathLike, to: PathLike) => {
    if (String(to).includes("/docs/adr/") && crash.seen++ >= crash.afterRenames) {
      throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
    }
    return actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});

const harness = commandHarness();
const scratch = mkdtempSync(join(tmpdir(), "hivemind-adr-crash-"));
afterAll(() => {
  harness.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
function repoWithAdrs(): string {
  const dir = join(scratch, String(counter++));
  mkdirSync(join(dir, "docs", "adr"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: scratch },
  });
  writeFileSync(join(dir, "docs/adr/0002-b.md"), adrText("B"));
  writeFileSync(join(dir, "docs/adr/0004-d.md"), adrText("D", { status: "proposed" }));
  return dir;
}

const files = (dir: string) =>
  ["0002-b.md", "0004-d.md"].map((name) => readFileSync(join(dir, "docs/adr", name), "utf8"));

const supersede = (dir: string) =>
  harness.run(["adr", "supersede", "2", "--by", "4"], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: scratch },
  });

describe("adr supersede after a crash between its renames", () => {
  it("fails naming the rerun, leaves <new> written, and a rerun completes it", async () => {
    const clean = repoWithAdrs();
    expect((await supersede(clean)).code).toBe(0);
    const expected = files(clean);

    const dir = repoWithAdrs();
    const before = files(dir);
    crash.seen = 0;
    crash.afterRenames = 1;
    const failed = await supersede(dir);
    crash.afterRenames = Number.POSITIVE_INFINITY;
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("1 of 2 files were replaced");
    expect(failed.stderr).toContain("Run 'hivemind adr supersede 2 --by 4' again to finish.");
    const [oldAfterCrash, newAfterCrash] = files(dir);
    // <new> was renamed first; <old> is untouched, and no temp file is left.
    expect(oldAfterCrash).toBe(before[0]);
    expect(newAfterCrash).toBe(expected[1]);
    expect(readdirSync(join(dir, "docs/adr")).sort()).toEqual(["0002-b.md", "0004-d.md"]);

    const rerun = await supersede(dir);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(files(dir)).toEqual(expected);
  });
});
