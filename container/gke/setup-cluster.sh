#!/usr/bin/env bash
# B-1163: one-time (and safely re-runnable) setup of everything a `gke` launch profile needs — the
# GKE cluster, the autoscaling leg node pool, the namespace, the conductor service account's IAM, and the
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
#      never modified (REVISED by B-1169: steps 10-12 below make exactly three enable-only updates,
#      and nothing else); a pool that differs from the expected settings is reported as `DRIFT:`;
#   5. creates the namespace and the conductor service account's roles/container.developer binding if
#      missing;
#   6. syncs two Kubernetes Secrets from Secret Manager: an ENV Secret (HARMONY_API_TOKEN and
#      CLAUDE_CODE_OAUTH_TOKEN) and a FILE Secret (auth.json, the Codex credential);
#   and, for the transcript bucket (B-1169 — legs keep session transcripts in
#   gs://<--transcript-bucket> through the Cloud Storage FUSE CSI driver, not on the per-ticket PVC):
#   2b. (inside step 2) checks the bucket exists — it is NEVER created here; a missing bucket stops the
#       run before anything is changed;
#  10. ensures the cluster's Workload Identity pool (<project>.svc.id.goog);
#  11. enables the GcsFuseCsiDriver add-on;
#  12. sets --workload-metadata=GKE_METADATA on the leg pool (recreates its nodes, so it REFUSES while a
#      leg Job is active);
#  13. creates the Google service account the legs act as;
#  14. grants it roles/storage.objectUser on the BUCKET only (never project-level);
#  15. lets the Kubernetes service account impersonate it (roles/iam.workloadIdentityUser);
#  16. creates that Kubernetes service account and annotates it with the Google one.
#  17. creates StorageClass harmony-ticket-disk (pd-balanced, Immediate binding, pinned to the zone) for
#      ticket disks, so a disk is made while the leg node boots; create-only, drift reported.
#  Every one of 10-16 reads first and changes only what differs, so a re-run is a no-op.
#  And, for the remote conductor pod (B-1173 — the daemon as a Deployment in its OWN namespace,
#  harmony-conductor; skipped entirely by --no-conductor). Steps 18-26 also read first and change only
#  what differs:
#  18. creates the namespace harmony-conductor;
#  19. creates the Google service account the conductor pod acts as (default harmony-conductor);
#  20. grants it roles/secretmanager.secretAccessor on the TWO NAMED secrets it reads at boot (the API token
#      and the GitHub App key) — per secret, never project-level;
#  21. grants it the project roles the Cloud Run launcher and the log shipper use: roles/run.developer and
#      roles/logging.logWriter;
#  22. grants it roles/iam.serviceAccountUser on the Cloud Run leg runtime account ONLY (needs
#      --cloud-run-runtime-sa; without it the step says so and does nothing);
#  23. grants it roles/artifactregistry.reader on the repository holding the conductor image (tag listing for
#      `harmony conductor update`, and the pod's image pull);
#  24. lets the harmony-conductor/harmony-conductor Kubernetes service account impersonate it
#      (roles/iam.workloadIdentityUser);
#  25. creates that Kubernetes service account and annotates it with the Google one;
#  26. applies the two namespaced RBAC manifests (container/conductor/k8s/rbac-legs.yaml, rbac-conductor.yaml).
#  It does NOT apply the ConfigMap, Deployment or CronJob: those carry an image version and the App
#  identifiers, so they are applied by hand (see the comments in container/conductor/k8s/).
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
  --daemon-sa <email>     the service account the conductor runs kubectl as (gets roles/container.developer)

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
  --leg-gsa-name <name>   Google service account the legs act as (Workload Identity) [harmony-gke-leg]
  --leg-ksa <name>        Kubernetes service account the leg pods run as [harmony-leg]
  --transcript-bucket <b> existing GCS bucket holding session transcripts; never created [harmony-conductor-transcripts]
  --no-codex              skip the Codex file Secret entirely
  --no-conductor          skip steps 18-26 (the remote conductor pod's namespace, account, grants and RBAC)
  --conductor-gsa-name <n> Google service account the conductor pod acts as [harmony-conductor]
  --sm-conductor-api-token <name>  Secret Manager secret the pod reads HARMONY_API_TOKEN from [harmony-conductor-api-token]
  --sm-conductor-app-key <name>    Secret Manager secret holding the GitHub App private key [harmony-daemon-app-private-key]
  --cloud-run-runtime-sa <email>   the Cloud Run leg job's runtime account; the pod may act as it (step 22). Omit to skip
  --artifact-repo <name>  Artifact Registry repository with the conductor image [harmony-workers]
  --artifact-location <l> its location [the region of --zone]
  --artifact-project <id> its project [--project]
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
LEG_GSA_NAME="harmony-gke-leg"
LEG_KSA="harmony-leg"
TRANSCRIPT_BUCKET="harmony-conductor-transcripts"
TICKET_SC="harmony-ticket-disk"
NO_CODEX=0
NO_CONDUCTOR=0
CONDUCTOR_NS="harmony-conductor"
CONDUCTOR_KSA="harmony-conductor"
CONDUCTOR_GSA_NAME="harmony-conductor"
SM_CONDUCTOR_API_TOKEN="harmony-conductor-api-token"
SM_CONDUCTOR_APP_KEY="harmony-daemon-app-private-key"
CLOUD_RUN_RUNTIME_SA=""
ARTIFACT_REPO="harmony-workers"
ARTIFACT_LOCATION=""
ARTIFACT_PROJECT=""
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
    --leg-gsa-name) need_value "$@"; LEG_GSA_NAME="$2"; shift 2 ;;
    --leg-ksa) need_value "$@"; LEG_KSA="$2"; shift 2 ;;
    --transcript-bucket) need_value "$@"; TRANSCRIPT_BUCKET="$2"; shift 2 ;;
    --no-codex) NO_CODEX=1; shift ;;
    --no-conductor) NO_CONDUCTOR=1; shift ;;
    --conductor-gsa-name) need_value "$@"; CONDUCTOR_GSA_NAME="$2"; shift 2 ;;
    --sm-conductor-api-token) need_value "$@"; SM_CONDUCTOR_API_TOKEN="$2"; shift 2 ;;
    --sm-conductor-app-key) need_value "$@"; SM_CONDUCTOR_APP_KEY="$2"; shift 2 ;;
    --cloud-run-runtime-sa) need_value "$@"; CLOUD_RUN_RUNTIME_SA="$2"; shift 2 ;;
    --artifact-repo) need_value "$@"; ARTIFACT_REPO="$2"; shift 2 ;;
    --artifact-location) need_value "$@"; ARTIFACT_LOCATION="$2"; shift 2 ;;
    --artifact-project) need_value "$@"; ARTIFACT_PROJECT="$2"; shift 2 ;;
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
LEG_GSA_EMAIL="${LEG_GSA_NAME}@${PROJECT}.iam.gserviceaccount.com"
CONDUCTOR_GSA_EMAIL="${CONDUCTOR_GSA_NAME}@${PROJECT}.iam.gserviceaccount.com"
[ -n "$ARTIFACT_LOCATION" ] || ARTIFACT_LOCATION="$REGION"
[ -n "$ARTIFACT_PROJECT" ] || ARTIFACT_PROJECT="$PROJECT"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_DIR="$HERE/../conductor/k8s"
# The shipped RBAC manifests name the default leg namespace (harmony-legs) and the default leg ServiceAccount;
# a different one would bind rights in the wrong place, so stop before anything is created.
if [ "$NO_CONDUCTOR" -eq 0 ] && { [ "$NAMESPACE" != "harmony-legs" ] || [ "$LEG_KSA" != "harmony-leg" ]; }; then
  die_usage "steps 18-26 apply manifests written for namespace harmony-legs and service account harmony-leg; pass --no-conductor to use other names here"
