#!/usr/bin/env bash
# GKE REAP wrapper — the cloud reap's contract (cloud-worker-reap.sh):
#   exit 0 = a running leg Job was found and deleted; exit 3 = nothing running (already gone).
# Deleting the Job deletes its pod and (ownerReference) its per-leg secret. The ticket's PVC is
# deliberately NEVER deleted here: it carries the engine cache and transcripts the next leg resumes from.
set -euo pipefail
CONDUCTION_ID="${1:?usage: gke-worker-reap.sh <conduction_id> <ticket>}"
TICKET="${2:?usage: gke-worker-reap.sh <conduction_id> <ticket>}"
# shellcheck source=gke-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/gke-common.sh"
gke_init_kubectl
rm -f "$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID/run.env"

ACTIVE="$(gke_unsettled_jobs "$CONDUCTION_ID")"
[ -z "$ACTIVE" ] && exit 3
for job in $ACTIVE; do
  "${KUBECTL[@]}" delete job "$job" --cascade=background --wait=false >/dev/null 2>&1 || true
done
exit 0
