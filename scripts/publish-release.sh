#!/usr/bin/env bash
# scripts/publish-release.sh — B-1475: publish one built release (scripts/build-release.mjs output).
#
# Usage: publish-release.sh <build-out-dir> <destination>
#   <destination> is gs://<bucket>   (Cloud Storage, through `gcloud storage`)
#              or a local directory   (the same semantics with plain files: tests and dry runs)
#
# The build's manifest.txt names every object (`immutable|pointer <local file> <object path>`); this script has no
# naming logic of its own. Order is the guarantee (docs/plugin-release-artefact.md, "Immutability"):
#   1. each IMMUTABLE object is created only if absent (gs: --if-generation-match=0). If it already exists, its bytes
#      are compared: identical = skip, different = exit non-zero naming the object, before any pointer is touched.
#   2. each immutable object is read back and its sha256 checked against the local file.
#   3. only then are the POINTERS written (overwrite allowed for pointers only).
set -euo pipefail

die() { echo "publish-release: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: publish-release.sh <build-out-dir> <gs://bucket | local-dir>"
OUT="$1"
DEST="${2%/}"
MANIFEST="$OUT/manifest.txt"
[ -f "$MANIFEST" ] || die "no manifest.txt in $OUT (run scripts/build-release.mjs first)"

sha() { sha256sum "$1" | cut -d' ' -f1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$DEST" in
  gs://*) BACKEND=gcs ;;
  *) BACKEND=local; mkdir -p "$DEST"; DEST="$(cd "$DEST" && pwd)" ;;
esac

# fetch <object> <file>: copy the stored object to a local file; non-zero when it does not exist.
fetch() {
  if [ "$BACKEND" = gcs ]; then
    gcloud storage cp --quiet "$DEST/$1" "$2" >/dev/null 2>&1
  else
    [ -f "$DEST/$1" ] && cp "$DEST/$1" "$2"
  fi
}

# create_only <file> <object>: 0 created, 2 already exists, other = error.
create_only() {
  if [ "$BACKEND" = gcs ]; then
    local err="$WORK/cp.err"
    if gcloud storage cp --quiet --if-generation-match=0 "$1" "$DEST/$2" 2>"$err"; then return 0; fi
    # A precondition failure means the object exists; anything else is a real error.
    if fetch "$2" "$WORK/probe"; then return 2; fi
    cat "$err" >&2
    return 1
  fi
  local target="$DEST/$2"
  [ -e "$target" ] && return 2
  mkdir -p "$(dirname "$target")"
  # Write to a temp name, then link: `ln` refuses an existing target, so this is create-only like the gs precondition.
  cp "$1" "$target.tmp.$$"
  if ln "$target.tmp.$$" "$target" 2>/dev/null; then rm -f "$target.tmp.$$"; return 0; fi
  rm -f "$target.tmp.$$"
  return 2
}

overwrite() {
  if [ "$BACKEND" = gcs ]; then
    gcloud storage cp --quiet --cache-control=no-cache "$1" "$DEST/$2" >/dev/null
  else
    mkdir -p "$(dirname "$DEST/$2")"
    cp "$1" "$DEST/$2.tmp.$$" && mv -f "$DEST/$2.tmp.$$" "$DEST/$2"
  fi
}

IMMUTABLE=()
POINTERS=()
while read -r kind file object; do
  [ -n "${kind:-}" ] || continue
  [ -f "$OUT/$file" ] || die "manifest names $file, which is not in $OUT"
  case "$object" in *..*|/*) die "refusing object path '$object'" ;; esac
  case "$kind" in
    immutable) IMMUTABLE+=("$file $object") ;;
    pointer) POINTERS+=("$file $object") ;;
    *) die "unknown manifest kind '$kind'" ;;
  esac
done < "$MANIFEST"
[ "${#IMMUTABLE[@]}" -gt 0 ] || die "manifest names no immutable objects"

# 1. create-only, compare on clash.
for entry in "${IMMUTABLE[@]}"; do
  file="${entry%% *}"; object="${entry#* }"
  rc=0; create_only "$OUT/$file" "$object" || rc=$?
  case "$rc" in
    0) echo "created $object" ;;
    2)
      fetch "$object" "$WORK/existing" || die "cannot read existing $object"
      if [ "$(sha "$WORK/existing")" = "$(sha "$OUT/$file")" ]; then
        echo "unchanged $object (identical bytes already published)"
      else
        die "$object is already published with DIFFERENT bytes; a published version is never overwritten. Pointers untouched."
      fi
      ;;
    *) die "upload of $object failed" ;;
  esac
done

# 2. read back and verify.
for entry in "${IMMUTABLE[@]}"; do
  file="${entry%% *}"; object="${entry#* }"
  fetch "$object" "$WORK/readback" || die "read-back of $object failed. Pointers untouched."
  [ "$(sha "$WORK/readback")" = "$(sha "$OUT/$file")" ] || die "read-back of $object does not match the build (sha256). Pointers untouched."
  echo "verified $object sha256 $(sha "$OUT/$file")"
done

# 3. pointers last. They never move BACKWARDS: when the channel's current release.json names a higher version (a
#    late retry of an older build), the immutable objects are still published but the pointers stay put.
version_of() { sed -n 's/^  "version": "\(.*\)",\{0,1\}$/\1/p' "$1" | head -n1; }
NEW_VERSION="$(version_of "$OUT/release.json")"
[ -n "$NEW_VERSION" ] || die "cannot read the version from $OUT/release.json"
for entry in ${POINTERS[@]+"${POINTERS[@]}"}; do
  [ "${entry%% *}" = release.json ] || continue
  if fetch "${entry#* }" "$WORK/current-release"; then
    CURRENT_VERSION="$(version_of "$WORK/current-release")"
    if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" != "$NEW_VERSION" ] \
      && [ "$(printf '%s\n%s\n' "$CURRENT_VERSION" "$NEW_VERSION" | sort -V | tail -n1)" = "$CURRENT_VERSION" ]; then
      echo "pointers left at $CURRENT_VERSION: this release ($NEW_VERSION) is older"
      exit 0
    fi
  fi
done
i=0
while [ "$i" -lt "${#POINTERS[@]}" ]; do
  entry="${POINTERS[$i]}"; i=$((i + 1))
  file="${entry%% *}"; object="${entry#* }"
  if fetch "$object" "$WORK/current" && [ "$(sha "$WORK/current")" = "$(sha "$OUT/$file")" ]; then
    echo "pointer $object already current"
    continue
  fi
  overwrite "$OUT/$file" "$object"
  echo "pointer $object -> $NEW_VERSION"
done
