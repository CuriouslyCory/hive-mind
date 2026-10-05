import { describe, expect, it } from "vitest";
import { defaultBacklogSteps } from "../src/backlog-steps.ts";
import { issueUrl, pullUrl } from "../src/constants.ts";
import { nextActionableStep } from "../src/store.ts";
import type { BacklogIssueView, BacklogPhaseView, BacklogStepView } from "../src/types.ts";

function step(key: string, completedAt: string | null = null): BacklogStepView {
  return {
    id: `step-${key}`,
    key,
    label: key,
    prompt: `Prompt ${key}`,
    sortOrder: 0,
    completedAt,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function issue(
  issueNumber: number,
  steps: BacklogStepView[],
  state: "open" | "closed" = "open",
): BacklogIssueView {
  return {
    id: `issue-${issueNumber}`,
    issueNumber,
    title: `Issue ${issueNumber}`,
    note: null,
    state,
    githubUpdatedAt: null,
    sortOrder: 0,
    updatedAt: "2026-10-01T00:00:00.000Z",
    steps,
  };
}

function phase(title: string, issues: BacklogIssueView[]): BacklogPhaseView {
  return {
    id: `phase-${title}`,
    title,
    description: null,
    sortOrder: 0,
    updatedAt: "2026-10-01T00:00:00.000Z",
    issues,
  };
}

const DONE = "2026-10-02T00:00:00.000Z";

describe("nextActionableStep", () => {
  it("is null for an empty or finished backlog", () => {
    expect(nextActionableStep([])).toBeNull();
    expect(nextActionableStep([phase("A", [])])).toBeNull();
    expect(
      nextActionableStep([phase("A", [issue(1, [step("a", DONE)]), issue(2, [])])]),
    ).toBeNull();
  });

  it("takes the first unfinished step in phase, then issue, then step order", () => {
    const backlog = [
      phase("Empty", []),
      phase("Now", [issue(1, [step("plan", DONE), step("implement"), step("later")])]),
      phase("Next", [issue(2, [step("plan")])]),
    ];
    expect(nextActionableStep(backlog)).toEqual({
      phaseTitle: "Now",
      issueNumber: 1,
      issueTitle: "Issue 1",
      step: step("implement"),
    });
  });

  it("skips closed issues and issues whose steps are all complete", () => {
    const backlog = [
      phase("A", [
        issue(1, [step("plan")], "closed"),
        issue(2, [step("plan", DONE), step("implement", DONE)]),
        issue(3, []),
      ]),
      phase("B", [issue(4, [step("plan")])]),
    ];
    expect(nextActionableStep(backlog)).toMatchObject({ phaseTitle: "B", issueNumber: 4 });
  });
});

describe("defaultBacklogSteps", () => {
  it("plans, then implements through to a linked PR", () => {
    const [plan, implement, ...rest] = defaultBacklogSteps(42);
    expect(rest).toEqual([]);
    const url = "https://github.com/CuriouslyCory/hive-mind/issues/42";
    expect(issueUrl(42)).toBe(url);
    expect(pullUrl(7)).toBe("https://github.com/CuriouslyCory/hive-mind/pull/7");

    expect(plan).toMatchObject({ key: "plan", label: "Step 1 · Plan", sortOrder: 0 });
    expect(plan?.prompt).toBe(
      `/bulletproof-plan ${url}\nWhen you're done, post the plan as a comment on the issue.`,
    );

    expect(implement).toMatchObject({
      key: "implement",
      label: "Step 2 · Implement + PR",
      sortOrder: 1,
    });
    const prompt = implement?.prompt ?? "";
    expect(prompt.startsWith(`${url}\n`)).toBe(true);
    // The four checks from AGENTS.md, then the review, then the PR.
    const checks = [
      "`pnpm lint`",
      "`pnpm typecheck`",
      "`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test`",
      "`pnpm build`",
    ].map((check) => prompt.indexOf(check));
    expect(checks.every((index) => index > -1)).toBe(true);
    expect(prompt).toContain("`pnpm test:e2e`");
    const review = prompt.indexOf("`coderabbit review --agent --base main`");
    const pr = prompt.indexOf("a PR against main is open and linked on the issue");
    expect(review).toBeGreaterThan(Math.max(...checks));
    expect(pr).toBeGreaterThan(review);
    expect(prompt).toContain("each rejected one has a one-line reason");
    expect(prompt).toContain("You may push the branch and open the PR without asking.");
  });
});
