#!/bin/sh
# B-870 — the Harmony STOP GATE (Claude Code `Stop` hook).
#
# A ticket-driving session must not be able to end its turn with nothing on the Harmony board.
# This wrapper exists for ONE reason: the fast path. A session that is not conducting a ticket must
# reach its turn-end with no measurable delay and no network call (AC9), so the breadcrumb check is
# a plain `test -f` in POSIX shell — no node, no interpreter, no I/O beyond one stat.
#
# Contract with the runtime (live-smoked):
#   * stdin carries the Stop JSON (session_id, transcript_path, cwd, hook_event_name,
#     stop_hook_active, last_assistant_message);
#   * exit 2 with a reason on stderr BLOCKS the turn-end and the reason reaches the model;
#   * any other exit code allows it.
#
# Every failure mode here exits 0. A broken gate must never wedge a terminal.

INPUT=$(cat 2>/dev/null)

# The session id, without starting an interpreter. The payload is JSON on one logical line; flatten
# it first so the match works even if the runtime ever pretty-prints.
SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\n' \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$SESSION_ID" ] || exit 0

# THE FAST PATH. No breadcrumb ⇒ this session is not driving a ticket ⇒ nothing to enforce.
HARMONY_DIR="${HARMONY_HOME:-$HOME/.harmony}"
BREADCRUMB="$HARMONY_DIR/conduct-sessions/$SESSION_ID.json"
[ -f "$BREADCRUMB" ] || exit 0

# The operator's escape switch — a control only a human can set (their own shell profile), and its
# use is always visible in the session log. Deliberately absent from every daemon/container profile.
if [ -n "${HARMONY_STOP_GATE_OFF:-}" ]; then
  printf '[harmony stop-gate] DISABLED for this session via HARMONY_STOP_GATE_OFF — turn-end allowed without a board check.\n' >&2
  exit 0
fi

ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
GATE="$ROOT/dist/bin/stop-gate.js"
[ -f "$GATE" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

printf '%s' "$INPUT" | node "$GATE" "$BREADCRUMB"
exit $?
