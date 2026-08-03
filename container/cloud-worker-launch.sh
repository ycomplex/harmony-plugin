#!/usr/bin/env bash
# B-754: Cloud Run job-execution LAUNCH wrapper.
#
# This is the "cloud" launch profile's launch template target. It exists so the daemon's
# scheduler/classify code (src/daemon/scheduler.ts, src/daemon/classify.ts) NEVER changes and NEVER
# parses stdout: the daemon still just runs a shell command to completion and reads its exit code.
# All Cloud Run CLI ambiguity is absorbed HERE.
#
# Usage: cloud-worker-launch.sh <conduction_id> <ticket>
set -euo pipefail

CONDUCTION_ID="${1:?usage: cloud-worker-launch.sh <conduction_id> <ticket>}"
TICKET="${2:?usage: cloud-worker-launch.sh <conduction_id> <ticket>}"

: "${HARMONY_PLUGIN_DIR:?HARMONY_PLUGIN_DIR is required (checkout the mint script runs from, same knob the docker profile uses)}"

# --- Config knobs (B-711 "config not constants") ----------------------------------------------
# Every value below is an env var with an EXAMPLE default matching the harmony-conductor GCP
# project's already-completed one-time founder setup (accepted design pt.7). Override on the
# daemon host if your project/region/job/identity differ — never hardcode a live value here.
: "${CLOUDSDK_CORE_PROJECT:=harmony-conductor}"
: "${CLOUDSDK_CORE_ACCOUNT:=harmony-daemon@harmony-conductor.iam.gserviceaccount.com}"
: "${HARMONY_CLOUD_RUN_REGION:=us-central1}"
: "${HARMONY_CLOUD_RUN_JOB:=harmony-build-worker}"
export CLOUDSDK_CORE_PROJECT CLOUDSDK_CORE_ACCOUNT

RUN_DIR="$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID"
mkdir -p "$RUN_DIR"

ENV_FILE="$RUN_DIR/run.env"           # per-run minted GIT_TOKEN, same lifetime/shape as B-732
EXEC_ENV_FILE="$RUN_DIR/exec-env-vars.yaml"  # per-EXECUTE-call file, deleted right after use

# 1. Mint a fresh per-run GitHub App installation token (B-732 mechanism, unchanged). Called
#    WITHOUT --base: unlike the docker profile there is no static secrets file to merge, because
#    HARMONY_API_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are bound to the Cloud Run JOB DEFINITION itself
#    via --set-secrets (accepted design cf579f0f pt.3, founder one-time setup — see README), not
#    passed per-execution. The minted env-file therefore carries only GIT_TOKEN.
node "$HARMONY_PLUGIN_DIR/scripts/mint-installation-token.mjs" --out "$ENV_FILE"

GIT_TOKEN="$(grep -m1 '^GIT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
if [ -z "$GIT_TOKEN" ]; then
  echo "cloud-worker-launch: minted env-file at $ENV_FILE carries no GIT_TOKEN" >&2
  exit 1
fi

# 2. Compose the per-execution env-vars FILE. A small, isolated function on purpose — see the
#    CONFIRM AT VERIFY note inside it.
write_exec_env_file() {
  # CONFIRM AT VERIFY (accepted design cf579f0f pt.3): exact gcloud flag/format for a FILE-based
  # env-vars input to `gcloud run jobs execute` (to avoid the minted GIT_TOKEN appearing in shell
  # history / `ps`) is not live-confirmed — verify against `gcloud run jobs execute --help` on a
  # real project and correct this function if the flag name differs.
  local file="$1"
  ( umask 077
    {
      printf 'CONDUCTION_ID: "%s"\n' "$CONDUCTION_ID"
      printf 'TICKET: "%s"\n' "$TICKET"
      printf 'GIT_TOKEN: "%s"\n' "$GIT_TOKEN"
    } > "$file"
  )
  chmod 600 "$file"
}
write_exec_env_file "$EXEC_ENV_FILE"

