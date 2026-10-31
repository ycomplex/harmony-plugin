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
# Writes the env triple to $DOGFOOD_DIR/.claude/settings.local.json — that's what the MCP
# server under `claude --plugin-dir` reads (still env-at-import for MCP; the B-1025 fix only
# touches the CLI's per-call resolver).
"$SCRIPT_DIR/setup-channel-env.sh" "$DOGFOOD_DIR" "$STAGING_URL" "$ANON_KEY" "$API_TOKEN"

# --- Register the staging project for the CLI -------------------------------
# The CLI's auth path (src/cli/resolve-supabase-target.ts) reads the project registry
# before env, so a registered project makes the CLI work with no env at all. We invoke
# `harmony login` directly with both flags so the resolved pair carries the same URL+key
# the script just wrote into $DOGFOOD_DIR/.claude/settings.local.json. The CLI looks up
# `harmony` on PATH; if the founder's hooks/link-cli.sh ran, it is there, else `node
# dist/bin/harmony.js` from the checkout also works. The `--token` arg never echoes
# because `harmony login` (src/cli/commands/auth.ts) only writes it to disk and never logs
# it. The `--name staging` makes the registered project idempotent across re-runs
# (addProject overwrites by name); running with no env then works the same as running with
# the env triple set.
if command -v harmony >/dev/null 2>&1 || [ -x "$REPO_ROOT/dist/bin/harmony.js" ]; then
  HARMONY_CMD="$(command -v harmony 2>/dev/null || echo node "$REPO_ROOT/dist/bin/harmony.js")"
  if "$HARMONY_CMD" login \
      --supabase-url "$STAGING_URL" \
      --supabase-anon-key "$ANON_KEY" \
      --token "$API_TOKEN" \
      --name staging >/dev/null 2>&1; then
    echo "Registered the 'staging' project for the CLI in \$HOME/.harmony/config.json."
  else
    echo "Warning: failed to register the 'staging' project for the CLI; the env triple is" >&2
    echo "still written above and is sufficient for the MCP server under claude --plugin-dir." >&2
  fi
else
  echo "Note: 'harmony' CLI not on PATH; skipped registering the 'staging' project." >&2
  echo "Run this once to register it manually:" >&2
  echo "  node $REPO_ROOT/dist/bin/harmony.js login --supabase-url $STAGING_URL --supabase-anon-key <key> --token <token> --name staging" >&2
fi

echo "Staging channel configured in $DOGFOOD_DIR"
echo "  Target: $STAGING_URL (staging)"
echo "Next: cd \"$DOGFOOD_DIR\" && claude --plugin-dir \"$REPO_ROOT\""
echo "Then confirm via get_project -> environment (target should be 'staging')."
