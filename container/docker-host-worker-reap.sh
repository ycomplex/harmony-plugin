#!/usr/bin/env bash
# B-708: Docker-host worker REAP wrapper — the "docker-host" launch profile's `reap` template target.
#
# The remote twin of docker-worker-reap.sh: `docker rm -f harmony-worker-<conduction_id>` on the host,
# over SSH, re-derived into the SAME three-way exit-code contract the daemon's quiet-reap renderer
# (src/daemon/quiet-reap.ts) depends on:
#   0 — a real container was found and removed (a live worker was reaped).
#   3 — the routine miss: docker named "No such container", OR the host is unreachable (ssh's own
#       exit 255). A host that is powered off has no worker, so there was nothing to reap.
#   1 — anything else: a genuine unexpected error, printed to stderr so it stays investigatable.
#
# "No such container" is keyed on docker's OUTPUT, not its exit code: current Docker releases print
# that message and still exit 0 for `rm -f` on an absent container (observed on 28.2.2), so the exit
# code alone cannot tell a kill from a miss.
#
# Also deletes the per-run files on the daemon's machine, as docker-worker-reap.sh does, and
# best-effort removes the host's copy of run.env (the minted token).
#
# Usage: docker-host-worker-reap.sh <conduction_id> <ticket>
set -uo pipefail

CONDUCTION_ID="${1:?usage: docker-host-worker-reap.sh <conduction_id> <ticket>}"
TICKET="${2:?usage: docker-host-worker-reap.sh <conduction_id> <ticket>}"

# shellcheck source=container/docker-host-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/docker-host-common.sh"

RUN_DIR="$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID"

# The local per-run files go first and unconditionally — whatever happens on the host, the minted
# token must not outlive the reap on this machine.
rm -f "$RUN_DIR/run.env"
rm -f "$RUN_DIR/run-config.json"

dh_require_safe_id docker-host-worker-reap "$CONDUCTION_ID" "conduction id" || exit 1
dh_require_safe_id docker-host-worker-reap "$TICKET" "ticket" || exit 1
dh_resolve_target docker-host-worker-reap || exit 1

# Capture combined output + exit code explicitly — no `set -e`, since a nonzero exit here is an
# expected, inspected outcome (same shape as docker-worker-reap.sh).
OUTPUT="$(dh_ssh "docker rm -f harmony-worker-$CONDUCTION_ID 2>&1" </dev/null 2>&1)"
SSH_EXIT=$?

if [ "$SSH_EXIT" -eq 255 ]; then
  exit 3 # unreachable — a host that is off has no worker
fi

# Best-effort: the host's copy of the per-run env-file. The launch wrapper's own exit trap normally
# removes it; this covers a launch wrapper that was killed before its trap ran.
dh_ssh "rm -f \"$DH_REMOTE_ROOT/$TICKET/$CONDUCTION_ID/run.env\"" </dev/null >/dev/null 2>&1 || true

if printf '%s' "$OUTPUT" | grep -q "No such container"; then
  exit 3
fi

if [ "$SSH_EXIT" -eq 0 ]; then
  exit 0
fi

echo "$OUTPUT" >&2
exit 1
