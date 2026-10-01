#!/bin/sh
# Installs the hivemind CLI from GitHub Releases.
#
#   curl -fsSL https://github.com/CuriouslyCory/hive-mind/releases/latest/download/install.sh | sh
#   sh install.sh [--version <version>] [--install-dir <dir>]
#
# Environment (flags take precedence):
#   HIVEMIND_VERSION       Release to install, such as 0.1.0 or v0.1.0. Default: the latest.
#   HIVEMIND_INSTALL_DIR   Directory for the binary. Default: $HOME/.local/bin.
#   HIVEMIND_RELEASES_URL  Release download base. Default:
#                          https://github.com/CuriouslyCory/hive-mind/releases.
#                          Must be https, except http on localhost/127.0.0.1 and
#                          file:// (a local mirror, which needs a pinned version).
#
# Supports Linux (glibc) and macOS on x64 and arm64. Downloads the archive and
# SHA256SUMS, verifies the checksum, stages the new binary in the install
# directory, checks that it runs there and reports the expected version, and
# only then replaces the installed binary with an atomic rename. Nothing is
# executed from $TMPDIR, so a noexec /tmp is fine. On any failure or
# interruption the existing installation is left untouched and temporary files
# are removed. Never uses sudo and never edits shell startup files.

set -eu

REPO_RELEASES="https://github.com/CuriouslyCory/hive-mind/releases"
BINARY="hivemind"

say() { printf 'hivemind-install: %s\n' "$*" >&2; }
die() {
  say "error: $*"
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: install.sh [--version <version>] [--install-dir <dir>]
Installs the hivemind CLI for Linux or macOS (x64, arm64) into a user directory.
EOF
}

version="${HIVEMIND_VERSION:-}"
install_dir="${HIVEMIND_INSTALL_DIR:-}"
releases="${HIVEMIND_RELEASES_URL:-$REPO_RELEASES}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version needs a value"
      version="$2"
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || die "--install-dir needs a value"
      install_dir="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

# --- platform -----------------------------------------------------------------

os_name="$(uname -s)"
machine="$(uname -m)"
case "$os_name" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) die "unsupported operating system: $os_name. Supported: Linux and macOS (x64, arm64)." ;;
esac
case "$machine" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) die "unsupported CPU architecture: $machine. Supported: x64 and arm64 on Linux and macOS." ;;
esac

if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
  # A shell under Rosetta reports x86_64 on Apple silicon; use the native build.
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    arch="arm64"
  fi
fi

if [ "$os" = "linux" ]; then
  if (ldd --version 2>&1 || true) | grep -qi musl; then
    die "this system uses musl libc (for example Alpine). hivemind supports glibc-based Linux only."
  fi
  if [ "$arch" = "x64" ] && [ -r /proc/cpuinfo ] && ! grep -qw avx2 /proc/cpuinfo; then
    die "this CPU lacks AVX2, which the Linux x64 build requires (x86-64-v3, roughly 2013 or newer)."
  fi
fi

# --- tools and source -------------------------------------------------------

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "sha256sum or shasum is required"
fi

releases="${releases%/}"
case "$releases" in
  https://*) curl_proto="=https" ;;
  http://localhost:* | http://localhost/* | http://127.0.0.1:* | http://127.0.0.1/*) curl_proto="=http" ;;
  file://*) curl_proto="=file" ;;
  *) die "HIVEMIND_RELEASES_URL must use https (http only for localhost): $releases" ;;
esac

# --fail turns HTTP errors into failures; redirects may not leave the scheme.
fetch() {
  curl --fail --silent --show-error --location --proto "$curl_proto" --proto-redir "$curl_proto" \
    --retry 2 --connect-timeout 20 --output "$2" "$1"
}

if [ -z "$version" ]; then
  case "$releases" in
    file://*) die "set HIVEMIND_VERSION (or --version) when installing from a file:// mirror" ;;
  esac
  # /releases/latest redirects to /releases/tag/v<version>.
  latest_url="$(curl --fail --silent --show-error --location --proto "$curl_proto" \
    --proto-redir "$curl_proto" --connect-timeout 20 --output /dev/null \
    --write-out '%{url_effective}' "$releases/latest")" || die "could not look up the latest release at $releases/latest"
  version="${latest_url##*/tag/}"
  [ "$version" != "$latest_url" ] || die "could not find the latest version from $latest_url"
