#!/usr/bin/env bash
# B-754: Cloud Run job-execution LAUNCH wrapper.
#
# This is the "cloud" launch profile's launch template target. It exists so the daemon's
# scheduler/classify code (src/daemon/scheduler.ts, src/daemon/classify.ts) NEVER changes and NEVER
# parses stdout: the daemon still just runs a shell command to completion and reads its exit code.
# All Cloud Run CLI ambiguity is absorbed HERE.
#
# B-717 item 6 (accepted design c4c975bd, plan-gate correction 1): this wrapper is now spawned as a
# TRACKED CHILD PROCESS by the daemon's fire-and-track scheduler — it is itself the `TrackedLaunch`
# handle src/daemon/scheduler.ts's `running` map holds, so N of these can run fully in parallel. The
# `update`+`execute` pair below mutates ONE SHARED Cloud Run job definition non-atomically (see the
# comments at those call sites) — safe only inside a mutual-exclusion window, so this wrapper now
# acquires an mkdir-based lock BEFORE that pair and releases it IMMEDIATELY after `execute` returns
# an execution id (not after the execution completes) — the lock's held duration is the few seconds
# of `update`+`execute`-submission, never the multi-minute build itself. `execute` no longer carries
# `--wait` (there is no "submission returns an execution id" moment with `--wait` present — it blocks
# until the WHOLE execution completes); this wrapper resolves the execution via the existing
# conduction-id label lookup instead (polling briefly, taking the newest — B-713 retries reuse the
# same label), THEN releases the lock, THEN polls `executions describe` (unchanged, step 4 below)
# until the execution reaches a terminal state.
#
# B-717 REOPENED FIX (live concurrency test, 2026-08-04): dropping `--wait` alone did NOT bound the
# lock to "a few seconds" as designed — `execute` without `--wait` still blocks until the operation
# in progress (the execution actually STARTING) completes, and a cold start of the worker image
# takes 1.5-2.5 minutes. The lock was therefore held ~2.5 minutes in practice, and a peer wrapper hit
# the (then 60s) lock-wait timeout and dirty-exited waiting for it. Fixed by adding `--async` to the
# `execute` call (see the call site below) — genuinely returns as soon as submission is accepted, no
# more waiting for the execution to start — plus raising `LOCK_WAIT_TIMEOUT_S`'s default from 60 to
# 300 as belt-and-braces for any residual slow creation.
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

# B-717 item 6 / plan-gate correction 3: the lock directory is SHARED across every concurrent
# wrapper invocation on THIS daemon host (it narrows the update+execute race against the one shared
# Cloud Run job definition, not a per-conduction resource) — deliberately NOT under RUN_DIR. A fresh
# TMPDIR per host is fine; override HARMONY_CLOUD_LAUNCH_LOCK_DIR if the host needs a different path.
: "${HARMONY_CLOUD_LAUNCH_LOCK_DIR:=${TMPDIR:-/tmp}/harmony-cloud-worker-launch.lock}"
LOCK_DIR="$HARMONY_CLOUD_LAUNCH_LOCK_DIR"
LOCK_WAIT_TIMEOUT_S="${HARMONY_CLOUD_LAUNCH_LOCK_TIMEOUT_S:-300}"
LOCK_POLL_S=1