fi

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
[ "$NO_CONDUCTOR" -eq 1 ] || SOURCES+=("$SM_CONDUCTOR_API_TOKEN" "$SM_CONDUCTOR_APP_KEY")
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

# B-1169: the transcript bucket must already exist. It is NEVER created here, and a missing one stops the
# run before anything below mutates.
if [ "$DRY_RUN" -eq 1 ]; then
  run gcloud storage buckets describe "gs://$TRANSCRIPT_BUCKET" --project "$PROJECT" '--format=value(name)'
elif ! gcloud storage buckets describe "gs://$TRANSCRIPT_BUCKET" --project "$PROJECT" '--format=value(name)' >/dev/null 2>&1; then
  echo "setup-cluster: transcript bucket gs://$TRANSCRIPT_BUCKET not found (or not readable) in project $PROJECT." >&2
  echo "setup-cluster: this script never creates it — create it or pass --transcript-bucket (nothing has been changed yet)." >&2
  exit 1
else
  echo "found bucket: gs://$TRANSCRIPT_BUCKET"
fi

QUOTA_WARNED=0
if [ "$SKIP_QUOTA" -eq 0 ]; then
  step "3. SSD_TOTAL_GB quota in $REGION"
  # Boot disks here are pd-standard, so they do NOT consume SSD quota. The per-ticket disks (PVCs) may
  # (an SSD-backed storage class), and they are what this headroom check is about. Informational only:
  # it never fails the run.
  # `gcloud compute regions describe` takes no --filter / --flatten, so the whole region is read as JSON
  # and the SSD_TOTAL_GB entry of its quotas list is picked here.
  if quota_json="$(capture gcloud compute regions describe "$REGION" --project "$PROJECT" --format=json)" \
    && quota_line="$(printf '%s' "$quota_json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const q = (JSON.parse(s).quotas || []).find((x) => x && x.metric === "SSD_TOTAL_GB");
    if (q && Number.isFinite(Number(q.usage)) && Number.isFinite(Number(q.limit))) process.stdout.write(q.usage + "\t" + q.limit);
  } catch {}
});' 2>/dev/null)" \
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
  # value(config.labels) prints k=v pairs joined by ';' (empty when the pool has no labels).
  labels="$(gcloud container node-pools describe "$POOL" --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    '--format=value(config.labels)' 2>/dev/null || true)"
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
  # Legs select harmony-leg=true (gke-render-leg.mjs); without the label they sit Pending and the
  # autoscaler never scales the pool up. The taint keeps other pods off; the label lets legs on.
  if ! printf '%s' "$labels" | tr ';' '\n' | grep -qx 'harmony-leg=true'; then
    echo "DRIFT: pool $POOL is missing the node label harmony-leg=true (legs will never schedule)"
    echo "  fix: gcloud container node-pools update $POOL --cluster $CLUSTER --zone $ZONE --project $PROJECT --node-labels harmony-leg=true"
    drift=1
  fi
  [ "$drift" -eq 0 ] && echo "node pool $POOL: matches the expected settings"
  [ "$drift" -eq 0 ] || echo "(nothing was changed — fix the pool by hand or recreate it if the drift matters)"