fi
version="${version#v}"
case "$version" in
  "" | *[!0-9A-Za-z.-]*) die "invalid version: $version" ;;
esac

asset="$BINARY-$version-$os-$arch.tar.gz"
base="$releases/download/v$version"

# --- install directory -------------------------------------------------------

if [ -z "$install_dir" ]; then
  [ -n "${HOME:-}" ] || die "HOME is not set; pass --install-dir"
  install_dir="$HOME/.local/bin"
fi
case "$install_dir" in
  /*) ;;
  *) install_dir="$(pwd)/$install_dir" ;;
esac
mkdir -p "$install_dir" 2>/dev/null || die "cannot create $install_dir; choose a writable directory with --install-dir"
[ -w "$install_dir" ] || die "$install_dir is not writable; choose another directory with --install-dir (sudo is never used)"
target="$install_dir/$BINARY"
if [ -d "$target" ]; then
  die "$target is a directory"
fi

# --- download, verify, replace ----------------------------------------------

tmp=""
staged=""
cleanup() {
  [ -z "$staged" ] || rm -f "$staged"
  [ -z "$tmp" ] || rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hivemind-install.XXXXXX")"

say "downloading $asset (v$version, $os-$arch)"
fetch "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

# Exactly one line must name the asset, in sha256sum format: "<hex>  <name>".
expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")"
case "$expected" in
  "") die "SHA256SUMS has no entry for $asset" ;;
  # A newline (repeated entry) is also outside [0-9a-f].
  *[!0-9a-f]*) die "SHA256SUMS has a malformed or repeated entry for $asset" ;;
esac
[ "${#expected}" -eq 64 ] || die "SHA256SUMS has a malformed entry for $asset"
actual="$(sha256 "$tmp/$asset")"
[ "$actual" = "$expected" ] || die "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"

# The archive must hold exactly one entry, the binary, so extraction cannot
# write anywhere else.
entries="$(tar -tzf "$tmp/$asset")" || die "$asset is not a valid archive"
[ "$entries" = "$BINARY" ] || die "$asset has unexpected contents"
mkdir "$tmp/extract"
tar -xzf "$tmp/$asset" -C "$tmp/extract" || die "could not extract $asset"
[ -f "$tmp/extract/$BINARY" ] && [ ! -L "$tmp/extract/$BINARY" ] || die "$asset does not contain a regular file named $BINARY"

# Stage next to the target so the final rename stays on one filesystem and is
# atomic: the old binary is replaced whole or not at all. The version check
# runs on the staged copy, not in $TMPDIR: hardened hosts often mount /tmp
# noexec, and the install directory is where the binary has to run anyway.
staged="$install_dir/.$BINARY.install.$$"
cp "$tmp/extract/$BINARY" "$staged" || die "could not write to $install_dir"
chmod 0755 "$staged"

# The new binary must run here and be the requested version before it
# replaces anything. The shell exits 126 when it cannot execute the file at
# all (permission denied, which includes a noexec mount, or a wrong format).
status=0
reported="$("$staged" --version 2>&1)" || status=$?
if [ "$status" -eq 126 ]; then
  die "cannot execute the downloaded binary in $install_dir: $reported. If that directory is on a filesystem mounted noexec, choose another with --install-dir."
elif [ "$status" -ne 0 ]; then
  die "the downloaded binary does not run on this system (exit $status): $reported"
fi
case "$reported" in
  "$BINARY $version "*) ;;
  *) die "the downloaded binary reports '$reported', expected version $version" ;;
esac

mv -f "$staged" "$target" || die "could not replace $target"
staged=""

say "installed $reported to $target"
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) say "$install_dir is not on PATH. Add it in your shell profile, for example: export PATH=\"$install_dir:\$PATH\"" ;;
esac
