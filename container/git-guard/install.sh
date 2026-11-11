#!/usr/bin/env bash
# B-1451: install the push-only git wrapper and the pre-push guard.
#   install.sh [guard-home] [bin-dir] [plugin-dir]
# guard-home defaults to $HOME/.harmony/git-guard; bin-dir to $HOME/bin.
set -euo pipefail
GUARD_HOME="${1:-$HOME/.harmony/git-guard}"
BIN_DIR="${2:-$HOME/bin}"
PLUGIN_DIR="${3:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$GUARD_HOME/hooks" "$BIN_DIR"
GUARD_HOME="$(cd "$GUARD_HOME" && pwd -P)"
BIN_DIR="$(cd "$BIN_DIR" && pwd -P)"

# The real git: the first `git` on PATH that is not a wrapper in BIN_DIR or $HOME/bin.
REAL_GIT=""
IFS=: read -r -a path_dirs <<<"$PATH"
for d in ${path_dirs[@]+"${path_dirs[@]}"}; do
  [ -n "$d" ] || continue
  [ -x "$d/git" ] && [ ! -d "$d/git" ] || continue
  rd="$(cd "$d" 2>/dev/null && pwd -P)" || continue
  [ "$rd" = "$BIN_DIR" ] && continue
  if [ -d "$HOME/bin" ] && [ "$rd" = "$(cd "$HOME/bin" && pwd -P)" ]; then continue; fi
  grep -q 'B-1451: push-only git wrapper' "$d/git" 2>/dev/null && continue
  REAL_GIT="$rd/git"
  break
done
if [ -z "$REAL_GIT" ]; then
  echo "B-1451 push guard: no real git found on PATH; guard not installed." >&2
  exit 1
fi

install -m 0755 "$SRC/hooks/pre-push" "$GUARD_HOME/hooks/pre-push"
printf '%s\n' "$REAL_GIT" >"$GUARD_HOME/real-git"
if [ -n "$PLUGIN_DIR" ]; then
  (cd "$PLUGIN_DIR" && pwd -P) >"$GUARD_HOME/plugin-dir"
else
  rm -f "$GUARD_HOME/plugin-dir"
fi
tmp="$(mktemp)"
sed -e "s|__REAL_GIT__|$REAL_GIT|" -e "s|__GUARD_HOOKS__|$GUARD_HOME/hooks|" "$SRC/git" >"$tmp"
install -m 0755 "$tmp" "$BIN_DIR/git"
rm -f "$tmp"
echo "B-1451: push guard installed (wrapper $BIN_DIR/git, real git $REAL_GIT)."