else
  run gcloud container node-pools create "$POOL" --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
    --machine-type "$MACHINE_TYPE" --disk-type pd-standard --disk-size 100 --image-type COS_CONTAINERD \
    --enable-image-streaming --enable-autoscaling --min-nodes 0 --max-nodes "$MAX_NODES" --num-nodes 0 \
    --node-taints harmony-leg=true:NoSchedule --node-labels harmony-leg=true
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

# --- B-1169: transcripts in the bucket. Steps 10-12 are the ONLY changes to an existing cluster/pool, and
# each is enable-only. Every step reads first and changes only what differs.
step "10. Workload Identity pool on cluster $CLUSTER"
have_pool="$(capture gcloud container clusters describe "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
  '--format=value(workloadIdentityConfig.workloadPool)' || true)"
if [ "$have_pool" = "$PROJECT.svc.id.goog" ]; then
  echo "workload pool: already $PROJECT.svc.id.goog"
else
  run gcloud container clusters update "$CLUSTER" --zone "$ZONE" --project "$PROJECT" "--workload-pool=$PROJECT.svc.id.goog"
fi

step "11. Cloud Storage FUSE CSI driver add-on on cluster $CLUSTER"
have_fuse="$(capture gcloud container clusters describe "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
  '--format=value(addonsConfig.gcsFuseCsiDriverConfig.enabled)' || true)"
