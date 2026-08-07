#!/usr/bin/env bash
# B-754: Cloud Run job-execution REAP wrapper.
#
# Cloud Run job executions get an API-assigned execution name/ID, not a caller-assigned one — unlike
# `docker rm -f harmony-worker-{conduction_id}`, reap can't blind-name-target. Reap instead resolves
# the STILL-RUNNING execution by the same conduction-id label the launch wrapper set at execute
# time, then cancels it, tolerating "not found" as a no-op exactly like today's `docker rm -f` on an
# absent container. Also deletes the per-run minted env-file, mirroring the docker reap template.
#
# Usage: cloud-worker-reap.sh <conduction_id> <ticket>
set -euo pipefail

CONDUCTION_ID="${1:?usage: cloud-worker-reap.sh <conduction_id> <ticket>}"
TICKET="${2:?usage: cloud-worker-reap.sh <conduction_id> <ticket>}"

# B-800 AC4: profiles.cloud.gcloud_project in a per-deployment config, when present, is this
# deployment's default GCP project — read via `harmony config get` (best-effort; a missing
# HARMONY_PLUGIN_DIR or deployment config falls straight through to the "harmony-conductor"
# literal below, UNCHANGED from before this ticket). An explicit CLOUDSDK_CORE_PROJECT in this
# script's own environment always wins over both (the `:=` below only assigns when unset).
_b800_default_cloudsdk_project="harmony-conductor"
if [ -n "${HARMONY_PLUGIN_DIR:-}" ] && [ -f "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" ]; then
  _b800_config_project="$(node "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" config get profiles.cloud.gcloud_project 2>/dev/null || true)"
  [ -n "$_b800_config_project" ] && _b800_default_cloudsdk_project="$_b800_config_project"
fi
: "${CLOUDSDK_CORE_PROJECT:=$_b800_default_cloudsdk_project}"
: "${CLOUDSDK_CORE_ACCOUNT:=harmony-daemon@harmony-conductor.iam.gserviceaccount.com}"
: "${HARMONY_CLOUD_RUN_REGION:=us-central1}"
: "${HARMONY_CLOUD_RUN_JOB:=harmony-build-worker}"
export CLOUDSDK_CORE_PROJECT CLOUDSDK_CORE_ACCOUNT

RUN_DIR="$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID"
ENV_FILE="$RUN_DIR/run.env"

# Resolve the still-incomplete execution for this conduction (status.completionTime=='' means it
# has not reached a terminal state yet — the same field the launch wrapper's authoritative read
# checks for a terminal outcome, applied here as "hasn't got one yet").
EXECUTION_NAME="$(
  gcloud run jobs executions list \
    --job="$HARMONY_CLOUD_RUN_JOB" \
    --region="$HARMONY_CLOUD_RUN_REGION" \
    --filter="metadata.labels.conduction-id=$CONDUCTION_ID AND status.completionTime=''" \
    --format='value(metadata.name)' \
    --limit=1 || true
)"

if [ -n "$EXECUTION_NAME" ]; then
  # CONFIRM AT VERIFY (accepted design cf579f0f pt.2): does a pending `execute --wait` actually
  # unblock promptly when a concurrent `executions cancel` lands? CONFIRMED (2026-08-03): a
  # concurrent `executions cancel` unblocked a pending `execute --wait` within ~7s (wait returned
  # 12:10:54Z; cancel's own confirmation printed 12:11:01Z), exit code 1, streamed "Cancelled by
  # user." The primary --wait strategy is sufficient; the bounded-poll contingency once considered
  # here is confirmed NOT needed. This remains a hang-robustness confirmation only — NOT a
  # classification-correctness gate, since the daemon's own `timedOut` in-process flag
  # (src/daemon/scheduler.ts) resolves classification independent of whatever the blocked --wait
  # call eventually returns. See cloud-worker-launch.sh's SMOKE-TEST GAP comment: a reaped/cancelled
  # execution remains indistinguishable from a failed one by exit code, by design.
  gcloud run jobs executions cancel "$EXECUTION_NAME" \
    --region="$HARMONY_CLOUD_RUN_REGION" \
    --async \
    --quiet || true
  rm -f "$ENV_FILE"
  # B-761: EXECUTION_NAME was found — a real execution really was there to cancel. Distinct exit
  # code from the "nothing found" branch below so the daemon's quiet-reap renderer
  # (src/daemon/quiet-reap.ts) can tell a genuine kill apart from a routine miss.
  exit 0
fi

rm -f "$ENV_FILE"
# B-761: EXECUTION_NAME was empty — the routine miss (nothing found to reap, e.g. the dead holder's
# execution already completed on its own). Exit 3, not the previous always-0, so the daemon's
# quiet-reap renderer can render this distinctly from a genuine kill.
exit 3
