#!/usr/bin/env bash
# GKE REAP wrapper — the cloud reap's contract (cloud-worker-reap.sh):
#   exit 0 = at least one unsettled leg Job was found and a `kubectl delete job` SUCCEEDED (B-1187: exit 0 now
#            proves a deletion);
#   exit 3 = nothing there (no unsettled Job found);
#   exit 1 = a delete failed (the Job may still be running — the caller must not treat it as reaped).
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
DELETED=0
FAILED=0
for job in $ACTIVE; do
  if "${KUBECTL[@]}" delete job "$job" --cascade=background --wait=false >/dev/null 2>&1; then
    DELETED=$((DELETED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "gke-worker-reap: could not delete job $job" >&2
  fi
done
[ "$FAILED" -gt 0 ] && exit 1
[ "$DELETED" -gt 0 ] && exit 0
exit 3
