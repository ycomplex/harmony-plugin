#!/usr/bin/env bash
# B-761: local-Docker worker REAP wrapper.
#
# The old inline reap template (`docker rm -f harmony-worker-{conduction_id}; rm -f $ENV_FILE`)
# always exited 0, because it joined the two commands with `;` (not `&&`) and the trailing `rm -f`
# almost always succeeds — so a genuinely-missing container (`docker rm -f` on one prints
# "Error response from daemon: No such container: ..." and exits 1) never surfaced. This wrapper
# captures docker's own exit code explicitly (it CANNOT use `set -e` for that one call, since the
# whole point is to inspect a nonzero exit rather than abort on it) and re-derives a three-way
# exit-code contract the daemon's quiet-reap renderer (src/daemon/quiet-reap.ts) depends on:
#   0 — docker's own exit was 0: a real container was found and removed (a live worker was reaped).
#   3 — docker's own exit was nonzero AND its output names "No such container": the routine miss
#       (nothing to reap — the dead holder already lost the container, or it never existed).
#   1 — anything else nonzero: a genuine unexpected docker error, NOT swallowed into 0 or 3 — the
#       captured output is printed to stderr so it stays investigatable.
#
# Usage: docker-worker-reap.sh <conduction_id> <ticket>
set -uo pipefail

CONDUCTION_ID="${1:?usage: docker-worker-reap.sh <conduction_id> <ticket>}"
TICKET="${2:?usage: docker-worker-reap.sh <conduction_id> <ticket>}"

RUN_DIR="$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID"
ENV_FILE="$RUN_DIR/run.env"

# Capture combined output + exit code explicitly — no `set -e` for this call, since a nonzero exit
# here is an expected, inspected outcome, not a script-ending error.
OUTPUT="$(docker rm -f "harmony-worker-$CONDUCTION_ID" 2>&1)"
DOCKER_EXIT=$?

rm -f "$ENV_FILE"
# B-846: the mint step's sibling run-config.json (mode-0600, no secret content) rides the same
# RUN_DIR lifetime as run.env -- clean it up the same way, on the same trigger.
rm -f "$RUN_DIR/run-config.json"

if [ "$DOCKER_EXIT" -eq 0 ]; then
  exit 0
fi

if printf '%s' "$OUTPUT" | grep -q "No such container"; then
  exit 3
fi

echo "$OUTPUT" >&2
exit 1
