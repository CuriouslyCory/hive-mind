---
"@hivemind/cli": patch
---

Build the binaries with Bun 1.4.4 (was 1.4.2), with oRPC 1.16.1 and zod 4.6.7 bundled. Commands, flags and `--json` output are unchanged. Each binary is about 28 MB larger, about 90–110 MB depending on the platform. The platform minimums are the same: glibc 2.17 on Linux, macOS 13.
