#!/usr/bin/env bash
# GKE REAP wrapper — the cloud reap's contract (cloud-worker-reap.sh):
#   exit 0 = at least one unsettled leg Job was found and a `kubectl delete job` SUCCEEDED (B-1187: exit 0 now
#            proves a deletion);
#   exit 3 = nothing there (no unsettled Job found);
#   exit 1 = a delete failed (the Job may still be running — the caller must not treat it as reaped).
# Deleting the Job deletes its pod and (ownerReference) its per-leg secret. The ticket's PVC is
# deliberately NEVER deleted here: it carries the engine cache and transcripts the next leg resumes from.
set -euo pipefail
CONDUCTION_ID="${1:?usage: gke-worker-reap.sh <conduction_id> <ticket> [job_name]}"
TICKET="${2:?usage: gke-worker-reap.sh <conduction_id> <ticket> [job_name]}"
JOB_NAME="${3:-}"
# shellcheck source=gke-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/gke-common.sh"
gke_init_kubectl
rm -f "$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID/run.env"

# Cleanup must prove pod shutdown, not merely enqueue a background Job deletion.
# Keep the ordinary deadline/adoption contract unchanged; only retirement requests strict proof.
if [ "${HARMONY_CONFIRM_WORKER_STOP:-}" = 1 ]; then
  if [ -n "$JOB_NAME" ]; then
    JOBS="$JOB_NAME"
  else
    JSON="$("${KUBECTL[@]}" get jobs -l "conduction-id=$CONDUCTION_ID" -o json)" || exit 1
    JOBS="$(printf '%s' "$JSON" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try { const j=JSON.parse(s); if(!Array.isArray(j.items)) process.exit(1);
    for(const job of j.items) {
      const done=(job.status?.conditions||[]).some(c=>c.status==="True" && ["Complete","Failed"].includes(c.type));
      if(!done) { if(!job.metadata?.name) process.exit(1); console.log(job.metadata.name); }
    }
  } catch { process.exit(1); }
});')" || exit 1
  fi
  for job in $JOBS; do
    "${KUBECTL[@]}" delete job "$job" --ignore-not-found --cascade=foreground --wait=false >/dev/null || exit 1
  done
  # Poll with get/list only: the conductor's existing RBAC deliberately grants no pod watch.
  for attempt in 1 2 3 4 5; do
    PRESENT=""
    for job in $JOBS; do
      FOUND="$("${KUBECTL[@]}" get job "$job" --ignore-not-found -o name)" || exit 1
      PRESENT="$PRESENT$FOUND"
    done
    JSON="$("${KUBECTL[@]}" get pods -l "conduction-id=$CONDUCTION_ID" -o json)" || exit 1
    if [ -z "$PRESENT" ] && printf '%s' "$JSON" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try { const j=JSON.parse(s); process.exit(Array.isArray(j.items) &&
    j.items.every(p=>["Succeeded","Failed"].includes(p.status?.phase)) ? 0 : 1);
  } catch { process.exit(1); }
});'; then
      [ -n "$JOBS" ] && exit 0
      exit 3
    fi
    sleep 2
  done
  echo 'gke-worker-reap: worker shutdown not yet confirmed' >&2
  exit 1
fi

if [ -n "$JOB_NAME" ]; then
  if OUTPUT="$("${KUBECTL[@]}" delete job "$JOB_NAME" --cascade=background --wait=false 2>&1)"; then
    exit 0
  fi
  case "$OUTPUT" in
    *NotFound*|*not\ found*) exit 3 ;;
    *) echo "gke-worker-reap: could not delete job $JOB_NAME: $OUTPUT" >&2; exit 1 ;;
  esac
fi

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
