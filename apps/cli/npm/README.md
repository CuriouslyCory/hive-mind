# hivemind

Command-line client for hive-mind.

```sh
npm install -g {{name}}
hivemind --help
```

Or run it without a global install:

```sh
npx {{name}} --help
```

This package is a small launcher. npm installs the standalone `hivemind` binary for your platform
from one of its optional dependencies, and the launcher runs it, passing through arguments,
signals and the exit code. Supported platforms: Linux (glibc) and macOS, each on x64 and arm64.
Linux x64 needs a CPU with AVX2.

If the launcher reports that the platform package is missing, reinstall without
`--omit=optional` (or `--no-optional`), or install the binary with the script from the project's
GitHub Releases instead.
