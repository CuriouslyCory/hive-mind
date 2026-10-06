---
"@hivemind/cli": minor
---

Add `hivemind plan decide <plan> <text>` to record a one-line decision against a Plan. The decision appears in the dashboard's Decisions panel and in the Plan's activity, where `plan log` now prints its text. The text is trimmed and must be 1 to 500 characters on one line; anything else fails with `USAGE_ERROR` before any request. Like `plan log --message`, it works in any Plan status, takes `--session` or `HIVEMIND_SESSION` for attribution, and accepts `--id` to retry a decision whose answer was lost. `--json` prints `{ event, created }`.
