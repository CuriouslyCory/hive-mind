---
"@hivemind/cli": minor
---

Add `hivemind adr` commands. `adr new` reserves the next ADR number from hive-mind and writes the ADR template, so two agents never pick the same number. `adr list` and `adr show` read hive-mind's copy of the ADRs, `adr status` and `adr supersede` edit local ADR files, and `adr sync` copies the ADR files of one commit (by default `origin/HEAD`) into hive-mind. `adr sync --check` validates `docs/adr/` without logging in, for pull request CI.
