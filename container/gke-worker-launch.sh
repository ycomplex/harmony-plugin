#!/usr/bin/env bash
# B-1060 SPIKE (pooled workers): GKE node-pool LAUNCH wrapper — the "gke" launch profile.
#
# NOT FOR MERGE. A spike artefact proving the profile seam (src/daemon/config.ts LaunchProfile):
# the daemon still runs one shell command per leg and reads only its exit code. Cloned from
# container/cloud-worker-launch.sh — same per-run App-token mint, same env contract, same Codex
# refusals — but the leg is ONE Kubernetes Job on a tainted, autoscaled leg pool instead of an
# execution of one shared Cloud Run job. Differences that matter:
#
#   * No launch lock. Cloud Run's update+execute pair mutated ONE shared job definition (B-717);
#     here every leg is its own Job object, so N launches never race on shared state.
#   * Credentials. Long-lived ones (HARMONY_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) come from a cluster
#     Secret the operator creates once ($HARMONY_GKE_BASE_SECRET). Per-run values (GIT_TOKEN and
#     the rest of the exec-env set) go into a per-leg Secret, created from a 0600 env-file
#     (--from-env-file: never on argv) and owned by the Job, so deleting the Job deletes it.
#   * Per-ticket PVC. One ReadWriteOnce disk per ticket carries BOTH the leg's engine data
#     (subPath docker -> /var/lib/docker: warm images/build cache across a ticket's legs, B-708's
#     named volume) AND its transcripts (subPath transcripts -> the cloud profile's transcript
#     mount root, so entrypoint.sh's symlink + sibling-resume logic runs unchanged — no GCS FUSE).
#   * Exit. Polls the Job's status: succeeded -> 0; failed (incl. a deleted node, an eviction, an
#     activeDeadline) -> 1; Job gone (reaped) -> 1. backoffLimit 0: the daemon's ladder retries,
#     never Kubernetes.
#
# usage: gke-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]
set -euo pipefail

CONDUCTION_ID="${1:?usage: gke-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]}"
TICKET="${2:?usage: gke-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]}"
DEFAULT_RUN_CONFIG='{}'
RUN_CONFIG_JSON="${3:-$DEFAULT_RUN_CONFIG}"
MODEL="${4:-}"

# --- Codex (B-1076 parity): same adapter probe and metered-credential refusals as the cloud launcher.
CODEX_RUN=0
CODEX_AUTH_CONTAINER_PATH="/home/worker/.codex-auth-src/auth.json"
CODEX_SECRET_MOUNT_DIR="/home/worker/.codex-auth-src"
ADAPTER_PROBE="$(node -e 'let s=process.argv[1];try{JSON.parse(s)}catch{try{s=Buffer.from(s,"base64").toString("utf8")}catch{}}try{const a=JSON.parse(s).agent;process.stdout.write(a&&typeof a.adapter==="string"?a.adapter:"")}catch{}' "$RUN_CONFIG_JSON" 2>/dev/null || true)"
if [ "$ADAPTER_PROBE" = "codex" ]; then CODEX_RUN=1; fi
if [ "$CODEX_RUN" = "1" ]; then
  for CODEX_REFUSED_VAR in OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN; do
    if [ -n "${!CODEX_REFUSED_VAR:-}" ]; then
      echo "gke-worker-launch: Refusing to start: $CODEX_REFUSED_VAR is set in the launcher's environment — a Codex leg runs on the plan-included login cache only (B-934: no metered fallback)" >&2
      exit 1
    fi
  done
fi

: "${HARMONY_PLUGIN_DIR:?HARMONY_PLUGIN_DIR is required (checkout the mint script runs from)}"
harmony_config() {
  [ -f "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" ] || return 0
  node "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" config get "$1" 2>/dev/null || true
}
REPOS_JSON="$(harmony_config repos)"
CONFIG_WORKER_IMAGE="$(harmony_config worker_image)"