case "$have_fuse" in
  [Tt]rue) echo "GcsFuseCsiDriver: already enabled" ;;
  *) run gcloud container clusters update "$CLUSTER" --zone "$ZONE" --project "$PROJECT" --update-addons GcsFuseCsiDriver=ENABLED ;;
esac

step "12. GKE_METADATA on node pool $POOL"
have_mode="$(capture gcloud container node-pools describe "$POOL" --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" \
  '--format=value(config.workloadMetadataConfig.mode)' || true)"
if [ "$have_mode" = "GKE_METADATA" ]; then
  echo "node pool $POOL: workload metadata already GKE_METADATA"
else
  # Changing it RECREATES the pool's nodes, which would kill a running leg: refuse while any leg Job is
  # active. kubectl has credentials from step 6. An unreadable answer is treated as "active" (fail closed).
  if [ "$DRY_RUN" -eq 1 ]; then
    capture kubectl -n "$NAMESPACE" get jobs -l app.kubernetes.io/part-of=harmony-legs -o 'jsonpath={.items[*].status.active}' || true
  else
    if ! active_raw="$(capture kubectl -n "$NAMESPACE" get jobs -l app.kubernetes.io/part-of=harmony-legs -o 'jsonpath={.items[*].status.active}')"; then
      echo "setup-cluster: could not read the leg Jobs in $NAMESPACE — refusing to recreate the nodes of pool $POOL; nothing was changed by this step." >&2
      exit 1
    fi
    if printf '%s' "$active_raw" | tr ' ' '\n' | awk '$1 + 0 > 0 { f = 1 } END { exit !f }'; then
      echo "setup-cluster: a leg Job is active in $NAMESPACE — setting GKE_METADATA recreates the nodes of pool $POOL and would kill it." >&2
      echo "setup-cluster: wait for the legs to finish, then run again; nothing was changed by this step." >&2
      exit 1
    fi
  fi
  run gcloud container node-pools update "$POOL" --cluster "$CLUSTER" --zone "$ZONE" --project "$PROJECT" --workload-metadata=GKE_METADATA
fi

step "13. Google service account $LEG_GSA_EMAIL"
if probe gcloud iam service-accounts describe "$LEG_GSA_EMAIL" --project "$PROJECT"; then
  echo "service account $LEG_GSA_EMAIL: exists"
else
  run gcloud iam service-accounts create "$LEG_GSA_NAME" --project "$PROJECT" --display-name "Harmony GKE leg (transcript bucket)"
fi

step "14. IAM: $LEG_GSA_EMAIL -> roles/storage.objectUser on gs://$TRANSCRIPT_BUCKET"
# `gcloud storage buckets get-iam-policy` has no --flatten/--filter (unlike `projects get-iam-policy`), so
# read the whole policy as JSON and pick the binding out in node. A failed or unparseable read is NOT
# "not held": it stops the run, because guessing would re-bind on every rerun and hide a real error.
held=""
if policy_json="$(capture gcloud storage buckets get-iam-policy "gs://$TRANSCRIPT_BUCKET" --format=json)"; then
  if ! held="$(printf '%s' "$policy_json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let p;
  try { p = JSON.parse(s); } catch { process.exit(2); }
  if (!p || typeof p !== "object") process.exit(2);
  const [role, member] = process.argv.slice(1);
  const hit = (Array.isArray(p.bindings) ? p.bindings : []).some((b) => b && b.role === role && Array.isArray(b.members) && b.members.includes(member));
  process.stdout.write(hit ? "yes" : "");
});' roles/storage.objectUser "serviceAccount:$LEG_GSA_EMAIL")"; then
    echo "setup-cluster: could not parse the IAM policy of gs://$TRANSCRIPT_BUCKET — changing nothing." >&2
    exit 1
  fi
