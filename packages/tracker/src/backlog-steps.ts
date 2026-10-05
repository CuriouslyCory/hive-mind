import { issueUrl } from "./constants.ts";

export interface BacklogStepDefinition {
  key: string;
  label: string;
  prompt: string;
  sortOrder: number;
}

/**
 * The steps a backlog issue gets when it is created without its own: plan it,
 * then implement it through to an open PR. Each prompt starts a fresh agent
 * session, so it names the issue and says what done means. The checks are the
 * ones AGENTS.md lists under "Done".
 */
export function defaultBacklogSteps(issueNumber: number): BacklogStepDefinition[] {
  const url = issueUrl(issueNumber);
  return [
    {
      key: "plan",
      label: "Step 1 · Plan",
      prompt: `/bulletproof-plan ${url}\nWhen you're done, post the plan as a comment on the issue.`,
      sortOrder: 0,
    },
    {
      key: "implement",
      label: "Step 2 · Implement + PR",
      prompt: [
        url,
        "Implement the plan posted on the issue. Fan out agents to orchestrate the implementation, and escalate decisions left for the user to specialist agents.",
        "",
        "Done means: `pnpm lint`, `pnpm typecheck`, `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test` and `pnpm build` pass, plus `pnpm test:e2e` when the change touches device login, `/api/v1` auth, a CLI command or the dashboard (see AGENTS.md); then `coderabbit review --agent --base main` has run, each valid finding is fixed and each rejected one has a one-line reason, and the checks pass again; then a PR against main is open and linked on the issue.",
        "You may push the branch and open the PR without asking.",
      ].join("\n"),
      sortOrder: 1,
    },
  ];
}
