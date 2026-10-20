#!/usr/bin/env bash
# GKE node-pool LAUNCH wrapper — the "gke" launch profile.
#
# The conductor still runs one shell command per leg and reads only its exit code. Cloned from
# container/cloud-worker-launch.sh — same per-run App-token mint, same exec-env set, same Codex
# refusals — but the leg is ONE Kubernetes Job on a tainted, autoscaled leg pool instead of an
# execution of one shared Cloud Run job:
#
#   * No launch lock. Every leg is its own Job object, so N launches never race on shared state.
#   * Credentials. Long-lived ones (HARMONY_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) come from a cluster
#     Secret the operator creates once ($HARMONY_GKE_BASE_SECRET). Per-run values (GIT_TOKEN and the
#     rest of the exec-env set) go into a per-leg Secret created from a 0600 env-file
#     (--from-env-file: never on argv) and owned by the Job, so deleting the Job deletes it.
#   * Per-ticket PVC (ticket-<lower-cased ticket id>) carrying the engine data and the Playwright
#     cache across a ticket's legs (see gke-render-leg.mjs LEG_DISK_MOUNTS). Session transcripts are
#     NOT on the PVC (B-1169): they live in gs://$HARMONY_GKE_TRANSCRIPT_BUCKET (the same
#     <ticket>/<conduction>/{projects,logs} layout as Cloud Run), mounted through the Cloud Storage
#     FUSE CSI driver and reached via the Kubernetes service account $HARMONY_GKE_SERVICE_ACCOUNT
#     (Workload Identity); setup-cluster.sh steps 10-16 provision all of that.
#   * Exit. Polls the Job: Complete with clean pod evidence -> 0; Failed, gone, or Complete with pod
#     evidence of a disruption (or evidence that cannot be read) -> 1. backoffLimit 0: the conductor's
#     ladder retries, never Kubernetes. Events are never read.
#
# usage: gke-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]
set -euo pipefail

CONDUCTION_ID="${1:?usage: gke-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]}"
TICKET="${2:?usage: gke-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]}"
DEFAULT_RUN_CONFIG='{}'
RUN_CONFIG_JSON="${3:-$DEFAULT_RUN_CONFIG}"
MODEL="${4:-}"
HERE="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=gke-common.sh
. "$HERE/gke-common.sh"

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
: "${HARMONY_GKE_BASE_SECRET:=harmony-worker-secrets}"
: "${HARMONY_GKE_CODEX_SECRET:=harmony-codex-auth}"
: "${HARMONY_GKE_REGISTRY:=us-central1-docker.pkg.dev/harmony-conductor/harmony-workers}"
: "${HARMONY_GKE_DEFAULT_IMAGE:=harmony-build-env-docker:latest}"
: "${HARMONY_GKE_CPU:=6}"
: "${HARMONY_GKE_MEMORY:=20Gi}"
: "${HARMONY_GKE_TICKET_DISK:=20Gi}"
# HARMONY_GKE_STORAGE_CLASS: unset => harmony-ticket-disk when the cluster has it, else standard-rwo (below).
: "${HARMONY_GKE_DEADLINE_S:=5400}"          # the Cloud Run job's task timeout
: "${HARMONY_GKE_POLL_S:=5}"
: "${HARMONY_GKE_JOB_TTL_S:=3600}"
: "${HARMONY_GKE_TRANSCRIPT_BUCKET:=harmony-conductor-transcripts}"
: "${HARMONY_GKE_SERVICE_ACCOUNT:=harmony-leg}"
TRANSCRIPT_MOUNT_ROOT="/mnt/harmony-transcripts"

# Image precedence: HARMONY_GKE_IMAGE > the deployment config's worker_image > the built-in default.
if [ -n "${HARMONY_GKE_IMAGE:-}" ]; then
  IMAGE_NAME="$HARMONY_GKE_IMAGE"; IMAGE_SOURCE="HARMONY_GKE_IMAGE"
elif [ -n "$CONFIG_WORKER_IMAGE" ]; then
  IMAGE_NAME="$CONFIG_WORKER_IMAGE"; IMAGE_SOURCE="deployment config worker_image"
else
  IMAGE_NAME="$HARMONY_GKE_DEFAULT_IMAGE"; IMAGE_SOURCE="built-in default"
