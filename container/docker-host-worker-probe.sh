#!/usr/bin/env bash
# B-708: Docker-host worker PROBE wrapper — the "docker-host" launch profile's `probe` template
# target, used ONLY for restart reconciliation (src/daemon/scheduler.ts), exactly like
# cloud-worker-probe.sh.
#
# Exit 0  = a worker container for this conduction is RUNNING on the host.
# Exit !=0 = it is not. An UNREACHABLE host (ssh's own exit 255) is "not running", never an error:
#            a host that is powered off has no worker.
#
# Read-only, and (like every other wrapper here) never parses worker stdout.
#
# Usage: docker-host-worker-probe.sh <conduction_id> <ticket>
set -uo pipefail

CONDUCTION_ID="${1:?usage: docker-host-worker-probe.sh <conduction_id> <ticket>}"
TICKET="${2:?usage: docker-host-worker-probe.sh <conduction_id> <ticket>}"
: "$TICKET" # unused beyond the daemon's own {ticket} template placeholder — kept for signature parity

# shellcheck source=container/docker-host-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/docker-host-common.sh"

dh_require_safe_id docker-host-worker-probe "$CONDUCTION_ID" "conduction id" || exit 1
dh_resolve_target docker-host-worker-probe || exit 1

# The name filter is anchored: docker's `name=` is a substring/regex match, and one conduction id
# must never match another's container.
RUNNING="$(dh_ssh "docker ps --filter 'name=^harmony-worker-$CONDUCTION_ID\$' --filter status=running -q" </dev/null 2>/dev/null)" || exit 1

if [ -n "$RUNNING" ]; then
  exit 0 # found — still running
fi
exit 1 # not found — settled, never existed, or the host is off