# 3. Fire the job execution, labelled so reap (and step 4 below) can find it without a
#    caller-assigned name (Cloud Run assigns the execution name/ID itself).
#
# `--wait`'s OWN exit code is not the classification signal: it is not precisely documented whether
# it reliably reflects the execution's true terminal outcome, so this wrapper NEVER trusts it and
# always falls through to the authoritative post-hoc read in step 4, regardless of what happens here.
set +e
gcloud run jobs execute "$HARMONY_CLOUD_RUN_JOB" \
  --region="$HARMONY_CLOUD_RUN_REGION" \
  --wait \
  --labels="conduction-id=$CONDUCTION_ID" \
  --update-env-vars-file="$EXEC_ENV_FILE"
# B-717 (accepted design cf579f0f pt.3, round-2 feedback): --update-env-vars mutates the Cloud Run
# JOB DEFINITION itself before `execute` reads it to launch the execution — there is no
# per-execution-only variant. Two concurrent `execute` calls would race each other's env values
# through this shared mutation. Safe ONLY because the daemon is strictly serial today (one build at
# a time) — B-717 (serial-execution/concurrency model) must treat this as a named, inherited
# constraint: either keep executions serialized past this call, or move per-execution values off
# `--update-env-vars` onto a mechanism that doesn't mutate shared job state, rather than discovering
# the race live.
EXECUTE_EXIT=$?
set -e

# The exec-env-vars file held the minted token in cleartext on disk for exactly one call's worth of
# time. Delete it the moment that call returns — success or failure, it is never reused.
rm -f "$EXEC_ENV_FILE"

# 4. SMOKE-TEST GAP (accepted design cf579f0f pt.1): parsing is grounded in the documented Cloud Run
# Jobs Execution resource schema (status.succeededCount/failedCount/completionTime), NOT an
# actually-observed `executions describe` output — the elicitation round's referenced smoke-test
# paste resolved to placeholders with no concrete values. CONFIRM against a live
# deliberately-succeeding and deliberately-failing execution before trusting this in production
# (design's own build-time verification requirement); all 4 ACs on B-754 stay unchecked pending
# that live confirmation (human's explicit deferral, 2026-08-03).
resolve_execution_name() {
  gcloud run jobs executions list \
    --job="$HARMONY_CLOUD_RUN_JOB" \
    --region="$HARMONY_CLOUD_RUN_REGION" \
    --filter="metadata.labels.conduction-id=$CONDUCTION_ID" \
    --sort-by="~metadata.creationTimestamp" \
    --format='value(metadata.name)' \
    --limit=1
}

EXECUTION_NAME="$(resolve_execution_name || true)"
if [ -z "$EXECUTION_NAME" ]; then
  echo "cloud-worker-launch: no execution found labelled conduction-id=$CONDUCTION_ID (execute's own exit was $EXECUTE_EXIT, not trusted)" >&2
  exit 1
fi

read -r SUCCEEDED FAILED COMPLETION < <(
  gcloud run jobs executions describe "$EXECUTION_NAME" \
    --region="$HARMONY_CLOUD_RUN_REGION" \
    --format='value(status.succeededCount,status.failedCount,status.completionTime)'
)
SUCCEEDED="${SUCCEEDED:-0}"
FAILED="${FAILED:-0}"

if [ "$SUCCEEDED" -ge 1 ] 2>/dev/null; then
  exit 0
elif [ "$FAILED" -ge 1 ] 2>/dev/null; then
  exit 1
else
  # Neither succeededCount nor failedCount set ⇒ still reconciling. Never hang, never guess
  # success: treat as dirty so the daemon's classifier parks/retries it, exactly like any other
  # dirty exit (src/daemon/classify.ts branch 6).
  echo "cloud-worker-launch: execution $EXECUTION_NAME has neither succeededCount nor failedCount set (completionTime='${COMPLETION:-}') — treating as dirty" >&2
  exit 1
fi
