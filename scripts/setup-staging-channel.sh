#!/usr/bin/env bash
# Set up a dedicated dogfood directory wired to the STAGING Supabase project (B-488).
#
# Usage: setup-staging-channel.sh <dogfood-dir> <staging-api-token> [staging-anon-key]
#
# Thin staging wrapper over setup-channel-env.sh (B-694 extracted the generic
# settings-triple writer so the build container and this channel share ONE
# mechanism). This script only resolves the staging constants + anon key, then
# delegates. Behaviour and CLI are unchanged from the original B-488 script.
#
# The anon key comes from arg 3, else VITE_SUPABASE_ANON_KEY in ../../web/.env
# (workspace layout), else we abort with a pointer at the Supabase dashboard.
# The API token is never echoed.
set -euo pipefail

# staging.harmony.ad's deployed Supabase project (NOT web/supabase/config.toml's
# project_id, which does not point at the deployed staging project).
STAGING_URL="https://meqkdgncdzromunylyxf.supabase.co"
STAGING_REF="meqkdgncdzromunylyxf"

usage() {
  echo "Usage: $(basename "$0") <dogfood-dir> <staging-api-token> [staging-anon-key]" >&2
  exit 1
}

[ $# -ge 2 ] || usage
DOGFOOD_DIR="$1"
API_TOKEN="$2"
ANON_KEY="${3:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Resolve the staging anon key -------------------------------------------
# Authoritative source: the Supabase dashboard for project $STAGING_REF
# (Project Settings > API keys). Fallback only: harmony-web's .env in the
# workspace layout — it may or may not carry the key matching $STAGING_REF,
# so we warn when its URL disagrees rather than trusting it blindly.
# Candidate paths cover the main checkout (../web) and a .worktrees/* checkout.
env_value() {
  # $1 = file, $2 = var name; strips surrounding quotes.
  sed -n "s/^$2=//p" "$1" | tail -n 1 | tr -d '"' | tr -d "'"
}
if [ -z "$ANON_KEY" ]; then
  for WEB_ENV in "$REPO_ROOT/../web/.env" "$REPO_ROOT/../../web/.env" "$REPO_ROOT/../../../web/.env"; do
    [ -f "$WEB_ENV" ] || continue
    ANON_KEY="$(env_value "$WEB_ENV" VITE_SUPABASE_ANON_KEY)"
    # Newer Supabase projects name it the publishable key.
    [ -n "$ANON_KEY" ] || ANON_KEY="$(env_value "$WEB_ENV" VITE_SUPABASE_PUBLISHABLE_KEY)"
    if [ -n "$ANON_KEY" ]; then
      if [ "$(env_value "$WEB_ENV" VITE_SUPABASE_URL)" != "$STAGING_URL" ]; then
        echo "Warning: $WEB_ENV does not point at $STAGING_URL; its key may not match" >&2
        echo "project $STAGING_REF. If auth fails, pass the anon key from the Supabase" >&2
        echo "dashboard (project $STAGING_REF > Project Settings > API keys) as the third argument." >&2
      fi
      break
    fi
  done
fi
if [ -z "$ANON_KEY" ]; then
  echo "Error: no staging anon key. Pass it as the third argument — the authoritative" >&2
  echo "source is the Supabase dashboard: project $STAGING_REF > Project Settings > API keys." >&2
  echo "(Fallback lookup found no VITE_SUPABASE_ANON_KEY / VITE_SUPABASE_PUBLISHABLE_KEY" >&2
  echo "in the workspace's web/.env.)" >&2
  exit 1
fi

# --- Delegate to the generic writer -----------------------------------------
"$SCRIPT_DIR/setup-channel-env.sh" "$DOGFOOD_DIR" "$STAGING_URL" "$ANON_KEY" "$API_TOKEN"

echo "Staging channel configured in $DOGFOOD_DIR"
echo "  Target: $STAGING_URL (staging)"
echo "Next: cd \"$DOGFOOD_DIR\" && claude --plugin-dir \"$REPO_ROOT\""
echo "Then confirm via get_project -> environment (target should be 'staging')."
