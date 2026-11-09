#!/bin/sh
# B-1423 — the SEAT STOP GUARD (Claude Code `Stop` hook, registered beside stop-gate.sh).
#
# Acts ONLY for a session named by a seat profile: a `session_id: <id>` line in
# ${HARMONY_HOME:-$HOME/.harmony}/seats/<name>.yml (format: docs/harmony-watch-files.md). The id may
# be unquoted, double- or single-quoted (B-1429); the one grep takes all three fixed lines. For such a
# session it runs `dist/bin/seat-hook.js stop`, which blocks the turn-end (exit 2, reason on stderr)
# when the seat's standing `harmony watch` is not running, and names the re-arm command.
#
# THE FAST PATH is everything above the node call: a directory test and one fixed-string grep, no
# interpreter. A session no profile names (every cloud leg, every ordinary session) exits 0 without
# starting node. Standing a seat down = deleting its profile, which puts it back on the fast path.
#
# Every failure exits 0. Only the decision's own exit 2 blocks.

INPUT=$(cat 2>/dev/null)

ID=$(printf '%s' "$INPUT" | tr -d '\n' \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$ID" in
  '' | *[!A-Za-z0-9_-]*) exit 0 ;;
esac

D="${HARMONY_HOME:-$HOME/.harmony}/seats"
[ -d "$D" ] || exit 0
PROFILE=$(grep -l -x -F -e "session_id: $ID" -e "session_id: \"$ID\"" -e "session_id: '$ID'" "$D"/*.yml 2>/dev/null | head -n 1)
[ -n "$PROFILE" ] || exit 0

ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
HOOK="$ROOT/dist/bin/seat-hook.js"
[ -f "$HOOK" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

printf '%s' "$INPUT" | node "$HOOK" stop "$PROFILE"
[ $? -eq 2 ] && exit 2
exit 0