# B-717 / plan-gate correction 3: release via an EXIT trap (crash-safety — a killed wrapper must not
# leave the lock held forever) AND explicitly the moment the execution exists (see call site below,
# well before this trap would otherwise fire) — both call sites share this one function.
#
# B-717 revising-building fix: release is PID-ownership-guarded, not an unconditional `rm -rf`. The
# unconditional form raced: wrapper A's explicit release could be followed by wrapper B legitimately
# `mkdir`ing the now-free $LOCK_DIR and starting its own critical section BEFORE A's EXIT trap fires
# minutes later — A's trap then `rm -rf`'d the directory again, deleting B's lock out from under it,
# and a third wrapper C could acquire mid-B's-critical-section and clobber B's `update` right before
# B's `execute` submits (the exact cross-contamination the lock exists to prevent). Only the process
# whose PID matches the stamp `acquire_lock` wrote (`echo $$ > "$LOCK_DIR/pid"`) may remove it — a
# non-matching stamp means someone else now legitimately holds the lock, so this is a no-op instead.
release_lock() {
  local holder_pid
  holder_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ "$holder_pid" = "$$" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap release_lock EXIT

acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    # Stamped with the holder's PID (below) — a lock left by a wrapper process that no longer
    # exists is STALE, not contended; break it rather than wait out the full timeout.
    local holder_pid
    holder_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
      echo "cloud-worker-launch: breaking a stale launch lock held by dead pid $holder_pid" >&2
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [ "$waited" -ge "$LOCK_WAIT_TIMEOUT_S" ]; then
      # BOUNDED wait, fails LOUD: the daemon's own retry ladder (dirty-exit, exponential backoff —
      # src/daemon/scheduler.ts) owns recovery from here; this script adds no new recovery logic.
      echo "cloud-worker-launch: timed out after ${LOCK_WAIT_TIMEOUT_S}s waiting for the launch lock — treating as a dirty exit" >&2
      exit 1
    fi
    sleep "$LOCK_POLL_S"
    waited=$((waited + LOCK_POLL_S))
  done
  echo $$ > "$LOCK_DIR/pid"
}

RUN_DIR="$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID"
mkdir -p "$RUN_DIR"

ENV_FILE="$RUN_DIR/run.env"           # per-run minted GIT_TOKEN, same lifetime/shape as B-732
EXEC_ENV_FILE="$RUN_DIR/exec-env-vars.yaml"  # per-EXECUTE-call file, deleted right after use

# 1. Mint a fresh per-run GitHub App installation token (B-732 mechanism, unchanged). Deliberately
#    OUTSIDE the launch lock — minting is per-conduction (its own RUN_DIR), not a shared-resource
#    mutation, and there is no reason to serialize it against other conductions' launches.
#    B-726 followup (2026-08-04 live probe): this call used to be made WITHOUT --base, on the
#    (wrong) assumption that there was no static secrets file to merge on the cloud path. That
#    omission was the actual root cause of B-726's ack flag never reaching the cloud container:
#    the minted env-file only ever carried GIT_TOKEN, so the HARMONY_ACK_PLUGIN_AHEAD_OF_PROD
#    acquisition below had nothing to read. Now minted WITH --base "$HOME/.harmony-container.env",
#    matching the local docker profile's launch template exactly (see
#    container/daemon-profile.example.json's `launch` field) — that static file is where the ack
#    flag actually lives on this host, same as the docker profile.
node "$HARMONY_PLUGIN_DIR/scripts/mint-installation-token.mjs" --base "$HOME/.harmony-container.env" --out "$ENV_FILE"

GIT_TOKEN="$(grep -m1 '^GIT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
if [ -z "$GIT_TOKEN" ]; then
  echo "cloud-worker-launch: minted env-file at $ENV_FILE carries no GIT_TOKEN" >&2
  exit 1
fi

# B-726 followup: now sourced from the SAME minted env-file as GIT_TOKEN above (which merges
# $HOME/.harmony-container.env via --base), read the same way (grep + cut). Deliberately NO
# non-empty check here, unlike GIT_TOKEN: an unset/empty ack must still fail closed downstream in
# provision.sh's ref/target fidelity guard, so this is allowed to come through empty.
HARMONY_ACK_PLUGIN_AHEAD_OF_PROD="$(grep -m1 '^HARMONY_ACK_PLUGIN_AHEAD_OF_PROD=' "$ENV_FILE" | cut -d= -f2- || true)"

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
      # B-726 followup: `update --env-vars-file` REPLACES the job's entire literal env-var set (see
      # the block comment above this function), so HARMONY_ACK_PLUGIN_AHEAD_OF_PROD has no other
      # channel to reach the cloud container's provision.sh ref/target fidelity check (the guard
      # B-726 itself added). This is now a local shell variable populated from the minted env-file
      # above (via `mint-installation-token.mjs --base "$HOME/.harmony-container.env"`), NOT
      # inherited from this wrapper's own invoking environment (the daemon host process) — forward
      # it only when set — an unset ack must still fail closed exactly as provision.sh intends, so
      # this is deliberately conditional, never unconditional.
      if [ -n "${HARMONY_ACK_PLUGIN_AHEAD_OF_PROD:-}" ]; then
        printf 'HARMONY_ACK_PLUGIN_AHEAD_OF_PROD: "%s"\n' "$HARMONY_ACK_PLUGIN_AHEAD_OF_PROD"
      fi
    } > "$file"
  )
  chmod 600 "$file"
}
write_exec_env_file "$EXEC_ENV_FILE"

