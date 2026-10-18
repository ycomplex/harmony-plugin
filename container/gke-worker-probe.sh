#!/usr/bin/env bash
# B-1060 SPIKE: GKE PROBE wrapper — the cloud probe's contract (cloud-worker-probe.sh):
#   exit 0 = a leg Job for this conduction is still running; exit 1 = settled or never existed.
# "Running" = a Job labelled conduction-id=<id> with neither a Complete nor a Failed condition.
set -euo pipefail
CONDUCTION_ID="${1:?usage: gke-worker-probe.sh <conduction_id> <ticket>}"
: "${2:?usage: gke-worker-probe.sh <conduction_id> <ticket>}"
: "${HARMONY_GKE_NAMESPACE:=harmony-legs}"
KUBECTL=(kubectl -n "$HARMONY_GKE_NAMESPACE")
if [ -n "${HARMONY_GKE_CONTEXT:-}" ]; then KUBECTL+=(--context "$HARMONY_GKE_CONTEXT"); fi

ACTIVE="$("${KUBECTL[@]}" get jobs -l "conduction-id=$CONDUCTION_ID" \
  -o jsonpath='{range .items[*]}{.metadata.name} {.status.conditions[*].type}{"\n"}{end}' 2>/dev/null \
  | awk 'NF && $0 !~ / (Complete|Failed)/ {print $1}' || true)"
[ -n "$ACTIVE" ] && exit 0
exit 1