: "${HARMONY_GKE_NAMESPACE:=harmony-legs}"
: "${HARMONY_GKE_BASE_SECRET:=harmony-worker-base}"
: "${HARMONY_GKE_CODEX_SECRET:=harmony-codex-auth}"
: "${HARMONY_GKE_REGISTRY:=us-central1-docker.pkg.dev/harmony-conductor/harmony-workers}"
: "${HARMONY_GKE_DEFAULT_IMAGE:=harmony-build-env-docker:spike}"
: "${HARMONY_GKE_CPU:=6}"
: "${HARMONY_GKE_MEMORY:=20Gi}"
: "${HARMONY_GKE_TICKET_DISK:=100Gi}"
: "${HARMONY_GKE_STORAGE_CLASS:=standard-rwo}"
: "${HARMONY_GKE_DEADLINE_S:=5400}"          # the Cloud Run job's task timeout
: "${HARMONY_GKE_POLL_S:=5}"
TRANSCRIPT_MOUNT_ROOT="/mnt/harmony-transcripts"

IMAGE_NAME="${CONFIG_WORKER_IMAGE:-$HARMONY_GKE_DEFAULT_IMAGE}"
case "$IMAGE_NAME" in
  */*) WORKER_IMAGE_REF="$IMAGE_NAME" ;;
  *)   WORKER_IMAGE_REF="$HARMONY_GKE_REGISTRY/$IMAGE_NAME" ;;
esac

KUBECTL=(kubectl -n "$HARMONY_GKE_NAMESPACE")
if [ -n "${HARMONY_GKE_CONTEXT:-}" ]; then KUBECTL+=(--context "$HARMONY_GKE_CONTEXT"); fi

# Checked before anything is minted: refusing here costs nothing.
if ! "${KUBECTL[@]}" get secret "$HARMONY_GKE_BASE_SECRET" >/dev/null 2>&1; then
  echo "gke-worker-launch: Refusing to start: base secret $HARMONY_GKE_NAMESPACE/$HARMONY_GKE_BASE_SECRET (HARMONY_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) is missing or unreadable — no Job created" >&2
  exit 1
fi
if [ "$CODEX_RUN" = "1" ] && ! "${KUBECTL[@]}" get secret "$HARMONY_GKE_CODEX_SECRET" >/dev/null 2>&1; then
  echo "gke-worker-launch: Refusing to start: this run selects the codex adapter but secret $HARMONY_GKE_NAMESPACE/$HARMONY_GKE_CODEX_SECRET (the login cache) is missing — no Job created" >&2
  exit 1
fi

# --- Mint (B-732), identical to the cloud launcher. ------------------------------------------------
RUN_DIR="$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID"
mkdir -p "$RUN_DIR"
ENV_FILE="$RUN_DIR/run.env"
LEG_ENV_FILE="$RUN_DIR/leg-secret.env"
trap 'rm -f "$LEG_ENV_FILE"' EXIT
MINT_MODEL_FLAG=()
if [ -n "$MODEL" ]; then MINT_MODEL_FLAG=(--model "$MODEL"); fi
node "$HARMONY_PLUGIN_DIR/scripts/mint-installation-token.mjs" --base "$HOME/.harmony-container.env" --out "$ENV_FILE" --conduction-id "$CONDUCTION_ID" --run-config "$RUN_CONFIG_JSON" ${MINT_MODEL_FLAG[@]+"${MINT_MODEL_FLAG[@]}"}
minted() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
GIT_TOKEN="$(minted GIT_TOKEN)"
if [ -z "$GIT_TOKEN" ]; then
  echo "gke-worker-launch: minted env-file at $ENV_FILE carries no GIT_TOKEN" >&2
  exit 1
fi

# The same variable set cloud-worker-launch.sh's write_exec_env_file() forwards, as KEY=value lines.
( umask 077
  {
    echo "CONDUCTION_ID=$CONDUCTION_ID"
    echo "TICKET=$TICKET"
    echo "GIT_TOKEN=$GIT_TOKEN"
    echo "HARMONY_TRANSCRIPT_MOUNT_ROOT=$TRANSCRIPT_MOUNT_ROOT"
    echo "HARMONY_CONDUCTION_ID=$CONDUCTION_ID"
    for k in HARMONY_PLUGIN_POSTURE HARMONY_RUN_CONFIG_JSON HARMONY_MODEL GIT_TOKEN_EXPIRES_AT HARMONY_LEG; do
      v="$(minted "$k")"
      if [ -n "$v" ]; then echo "$k=$v"; fi
    done
    if [ -n "$REPOS_JSON" ]; then echo "HARMONY_REPOS_JSON=$(printf '%s' "$REPOS_JSON" | base64 | tr -d '\n')"; fi
    if [ "$CODEX_RUN" = "1" ]; then echo "HARMONY_CODEX_AUTH_FILE=$CODEX_AUTH_CONTAINER_PATH"; fi
  } > "$LEG_ENV_FILE"
)

# --- Names. A ticket's legs share its PVC; each leg (incl. a ladder retry, same conduction id) gets
# its own Job, found again by the conduction-id label.
TICKET_SLUG="$(printf '%s' "$TICKET" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
PVC_NAME="ticket-$TICKET_SLUG"
JOB_NAME="leg-${CONDUCTION_ID:0:8}-$(date +%s)"
LEG_SECRET="$JOB_NAME-env"

render() {  # $1 = what: pvc | job
  WHAT="$1" PVC_NAME="$PVC_NAME" JOB_NAME="$JOB_NAME" LEG_SECRET="$LEG_SECRET" TICKET="$TICKET" \
  CONDUCTION_ID="$CONDUCTION_ID" IMAGE="$WORKER_IMAGE_REF" CPU="$HARMONY_GKE_CPU" MEM="$HARMONY_GKE_MEMORY" \
  DISK="$HARMONY_GKE_TICKET_DISK" SC="$HARMONY_GKE_STORAGE_CLASS" DEADLINE="$HARMONY_GKE_DEADLINE_S" \
  BASE_SECRET="$HARMONY_GKE_BASE_SECRET" CODEX_RUN="$CODEX_RUN" CODEX_SECRET="$HARMONY_GKE_CODEX_SECRET" \
  CODEX_DIR="$CODEX_SECRET_MOUNT_DIR" TROOT="$TRANSCRIPT_MOUNT_ROOT" \
  node "$(dirname "${BASH_SOURCE[0]}")/gke-render-leg.mjs"
}

render pvc | "${KUBECTL[@]}" apply -f - >/dev/null
"${KUBECTL[@]}" create secret generic "$LEG_SECRET" --from-env-file="$LEG_ENV_FILE" >/dev/null
rm -f "$LEG_ENV_FILE"
render job | "${KUBECTL[@]}" create -f - >/dev/null
# Tie the per-leg secret's lifetime to the Job (deleting the Job — reap, TTL — deletes the secret).
JOB_UID="$("${KUBECTL[@]}" get job "$JOB_NAME" -o jsonpath='{.metadata.uid}')"
"${KUBECTL[@]}" patch secret "$LEG_SECRET" --type merge \
  -p "{\"metadata\":{\"ownerReferences\":[{\"apiVersion\":\"batch/v1\",\"kind\":\"Job\",\"name\":\"$JOB_NAME\",\"uid\":\"$JOB_UID\"}]}}" >/dev/null
echo "gke-worker-launch: job $HARMONY_GKE_NAMESPACE/$JOB_NAME (image $WORKER_IMAGE_REF, pvc $PVC_NAME)" >&2

# --- Wait for a terminal state. --------------------------------------------------------------------
while :; do
  set +e
  STATE="$("${KUBECTL[@]}" get job "$JOB_NAME" -o jsonpath='{.status.succeeded}/{.status.failed}' 2>/dev/null)"
  GET_EXIT=$?
  set -e
  if [ "$GET_EXIT" -ne 0 ]; then
    if [ -z "$("${KUBECTL[@]}" get job "$JOB_NAME" --ignore-not-found -o name 2>/dev/null || echo api-error)" ]; then
      echo "gke-worker-launch: job $JOB_NAME is gone (reaped or deleted) — dirty exit" >&2
      exit 1
    fi
    sleep "$HARMONY_GKE_POLL_S"; continue   # transient API error: keep waiting
  fi
  case "$STATE" in
    1/*) exit 0 ;;
    */[1-9]*)
      REASON="$("${KUBECTL[@]}" get job "$JOB_NAME" -o jsonpath='{.status.conditions[?(@.type=="Failed")].reason}' 2>/dev/null || true)"
      echo "gke-worker-launch: job $JOB_NAME failed (${REASON:-unknown reason}) — dirty exit" >&2
      exit 1 ;;
  esac
  sleep "$HARMONY_GKE_POLL_S"
done