# B-717 item 6: acquire the shared launch lock NOW — right before the two non-atomic calls that
# mutate the shared job definition, narrowing the critical section to exactly that pair (plus the
# execution-id resolve immediately after) rather than the whole multi-minute build.
acquire_lock

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
# B-717 (accepted design c4c975bd pt.6, plan-gate correction 1 — RESOLVED): `update --env-vars-file`
# mutates (replaces) the Cloud Run JOB DEFINITION itself before the `execute` call immediately below
# reads that same job definition to launch the execution — TWO non-atomic gcloud calls against one
# shared job definition. B-717 resolves the race this created (once the daemon stopped being
# strictly serial) with the mkdir-based lock acquired immediately above: both calls, and the
# execution-id resolve after them, run inside its critical section — see acquire_lock/release_lock.
gcloud run jobs update "$HARMONY_CLOUD_RUN_JOB" \
  --region="$HARMONY_CLOUD_RUN_REGION" \
  --env-vars-file="$EXEC_ENV_FILE" \
  --update-labels="conduction-id=$CONDUCTION_ID"

# 3b. Fire the job execution WITHOUT --wait (B-717 plan-gate correction 1) AND WITH --async (B-717
#     reopened fix, live concurrency test 2026-08-04): `execute --wait` is a single blocking call
#     with no "submission returns an execution id" moment. But dropping `--wait` alone was NOT
#     enough — `execute` without `--wait` still blocks until the operation in progress (the
#     execution actually STARTING) completes, and a cold start of the worker image takes 1.5-2.5
#     minutes, not the "few seconds" the launch lock (acquire_lock/release_lock above) was designed
#     to be held for. A peer wrapper hit the lock's wait timeout and dirty-exited while this call was
#     still blocked. `--async` (CONFIRMED present on `gcloud run jobs execute --help`: "Return
#     immediately, without waiting for the operation in progress to complete.") fixes this: the lock
#     is now held only for the `update`+`execute`-submission round trip, genuinely a few seconds. Env
#     vars/labels are snapshotted at job-execute time regardless of `--async`, and this wrapper
#     already resolves the execution afterward via the conduction-id label lookup (below) rather than
#     parsing `execute`'s own output, so no other logic here needs to change.
#     `gcloud run jobs execute` has no `--labels` flag (CONFIRMED live, 2026-08-03 — see the `update`
#     call site above); the execution is instead found via the `conduction-id` label the `update`
#     call above just set on the JOB DEFINITION, which the execution inherits (CONFIRMED live) into
#     its own `metadata.labels` — no caller-assigned name needed (Cloud Run assigns the execution
#     name/ID itself). This launches with the env vars the `update` call immediately above just
#     pushed onto the job definition, too.
#
# `execute`'s OWN submit-time exit code is not the classification signal here (unchanged rationale
# from the old `--wait` form — see step 4's authoritative post-hoc read, which this wrapper always
# falls through to regardless of what happens at submission).
# B-754 fix (2026-08-03): execute fired with NO container args, so the entrypoint's no-arg
# default silently exited 0, no work done. `--args` CONFIRMED live (2026-08-03) on `execute`; the
# comma splits the two positional args (`headless`, prompt) — spaces inside the prompt survive
# since gcloud only splits on commas.
set +e
gcloud run jobs execute "$HARMONY_CLOUD_RUN_JOB" \
  --region="$HARMONY_CLOUD_RUN_REGION" \
  --async \
  --args="headless,/harmony-plugin:harmony-conduct $TICKET --one-shot"
