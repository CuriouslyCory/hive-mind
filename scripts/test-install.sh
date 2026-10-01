#!/bin/sh
# Tests scripts/install.sh against a local release mirror: an HTTP fixture
# server on 127.0.0.1 (Node, which the repo already needs) and a file://
# mirror. The "binaries" are shell scripts that print a version, packed and
# checksummed like real release assets for this host's platform.
#
#   sh scripts/test-install.sh        (or: pnpm test:install)
#   SH=bash sh scripts/test-install.sh   runs install.sh under another shell
#                                        (SH is one command name or path)
#
# Covers: fresh, repeat and pinned installs into a path with spaces; latest
# lookup; file:// mirror; unsupported OS and CPU; non-https mirror; missing
# asset; bad checksum; truncated download; interrupted download; a binary that
# reports the wrong version; an archive with extra entries. Every failure case
# checks that the existing installation is byte-for-byte unchanged and that no
# temporary or staged files are left behind.

set -eu

SH="${SH:-sh}"
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
installer="$root_dir/scripts/install.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/hivemind install test.XXXXXX")"
server_pid=""
cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d ' ' -f 1; }
else
  sha() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
fi

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported test host" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) echo "unsupported test host" >&2; exit 1 ;; esac
if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi

# --- fixture releases ----------------------------------------------------------

releases="$work/mirror/releases"

# make_release <version> [reported version] [sums: good|bad|none] [extra entry]
make_release() {
  v="$1"
  reported="${2:-$1}"
  sums="${3:-good}"
  dir="$releases/download/v$v"
  stage="$work/stage/$v"
  mkdir -p "$dir" "$stage"
  printf '#!/bin/sh\necho "hivemind %s (test, fixture)"\n' "$reported" >"$stage/hivemind"
  chmod 0755 "$stage/hivemind"
  asset="hivemind-$v-$os-$arch.tar.gz"
  if [ -n "${4:-}" ]; then
    printf 'x\n' >"$stage/$4"
    tar -czf "$dir/$asset" -C "$stage" hivemind "$4"
  else
    tar -czf "$dir/$asset" -C "$stage" hivemind
  fi
  # A decoy line for another platform, as in a real SHA256SUMS.
  printf '%s  hivemind-%s-other-arch.tar.gz\n' "$(printf '0%.0s' $(seq 64))" "$v" >"$dir/SHA256SUMS"
  case "$sums" in
    good) printf '%s  %s\n' "$(sha "$dir/$asset")" "$asset" >>"$dir/SHA256SUMS" ;;
    bad) printf '%s  %s\n' "$(printf 'a%.0s' $(seq 64))" "$asset" >>"$dir/SHA256SUMS" ;;
    none) ;;
  esac
}

make_release 9.9.9            # latest
make_release 9.9.8            # an older, pinned release
make_release 9.9.6 9.9.6 bad  # SHA256SUMS does not match
make_release 9.9.7            # served truncated
make_release 9.9.5            # served slowly, then interrupted
make_release 9.9.4 1.0.0      # binary reports another version
make_release 9.9.3 9.9.3 good evil  # archive holds an extra file
make_release 9.9.2 9.9.2 none # no checksum entry for this platform

cat >"$work/server.mjs" <<'EOF'
import { createReadStream, statSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const [root, log, portFile] = process.argv.slice(2);
const server = createServer((req, res) => {
  appendFileSync(log, `${req.url}\n`);
  if (req.url === "/releases/latest") {
    res.writeHead(302, { location: "/releases/tag/v9.9.9" });
    return res.end();
  }
  if (req.url.startsWith("/releases/tag/")) return res.end("release page");
  const path = join(root, decodeURIComponent(req.url));
  let size;
  try {
    size = statSync(path).size;
  } catch {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "content-length": size });
  if (req.url.includes("/v9.9.7/") && req.url.endsWith(".tar.gz")) {
    // Half the body, then the connection drops.
    createReadStream(path, { end: Math.floor(size / 2) }).on("end", () => res.destroy()).pipe(res, { end: false });
  } else if (req.url.includes("/v9.9.5/") && req.url.endsWith(".tar.gz")) {
    res.write("\x1f\x8b"); // and never finish
  } else {
    createReadStream(path).pipe(res);
  }
});
server.listen(0, "127.0.0.1", () => appendFileSync(portFile, String(server.address().port)));
EOF
: >"$work/requests.log"
node "$work/server.mjs" "$work/mirror" "$work/requests.log" "$work/port" &
server_pid=$!
i=0
while [ ! -s "$work/port" ]; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || { echo "fixture server did not start" >&2; exit 1; }
  sleep 0.1
done
http_url="http://127.0.0.1:$(cat "$work/port")/releases"

# --- helpers -----------------------------------------------------------------------

bin_dir="$work/install dir/with spaces/bin"
tmp_dir="$work/tmp dir"
mkdir -p "$tmp_dir"
out="$work/out.txt"

# install_with <releases url> [VAR=value ...] -- [installer args]
install_with() {
  url="$1"
  shift
  env HIVEMIND_RELEASES_URL="$url" HIVEMIND_INSTALL_DIR="$bin_dir" TMPDIR="$tmp_dir" \
    HIVEMIND_VERSION= "$@" >"$out" 2>&1
}
run_installer() { install_with "$@" "$SH" "$installer"; }

installed_version() { "$bin_dir/hivemind" --version 2>/dev/null | cut -d ' ' -f 2; }

no_leftovers() {
  [ -z "$(ls -A "$tmp_dir")" ] && [ -z "$(find "$bin_dir" -name '.hivemind.install.*')" ]
}

