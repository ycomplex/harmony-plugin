#!/usr/bin/env bash
# B-1163: one-time (and safely re-runnable) setup of everything a `gke` launch profile needs — the
# GKE cluster, the autoscaling leg node pool, the namespace, the daemon service account's IAM, and the
# two Kubernetes Secrets the legs read. Run it ONCE, by an operator who is already logged in to gcloud
# with enough rights on the project:
#
#   bash container/gke/setup-cluster.sh --project <project-id> --daemon-sa <sa-email> [options]
#
# What it does, in order (see --help for the flags):
#   1. checks gcloud / kubectl / gke-gcloud-auth-plugin are installed (not in --dry-run);
#   2. checks the source Secret Manager secrets exist — BEFORE anything is created;
#   3. prints the SSD_TOTAL_GB quota headroom (a warning, never a failure);
#   4. creates the cluster and the leg node pool ONLY IF MISSING — an existing cluster or pool is
#      never modified; a pool that differs from the expected settings is reported as `DRIFT:`;
#   5. creates the namespace and the daemon service account's roles/container.developer binding if
#      missing;
#   6. syncs two Kubernetes Secrets from Secret Manager: an ENV Secret (HARMONY_API_TOKEN and
#      CLAUDE_CODE_OAUTH_TOKEN) and a FILE Secret (auth.json, the Codex credential).
#
# Guarantees:
#   * It works in a TEMPORARY kubeconfig (removed on exit); the operator's own kubeconfig is never read
#     or written.
#   * Secret values go only to mode-600 files in a private temp dir and through a pipe into
#     `kubectl apply`; they never appear in argv, stdout, stderr or a log. Only Secret and key NAMES are
#     printed. There is no `set -x`.
#   * --dry-run prints every gcloud / kubectl command it WOULD run (reads included) and runs none of them.
#   * The two Secrets are separate on purpose: a dotted key (auth.json) is not a valid environment
#     variable name, and a file credential must not be exposed to every leg's environment.
#   * No Harmony-specific value is a default for --project / --daemon-sa: this serves other deployments.
#     The default cluster name is deliberately NEW, so the hand-made spike cluster is untouched unless
#     someone passes its name.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: setup-cluster.sh --project <id> --daemon-sa <service-account-email> [options]

Required:
  --project <id>          GCP project (falls back to $CLOUDSDK_CORE_PROJECT, then `gcloud config get-value project`)
  --daemon-sa <email>     the service account the daemon runs kubectl as (gets roles/container.developer)

Options (defaults in brackets):
  --zone <zone>           [us-central1-a]
  --cluster <name>        [harmony-legs]
  --pool <name>           [legs]
  --machine-type <type>   [e2-standard-8]
  --max-nodes <n>         [2]
  --namespace <ns>        [harmony-legs]
  --env-secret <name>     Kubernetes Secret holding the two env tokens [harmony-worker-secrets]
  --codex-secret <name>   Kubernetes Secret holding the Codex file credential [harmony-codex-auth]
  --sm-api-token <name>   Secret Manager source for HARMONY_API_TOKEN [HARMONY_API_TOKEN]
  --sm-claude-token <n>   Secret Manager source for CLAUDE_CODE_OAUTH_TOKEN [CLAUDE_CODE_OAUTH_TOKEN]
  --sm-codex <name>       Secret Manager name of the Codex credential file [harmony-codex-auth]
  --no-codex              skip the Codex file Secret entirely
  --skip-quota-check      do not read the SSD_TOTAL_GB quota
  --dry-run               print every command instead of running it (no gcloud/kubectl needed)
  -h, --help              this text
USAGE
}

die_usage() {
  echo "setup-cluster: $*" >&2
  usage >&2
  exit 2
}

PROJECT="${CLOUDSDK_CORE_PROJECT:-}"
DAEMON_SA=""
ZONE="us-central1-a"
CLUSTER="harmony-legs"
POOL="legs"
MACHINE_TYPE="e2-standard-8"
MAX_NODES="2"
NAMESPACE="harmony-legs"
ENV_SECRET="harmony-worker-secrets"
CODEX_SECRET="harmony-codex-auth"
SM_API_TOKEN="HARMONY_API_TOKEN"
SM_CLAUDE_TOKEN="CLAUDE_CODE_OAUTH_TOKEN"
SM_CODEX="harmony-codex-auth"
NO_CODEX=0
SKIP_QUOTA=0
DRY_RUN=0

