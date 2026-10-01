#!/usr/bin/env bash
# GitHub release and npm publishing steps for .github/workflows/release.yml.
# Every step can be rerun after a partial failure: what already exists is
# compared, never replaced, and a mismatch stops the release.
#
#   release.sh draft <tag> <target-sha> <title> <notes-file> <prerelease:true|false> <file>...
#       Creates the draft release if it is missing, then uploads each file
#       that is not attached yet. A file already attached must have the same
#       SHA-256; an attached file not in the list is an error.
#   release.sh download <tag> <dir>
#       Downloads every asset of the release (draft or published) into <dir>.
#   release.sh publish <tag> <prerelease:true|false>
#       Publishes the draft; a release already published is left alone.
#   release.sh npm-publish <dir>
#       Publishes the tarballs listed in <dir>/npm-packages.json in order
#       (platform packages first, the launcher last). A version already on the
#       registry is skipped if its integrity matches and is an error if not.
#       NPM_PROVENANCE=true adds --provenance.
#
# Needs gh (GH_TOKEN), jq and GITHUB_REPOSITORY; npm-publish needs npm.

set -euo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

die() {
  echo "::error::$*" >&2
  exit 1
}

# The release with this tag, drafts included (the tags endpoint skips drafts).
release_json() {
  local tag="$1" found
  found="$(gh api --paginate "repos/$repo/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"$tag\") | {id, draft, target_commitish, html_url, assets: [.assets[] | {id, name}]}" |
    jq -s .)"
  case "$(jq length <<<"$found")" in
    0) ;;
    1) jq '.[0]' <<<"$found" ;;
    *) die "more than one release uses tag $tag; delete the extra drafts" ;;
  esac
}

download_asset() {
  gh api -H "Accept: application/octet-stream" "repos/$repo/releases/assets/$1" >"$2"
}

sha() { sha256sum "$1" | cut -d ' ' -f 1; }

cmd_draft() {
  local tag="$1" sha_target="$2" title="$3" notes="$4" prerelease="$5"
  shift 5
  local release
  release="$(release_json "$tag")"
  if [ -z "$release" ]; then
    local flags=(--draft --target "$sha_target" --title "$title" --notes-file "$notes")
    [ "$prerelease" = true ] && flags+=(--prerelease)
    gh release create "$tag" "${flags[@]}"
    release="$(release_json "$tag")"
    [ -n "$release" ] || die "created release $tag but cannot find it"
  fi

  local target draft
  target="$(jq -r .target_commitish <<<"$release")"
  draft="$(jq -r .draft <<<"$release")"
  [ "$target" = "$sha_target" ] ||
    die "release $tag targets $target, not $sha_target. Bump the version, or delete the draft to rebuild."

  local tmp names=()
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  for file in "$@"; do
    local name id
    name="$(basename "$file")"
    names+=("$name")
    id="$(jq -r --arg name "$name" '.assets[] | select(.name == $name) | .id' <<<"$release")"
    if [ -n "$id" ]; then
      download_asset "$id" "$tmp/$name"
      [ "$(sha "$tmp/$name")" = "$(sha "$file")" ] ||
        die "$name on $tag differs from this build; it is never overwritten. Delete the draft (or bump the version) to rebuild."
      echo "$name: already attached, identical"
    elif [ "$draft" = true ]; then
      gh release upload "$tag" "$file"
      echo "$name: uploaded"
    else
      die "release $tag is published but lacks $name"
    fi
  done
  local extra
  extra="$(jq -r --args '.assets[].name | select(. as $n | $ARGS.positional | index($n) | not)' "${names[@]}" <<<"$release")"
  [ -z "$extra" ] || die "release $tag has unexpected assets: $extra"
  echo "draft: $(jq -r .html_url <<<"$release")"
}

cmd_download() {
  local tag="$1" dir="$2" release
  release="$(release_json "$tag")"
  [ -n "$release" ] || die "no release for $tag"
  mkdir -p "$dir"
  while IFS=$'\t' read -r id name; do
    download_asset "$id" "$dir/$name"
  done < <(jq -r '.assets[] | [.id, .name] | @tsv' <<<"$release")
}

cmd_publish() {
  local tag="$1" prerelease="$2" release
  release="$(release_json "$tag")"
  [ -n "$release" ] || die "no release for $tag"
  if [ "$(jq -r .draft <<<"$release")" = false ]; then
    echo "$tag is already published"
    return
  fi
  if [ "$prerelease" = true ]; then
    gh release edit "$tag" --draft=false --prerelease
  else
    gh release edit "$tag" --draft=false --latest
  fi
}

cmd_npm_publish() {
  local dir
  dir="$(cd "$1" && pwd)"
  # npm reads the package.json of its working directory; in the repository
  # that is the root manifest, whose devEngines (pnpm) fails every npm command.
  cd "$dir"
  while IFS=$'\t' read -r name version file integrity; do
    local published err
    err="$(mktemp)"
    if published="$(npm view "$name@$version" dist.integrity 2>"$err")"; then
      :
    elif grep -q E404 "$err"; then
      published=""
    else
      cat "$err" >&2
      die "could not check $name@$version on the registry"
    fi
    rm -f "$err"
    if [ -z "$published" ]; then
      local flags=(--access public)
      [ "${NPM_PROVENANCE:-false}" = true ] && flags+=(--provenance)
      npm publish "./$file" "${flags[@]}"
      echo "$name@$version: published"
    elif [ "$published" = "$integrity" ]; then
      echo "$name@$version: already published, identical"
    else
      die "$name@$version is already on the registry with different contents ($published); npm versions cannot be replaced"
    fi
  done < <(jq -r '.[] | [.name, .version, .file, .integrity] | @tsv' npm-packages.json)
}

command="${1:-}"
shift || true
case "$command" in
  draft) cmd_draft "$@" ;;
  download) cmd_download "$@" ;;
  publish) cmd_publish "$@" ;;
  npm-publish) cmd_npm_publish "$@" ;;
  *) die "usage: release.sh draft|download|publish|npm-publish ..." ;;
esac