# expect_failure <name> <message pattern> <releases url> [VAR=value ...]
# Runs the installer, which must fail with the message and change nothing.
expect_failure() {
  name="$1"
  pattern="$2"
  shift 2
  before="$(sha "$bin_dir/hivemind")"
  if run_installer "$@"; then
    fail "$name: installer succeeded"
  elif ! grep -q -- "$pattern" "$out"; then
    fail "$name: message did not match '$pattern': $(cat "$out")"
  elif [ "$(sha "$bin_dir/hivemind")" != "$before" ]; then
    fail "$name: the existing installation changed"
  elif ! no_leftovers; then
    fail "$name: temporary files were left behind"
  else
    pass "$name"
  fi
}

# --- cases ---------------------------------------------------------------------------

if run_installer "$http_url" && [ "$(installed_version)" = 9.9.9 ] && [ -x "$bin_dir/hivemind" ] && no_leftovers; then
  pass "fresh install of the latest release into a path with spaces"
else
  fail "fresh install: $(cat "$out")"
fi

if run_installer "$http_url" && [ "$(installed_version)" = 9.9.9 ] && no_leftovers; then
  pass "repeat install"
else
  fail "repeat install: $(cat "$out")"
fi

if install_with "$http_url" "$SH" "$installer" --version v9.9.8 && [ "$(installed_version)" = 9.9.8 ]; then
  pass "pinned version with --version v9.9.8"
else
  fail "pinned version: $(cat "$out")"
fi

# curl wants a URL, so the spaces in the mirror path are percent-encoded.
file_url="file://$(printf '%s' "$releases" | sed 's/ /%20/g')"
if run_installer "$file_url" HIVEMIND_VERSION=9.9.9 && [ "$(installed_version)" = 9.9.9 ]; then
  pass "install from a file:// mirror"
else
  fail "file:// mirror: $(cat "$out")"
fi

# From here the installed 9.9.9 must survive every failure.
expect_failure "file:// mirror needs a pinned version" "set HIVEMIND_VERSION" "$file_url"
expect_failure "rejects a non-https mirror" "must use https" "http://example.com/releases" HIVEMIND_VERSION=9.9.8
expect_failure "missing release asset" "download failed" "$http_url" HIVEMIND_VERSION=1.2.3
expect_failure "bad checksum" "checksum mismatch" "$http_url" HIVEMIND_VERSION=9.9.6
expect_failure "no checksum entry" "SHA256SUMS has no entry" "$http_url" HIVEMIND_VERSION=9.9.2
expect_failure "truncated download" "download failed" "$http_url" HIVEMIND_VERSION=9.9.7
expect_failure "binary reports the wrong version" "expected version 9.9.4" "$http_url" HIVEMIND_VERSION=9.9.4
expect_failure "archive with extra entries" "unexpected contents" "$http_url" HIVEMIND_VERSION=9.9.3

# Unsupported platforms: a fake uname first on PATH. Nothing may be downloaded.
fake_uname() {
  mkdir -p "$work/uname-$1-$2"
  cat >"$work/uname-$1-$2/uname" <<EOF
#!/bin/sh
case "\$1" in -s) echo $1 ;; -m) echo $2 ;; *) exit 1 ;; esac
EOF
  chmod +x "$work/uname-$1-$2/uname"
  printf '%s' "$work/uname-$1-$2:$PATH"
}
requests_before="$(wc -l <"$work/requests.log")"
expect_failure "unsupported OS" "unsupported operating system: FreeBSD" "$http_url" PATH="$(fake_uname FreeBSD amd64)"
expect_failure "unsupported OS (Windows shell)" "unsupported operating system: MINGW64_NT" "$http_url" PATH="$(fake_uname MINGW64_NT-10.0 x86_64)"
expect_failure "unsupported CPU" "unsupported CPU architecture: i686" "$http_url" PATH="$(fake_uname Linux i686)"
expect_failure "unsupported CPU (armv7)" "unsupported CPU architecture: armv7l" "$http_url" PATH="$(fake_uname Linux armv7l)"
if [ "$(wc -l <"$work/requests.log")" = "$requests_before" ]; then
  pass "unsupported platforms download nothing"
else
  fail "unsupported platforms made requests"
fi

# Interrupted download: the 9.9.5 archive never finishes. Signal the installer
# and its curl, as Ctrl-C would (the shell runs its trap once curl exits).
before="$(sha "$bin_dir/hivemind")"
env HIVEMIND_RELEASES_URL="$http_url" HIVEMIND_INSTALL_DIR="$bin_dir" TMPDIR="$tmp_dir" \
  HIVEMIND_VERSION=9.9.5 "$SH" "$installer" >"$out" 2>&1 &
pid=$!
i=0
started=yes
until grep -q "/v9.9.5/hivemind" "$work/requests.log"; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || { started=no; break; }
  sleep 0.1
done
sleep 0.3
# env execs the shell, so $pid is the installer itself.
kill -TERM "$pid" 2>/dev/null || true
pkill -TERM -P "$pid" 2>/dev/null || true
status=0
wait "$pid" || status=$?
if [ "$started" = no ]; then
  fail "interrupted download: the installer never requested the archive: $(cat "$out")"
elif [ "$status" -ne 143 ]; then
  fail "interrupted download: expected exit 143 from the TERM trap, got $status: $(cat "$out")"
elif [ "$(sha "$bin_dir/hivemind")" != "$before" ]; then
  fail "interrupted download: the existing installation changed"
elif ! no_leftovers; then
  fail "interrupted download: temporary files were left behind ($(ls -A "$tmp_dir"))"
else
  pass "interrupted download"
fi

if [ "$failures" -ne 0 ]; then
  printf '%s installer test(s) failed\n' "$failures"
  exit 1
fi
printf 'all installer tests passed (%s)\n' "$SH"
