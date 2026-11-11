#!/usr/bin/env bash
# B-1451: refuse to start the agent on a plugin checkout with uncommitted changes.
# Prints paths only (porcelain columns 4+), never contents. Exit 1 when dirty.
set -u
dir="${1:?usage: dirty-check.sh <plugin-dir>}"
paths="$(git -C "$dir" status --porcelain 2>/dev/null | cut -c4- | paste -sd, - | sed 's/,/, /g')"
if [ -n "$paths" ]; then
  echo "B-1451: refusing to start the agent: the plugin checkout has uncommitted changes: $paths" >&2
  exit 1
fi
exit 0
