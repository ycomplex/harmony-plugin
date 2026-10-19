#!/usr/bin/env bash
# GKE PROBE wrapper — the cloud probe's contract (cloud-worker-probe.sh):
#   exit 0 = a leg Job for this conduction is still running; exit 1 = settled or never existed.
# "Running" = a Job labelled conduction-id=<id> with neither a Complete nor a Failed condition.
set -euo pipefail
CONDUCTION_ID="${1:?usage: gke-worker-probe.sh <conduction_id> <ticket>}"
: "${2:?usage: gke-worker-probe.sh <conduction_id> <ticket>}"
# shellcheck source=gke-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/gke-common.sh"
gke_init_kubectl

ACTIVE="$(gke_unsettled_jobs "$CONDUCTION_ID")"
[ -n "$ACTIVE" ] && exit 0
exit 1