fi
case "$IMAGE_NAME" in
  */*) WORKER_IMAGE_REF="$IMAGE_NAME" ;;
  *)   WORKER_IMAGE_REF="$HARMONY_GKE_REGISTRY/$IMAGE_NAME" ;;
esac
echo "gke-worker-launch: image $WORKER_IMAGE_REF (source: $IMAGE_SOURCE)" >&2

gke_init_kubectl

# Checked before anything is minted: refusing here costs nothing.
if ! "${KUBECTL[@]}" get secret "$HARMONY_GKE_BASE_SECRET" >/dev/null 2>&1; then
  echo "gke-worker-launch: Refusing to start: base secret $HARMONY_GKE_NAMESPACE/$HARMONY_GKE_BASE_SECRET (HARMONY_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) is missing or unreadable — no Job created" >&2
  exit 1
fi
if ! "${KUBECTL[@]}" get serviceaccount "$HARMONY_GKE_SERVICE_ACCOUNT" >/dev/null 2>&1; then
  echo "gke-worker-launch: Refusing to start: Kubernetes service account $HARMONY_GKE_NAMESPACE/$HARMONY_GKE_SERVICE_ACCOUNT (the Workload Identity identity that reaches the transcript bucket) is missing or unreadable — no Job created" >&2
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
# its own Job, found again by the conduction-id label. The PVC pattern is relied on by the
# ticket-disk cleanup sweep: ticket-<id lower-cased, [^a-z0-9-] -> '-'>.
TICKET_SLUG="$(printf '%s' "$TICKET" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
PVC_NAME="ticket-$TICKET_SLUG"
JOB_NAME="leg-${CONDUCTION_ID:0:8}-$(date +%s)"
LEG_SECRET="$JOB_NAME-env"

# --- Ticket-disk storage class. setup-cluster.sh step 17 creates harmony-ticket-disk: Immediate binding,
# pinned to the leg pool's zone, so the disk is created WHILE the node scales up. standard-rwo waits for
# the pod to land and then races the new node's disk driver ("no topology key found"; ~65 s on the
# first GKE leg, 2026-10-20). A cluster set up before step 17 keeps working on standard-rwo.
if [ -z "${HARMONY_GKE_STORAGE_CLASS:-}" ]; then
  if "${KUBECTL[@]}" get storageclass harmony-ticket-disk >/dev/null 2>&1; then
    HARMONY_GKE_STORAGE_CLASS=harmony-ticket-disk
  else
    HARMONY_GKE_STORAGE_CLASS=standard-rwo
    echo "gke-worker-launch: storage class harmony-ticket-disk not found; using standard-rwo (run setup-cluster.sh to create it)" >&2
  fi
fi

render() {  # $1 = what: pvc | job
  WHAT="$1" PVC_NAME="$PVC_NAME" JOB_NAME="$JOB_NAME" LEG_SECRET="$LEG_SECRET" TICKET="$TICKET" \
  CONDUCTION_ID="$CONDUCTION_ID" IMAGE="$WORKER_IMAGE_REF" CPU="$HARMONY_GKE_CPU" MEM="$HARMONY_GKE_MEMORY" \
  DISK="$HARMONY_GKE_TICKET_DISK" SC="$HARMONY_GKE_STORAGE_CLASS" DEADLINE="$HARMONY_GKE_DEADLINE_S" \
  JOB_TTL_S="$HARMONY_GKE_JOB_TTL_S" \
  BASE_SECRET="$HARMONY_GKE_BASE_SECRET" CODEX_RUN="$CODEX_RUN" CODEX_SECRET="$HARMONY_GKE_CODEX_SECRET" \
  CODEX_DIR="$CODEX_SECRET_MOUNT_DIR" TROOT="$TRANSCRIPT_MOUNT_ROOT" \
  TRANSCRIPT_BUCKET="$HARMONY_GKE_TRANSCRIPT_BUCKET" SERVICE_ACCOUNT="$HARMONY_GKE_SERVICE_ACCOUNT" \
  node "$HERE/gke-render-leg.mjs"
}

render pvc | "${KUBECTL[@]}" apply -f - >/dev/null
# The Job first, then its per-leg secret CREATED already owned by it (deleting the Job — reap, TTL — deletes the
# secret). One create, no get/patch: the remote conductor's Role (container/conductor/k8s/rbac-legs.yaml) may create
# secrets but read only the two named base ones, and `kubectl patch` reads first (B-1173, 2026-10-20). The leg pod
# waits for the secret it names in envFrom, which appears seconds later. The manifest is rendered client-side, so
# no value is ever on argv; it travels on a pipe.
render job | "${KUBECTL[@]}" create -f - >/dev/null
JOB_UID="$("${KUBECTL[@]}" get job "$JOB_NAME" -o jsonpath='{.metadata.uid}')"
if ! "${KUBECTL[@]}" create secret generic "$LEG_SECRET" --from-env-file="$LEG_ENV_FILE" --dry-run=client -o json \
  | JOB_NAME="$JOB_NAME" JOB_UID="$JOB_UID" node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => {
        const o = JSON.parse(s);
        o.metadata.ownerReferences = [{ apiVersion: "batch/v1", kind: "Job", name: process.env.JOB_NAME, uid: process.env.JOB_UID }];
        process.stdout.write(JSON.stringify(o));
      });' \
  | "${KUBECTL[@]}" create -f - >/dev/null; then
  rm -f "$LEG_ENV_FILE"
  echo "gke-worker-launch: could not create the leg secret $LEG_SECRET; deleting job $JOB_NAME" >&2
  "${KUBECTL[@]}" delete job "$JOB_NAME" --ignore-not-found >/dev/null 2>&1 || true
  exit 1
fi
rm -f "$LEG_ENV_FILE"
echo "gke-worker-launch: job $HARMONY_GKE_NAMESPACE/$JOB_NAME (pvc $PVC_NAME)" >&2

# --- Wait for a terminal state. --------------------------------------------------------------------
# Verdicts are parsed with node from the Job's JSON; Events are never read.
JOB_VERDICT_JS='
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { process.exit(2); }
  if (!j || typeof j !== "object" || !j.metadata) process.exit(2);
  const conds = (j.status && j.status.conditions) || [];
  const has = (t) => conds.find((c) => c.type === t && c.status === "True");
  const failed = has("Failed");
  if (failed) { process.stdout.write("failed " + (failed.reason || "unknown reason") + "\n"); return; }
  process.stdout.write(has("Complete") ? "complete\n" : "active\n");
});'
POD_EVIDENCE_JS='
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { process.exit(2); }
  const items = j && Array.isArray(j.items) ? j.items : null;
  if (!items || items.length === 0) process.exit(2);
  const BAD = ["Terminated", "NodeShutdown", "Shutdown", "Evicted", "Preempting"];
  const found = [];
  for (const p of items) {
    const name = (p.metadata && p.metadata.name) || "?";
    const st = p.status || {};
    if ((st.conditions || []).some((c) => c.type === "DisruptionTarget" && c.status === "True")) found.push(name + ": DisruptionTarget=True");
    if (p.metadata && p.metadata.deletionTimestamp) found.push(name + ": deletionTimestamp set");
    if (BAD.includes(st.reason)) found.push(name + ": status.reason=" + st.reason);
  }
  process.stdout.write(found.length ? "bad " + found.join("; ") + "\n" : "clean\n");
});'

POD_TRIES=0
while :; do
  set +e
  JOB_JSON="$("${KUBECTL[@]}" get job "$JOB_NAME" -o json 2>/dev/null)"
  GET_EXIT=$?
  set -e
  VERDICT=""
  if [ "$GET_EXIT" -eq 0 ]; then
    VERDICT="$(printf '%s' "$JOB_JSON" | node -e "$JOB_VERDICT_JS" 2>/dev/null || true)"
  else
    if [ -z "$("${KUBECTL[@]}" get job "$JOB_NAME" --ignore-not-found -o name 2>/dev/null || echo api-error)" ]; then
      echo "gke-worker-launch: job $JOB_NAME is gone (reaped or deleted) — dirty exit" >&2
      exit 1
    fi
  fi
  case "$VERDICT" in
    failed*)
      echo "gke-worker-launch: job $JOB_NAME failed (${VERDICT#failed }) — dirty exit" >&2
      exit 1 ;;
    complete)
      set +e
      PODS_JSON="$("${KUBECTL[@]}" get pods -l "job-name=$JOB_NAME" -o json 2>/dev/null)"
      PODS_EXIT=$?
      set -e
      EVIDENCE=""
      if [ "$PODS_EXIT" -eq 0 ]; then
        EVIDENCE="$(printf '%s' "$PODS_JSON" | node -e "$POD_EVIDENCE_JS" 2>/dev/null || true)"
      fi
      case "$EVIDENCE" in
        clean) exit 0 ;;
        bad*)
          echo "gke-worker-launch: job $JOB_NAME is Complete but its pod shows a disruption (${EVIDENCE#bad }) — dirty exit" >&2
          exit 1 ;;
      esac
      POD_TRIES=$((POD_TRIES + 1))
      if [ "$POD_TRIES" -ge 3 ]; then
        echo "gke-worker-launch: job $JOB_NAME is Complete but its pod evidence could not be confirmed after $POD_TRIES reads — failing closed" >&2
        exit 1
      fi ;;
  esac
  sleep "$HARMONY_GKE_POLL_S"
done
