#!/usr/bin/env bash
# B-1060 SPIKE: GKE REAP wrapper — the cloud reap's contract (cloud-worker-reap.sh):
#   exit 0 = a running leg Job was found and deleted; exit 3 = nothing running (already gone).
# Deleting the Job deletes its pod and (ownerReference) its per-leg secret. The ticket's PVC is
# deliberately left alone: it carries the engine cache and transcripts the next leg resumes from.
set -euo pipefail
CONDUCTION_ID="${1:?usage: gke-worker-reap.sh <conduction_id> <ticket>}"
TICKET="${2:?usage: gke-worker-reap.sh <conduction_id> <ticket>}"
: "${HARMONY_GKE_NAMESPACE:=harmony-legs}"
KUBECTL=(kubectl -n "$HARMONY_GKE_NAMESPACE")
if [ -n "${HARMONY_GKE_CONTEXT:-}" ]; then KUBECTL+=(--context "$HARMONY_GKE_CONTEXT"); fi
rm -f "$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID/run.env"

ACTIVE="$("${KUBECTL[@]}" get jobs -l "conduction-id=$CONDUCTION_ID" \
  -o jsonpath='{range .items[*]}{.metadata.name} {.status.conditions[*].type}{"\n"}{end}' 2>/dev/null \
  | awk 'NF && $0 !~ / (Complete|Failed)/ {print $1}' || true)"
[ -z "$ACTIVE" ] && exit 3
for job in $ACTIVE; do
  "${KUBECTL[@]}" delete job "$job" --cascade=background --wait=false >/dev/null 2>&1 || true
done
exit 0