elif [ "$DRY_RUN" -eq 0 ]; then
  echo "setup-cluster: could not read the IAM policy of gs://$TRANSCRIPT_BUCKET — changing nothing." >&2
  exit 1
fi
if [ -n "$held" ]; then
  echo "$LEG_GSA_EMAIL already holds roles/storage.objectUser on gs://$TRANSCRIPT_BUCKET"
else
  run gcloud storage buckets add-iam-policy-binding "gs://$TRANSCRIPT_BUCKET" \
    "--member=serviceAccount:$LEG_GSA_EMAIL" --role=roles/storage.objectUser
fi

WI_MEMBER="serviceAccount:$PROJECT.svc.id.goog[$NAMESPACE/$LEG_KSA]"
step "15. IAM: $NAMESPACE/$LEG_KSA may impersonate $LEG_GSA_EMAIL (Workload Identity)"
held="$(capture gcloud iam service-accounts get-iam-policy "$LEG_GSA_EMAIL" --project "$PROJECT" '--flatten=bindings[].members' \
  "--filter=bindings.role:roles/iam.workloadIdentityUser AND bindings.members:$WI_MEMBER" \
  '--format=value(bindings.role)' || true)"
if [ -n "$held" ]; then
  echo "$WI_MEMBER already holds roles/iam.workloadIdentityUser"
else
  run gcloud iam service-accounts add-iam-policy-binding "$LEG_GSA_EMAIL" --project "$PROJECT" \
    --role=roles/iam.workloadIdentityUser "--member=$WI_MEMBER"
fi

step "16. Kubernetes service account $NAMESPACE/$LEG_KSA"
if probe kubectl -n "$NAMESPACE" get serviceaccount "$LEG_KSA"; then
  echo "service account $LEG_KSA: exists"
else
  run kubectl -n "$NAMESPACE" create serviceaccount "$LEG_KSA"
fi
have_annot="$(capture kubectl -n "$NAMESPACE" get serviceaccount "$LEG_KSA" -o 'jsonpath={.metadata.annotations.iam\.gke\.io/gcp-service-account}' || true)"
if [ "$have_annot" = "$LEG_GSA_EMAIL" ]; then
  echo "service account $LEG_KSA: already annotated for $LEG_GSA_EMAIL"
else
  run kubectl -n "$NAMESPACE" annotate serviceaccount "$LEG_KSA" "iam.gke.io/gcp-service-account=$LEG_GSA_EMAIL" --overwrite
fi

# --- Ticket disks are created while the leg node boots (2026-10-20). With WaitForFirstConsumer
# (standard-rwo) the disk waits for the pod to land on the new node, then races its disk driver. The
# leg pool is one zone, so the class pins that zone and binds Immediately. Create-only: a StorageClass's
# parameters are immutable, so a drifted one is reported, never changed.
step "17. StorageClass $TICKET_SC (ticket disks, Immediate binding in $ZONE)"
if probe kubectl get storageclass "$TICKET_SC"; then
  sc_line="$(capture kubectl get storageclass "$TICKET_SC" \
    -o 'jsonpath={.volumeBindingMode}{"\t"}{.parameters.type}{"\t"}{.allowedTopologies[0].matchLabelExpressions[0].values[0]}' || true)"
  if [ "$sc_line" = "$(printf 'Immediate\tpd-balanced\t%s' "$ZONE")" ]; then
    echo "storage class $TICKET_SC: exists and matches"
  else
    echo "DRIFT: storage class $TICKET_SC is '$sc_line' (binding, disk type, zone), expected Immediate, pd-balanced, $ZONE"
    echo "(nothing was changed — delete it and rerun once no ticket disk uses it, if the drift matters)"
  fi
