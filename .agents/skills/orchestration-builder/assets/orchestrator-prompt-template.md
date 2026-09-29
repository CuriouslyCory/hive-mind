<!--
ORCHESTRATOR PROMPT TEMPLATE
Fill every {{PLACEHOLDER}}. Drop in the derived wave tables. Keep exactly ONE
finalization block (single-PR OR per-issue) and delete the other. Reconcile all
names with STATE.md. Avoid em-dashes in the filled output.
-->

{{TRACKING_ISSUE_URL_OR_CONTEXT}}

| Item | Slice | Tracker key | Blocked by |
| ---- | ----- | ----------- | ---------- |

{{ITEM_TABLE_ROWS}}

You are the **orchestrator**. Drive all items below to completion autonomously, fanning out {{AGENT_MODEL}} specialist agents to do the implementation. Preserve your own context window: delegate implementation, keep plans and run state in files on disk rather than in context, and read those files back when you need them.

Do not stop to wait for user input at any point before the final PR. When a question would normally go to the user, escalate it to a {{ARBITER_MODEL}} arbiter agent (see "Escalating decisions"), record its answer, and keep going.

## Configuration

- Base branch: `{{BASE_BRANCH}}`
- Integration branch: `{{INTEGRATION_BRANCH}}`
- PR model: `{{PR_MODEL}}`
- Per-item planning: `{{PLANNING_STEP}}`
- Orchestrator model: {{ORCHESTRATOR_MODEL}}. Start this session on it (e.g. `claude --model claude-opus-5-5`).
- Specialist agents: {{AGENT_MODEL}}. Pass `model: "opus"` explicitly on every spawn.
- Arbiter: {{ARBITER_MODEL}}. Pass `model: "fable"` explicitly.

## Branching and worktree model

There is exactly one long-lived integration branch for this effort.

1. Create the integration branch from the latest base:
   ```
   git switch {{BASE_BRANCH}} && git pull
   git switch -c {{INTEGRATION_BRANCH}}
   git push -u origin {{INTEGRATION_BRANCH}}
   ```
2. Implement every item in its own git worktree on its own branch, branched from the current tip of the integration branch. Separate worktrees are what let parallel items proceed without sharing a working tree:
   ```
   git worktree add ../wt-<item> -b feat/<item-slug> {{INTEGRATION_BRANCH}}
   ```
3. Branch each wave's worktrees from the integration tip only after the previous wave has merged, so dependent items inherit their dependencies' code with nothing to reconcile.

## Waves

Run items wave by wave. Within a wave, run items in parallel. Merge a wave fully (and re-verify integration) before branching the next wave.

{{WAVE_SECTIONS}}

<!-- Each wave section should look like:
### Wave N ({{parallel|sequential}}): branch from {{base or post-wave-(N-1) integration tip}}
- #<id> <slice>. Depends on: <deps>. <shared-surface note if any>
- #<id> <slice>. Depends on: <deps>.
-->

## Per-item loop

For each item, in wave order:

1. **Plan.** Run {{PLANNING_STEP}} against the item to produce an implementation plan. Save it to `plans/<item>.md` rather than holding it in context. The plan must include explicit review and verification steps. If the planning step asks a scope question or wants approval before code is written, escalate that to the arbiter instead of waiting, and write the arbiter's answer into the plan file.
2. **Execute.** Fan out one or more {{AGENT_MODEL}} specialist agents inside that item's worktree to implement the plan. Give each agent only the scope it needs: the item, its plan file, and the relevant paths. Tell each agent to return open questions to you rather than guessing or stopping; you escalate them.
3. **Review and fix.** Follow the review process defined in the plan. Apply any fixes it surfaces.
4. **Verification gate (must pass before merge).** In the item's worktree: build green, lint clean, all tests pass, and the item's acceptance criteria met. Honor any item-specific budget or guard noted in the plan.
5. **Decision/ADR checkpoint.** For items carrying a decision flag, have the arbiter make the decision if the plan did not already settle it. Record the decision in the worktree (file/commit) before merging, and list it for sign-off at PR review.
6. **Commit hygiene.** Conventional commits that reference the item, e.g. `feat(<area>): <change> (#<id>)`.
7. **Record progress** to `STATE.md` (status, branch, merged yes/no) so the run is resumable if interrupted.

## Escalating decisions