need_value() { [ $# -ge 2 ] || die_usage "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --project) need_value "$@"; PROJECT="$2"; shift 2 ;;
    --daemon-sa) need_value "$@"; DAEMON_SA="$2"; shift 2 ;;
    --zone) need_value "$@"; ZONE="$2"; shift 2 ;;
    --cluster) need_value "$@"; CLUSTER="$2"; shift 2 ;;
    --pool) need_value "$@"; POOL="$2"; shift 2 ;;
    --machine-type) need_value "$@"; MACHINE_TYPE="$2"; shift 2 ;;
    --max-nodes) need_value "$@"; MAX_NODES="$2"; shift 2 ;;
    --namespace) need_value "$@"; NAMESPACE="$2"; shift 2 ;;
    --env-secret) need_value "$@"; ENV_SECRET="$2"; shift 2 ;;
    --codex-secret) need_value "$@"; CODEX_SECRET="$2"; shift 2 ;;
    --sm-api-token) need_value "$@"; SM_API_TOKEN="$2"; shift 2 ;;
    --sm-claude-token) need_value "$@"; SM_CLAUDE_TOKEN="$2"; shift 2 ;;
    --sm-codex) need_value "$@"; SM_CODEX="$2"; shift 2 ;;
    --no-codex) NO_CODEX=1; shift ;;
    --skip-quota-check) SKIP_QUOTA=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die_usage "unknown argument: $1" ;;
  esac
done

if [ -z "$PROJECT" ] && command -v gcloud >/dev/null 2>&1; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
fi
[ -n "$PROJECT" ] || die_usage "--project is required (or set CLOUDSDK_CORE_PROJECT, or run 'gcloud config set project')"
[ -n "$DAEMON_SA" ] || die_usage "--daemon-sa is required"
case "$DAEMON_SA" in
  *@* ) ;;
  *) die_usage "--daemon-sa must be a service account email, got '$DAEMON_SA'" ;;
esac
case "$MAX_NODES" in
  '' | *[!0-9]* | 0) die_usage "--max-nodes must be a positive integer, got '$MAX_NODES'" ;;
esac

REGION="${ZONE%-*}"

step() { echo; echo "=== $* ==="; }

# --- the ONE door every gcloud / kubectl call goes through ---------------------------------------
# run:     a mutating or output-bearing call. In --dry-run: print it, execute nothing.
# probe:   an existence check (output discarded). In --dry-run: print it and report "absent" (1), so
#          the output shows the full create path.
# capture: a read whose stdout is wanted. In --dry-run: print it, return 1, output nothing.
quote() { printf '%q ' "$@"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] $(quote "$@")"
    return 0
  fi
  "$@"
}
probe() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] $(quote "$@")"
    return 1
  fi
  "$@" >/dev/null 2>&1
}
capture() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] $(quote "$@")" >&2
    return 1
  fi
  "$@" 2>/dev/null
}

step "1. Preflight: tools"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run: no gcloud / kubectl call is made, so none is required"
else
  for tool in gcloud kubectl gke-gcloud-auth-plugin; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "setup-cluster: '$tool' is not on PATH — install it and run again." >&2
      exit 1
    fi
  done
  echo "gcloud, kubectl and gke-gcloud-auth-plugin found"
fi

step "2. Preflight: Secret Manager sources exist"
SOURCES=("$SM_API_TOKEN" "$SM_CLAUDE_TOKEN")
[ "$NO_CODEX" -eq 1 ] || SOURCES+=("$SM_CODEX")
missing=()
for s in "${SOURCES[@]}"; do
  if [ "$DRY_RUN" -eq 1 ]; then
    run gcloud secrets describe "$s" --project "$PROJECT" '--format=value(name)'
  elif ! gcloud secrets describe "$s" --project "$PROJECT" '--format=value(name)' >/dev/null 2>&1; then
    missing+=("$s")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "setup-cluster: Secret Manager secret(s) not found in project $PROJECT: ${missing[*]}" >&2
  echo "setup-cluster: create them first (nothing has been created yet)." >&2
  exit 1
fi
[ "$DRY_RUN" -eq 1 ] || echo "found: ${SOURCES[*]}"

