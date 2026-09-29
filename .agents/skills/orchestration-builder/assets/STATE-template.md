<!--
STATE.md TEMPLATE
One row per item, grouped by wave. Fill every {{PLACEHOLDER}}. Pre-fill the
verification-gate and decision tables from parsed flags. Keep the integration
branch name identical to the orchestrator prompt. Avoid em-dashes.
-->

# Orchestration State: {{INTEGRATION_BRANCH}}

Source of truth for this run. Update after every state change (plan saved, agent dispatched, gate passed, branch merged). If the run is interrupted, read this file first to resume.

- Integration branch: `{{INTEGRATION_BRANCH}}`
- Base branch / final PR target: `{{BASE_BRANCH}}`
- PR model: `{{PR_MODEL}}`
- Models: orchestrator {{ORCHESTRATOR_MODEL}}, specialists {{AGENT_MODEL}}, arbiter {{ARBITER_MODEL}}
- Tracking context: {{TRACKING_ISSUE_URL_OR_CONTEXT}}
- Last updated: <YYYY-MM-DD HH:MM> by orchestrator

## Status legend

- `not-started` no worktree yet
- `planning` running the per-item planning step
- `planned` plan file written, ready for agents
- `in-progress` specialist agents executing
- `review` review steps running
- `fixing` applying review fixes
- `verified` build, lint, tests, and acceptance criteria all green in the worktree
- `merged` merged into integration and integration re-verified
- `blocked` waiting on a dependency, a failed gate, or a `needs-human` arbiter decision (see Notes); independent items keep running

{{WAVE_TABLES}}

<!-- Each wave table:
## Wave N ({{parallel|sequential}}): branch from {{base or post-wave-(N-1) integration tip}}

| Item | Slug / branch | Worktree | Tracker key | Depends on | Plan file | Status | Merged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #<id> | `feat/<slug>` | `../wt-<id>` | <key> | <deps> | `plans/<id>.md` | not-started | no |
-->

## Verification gates

Record pass/fail and date when each item clears its gate in-worktree, before merge.

| Item | Build | Lint | Tests | Acceptance criteria | Item-specific check |
| ---- | ----- | ---- | ----- | ------------------- | ------------------- |

{{VERIFICATION_GATE_ROWS}}

## Integration re-verification log

After each merge, re-run build, lint, and tests on the integration branch and log the result.

| Date | After merging | Build | Lint | Tests | Conflicts resolved | Notes |
| ---- | ------------- | ----- | ---- | ----- | ------------------ | ----- |

{{REVERIFY_ROWS}}

## Decisions / ADRs to confirm

| Decision | Item | Recorded | Confirmed at PR review |
| -------- | ---- | -------- | ---------------------- |

{{DECISION_ROWS}}

## Arbiter decisions

Every question escalated to the arbiter instead of the user. Record it before applying it. Set Needs human to `yes` when the arbiter returned something only a person can do; those carry into the final PR.

| Date | Item | Question | Decision | Rationale | Reversible | Needs human |
| ---- | ---- | -------- | -------- | --------- | ---------- | ----------- |

{{ARBITER_ROWS}}

## Finalization checklist

- [ ] All items show `merged`
- [ ] Final full build, lint, and test suite green on `{{INTEGRATION_BRANCH}}`
- [ ] PR opened into `{{BASE_BRANCH}}` per the configured PR model
- [ ] PR body includes `Closes <id>` for every item
- [ ] PR body summarizes every decision/ADR for sign-off
- [ ] PR body lists every arbiter decision and any open `needs-human` items
- [ ] All worktrees removed; merged item branches deleted
- [ ] Final PR left for human review (orchestrator does not self-merge)

## Notes and blockers

Use this space for anything that affected the run: a failed gate and how it was resolved, a conflict during integration, a decision rationale, or a reason an item is `blocked`.

-