EXECUTE_SUBMIT_EXIT=$?
set -e

# The exec-env-vars file held the minted token in cleartext on disk for exactly one call's worth of
# time. Delete it the moment BOTH calls above have returned — success or failure, it is never reused.
rm -f "$EXEC_ENV_FILE"

# B-717 plan-gate correction 1: resolve the execution via the existing conduction-id label lookup —
# POLL briefly until it appears (submission is async; the execution may not be listable the instant
# `execute` returns), taking the NEWEST (B-713 retries reuse the same label, so an older execution
# from a prior attempt must never be mistaken for this one). Do NOT parse `execute`'s own stdout for
# the execution name — this wrapper never keys on stdout (the agent-portability guardrail extends to
# this script too), and gcloud's stdout shape for `execute` is not a stable API surface.
resolve_execution_name() {
  local attempt
  for attempt in $(seq 1 15); do
    local name
    name="$(gcloud run jobs executions list \
      --job="$HARMONY_CLOUD_RUN_JOB" \
      --region="$HARMONY_CLOUD_RUN_REGION" \
      --filter="metadata.labels.conduction-id=$CONDUCTION_ID" \
      --sort-by="~metadata.creationTimestamp" \
      --format='value(metadata.name)' \
      --limit=1 || true)"
    if [ -n "$name" ]; then
      echo "$name"
      return 0
    fi
    sleep 1
  done
  return 1
}

EXECUTION_NAME="$(resolve_execution_name || true)"

# B-717 item 6: release the lock the MOMENT the execution exists (or resolution definitively failed)
# — env/labels are already snapshotted into the execution at creation, so nothing past this point
# needs the lock. The EXIT trap (release_lock) is the crash-safety backstop; this explicit call is
# what actually narrows the held duration to the few seconds above.
release_lock

if [ -z "$EXECUTION_NAME" ]; then
  echo "cloud-worker-launch: no execution found labelled conduction-id=$CONDUCTION_ID after submitting (execute's own submit exit was $EXECUTE_SUBMIT_EXIT, not trusted)" >&2
  exit 1
fi

# 4. Poll for a terminal state — this wrapper used to rely on `execute --wait` to block here; B-717
#    narrows the lock to the update+execute+resolve section above, so this wrapper now does its own
#    UNLOCKED poll loop instead (the daemon's own per-launch deadline — src/daemon/scheduler.ts —
#    bounds the OVERALL wait from the caller's side; this loop just watches for completion).
#
# SMOKE-TEST GAP (accepted design cf579f0f pt.1) — CONFIRMED via live observation (2026-08-03):
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
POLL_S="${HARMONY_CLOUD_LAUNCH_POLL_S:-5}"
while :; do
  COMPLETION="$(gcloud run jobs executions describe "$EXECUTION_NAME" \
    --region="$HARMONY_CLOUD_RUN_REGION" \
    --format='value(status.completionTime)' 2>/dev/null || true)"
  [ -n "$COMPLETION" ] && break
  sleep "$POLL_S"
done

# B-754-element fix (2026-08-04, found while diagnosing B-726's live cloud verify failure):
# `--format='value(...)'` prints tab/space-separated columns, and when a column (e.g.
# succeededCount) is null/absent, gcloud emits nothing for it — the shell's `read` strips that
# leading empty field and every remaining field shifts left, so FAILED's value lands in the
# SUCCEEDED variable. Every FAILED execution (succeededCount null, failedCount=1) therefore parsed
# as SUCCEEDED=1 and the wrapper exited 0 on a failed build. Parse via `--format=json` + `jq` instead,
# defaulting each field with `// 0` / `// ""` so a null/absent field can never shift the others.
read -r SUCCEEDED FAILED COMPLETION < <(
  gcloud run jobs executions describe "$EXECUTION_NAME" \
    --region="$HARMONY_CLOUD_RUN_REGION" \
    --format=json \
  | jq -r '[.status.succeededCount // 0, .status.failedCount // 0, .status.completionTime // ""] | @tsv'
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
