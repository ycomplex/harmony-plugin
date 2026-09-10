#!/bin/sh
# B-992 — the Harmony PRE-TOOL-USE GATE (Claude Code `PreToolUse` hook).
#
# The mirror image of hooks/stop-gate.sh (B-870): where that gate stops a turn from ENDING with
# nothing on the board, this one stops a POSITIVELY-IDENTIFIED daemon worker from USING a
# "boundary tool" (opening/merging a PR, accepting a verify brief) before the project's declared
# gate point has run. See src/hooks/pretooluse-gate.ts for the real decision — this wrapper exists
# for ONE reason: the fast path, layered so a non-boundary call in a non-manifest repo costs no more
# than the SAME handful of `test`/`sed`/`case` operations stop-gate.sh's own fast path costs, and a
# manifest-bearing repo's non-boundary call still costs no node spawn.
#
# Contract with the runtime (live-captured — see src/hooks/__fixtures__/pretooluse-*.json):
#   * stdin carries the PreToolUse JSON (session_id, transcript_path, cwd, tool_name, tool_input,
#     tool_use_id, ...);
#   * exit 2 with a reason on stderr DENIES the tool call and the reason reaches the model — the SAME
#     mechanism stop-gate.sh uses for its own block;
#   * any other exit code allows it.
#
# Every failure mode here exits 0. A broken gate must never wedge a tool call.

INPUT=$(cat 2>/dev/null)

# Layer 1: no session cwd on the payload at all -> nothing to resolve a manifest against.
CWD=$(printf '%s' "$INPUT" | tr -d '\n' \
  | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$CWD" ] || exit 0

# Layer 2 (AC2's no-op floor): no `.harmony/project.yml` in this repo -> nothing declared, nothing
# to enforce. No JSON parsing, no node — one stat.
MANIFEST="$CWD/.harmony/project.yml"
[ -f "$MANIFEST" ] || exit 0

# Layer 3: only for a manifest-bearing repo, grep the RAW stdin text for a boundary token BEFORE
# spawning node — no JSON parsing at this layer either. This is what keeps every non-boundary tool
# call (Read, Edit, a plain `git push`, an unrelated Bash command) at microsecond cost even in a
# manifest-bearing repo.
case "$INPUT" in
  *'gh pr create'*|*'gh pr merge'*|*'resolve_brief'*) : ;;
  *) exit 0 ;;
esac

ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
GATE="$ROOT/dist/bin/pretooluse-gate.js"
[ -f "$GATE" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

printf '%s' "$INPUT" | node "$GATE" "$CWD"
exit $?