else
  run_apply_sc() {
    cat <<SC | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: $TICKET_SC
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-balanced
volumeBindingMode: Immediate
reclaimPolicy: Delete
allowVolumeExpansion: true
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.gke.io/zone
        values: [$ZONE]
SC
  }
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would: kubectl apply StorageClass $TICKET_SC (pd.csi.storage.gke.io, pd-balanced, Immediate, zone $ZONE)"
  else
    run_apply_sc
  fi
fi

# --- B-1173: the remote conductor pod. Every step reads first and changes only what differs. IAM policies are
# read as plain JSON (--format=json) and the binding picked out in node: `get-iam-policy` flag support differs
# by resource type (storage buckets reject --flatten/--filter, see step 14), and JSON is accepted by all of them.
# A failed or unparseable read STOPS the run; guessing "not held" would re-bind on every rerun and hide a real error.
policy_has() {  # stdin: IAM policy JSON; $1 role, $2 member. Prints "yes" when held; exit 2 when unparseable.
  node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let p;
  try { p = JSON.parse(s); } catch { process.exit(2); }
  if (!p || typeof p !== "object") process.exit(2);
  const [role, member] = process.argv.slice(1);
  const hit = (Array.isArray(p.bindings) ? p.bindings : []).some((b) => b && b.role === role && Array.isArray(b.members) && b.members.includes(member));
  process.stdout.write(hit ? "yes" : "");
});' "$1" "$2"
}
# ensure_binding <what> <role> <member> -- <read command...> -- <write command...>
ensure_binding() {
  local what="$1" role="$2" member="$3"; shift 3
  local read_cmd=() write_cmd=() part=read
  shift # the first --
  for a in "$@"; do
    if [ "$a" = "--" ] && [ "$part" = read ]; then part=write; continue; fi
    if [ "$part" = read ]; then read_cmd+=("$a"); else write_cmd+=("$a"); fi
  done
  local pj held=""
  if pj="$(capture "${read_cmd[@]}")"; then
    if ! held="$(printf '%s' "$pj" | policy_has "$role" "$member")"; then
      echo "setup-cluster: could not parse the IAM policy of $what — changing nothing." >&2
      exit 1
    fi
  elif [ "$DRY_RUN" -eq 0 ]; then
    echo "setup-cluster: could not read the IAM policy of $what — changing nothing." >&2
    exit 1
  fi
  if [ -n "$held" ]; then
    echo "$member already holds $role on $what"
  else
    run "${write_cmd[@]}"
  fi
}

if [ "$NO_CONDUCTOR" -eq 1 ]; then
  echo
  echo "steps 18-26 (remote conductor pod): skipped (--no-conductor)"
