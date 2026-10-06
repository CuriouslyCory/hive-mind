---
status: accepted
date: 2026-09-29
---

# Record architecture decisions as repo files

## Context

hive-mind's stack decisions in [#1](https://github.com/CuriouslyCory/hive-mind/issues/1) need a written record that agents and people can read before changing an area. #1's open question 1 asks where ADRs live: markdown files in the repo, reviewed in PRs, or only inside hive-mind with an optional export. #1 recommends repo files, with hive-mind allocating numbers and indexing content once M4 exists.

M4 will parse these files (number, title, status, supersedes link, content), so the format is a contract and has to be fixed before the first ADR is written. The M0 plan ([#2](https://github.com/CuriouslyCory/hive-mind/issues/2), "ADR format and set") defines it; this ADR records it.

## Decision

ADRs are markdown files in `docs/adr/`. The repo file is the source of truth, before and after M4. This answers #1's open question 1.

- **File name:** `docs/adr/NNNN-slug.md`. `NNNN` is the zero-padded number; the slug is lowercase words joined by hyphens. The number comes from the file name only.
- **Title:** the H1, written as `# <Title>`, without the number.
- **Frontmatter:** YAML with only these keys:
  - `status`: one of `proposed`, `accepted`, `superseded`, `deprecated`.
  - `date`: ISO 8601 (`YYYY-MM-DD`), the date the current status was set.
  - `supersedes`: only when non-empty. A YAML list of plain integers such as `[4]`, never zero-padded: YAML 1.1 reads `0008` as a malformed octal.
- **Sections**, as H2s in this order: `Context`, `Decision`, `Consequences`, and `Alternatives considered` when a rejection wasn't obvious. Keep an ADR short; most are 30–50 lines. Every Context links to #1, and to the issue and PR that implemented the decision when there is one.
- **Status rule:** `accepted` if the decision is exercised by merged code or is pure policy; `proposed` otherwise. A proposed ADR names the milestone that owns it, and that milestone's PR accepts it, edits it, or supersedes it.
- **Changing a decision:** write a new ADR with `supersedes: [N]` and set ADR N's status to `superseded`. An accepted ADR's decision is not rewritten in place; correcting facts in its Consequences is allowed.
- **No other files** in `docs/adr/`: no `template.md` (it would match M4's file glob) and no `README.md` index (it would conflict under parallel PRs).

The template follows. Replace `YYYY-MM-DD` with the date the status was set. An ADR that supersedes others also gets a `supersedes` line after `date`, such as `supersedes: [4]`.

```markdown
---
status: proposed
date: YYYY-MM-DD
---

# Title of the decision

## Context

Why a decision is needed. Link #1 and the implementing issue or PR.

## Decision

What was decided.

## Consequences

What becomes easier or harder, and what was verified.

## Alternatives considered

Rejected options and why. Omit when the rejection was obvious.
```

## Consequences

- All twelve M0 numbers (0001–0012) were allocated in one PR, so they cannot collide. Until M4 allocates numbers on the server, a new ADR takes the next free number on `main`; two open PRs can pick the same number, and the second to merge must renumber. Amended 2026-10-05 by M4, [#19](https://github.com/CuriouslyCory/hive-mind/issues/19): in a repository bound to a Project, numbers now come from `hivemind adr new`, which reserves them in hive-mind (ADR-0017). The next-free-number rule and renumbering apply only to files that bypass it, and to this repository until it is bound.
- M4 can find ADRs with the glob `docs/adr/[0-9][0-9][0-9][0-9]-*.md` and read status and supersedes links from frontmatter without parsing prose.
- Adding a frontmatter key or a status value is a change to M4's parser and needs a new ADR that supersedes this one.
- ADRs go through the same PR review as code, so a decision and the change that implements it can land together.
