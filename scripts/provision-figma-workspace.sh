#!/usr/bin/env bash
# provision-figma-workspace.sh — the vendor operator's one step for connecting a new workspace to Figma (B-1310).
#
# Creates a workspace's three Figma secret slots in the vendor's Secret Manager project and binds
# exactly the accounts that use them, each on the slot itself:
#
#   harmony-figma-ws-<workspace-uuid>-grant   the full Figma sign-in (refresh job only)
#   harmony-figma-ws-<workspace-uuid>-pat     the REST personal access token
#   harmony-figma-ws-<workspace-uuid>-access  the short-lived access token the legs use
#
# The slots always live in the vendor's project (harmony-conductor): the figma-connect edge function,
# the activate and refresh RPCs and container/figma/launch-context.sh all hard-code it. A conductor in
# another GCP project therefore needs a cross-project binding on the two slots it reads (-access, -pat);
# that is what the third argument names. The conductor's launcher (container/gke/gke-worker-launch.sh)
# reads those two and copies them into the per-leg Kubernetes Secret, so a leg never reads Secret Manager.
#
# It never grants a project-level role, never creates a key and never reads a secret payload. Reads
# are limited to `secrets describe` (does the slot exist?) and `secrets get-iam-policy` (the read-back).
# Re-running is safe: an existing slot is skipped and IAM bindings are idempotent.
#
# Usage:
#   scripts/provision-figma-workspace.sh <workspace-uuid> <conductor-gsa-email> [--dry-run]
#
#   <workspace-uuid>       the workspace id, from the board URL /w/<workspace-id>/...
#   <conductor-gsa-email>  the conductor pod's Workload Identity service account, printed by
#                          container/gke/setup-cluster.sh as "conductor GSA:" (the pod's, not the leg's)
#   --dry-run              print every mutating gcloud command instead of running it
set -euo pipefail

PROJECT="harmony-conductor"
CONNECT="serviceAccount:harmony-figma-connect@harmony-conductor.iam.gserviceaccount.com"
REFRESH="serviceAccount:harmony-figma-refresh@harmony-conductor.iam.gserviceaccount.com"

usage() {
  echo "usage: $0 <workspace-uuid> <conductor-gsa-email> [--dry-run]" >&2
  exit 2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
WORKSPACE="$1"
CONDUCTOR_EMAIL="$2"
DRY_RUN=0
if [ "$#" -eq 3 ]; then
  [ "$3" = "--dry-run" ] || usage
  DRY_RUN=1
fi

if ! printf '%s' "$WORKSPACE" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  echo "error: workspace id must be a lower-case UUID (from the board URL /w/<workspace-id>/...)" >&2
  exit 2
fi
if ! printf '%s' "$CONDUCTOR_EMAIL" | grep -Eq '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$'; then
  echo "error: conductor account must be a service-account email (<name>@<project>.iam.gserviceaccount.com)" >&2
  exit 2
fi
CONDUCTOR="serviceAccount:$CONDUCTOR_EMAIL"

PREFIX="harmony-figma-ws-$WORKSPACE"
GRANT="$PREFIX-grant"
PAT="$PREFIX-pat"
ACCESS="$PREFIX-access"

# A mutation: printed in --dry-run, run otherwise.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] gcloud $*"
  else
    gcloud "$@"
  fi
}

create_slot() {
  local slot="$1"
  if gcloud secrets describe "$slot" --project "$PROJECT" >/dev/null 2>&1; then
    echo "exists:  $slot"
    return
  fi
  run secrets create "$slot" --project "$PROJECT" --replication-policy automatic
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would create: $slot"
  else
    echo "created: $slot"
  fi
}

# bind <slot> <kind> <member> <role>
bind() {
  local slot="$1" kind="$2" member="$3" role="$4"
  if [ "$DRY_RUN" -eq 1 ]; then
    run secrets add-iam-policy-binding "$slot" --project "$PROJECT" --member "$member" --role "$role"
    echo "would bind: $kind  $role  $member"
  else
    run secrets add-iam-policy-binding "$slot" --project "$PROJECT" --member "$member" --role "$role" >/dev/null
    echo "bound: $kind  $role  $member"
  fi
}

echo "Provisioning Figma slots for workspace $WORKSPACE in project $PROJECT"
[ "$DRY_RUN" -eq 1 ] && echo "(dry run: nothing is created or bound)"

create_slot "$GRANT"
create_slot "$PAT"
create_slot "$ACCESS"

# The connect function adds new versions to all three slots.
bind "$GRANT" grant "$CONNECT" roles/secretmanager.secretVersionAdder
bind "$PAT" pat "$CONNECT" roles/secretmanager.secretVersionAdder
bind "$ACCESS" access "$CONNECT" roles/secretmanager.secretVersionAdder
# The refresh job reads the grant (and the PAT for a library refresh) and writes the grant and access.
bind "$GRANT" grant "$REFRESH" roles/secretmanager.secretAccessor
bind "$PAT" pat "$REFRESH" roles/secretmanager.secretAccessor
bind "$GRANT" grant "$REFRESH" roles/secretmanager.secretVersionAdder
bind "$ACCESS" access "$REFRESH" roles/secretmanager.secretVersionAdder
# The conductor reads only the access token and the PAT, to copy them into each leg's Secret.
bind "$ACCESS" access "$CONDUCTOR" roles/secretmanager.secretAccessor
bind "$PAT" pat "$CONDUCTOR" roles/secretmanager.secretAccessor

echo
echo "Read-back (send these policies to the workspace owner):"
for slot in "$GRANT" "$PAT" "$ACCESS"; do
  echo "--- $slot"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] gcloud secrets get-iam-policy $slot --project $PROJECT --format=yaml(bindings)"
  else
    gcloud secrets get-iam-policy "$slot" --project "$PROJECT" --format='yaml(bindings)'
  fi
done