else
  CONDUCTOR_MEMBER="serviceAccount:$CONDUCTOR_GSA_EMAIL"

  step "18. Namespace $CONDUCTOR_NS"
  if probe kubectl get namespace "$CONDUCTOR_NS"; then
    echo "namespace $CONDUCTOR_NS: exists"
  else
    run kubectl create namespace "$CONDUCTOR_NS"
  fi

  step "19. Google service account $CONDUCTOR_GSA_EMAIL"
  if probe gcloud iam service-accounts describe "$CONDUCTOR_GSA_EMAIL" --project "$PROJECT"; then
    echo "service account $CONDUCTOR_GSA_EMAIL: exists"
  else
    run gcloud iam service-accounts create "$CONDUCTOR_GSA_NAME" --project "$PROJECT" --display-name "Harmony conductor (remote pod)"
  fi

  step "20. IAM: $CONDUCTOR_GSA_EMAIL -> roles/secretmanager.secretAccessor on its two named secrets"
  for sm in "$SM_CONDUCTOR_API_TOKEN" "$SM_CONDUCTOR_APP_KEY"; do
    ensure_binding "secret $sm" roles/secretmanager.secretAccessor "$CONDUCTOR_MEMBER" -- \
      gcloud secrets get-iam-policy "$sm" --project "$PROJECT" --format=json -- \
      gcloud secrets add-iam-policy-binding "$sm" --project "$PROJECT" "--member=$CONDUCTOR_MEMBER" --role=roles/secretmanager.secretAccessor
  done

  step "21. IAM: $CONDUCTOR_GSA_EMAIL -> Cloud Run launch and log writing (project roles)"
  for role in roles/run.developer roles/logging.logWriter; do
    ensure_binding "project $PROJECT" "$role" "$CONDUCTOR_MEMBER" -- \
      gcloud projects get-iam-policy "$PROJECT" --format=json -- \
      gcloud projects add-iam-policy-binding "$PROJECT" "--member=$CONDUCTOR_MEMBER" "--role=$role" --condition=None
  done

  step "22. IAM: $CONDUCTOR_GSA_EMAIL -> roles/iam.serviceAccountUser on the Cloud Run leg runtime account"
  if [ -z "$CLOUD_RUN_RUNTIME_SA" ]; then
    echo "skipped: --cloud-run-runtime-sa was not given. The pod launches Cloud Run legs only if it may act as that job's"
    echo "runtime account; rerun with --cloud-run-runtime-sa <email> before using the cloud profile from the pod."
  else
    ensure_binding "service account $CLOUD_RUN_RUNTIME_SA" roles/iam.serviceAccountUser "$CONDUCTOR_MEMBER" -- \
      gcloud iam service-accounts get-iam-policy "$CLOUD_RUN_RUNTIME_SA" --project "$PROJECT" --format=json -- \
      gcloud iam service-accounts add-iam-policy-binding "$CLOUD_RUN_RUNTIME_SA" --project "$PROJECT" "--member=$CONDUCTOR_MEMBER" --role=roles/iam.serviceAccountUser
  fi

  step "23. IAM: $CONDUCTOR_GSA_EMAIL -> roles/artifactregistry.reader on repository $ARTIFACT_REPO"
  ensure_binding "repository $ARTIFACT_REPO" roles/artifactregistry.reader "$CONDUCTOR_MEMBER" -- \
    gcloud artifacts repositories get-iam-policy "$ARTIFACT_REPO" --location "$ARTIFACT_LOCATION" --project "$ARTIFACT_PROJECT" --format=json -- \
    gcloud artifacts repositories add-iam-policy-binding "$ARTIFACT_REPO" --location "$ARTIFACT_LOCATION" --project "$ARTIFACT_PROJECT" "--member=$CONDUCTOR_MEMBER" --role=roles/artifactregistry.reader

  CONDUCTOR_WI_MEMBER="serviceAccount:$PROJECT.svc.id.goog[$CONDUCTOR_NS/$CONDUCTOR_KSA]"
  step "24. IAM: $CONDUCTOR_NS/$CONDUCTOR_KSA may impersonate $CONDUCTOR_GSA_EMAIL (Workload Identity)"
  ensure_binding "service account $CONDUCTOR_GSA_EMAIL" roles/iam.workloadIdentityUser "$CONDUCTOR_WI_MEMBER" -- \
    gcloud iam service-accounts get-iam-policy "$CONDUCTOR_GSA_EMAIL" --project "$PROJECT" --format=json -- \
    gcloud iam service-accounts add-iam-policy-binding "$CONDUCTOR_GSA_EMAIL" --project "$PROJECT" --role=roles/iam.workloadIdentityUser "--member=$CONDUCTOR_WI_MEMBER"

  step "25. Kubernetes service account $CONDUCTOR_NS/$CONDUCTOR_KSA"
  if probe kubectl -n "$CONDUCTOR_NS" get serviceaccount "$CONDUCTOR_KSA"; then
    echo "service account $CONDUCTOR_KSA: exists"
  else
    run kubectl -n "$CONDUCTOR_NS" create serviceaccount "$CONDUCTOR_KSA"
  fi
  have_annot="$(capture kubectl -n "$CONDUCTOR_NS" get serviceaccount "$CONDUCTOR_KSA" -o 'jsonpath={.metadata.annotations.iam\.gke\.io/gcp-service-account}' || true)"
  if [ "$have_annot" = "$CONDUCTOR_GSA_EMAIL" ]; then
    echo "service account $CONDUCTOR_KSA: already annotated for $CONDUCTOR_GSA_EMAIL"
  else
    run kubectl -n "$CONDUCTOR_NS" annotate serviceaccount "$CONDUCTOR_KSA" "iam.gke.io/gcp-service-account=$CONDUCTOR_GSA_EMAIL" --overwrite
  fi

  step "26. RBAC for the conductor pod (namespaced Roles only)"
  for f in rbac-legs.yaml rbac-conductor.yaml; do
    if [ ! -f "$MANIFEST_DIR/$f" ]; then
      echo "setup-cluster: manifest $MANIFEST_DIR/$f not found" >&2
      exit 1
    fi
    # apply is create-or-update and a no-op when nothing differs.
    run kubectl apply -f "$MANIFEST_DIR/$f"
  done
