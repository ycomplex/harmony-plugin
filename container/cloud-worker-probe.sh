#!/usr/bin/env bash
# B-717: Cloud Run job-execution PROBE wrapper — the "cloud" launch profile's optional `probe`
# template target, used ONLY for restart reconciliation (src/daemon/scheduler.ts): on a newly-won
# takeover of a lease whose `leg_started_at` is non-null, the daemon runs this to ask "is a worker
# for this conduction still genuinely running, on ANY daemon?" before ever reaping or re-firing.
#
# Exit 0  = a worker for this conduction is STILL RUNNING (found — an incomplete execution exists).
# Exit !=0 = no worker found (settled/absent) — the daemon falls back to REAP-THEN-FIRE.
#
# Mirrors cloud-worker-reap.sh's own resolve logic (same filter shape) — deliberately read-only,
# never mutates anything, and (like every other wrapper here) never parses worker stdout.
#
# Usage: cloud-worker-probe.sh <conduction_id> <ticket>
set -euo pipefail

CONDUCTION_ID="${1:?usage: cloud-worker-probe.sh <conduction_id> <ticket>}"
TICKET="${2:?usage: cloud-worker-probe.sh <conduction_id> <ticket>}"
: "$TICKET" # unused beyond the daemon's own {ticket} template placeholder — kept for signature parity

: "${CLOUDSDK_CORE_PROJECT:=harmony-conductor}"
: "${CLOUDSDK_CORE_ACCOUNT:=harmony-daemon@harmony-conductor.iam.gserviceaccount.com}"
: "${HARMONY_CLOUD_RUN_REGION:=us-central1}"
: "${HARMONY_CLOUD_RUN_JOB:=harmony-build-worker}"
export CLOUDSDK_CORE_PROJECT CLOUDSDK_CORE_ACCOUNT

EXECUTION_NAME="$(
  gcloud run jobs executions list \
    --job="$HARMONY_CLOUD_RUN_JOB" \
    --region="$HARMONY_CLOUD_RUN_REGION" \
    --filter="metadata.labels.conduction-id=$CONDUCTION_ID AND status.completionTime=''" \
    --format='value(metadata.name)' \
    --limit=1 || true
)"

if [ -n "$EXECUTION_NAME" ]; then
  exit 0 # found — still running
fi
exit 1 # not found — settled or never existed
