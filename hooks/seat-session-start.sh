#!/bin/sh
# B-1423 — the SEAT SESSION-START hook (Claude Code `SessionStart`).
#
# Acts ONLY for a session named by a seat profile: a `session_id: <id>` line in
# ${HARMONY_HOME:-$HOME/.harmony}/seats/<name>.yml (format: docs/harmony-watch-files.md). The id may
# be unquoted, double- or single-quoted (B-1429); the one grep takes all three fixed lines. For such a
# session it runs `dist/bin/seat-hook.js start`, which puts a one-shot `harmony watch --once` board
# summary in the session's context.
#
# THE FAST PATH is everything above the node call: a directory test and one fixed-string grep, no
# interpreter. A session no profile names (every cloud leg, every ordinary session) prints `{}` and
# exits without starting node. A fresh start gets a new session id, so it matches no profile until the
# seat rewrites its profile's `session_id:`; a resume keeps its id and matches.
#
# Every failure prints `{}` and exits 0. This hook never fails a session start.

INPUT=$(cat 2>/dev/null)

noop() {
  printf '{}\n'
  exit 0
}

ID=$(printf '%s' "$INPUT" | tr -d '\n' \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$ID" in
  '' | *[!A-Za-z0-9_-]*) noop ;;
esac

D="${HARMONY_HOME:-$HOME/.harmony}/seats"
[ -d "$D" ] || noop
PROFILE=$(grep -l -x -F -e "session_id: $ID" -e "session_id: \"$ID\"" -e "session_id: '$ID'" "$D"/*.yml 2>/dev/null | head -n 1)
[ -n "$PROFILE" ] || noop

ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
HOOK="$ROOT/dist/bin/seat-hook.js"
[ -f "$HOOK" ] || noop
command -v node >/dev/null 2>&1 || noop

OUT=$(printf '%s' "$INPUT" | node "$HOOK" start "$PROFILE" 2>/dev/null)
[ -n "$OUT" ] || noop
printf '%s\n' "$OUT"
exit 0