fi

step "Done. Values for the deployment config"
echo "project:        $PROJECT"
echo "zone:           $ZONE"
echo "cluster:        $CLUSTER"
echo "node pool:      $POOL"
echo "namespace:      $NAMESPACE"
echo "transcripts:    gs://$TRANSCRIPT_BUCKET (Cloud Storage FUSE CSI)"
echo "leg GSA:        $LEG_GSA_EMAIL"
echo "leg KSA:        $NAMESPACE/$LEG_KSA"
echo "env Secret:     $ENV_SECRET (keys: HARMONY_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN)"
if [ "$NO_CODEX" -eq 1 ]; then
  echo "file Secret:    none (--no-codex)"
else
  echo "file Secret:    $CODEX_SECRET (key: auth.json)"
fi
if [ "$NO_CONDUCTOR" -eq 0 ]; then
  echo "conductor GSA:  $CONDUCTOR_GSA_EMAIL"
  echo "conductor KSA:  $CONDUCTOR_NS/$CONDUCTOR_KSA"
  echo "conductor secrets (names): $SM_CONDUCTOR_API_TOKEN, $SM_CONDUCTOR_APP_KEY"
fi
echo
echo "Next steps:"
if [ "$QUOTA_WARNED" -eq 1 ]; then
  echo "  - request an SSD_TOTAL_GB quota increase in $REGION (the warning above fired)."
fi
echo "  - on the conductor host (with kubectl and gke-gcloud-auth-plugin installed), as the conductor service account:"
echo "      CLOUDSDK_CORE_ACCOUNT=$DAEMON_SA gcloud container clusters get-credentials $CLUSTER --zone $ZONE --project $PROJECT"
echo "  - if you changed the defaults, tell the launcher: HARMONY_GKE_TRANSCRIPT_BUCKET=$TRANSCRIPT_BUCKET HARMONY_GKE_SERVICE_ACCOUNT=$LEG_KSA"
echo "  - schedule container/gke/sweep-ticket-disks.sh on the conductor host (cron / launchd) — or, for the remote conductor, let its CronJob do it."
if [ "$NO_CONDUCTOR" -eq 0 ]; then
  echo "  - remote conductor: edit and apply container/conductor/k8s/configmap.yaml, deployment.yaml and cronjob-sweep.yaml (fill the image version"
  echo "    and the App identifiers; each file's header says how). Nothing here starts a conductor."
  if [ -z "$CLOUD_RUN_RUNTIME_SA" ]; then
    echo "  - step 22 was skipped: rerun with --cloud-run-runtime-sa <email> before the pod launches Cloud Run legs."
  fi
fi