QUOTA_WARNED=0
if [ "$SKIP_QUOTA" -eq 0 ]; then
  step "3. SSD_TOTAL_GB quota in $REGION"
  # Boot disks here are pd-standard, so they do NOT consume SSD quota. The per-ticket disks (PVCs) may
  # (an SSD-backed storage class), and they are what this headroom check is about. Informational only:
  # it never fails the run.
  if quota_line="$(capture gcloud compute regions describe "$REGION" --project "$PROJECT" \
    '--flatten=quotas[]' '--filter=quotas.metric=SSD_TOTAL_GB' '--format=value(quotas.usage,quotas.limit)')" \
    && [ -n "$quota_line" ]; then
    usage_gb="$(printf '%s' "$quota_line" | awk -F'\t' '{print $1}')"
    limit_gb="$(printf '%s' "$quota_line" | awk -F'\t' '{print $2}')"
    echo "SSD_TOTAL_GB: ${usage_gb} of ${limit_gb} GB used in ${REGION}"
    if awk -v u="$usage_gb" -v l="$limit_gb" 'BEGIN { exit !((l - u) < 100) }'; then
      echo "WARNING: less than 100 GB of SSD_TOTAL_GB headroom in $REGION — ticket disks may fail to provision."
      QUOTA_WARNED=1
    fi
  elif [ "$DRY_RUN" -eq 0 ]; then
    echo "SSD_TOTAL_GB: could not be read (continuing)"
  fi
fi

# A TEMPORARY kubeconfig: nothing below reads or writes the operator's own.
KUBECONFIG="$(mktemp)"
export KUBECONFIG
umask 077
SECRET_DIR="$(mktemp -d)"
cleanup() { rm -f "$KUBECONFIG"; rm -rf "$SECRET_DIR"; }
trap cleanup EXIT

step "4. Cluster $CLUSTER"
if probe gcloud container clusters describe "$CLUSTER" --zone "$ZONE" --project "$PROJECT"; then
  echo "cluster $CLUSTER: exists, left unchanged"
else
  run gcloud container clusters create "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    --num-nodes 1 --machine-type e2-medium --disk-type pd-standard --enable-image-streaming
fi

step "5. Leg node pool $POOL"
if probe gcloud container node-pools describe "$POOL" --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT"; then
  echo "node pool $POOL: exists, left unchanged — checking it against the expected settings"
  pool_line="$(gcloud container node-pools describe "$POOL" --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    '--format=value(config.machineType,config.diskType,autoscaling.minNodeCount,autoscaling.maxNodeCount)' 2>/dev/null || true)"
  taints="$(gcloud container node-pools describe "$POOL" --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    '--flatten=config.taints[]' '--format=value(config.taints.key,config.taints.value,config.taints.effect)' 2>/dev/null || true)"
  have_mt="$(printf '%s' "$pool_line" | awk -F'\t' '{print $1}')"
  have_dt="$(printf '%s' "$pool_line" | awk -F'\t' '{print $2}')"
  have_min="$(printf '%s' "$pool_line" | awk -F'\t' '{print $3}')"
  have_max="$(printf '%s' "$pool_line" | awk -F'\t' '{print $4}')"
  # proto3 omits a zero value, so an absent minNodeCount means 0.
  [ -n "$have_min" ] || have_min=0
  drift=0
  if [ "$have_mt" != "$MACHINE_TYPE" ]; then echo "DRIFT: pool $POOL machine type is '${have_mt:-unknown}', expected '$MACHINE_TYPE'"; drift=1; fi
  if [ "$have_dt" != "pd-standard" ]; then echo "DRIFT: pool $POOL disk type is '${have_dt:-unknown}', expected 'pd-standard'"; drift=1; fi
  if [ "$have_min" != "0" ]; then echo "DRIFT: pool $POOL min nodes is '$have_min', expected '0'"; drift=1; fi
  if [ "$have_max" != "$MAX_NODES" ]; then echo "DRIFT: pool $POOL max nodes is '${have_max:-unknown}', expected '$MAX_NODES'"; drift=1; fi
  if ! printf '%s\n' "$taints" | awk -F'\t' '$1 == "harmony-leg" && $2 == "true" && $3 == "NO_SCHEDULE" { f = 1 } END { exit !f }'; then
    echo "DRIFT: pool $POOL is missing the taint harmony-leg=true:NoSchedule"; drift=1
  fi
  [ "$drift" -eq 0 ] && echo "node pool $POOL: matches the expected settings"
  [ "$drift" -eq 0 ] || echo "(nothing was changed — fix the pool by hand or recreate it if the drift matters)"
