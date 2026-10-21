#!/usr/bin/env bash
# GKE PROBE wrapper — the cloud probe's contract (cloud-worker-probe.sh):
#   exit 0 = a leg Job for this conduction is still running; exit 1 = settled or never existed.
# "Running" = a Job labelled conduction-id=<id> with neither a Complete nor a Failed condition.
set -euo pipefail
CONDUCTION_ID="${1:?usage: gke-worker-probe.sh <conduction_id> <ticket> [job_name]}"
: "${2:?usage: gke-worker-probe.sh <conduction_id> <ticket> [job_name]}"
JOB_NAME="${3:-}"
# shellcheck source=gke-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/gke-common.sh"
gke_init_kubectl

if [ -n "$JOB_NAME" ]; then
  JSON="$("${KUBECTL[@]}" get job "$JOB_NAME" -o json 2>/dev/null)" || exit 1
  printf '%s' "$JSON" | node -e '
let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    const types = ((j.status && j.status.conditions) || []).filter(c => c.status === "True").map(c => c.type);
    process.exit(types.includes("Complete") || types.includes("Failed") ? 1 : 0);
  } catch { process.exit(1); }
});'
  exit $?
fi

ACTIVE="$(gke_unsettled_jobs "$CONDUCTION_ID")"
[ -n "$ACTIVE" ] && exit 0
exit 1
