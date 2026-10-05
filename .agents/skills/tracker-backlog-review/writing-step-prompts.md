# Writing backlog step prompts

A step prompt is pasted as the first message of a fresh agent run: a new Claude Code conversation that has none of the backlog context you have now, and that runs unattended for hours. It succeeds when it reaches a finish line it can check on its own and stops only where the user is actually needed. Each rule below serves one of those two things.

## The shape

Every step prompt answers four questions, in this order:

1. **What to build.** The issue URL on the first line, then one sentence naming the outcome of this run. Hand over the whole step in one message; the run should come in early and go all the way to the end.
2. **What done means.** A list of checkable end states. "Plan posted as a comment on #19 and its URL returned" can be checked. "Plan the issue" cannot. Without a finish line, Opus 5.5 may stop after the first phase and report instead of continuing.
3. **What it may do without asking.** Pre-authorise every action you can foresee that would otherwise make it pause for permission, such as adding a new fixture file under `packages/contract/test/fixtures/v1/`, commenting on or closing the issue, opening a follow-up issue, or pushing a branch. Anything left unsaid is something it may stop to ask about.
4. **When to stop and ask.** Name the stops, then tell it to keep going through everything else. This part lets it ask for help. The model is trained to resolve its own questions and push through, so without explicit stop conditions it will guess where it should have asked.

Then say what the final report should contain (see [The report](#the-report)).

## Coding steps

Every step that changes code ends with the same three items in its done list, in this order:

1. **CodeRabbit review.** Once the repo checks pass, run `coderabbit review --agent --base main` on the branch.
2. **Remediation.** Fix each valid finding. For each finding it rejects, give a one-line reason. Then rerun the checks until they pass again.
3. **Pull request.** Open a PR against `main` as the last action, and link it on the issue.

Put all three in the done list itself. In the "You may" part, pre-authorise pushing the branch and opening the PR. Steps that don't change code, such as planning or reproducing a bug, leave these items out.

## Stops

Write the stops as an exhaustive list. Everything else is a keep-going step: status notes go in the same message as the next action, and phases run back to back. When a step spans phases, say "do every phase in one pass". Otherwise the run may finish phase 0 and wait.

The stops for this repo, from `AGENTS.md`:

- **A schema change that cannot be made expand/contract.** The Vercel build migrates the database before the new code is live, so the running deployment must keep working on the new schema.
- **A change to anything pinned in `packages/contract/test/fixtures/v1/`**: removing or changing a route, status, field or error code breaks released CLIs (ADR-0009). Adding a response field, a route or a new fixture file does not, and can be pre-authorised.
- **Destructive or outward-facing actions**: deleting data, force-pushing, running `drizzle-kit push` or applying migrations against a shared (non-local) database, deleting a Neon preview database branch (only the repo owner can; the PR asks them, see `AGENTS.md` → Schema changes), and anything outside this repo.
- **A check that passes only by disabling a lint rule, adding a suppression comment or skipping a test.**
- **A failing check it cannot explain.**
- **The CodeRabbit quota.** It allows 5 reviews an hour, shared across all runs. Tell the run to poll `coderabbit usage` and wait for quota rather than buy credits.

For decisions a specialist can settle (API shape, test strategy, naming), keep the existing instruction to escalate them to specialist subagents. Stopping for those would leave the run waiting on the user for decisions it can make itself.

## Content

- **Include what it cannot find by looking**: ordering constraints between issues, what an earlier step or PR decided, which seams belong to other issues, and why the issue sits in its phase. Leave out what one `gh issue view` or file read gives it.
- **Name the checks that prove the work.** For this repo these are the four from `AGENTS.md` → Done: `pnpm lint`, `pnpm typecheck`, `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test` and `pnpm build`, after `docker compose up -d`. Add:
  - `TEST_DATABASE_URL=… pnpm test:e2e` when the change touches device login, `/api/v1` auth or a CLI command;
  - for a change to the dashboard, its Event stream or its live updates, `pnpm test:e2e` twice: once under `next dev` and once with `E2E_SERVER=start` after `pnpm build`;
  - for a schema change, a migration generated with `pnpm db:generate` and committed;
  - for a user-visible CLI change, a changeset (`pnpm changeset`) committed with the change.

  Then ask it to list anything it could not verify, and why.
- **Tell it to use subagents** when the work splits into independent parts, such as several packages, an audit, or many review findings. Opus 5.5 underuses them unless told. Keep the standing line "Always use Opus 5.5 based sub agents."
- **For design work, give both lists**: the target look and the specific patterns to leave out (for example, pill buttons, monospace labels, or numbered section labels). A general "avoid generic looks" only swaps one default style for another. The dashboard uses plain CSS in `apps/web`; point to the existing pages it should match.
- **Spend the words on facts and finish lines.** Instructions to "think hard" or "think carefully" change nothing because the model already reasons before replying, so leave them out.
- **Ask for rationale, not reasoning.** Phrase it as "say why you chose X over Y". Requests to show its reasoning or thinking can trip the model's safeguards and move the run to an older model.

## The report

End each prompt by asking for a final message in this order:

1. **Blocked on me**: decisions left open and approvals needed. This goes first because it is what the user reads first.
2. **Changed**: PR or comment links and what each one does.
3. **Found**: surprises, follow-up issues, and anything it could not verify.
4. **Merge risk**, for implementation steps: the worst plausible effect of merging today.

## Check before saving

Read each prompt as the fresh run will, with no backlog context:

- Can it tell done from not done without asking?
- If it changes code, does the done list end with the CodeRabbit review, remediation, and the PR?
- Would any foreseeable action make it pause for permission that the prompt could have granted?
- Is every stop listed, with everything else a keep-going step?
- Could it follow this prompt with no other context?

## Example

Issue #19's body is already the M4 implementation plan, so its implementation step reads:

```text
https://github.com/CuriouslyCory/hive-mind/issues/19
Implement M4 as specified in the issue body: ADR number reservations, `hivemind adr new/list/show/status/supersede/sync`, the ADR `/api/v1` routes, and the ADR dashboard pages with live updates.
Done means: pnpm lint, pnpm typecheck, TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test and pnpm build pass; pnpm test:e2e passes under next dev and again with E2E_SERVER=start after pnpm build; the migration is generated with pnpm db:generate, is expand-only and is committed; every existing file in packages/contract/test/fixtures/v1/ is byte-identical; the reader for the new adr.* Events lands in a commit before any writer, as the issue requires; a changeset covers the new `hivemind adr` commands; `coderabbit review --agent --base main` has run, each valid finding is fixed and each rejected one has a one-line reason, and the checks pass again afterwards; a PR against main is open and linked on the issue.
You may add the new fixture files and Project key permissions the issue specifies, comment on the issue, open follow-up issues (including the one for .github/workflows/adr-sync.yml if its Project key secret does not exist), push the branch, and open the PR without asking.
Fan out Opus 5.5 based sub agents for independent parts (the parser, the schema and routes, the CLI, the dashboard pages), and escalate design decisions to specialist agents. Do every phase in one pass.
Stop and ask me only if: a schema change cannot be expand-only; an existing file in packages/contract/test/fixtures/v1/ would change; it would delete data, force-push, run drizzle-kit push or apply a migration to a non-local database, delete a Neon database branch, or touch anything outside this repo; a check passes only by disabling a rule, adding a suppression or skipping a test; a check fails for a reason you cannot explain; or CodeRabbit quota stays exhausted (poll `coderabbit usage`; do not buy credits).
Finish with: Blocked on me, Changed (PR link), Found (including anything you could not verify), and the risk of merging today.
```
