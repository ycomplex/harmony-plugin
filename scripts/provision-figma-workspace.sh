#!/usr/bin/env bash
# Provision the Figma credential slots and per-slot IAM bindings for ONE workspace
# in the harmony-conductor GCP project. Mirrors the live shape of Harmony's own
# workspace as documented in plugin/docs/figma-connection-rollout.md
# ("Staging preparation" steps 1, 2 and 5) and docs/project/harmony-deployment-values.md
# ("Figma connection"). Creates no keys, reads no payloads, touches no project-level role.
#
# The slots ALWAYS live in harmony-conductor: the figma-connect function, the activate and
# refresh RPCs and container/figma/launch-context.sh all hard-code that project. What differs
# per customer is the CONDUCTOR identity that reads -access and -pat at leg launch: the gke
# launcher runs inside the conductor pod (container/gke/gke-worker-launch.sh) as that pod's
# Workload Identity account, so a conductor in another GCP project needs a cross-project
# binding on the two slots. The leg itself never reads Secret Manager for Figma: the launcher
# copies both values into the per-leg Kubernetes Secret <job>-figma.
#
# Usage:   ./provision-figma-workspace.sh <workspace-uuid> <conductor-gsa-email> [--dry-run]
# Vendor:  ./provision-figma-workspace.sh <workspace-uuid> harmony-conductor@harmony-conductor.iam.gserviceaccount.com --dry-run
# Other:   ./provision-figma-workspace.sh <workspace-uuid> harmony-conductor@<conductor-gcp-project>.iam.gserviceaccount.com --dry-run   (a conductor in another GCP project)
set -euo pipefail

WS="${1:?workspace uuid required}"
CONDUCTOR_GSA="${2:?conductor service-account email required (the conductor pod's Workload Identity account, not the leg's)}"
DRY="${3:-}"
PROJECT=harmony-conductor
[[ "$WS" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "not a uuid: $WS" >&2; exit 2; }
[[ "$CONDUCTOR_GSA" =~ ^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$ ]] || { echo "not a service-account email: $CONDUCTOR_GSA" >&2; exit 2; }
[[ -z "$DRY" || "$DRY" == "--dry-run" ]] || { echo "third argument must be --dry-run or absent" >&2; exit 2; }

CONNECT=serviceAccount:harmony-figma-connect@harmony-conductor.iam.gserviceaccount.com   # the figma-connect edge function's key (fixed; hard-coded in core.ts)
REFRESH=serviceAccount:harmony-figma-refresh@harmony-conductor.iam.gserviceaccount.com   # the hourly refresh CronJobs in Harmony's cluster (project-wide on the prod board)
CONDUCTOR="serviceAccount:${CONDUCTOR_GSA}"                                              # the customer's conductor pod; reads -access and -pat per leg

ADDER=roles/secretmanager.secretVersionAdder
ACCESSOR=roles/secretmanager.secretAccessor

run() { if [[ "$DRY" == "--dry-run" ]]; then printf '[dry-run]'; printf ' %q' "$@"; echo; else "$@"; fi; }

# 1. The three slots (idempotent: skip any that already exists).
for kind in grant pat access; do
  name="harmony-figma-ws-${WS}-${kind}"
  if gcloud secrets describe "$name" --project "$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    echo "exists: $name"
  else
    run gcloud secrets create "$name" --project "$PROJECT" --replication-policy automatic
  fi
done

# 2. Per-slot bindings (add-iam-policy-binding is idempotent). No conditions, matching the vendor workspace.
# In --dry-run the command is printed (never silenced) and nothing is bound; only a real run hides gcloud's output.
bind() {
  if [[ "$DRY" == "--dry-run" ]]; then
    run gcloud secrets add-iam-policy-binding "harmony-figma-ws-${WS}-$1" --project "$PROJECT" --member "$2" --role "$3" --quiet
    echo "would bind: $1  $3  $2"
  else
    run gcloud secrets add-iam-policy-binding "harmony-figma-ws-${WS}-$1" --project "$PROJECT" --member "$2" --role "$3" --quiet >/dev/null
    echo "bound: $1  $3  $2"
  fi
}

# connect handler: add versions to all three (what the failed save needed)
bind grant  "$CONNECT" "$ADDER"
bind pat    "$CONNECT" "$ADDER"
bind access "$CONNECT" "$ADDER"

# refresh job: read the grant and the PAT; publish new grant and access versions
bind grant  "$REFRESH" "$ACCESSOR"
bind pat    "$REFRESH" "$ACCESSOR"
bind grant  "$REFRESH" "$ADDER"
bind access "$REFRESH" "$ADDER"

# conductor pod: read access token and PAT only, never the grant
bind access "$CONDUCTOR" "$ACCESSOR"
bind pat    "$CONDUCTOR" "$ACCESSOR"

# 3. Read back: the resulting policy per slot (members and roles only).
for kind in grant pat access; do
  echo "== harmony-figma-ws-${WS}-${kind}"
  if [[ "$DRY" == "--dry-run" ]]; then
    run gcloud secrets get-iam-policy "harmony-figma-ws-${WS}-${kind}" --project "$PROJECT" --format='table(bindings.role,bindings.members)'
  else
    gcloud secrets get-iam-policy "harmony-figma-ws-${WS}-${kind}" --project "$PROJECT" --format='table(bindings.role,bindings.members)'
  fi
done
