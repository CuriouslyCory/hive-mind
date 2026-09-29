---
name: orchestration-builder
description: Convert a set of Jira stories or GitHub issues into a dependency-aware, parallelized orchestration plan plus a resumable STATE.md tracker. Use this skill whenever someone pastes a set of issues, stories, or a work-item table (especially with a "blocked by" / dependency column) and wants it turned into an agent-driven execution plan. Trigger on phrasings like "turn these issues into an orchestrated plan", "build me an orchestration plan", "make a wave plan", "fan out agents to implement these stories", "orchestrate this backlog", "plan parallel execution with worktrees", or when a tracking issue links several sub-issues that need coordinated implementation. Also trigger when someone has a dependency graph of work and wants maximum safe parallelism with a single clean merge.
---

# Orchestration Plan Builder

Turn a pasted set of work items (Jira stories or GitHub issues) into two drop-in files:

1. An **orchestrator prompt** that an agent can follow to implement every item autonomously, fanning out specialist agents, using git worktrees for safe parallelism, and producing a clean merge.
2. A **STATE.md** tracker that serves as the resumable source of truth for the run.

The core value is converting a flat "blocked by" list into **waves**: groups of items that can run in parallel because their dependencies are already satisfied. This extracts more parallelism than a strict serial critical path while keeping parallel work from colliding.

Two defaults apply to both this skill and the plan it generates:

- **Opus 5.5 everywhere.** The orchestrator session and every specialist agent run on Opus 5.5 (`claude-opus-5-5`; Agent tool `model: "opus"`).
- **Decisions go to an arbiter, not the user.** Any question that would otherwise stop the flow to wait for the user goes to a Fable 5.1 arbiter agent (`claude-fable-5-1`; Agent tool `model: "fable"`). The arbiter decides, the decision is recorded, and the flow continues. The user reviews every arbiter decision afterwards: in this skill's final summary, and in the generated plan's final PR. See [Decision escalation](#decision-escalation-the-arbiter).

## Inputs

The user pastes the work items. Accept any reasonable shape: a markdown table, a bulleted list, or raw issue text. Extract these fields per item, leaving any you cannot find explicitly marked as unknown rather than inventing them:

- **id**: the issue number (e.g. `#128`). This is the handle used everywhere.
- **title / slice**: a short description of the work.
- **blocked by**: the list of ids this item depends on. "start now" / "none" / "-" all mean no dependency.
- **decision flags**: any ADR, design decision, or "confirm at review" note attached to the item.
- **branch slug**: derive a short kebab-case slug from the title if one is not given (e.g. `#128` "`hivemind plan` and `task claim` CLI commands" becomes `128-cli-plan-commands`).

If the dependency column is missing entirely, escalate to the arbiter whether the items are independent or share an order, giving it the item text to judge from. Do not fabricate dependencies yourself, and record the arbiter's answer as a decision so the user can see where the dependency data came from.

## Step 1: Parse the work items

Build a normalized list of items with the fields above. Echo back a compact table of what you parsed so the user can catch a misread, then continue without waiting. Keep terminology exactly as the user wrote it (issue ids, keys, names).

## Step 2: Build the dependency graph and derive waves

Treat each item as a node and each "blocked by" entry as an edge from dependency to dependent.

1. **Check for cycles.** If A blocks B and B blocks A (directly or transitively), the cycle cannot be waved. Escalate it to the arbiter with the items involved and ask which edge to drop (or whether to merge the items into one). Apply its answer, record it as a decision, and report the cycle and the resolution in the summary.
2. **Layer topologically.** Assign each item a wave number: an item with no dependencies is Wave 1; any other item lands one wave after the latest wave of all its dependencies. Formally, `wave(item) = 1 + max(wave(d) for d in deps)`, or `1` if it has no deps.
3. **Maximize parallelism, do not over-serialize.** Derive waves purely from the dependency graph. If an item only depends on one early item, it belongs in the next wave even if a human might have listed it later in a serial path. (Example: an item that depends only on a Wave 1 item belongs in Wave 2, in parallel with other Wave 2 items, not pushed to the end.)
4. **Flag shared-surface risk.** Items in the same wave run in parallel, so they must not edit the same files at the same time. You usually cannot prove file overlap from issue text, so scan titles and descriptions for shared modules, shared accessors, or the same component named across two same-wave items. Do not silently assume such pairs are safe: escalate each one to the arbiter, which can read the code and decide whether to keep the pair parallel or split the wave. The worktree model (below) contains the conflict either way, but the check decides whether the merge will be painful.

Show the derived waves (which items in each wave, and why) and the shared-surface outcomes, then generate the files without waiting.

## Step 3: Resolve configuration

The generated plan has a small configuration block. Use the user's value when they gave one, otherwise the default. Where there is no usable default (for example, an effort slug that the items do not make obvious), ask the arbiter rather than the user.

- **base branch**: default `main`.
- **integration branch**: default `feat/<short-effort-slug>`. Derive the slug from the tracking issue or the common theme of the items.
- **PR model**: `single` (default) or `per-issue`.
  - `single`: every item merges locally into the integration branch; one PR opens at the very end targeting the base branch. Fewer reviews, one clean diff.
  - `per-issue`: each item opens its own PR into the integration branch as it completes. More granular review, more overhead.
- **orchestrator model**: default Opus 5.5 (`claude-opus-5-5`). The session that runs the generated prompt should be started on it, e.g. `claude --model claude-opus-5-5`.
- **specialist agent model**: default Opus 5.5 (Agent tool `model: "opus"`). Set it explicitly on every spawn rather than relying on inheritance, because a configured default subagent model would otherwise win.
- **arbiter model**: default Fable 5.1 (Agent tool `model: "fable"`).
- **planning step**: default the `/bulletproof-plan` skill for per-item planning. This is pluggable; if the user has no such skill, substitute "produce a written implementation plan with explicit review and verification steps."

## Step 4: Generate the two files

Fill the templates in `assets/` and write both files where the user can grab them.

- `assets/orchestrator-prompt-template.md` becomes the orchestrator prompt. Substitute the configuration, drop in the per-wave tables you derived, and select the `single` or `per-issue` finalization block. Delete the unused block; do not leave both in.
- `assets/STATE-template.md` becomes `STATE.md`. One row per item, grouped by wave, with branch slug, worktree path, dependencies, and status. Pre-fill the verification-gate and ADR tables from the decision flags you parsed, and the Arbiter decisions table with any decisions the arbiter made during the build (item `plan` for ones that are not item-specific).

Keep the two files consistent. If you change a branch name or wave assignment, reconcile it in both. Echo the integration branch name identically in each.

## Decision escalation (the arbiter)

The arbiter replaces "stop and ask the user" throughout, both while you build the plan and while the orchestrator runs it. It exists so a long run does not sit idle for hours waiting on a question the user would have answered with a quick judgment call.

**What goes to the arbiter.** Anything that would otherwise be put to the user and wait for an answer: ambiguous scope ("does this item include X?"), a choice between design options, a decision or ADR flag on an item, a planning step that wants approval before code is written, a cycle or a shared-surface split, a verification gate that still fails after a reasonable fix attempt, and conflicts between an issue and the repo's docs or ADRs. Routine calls with an obvious answer are not escalated; the orchestrator makes those itself.

**How to escalate.** Spawn one agent with `model: "fable"` and a self-contained brief, since it does not see your context:

- the question, stated as a decision to make;
- the options you see, with their trade-offs, and your own recommendation;
- pointers (not pasted contents) to what it should read: the issue, the item's plan file, `STATE.md`, relevant ADRs and code paths;
- the constraints that apply (the repo's AGENTS.md, the item's acceptance criteria).

Ask it to return: the decision, a short rationale, whether the decision is reversible, and anything that only a human can do (see below). The arbiter decides; it does not implement.

**After it answers.** Record the decision (in `STATE.md` for a run, in the summary for the build step), apply it, and continue. Treat it as settled for the rest of the run; escalate the same question again only if new facts come to light, and say what changed.

**Where the arbiter's authority ends.** It cannot:

- waive a verification gate or disable a rule to make a check pass; broken work never merges;
- merge the final PR into the base branch; that stays a human review;
- perform or approve anything that needs human credentials, account access, or a physical action, or an outward-facing irreversible action the plan did not already call for (deploying, messaging people, deleting data).

When a decision needs one of those, the arbiter marks it `needs-human`. The orchestrator marks only the affected item `blocked`, keeps running every item that does not depend on it, and lists the open question in the final PR so the user can resolve it in one place.

## Wave and worktree model (why the plan is shaped this way)

The generated plan rests on three rules. Preserve them when filling the template.

- **One long-lived integration branch, plus per-item worktrees.** Each item is implemented in its own git worktree on its own branch, branched from the current tip of the integration branch. Separate worktrees mean two parallel agents never share a working tree, so same-wave work cannot clobber the same files mid-edit.
- **Branch each wave after the previous wave merges.** Dependent items inherit their dependencies' code by branching from the post-merge integration tip, so there is nothing to reconcile when they start. Re-verify the integration branch (build, lint, tests) after every merge so conflicts surface against a known-green baseline instead of piling up.
- **Do not self-merge the final PR.** The orchestrator stops at an open PR for human review.

## Worked example

Input (abbreviated, illustrative issue numbers):

```
#126 CLI device-flow login          blocked by: none
#127 plan/task schema + contract    blocked by: none
#128 plan + task claim CLI commands blocked by: #126, #127
#130 hivemind-plans agent skill     blocked by: #128
#129 dashboard plan detail page     blocked by: #127
```

Derived waves:

- Wave 1 (parallel): #126, #127 (no deps)
- Wave 2 (parallel): #128 (needs #126, #127), #129 (needs #127 only, so it joins Wave 2 rather than being serialized to the end)
- Wave 3: #130 (needs #128)

Note #129 lands in Wave 2 even though a human-written serial path might place it last. That is the parallelism the wave derivation is meant to surface. #128 and #129 would both be flagged for a shared-surface check if either one changes the plan schemas in `packages/contract`.

## Things to get right

- Mark unknowns explicitly; never invent a Jira key, dependency, or ADR.
- Use the user's exact ids and terminology throughout both files.
- When PR model is `single`, the final PR body lists `Closes <id>` for every item so they auto-close on merge, and summarizes every decision/ADR for sign-off.
- Avoid em-dashes in the generated files; use commas or parentheses.
- The plan delegates implementation to specialist agents and keeps plans and state in files on disk, so the orchestrator preserves its own context window. Reinforce this in the generated prompt.
- Never stop to wait for user input while building or running the plan; escalate to the arbiter instead. Every arbiter decision must end up somewhere the user will read it (the build summary, `STATE.md`, and the final PR body).

## Output

Write `orchestrator-prompt.md` and `STATE.md` in the root directory of this skill, present both, and give a two to three line summary of the wave structure and any shared-surface flags. List every decision the arbiter made during the build, with its one-line rationale, so the user can overturn any of them. Offer to adjust wave splits or switch the PR model.