Escalate to the arbiter anything you would otherwise ask the user: ambiguous scope, a choice between design options, a decision/ADR flag, a planning step that wants approval, a conflict between an issue and the repo's docs or ADRs, a same-wave collision on a shared surface, or a verification gate that still fails after a reasonable fix attempt. Make routine calls with an obvious answer yourself.

Spawn one agent with `model: "fable"` and a self-contained brief (it does not see your context):

```
Decision needed for <item>: <the question, stated as a decision>
Options: <each option with its trade-offs>
My recommendation: <option and why>
Read: <issue link, plans/<item>.md, STATE.md, relevant ADRs and code paths>
Constraints: <repo AGENTS.md, the item's acceptance criteria>
Return: the decision, a short rationale, whether it is reversible, and anything
only a human can do. Decide; do not implement.
```

Then record the decision in the Arbiter decisions table in `STATE.md`, apply it, and continue. Treat it as settled for the rest of the run; re-escalate only if new facts appear, and say what changed.

The arbiter cannot waive a verification gate, disable a rule to make a check pass, merge the final PR, or perform or approve anything that needs human credentials, account access, or an outward-facing irreversible action the plan did not already call for. When it returns `needs-human`, mark only the affected item `blocked` with the reason, keep running every item that does not depend on it, and carry the open question into the final PR.

{{FINALIZATION_BLOCK}}

<!--
================= FINALIZATION BLOCK: PR_MODEL = single =================
Keep this block when PR_MODEL is single; delete the per-issue block.

## Merge to integration (single-PR model)

When an item passes its verification gate, merge locally and re-verify:
```
git switch {{INTEGRATION_BRANCH}} && git pull
git merge --no-ff feat/<item-slug>
# run build + lint + tests on integration; fix any merge fallout before continuing
git push
git worktree remove ../wt-<item>
```
Open no PR until every item has merged into integration.

## Finalization (once all items have merged)

1. Run the full build + lint + test suite one final time on `{{INTEGRATION_BRANCH}}`.
2. Open one PR: `{{INTEGRATION_BRANCH}}` into `{{BASE_BRANCH}}`. In the body, include `Closes <id>` for every item so they auto-close on merge, summarize every decision/ADR and every arbiter decision for reviewer confirmation, and list any `needs-human` items that are still open.
3. Remove any remaining worktrees and delete merged item branches.
4. Do not merge the final PR yourself; leave it for human review.
========================================================================

================= FINALIZATION BLOCK: PR_MODEL = per-issue ==============
Keep this block when PR_MODEL is per-issue; delete the single-PR block.

## Merge per item (per-issue PR model)

When an item passes its verification gate:
```
git switch feat/<item-slug>
git push -u origin feat/<item-slug>
```
Open a PR: `feat/<item-slug>` into `{{INTEGRATION_BRANCH}}`. In the body, include `Closes <id>` and note any decision/ADR and arbiter decision for the item. Leave the PR for human review; do not self-merge. While it waits, keep working on any item that does not depend on it. After it is merged by a human:
```
git switch {{INTEGRATION_BRANCH}} && git pull
# run build + lint + tests on integration; fix any fallout before the next wave
git worktree remove ../wt-<item>
```
Re-verify integration after each merge so the next wave branches from a known-green tip.

## Finalization (once all items have merged into integration)

1. Run the full build + lint + test suite on `{{INTEGRATION_BRANCH}}`.
2. Open one PR: `{{INTEGRATION_BRANCH}}` into `{{BASE_BRANCH}}` summarizing the effort, listing the decisions/ADRs and every arbiter decision, and listing any `needs-human` items that are still open.
3. Remove any remaining worktrees and delete merged item branches.
4. Do not merge the final PR yourself; leave it for human review.
========================================================================
-->

## Guardrails

- One item per worktree; never run two agents against the same working tree.
- Re-verify integration after every merge, not just at the end, so conflicts surface early against a known-green baseline.
- Never merge broken work. If a verification gate fails and an agent cannot resolve it after a reasonable attempt, escalate to the arbiter (retry with a different approach, descope to a follow-up issue, or mark the item `blocked`) rather than stopping the run.
- Never stop to wait for user input before the final PR; escalate to the arbiter instead.
- Keep `plans/` files and `STATE.md` current; treat them as the source of truth so you can resume after a restart.
- Mark unknowns explicitly; do not invent keys, dependencies, or decisions.
