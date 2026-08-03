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
#    CONFIRMED note inside it (round 3: the flag/format question this note originally raised is now
#    resolved by a live check, see below).
write_exec_env_file() {
  # CONFIRMED (2026-08-03, live `gcloud run jobs execute --help` check): `gcloud run jobs execute`
  # has NO file-based env-vars flag at all — the previously-assumed `--update-env-vars-file` does not
  # exist on `execute`. `--help` only offers the inline `--update-env-vars` (KEY=VALUE form) merge-override
  # form there (gcloud's own documented wording: it merges into, rather than replaces, the job's
  # existing literal env set). The file-based form (`--env-vars-file`) exists only on
  # `gcloud run jobs update`. This function's output is therefore consumed by an `update` call that
  # must run BEFORE `execute` (see the call sites below), not by `execute` directly.
  #
  # Deliberately NOT using the inline `--update-env-vars` merge-override for GIT_TOKEN even though it
  # exists: this ticket's own test suite requires GIT_TOKEN never appear on the command line, so
  # GIT_TOKEN stays file-based via `update --env-vars-file`. Whether the inline merge-override form on
  # `execute` could later carry the two non-secret scalars (CONDUCTION_ID, TICKET) instead is
  # unresolved and not adopted here.
  #
  # CONFIRMED (2026-08-03, live smoke probe): the minted token still lands in the job/execution spec
  # metadata either way — inline or file form. The file-based route's real benefit was never keeping
  # the token out of the spec; it keeps the token off THIS daemon host's argv/process list (`ps`,
  # shell history), which it still does.
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

# 3a. Push the per-execution env vars onto the JOB DEFINITION FIRST. `gcloud run jobs execute` has no
#     file-based env-vars flag (CONFIRMED via a live `gcloud run jobs execute --help` check,
#     2026-08-03 — see write_exec_env_file() above); the file-based form is `--env-vars-file` on
#     `gcloud run jobs update`, so that must run before `execute` can pick the values up.
#
#     This same `update` call also carries `--update-labels="conduction-id=$CONDUCTION_ID"`, for the
#     same reason: CONFIRMED (2026-08-03, live `gcloud run jobs execute --help` check) that `execute`
#     has NO `--labels` flag at all (an earlier version of this script wrongly passed one there, which
#     killed every launch on an unknown-flag error). `update` is the only call site that CAN set the
#     label, and the label on the JOB DEFINITION propagates to the execution: CONFIRMED live that the
#     execution's own `metadata.labels` carries the job's `conduction-id` label, so reap's
#     `metadata.labels.conduction-id=…` filter (container/cloud-worker-reap.sh) still finds it — see
#     the note at the `execute` call site below.
#
#     `--env-vars-file` REPLACES the job's ENTIRE literal env-var set — it is not a merge. Every
#     per-leg literal env var (GIT_TOKEN, CONDUCTION_ID, TICKET) must therefore ride this ONE file,
#     and the job definition must otherwise carry NO other literal env vars, or this call would wipe
#     them. Standing secrets (HARMONY_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) stay as `--set-secrets`
#     bindings, which are a separate mechanism from literal env vars and are untouched by this call
#     (there's a separate `--clear-secrets` flag if secret bindings ever need clearing — not used
#     here).
#
# B-717 (accepted design cf579f0f pt.3, round-2 feedback; STRENGTHENED round 3): `update
# --env-vars-file` mutates (replaces) the Cloud Run JOB DEFINITION itself before the `execute` call
# immediately below reads that same job definition to launch the execution — there is no
# per-execution-only variant. Round 3 makes this TWO non-atomic gcloud calls (`update` then `execute`)
# against that one shared job definition, not one — which STRENGTHENS, not relaxes, the existing named
# constraint: two concurrent update+execute pairs could interleave and race each other's env values
# through this shared mutation. Safe ONLY because the daemon is strictly serial today (one build at a
# time) — B-717 (serial-execution/concurrency model) must treat this as a named, inherited constraint:
# either keep executions serialized past this call, or move per-execution values off
# `update --env-vars-file` onto a mechanism that doesn't mutate shared job state, rather than
# discovering the race live.
gcloud run jobs update "$HARMONY_CLOUD_RUN_JOB" \
  --region="$HARMONY_CLOUD_RUN_REGION" \
  --env-vars-file="$EXEC_ENV_FILE" \
  --update-labels="conduction-id=$CONDUCTION_ID"

# 3b. Fire the job execution. `gcloud run jobs execute` has no `--labels` flag (CONFIRMED live,
#     2026-08-03 — see the `update` call site above); the execution is instead found by reap (and step
#     4 below) via the `conduction-id` label the `update` call above just set on the JOB DEFINITION,
#     which the execution inherits (CONFIRMED live) into its own `metadata.labels` — no
#     caller-assigned name needed (Cloud Run assigns the execution name/ID itself). This launches with
#     the env vars the `update` call immediately above just pushed onto the job definition, too.
#
# B-717 (accepted design cf579f0f pt.3, round-2 feedback; STRENGTHENED round 3): see the identical
# comment at the `update --env-vars-file` call site immediately above — this `execute` call is the
# second of the two non-atomic calls against the shared JOB DEFINITION that comment describes. Safe
# ONLY because the daemon is strictly serial today.
#
# `--wait`'s OWN exit code is not the classification signal here: CONFIRMED via live observation
# (2026-08-03) that `execute --wait` collapses the launched container's own exit code down to a
# simple pass/fail signal (observed: container process exit code 7 -> `gcloud` process exit code 1)
# — fine for classify.ts's zero/non-zero contract, but too coarse to trust directly, so this wrapper
# still NEVER keys off it and always falls through to the authoritative post-hoc read in step 4,
# regardless of what happens here.
# B-754 fix (2026-08-03): execute fired with NO container args, so the entrypoint's no-arg
# default silently exited 0, no work done. `--args` CONFIRMED live (2026-08-03) on `execute`; the
# comma splits the two positional args (`headless`, prompt) — spaces inside the prompt survive
# since gcloud only splits on commas.
set +e
gcloud run jobs execute "$HARMONY_CLOUD_RUN_JOB" \
  --region="$HARMONY_CLOUD_RUN_REGION" \
  --args="headless,/harmony-plugin:harmony-conduct $TICKET --one-shot" \
  --wait
EXECUTE_EXIT=$?
set -e

# The exec-env-vars file held the minted token in cleartext on disk for exactly one call's worth of
# time. Delete it the moment that call returns — success or failure, it is never reused.
rm -f "$EXEC_ENV_FILE"

# 4. SMOKE-TEST GAP (accepted design cf579f0f pt.1) — CONFIRMED via live observation (2026-08-03):
# parsing on status.succeededCount/failedCount/completionTime is CORRECT and matches the real
# `executions describe` output. Observed shapes, for reference (this wrapper still parses ONLY the
# count fields below, never the conditions array, for control flow):
#   succeeded: conditions[type=Completed].status=="True", succeededCount:1
#   failed:    conditions[type=Completed].status=="False", reason:"NonZeroExitCode", failedCount:1
# A reaped/cancelled execution is INDISTINGUISHABLE from a failed one by this exit code, and this must
# remain so: the daemon's own in-process `timedOut` flag (src/daemon/scheduler.ts) owns worker-timeout
# classification, per classify.ts's never-key-on-the-code rule — do not special-case cancellation here.
# All 4 ACs on B-754 stay unchecked regardless: they require a live Cloud Run job to check against,
# and code-only evidence satisfies none of them (human's explicit deferral, 2026-08-03).
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