else
  run gcloud container node-pools create "$POOL" --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    --machine-type "$MACHINE_TYPE" --disk-type pd-standard --disk-size 100 --image-type COS_CONTAINERD \
    --enable-image-streaming --enable-autoscaling --min-nodes 0 --max-nodes "$MAX_NODES" --num-nodes 0 \
    --node-taints harmony-leg=true:NoSchedule
fi

step "6. Credentials (temporary kubeconfig)"
run gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$PROJECT"

step "7. Namespace $NAMESPACE"
if probe kubectl get namespace "$NAMESPACE"; then
  echo "namespace $NAMESPACE: exists"
else
  run kubectl create namespace "$NAMESPACE"
fi

step "8. IAM: $DAEMON_SA -> roles/container.developer"
held="$(capture gcloud projects get-iam-policy "$PROJECT" '--flatten=bindings[].members' \
  "--filter=bindings.role:roles/container.developer AND bindings.members:serviceAccount:$DAEMON_SA" \
  '--format=value(bindings.role)' || true)"
if [ -n "$held" ]; then
  echo "$DAEMON_SA already holds roles/container.developer"
else
  run gcloud projects add-iam-policy-binding "$PROJECT" "--member=serviceAccount:$DAEMON_SA" \
    --role=roles/container.developer --condition=None
fi

step "9. Kubernetes Secrets in $NAMESPACE"
# fetch <secret-manager-name> <key>: the value goes to a FILE only (umask 077 above), never to argv or
# the terminal. In --dry-run nothing is accessed; the command is shown with the file path only.
fetch() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] $(quote gcloud secrets versions access latest "--secret=$1" --project "$PROJECT") > $(quote "$SECRET_DIR/$2")"
  else
    gcloud secrets versions access latest "--secret=$1" --project "$PROJECT" > "$SECRET_DIR/$2"
  fi
}
# sync_secret <k8s-secret-name> <key>...: create-or-update through a pipe; the YAML is never printed.
sync_secret() {
  local name="$1"; shift
  local args=() key
  for key in "$@"; do args+=("--from-file=$key=$SECRET_DIR/$key"); done
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] $(quote kubectl -n "$NAMESPACE" create secret generic "$name" "${args[@]}" --dry-run=client -o yaml) | $(quote kubectl apply -f -)"
  else
    kubectl -n "$NAMESPACE" create secret generic "$name" "${args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  fi
  echo "secret $name: keys $*"
}
fetch "$SM_API_TOKEN" HARMONY_API_TOKEN
fetch "$SM_CLAUDE_TOKEN" CLAUDE_CODE_OAUTH_TOKEN
sync_secret "$ENV_SECRET" HARMONY_API_TOKEN CLAUDE_CODE_OAUTH_TOKEN
if [ "$NO_CODEX" -eq 1 ]; then
  echo "codex: skipped (--no-codex)"
else
  fetch "$SM_CODEX" auth.json
  sync_secret "$CODEX_SECRET" auth.json
fi

step "Done. Values for the deployment config"
echo "project:        $PROJECT"
echo "zone:           $ZONE"
echo "cluster:        $CLUSTER"
echo "node pool:      $POOL"
echo "namespace:      $NAMESPACE"
echo "env Secret:     $ENV_SECRET (keys: HARMONY_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN)"
if [ "$NO_CODEX" -eq 1 ]; then
  echo "file Secret:    none (--no-codex)"
else
  echo "file Secret:    $CODEX_SECRET (key: auth.json)"
fi
echo
echo "Next steps:"
if [ "$QUOTA_WARNED" -eq 1 ]; then
  echo "  - request an SSD_TOTAL_GB quota increase in $REGION (the warning above fired)."
fi
echo "  - on the daemon host (with kubectl and gke-gcloud-auth-plugin installed), as the daemon service account:"
echo "      CLOUDSDK_CORE_ACCOUNT=$DAEMON_SA gcloud container clusters get-credentials $CLUSTER --zone $ZONE --project $PROJECT"
echo "  - schedule container/gke/sweep-ticket-disks.sh on the daemon host (cron / launchd)."
