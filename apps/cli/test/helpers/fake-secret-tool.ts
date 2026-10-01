import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Fake `secret-tool` executables for hosts without libsecret (this one, and
// CI). Each returns the directory to prepend to PATH.

function install(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "secret-tool");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return dir;
}

/**
 * Behaves like secret-tool store/lookup/clear against files in `state`,
 * including the real tool's exit 1 with no output from `lookup` and `clear`
 * when nothing matches (Ubuntu 24.04). Every
 * argv is appended to `state/argv.log` and every stdin payload to
 * `state/stdin.log`, so tests can check where the secret travelled.
 */
export function workingSecretTool(dir: string, state: string): string {
  mkdirSync(state, { recursive: true });
  return install(
    dir,
    `state=${JSON.stringify(state)}
printf '%s\\n' "$*" >> "$state/argv.log"
cmd="$1"; shift
[ "$cmd" = store ] && shift  # drop --label=...
key=$(printf '%s' "$*" | od -An -tx1 | tr -d ' \\n')
case "$cmd" in
  store) cat > "$state/item-$key"; cat "$state/item-$key" >> "$state/stdin.log" ;;
  lookup) [ -f "$state/item-$key" ] || exit 1; cat "$state/item-$key" ;;
  clear) [ -f "$state/item-$key" ] || exit 1; rm -f "$state/item-$key" ;;
  *) echo "secret-tool: unknown command" >&2; exit 2 ;;
esac`,
  );
}

/** Never answers, like a client stuck on an unresponsive bus. Records its pid. */
export function hangingSecretTool(dir: string, pidFile: string): string {
  return install(dir, `echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 300`);
}

/** Exits 1 with `stderr`, like secret-tool on a host without a Secret Service. */
export function failingSecretTool(dir: string, stderr: string): string {
  return install(dir, `echo ${JSON.stringify(stderr)} >&2\nexit 1`);
}
