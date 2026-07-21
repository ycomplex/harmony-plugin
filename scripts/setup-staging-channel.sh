#!/usr/bin/env bash
# Set up a dedicated dogfood directory wired to the STAGING Supabase project (B-488).
#
# Usage: setup-staging-channel.sh <dogfood-dir> <staging-api-token> [staging-anon-key]
#
# What it does (idempotent, merge-safe):
#   1. <dogfood-dir>/.claude/settings.local.json — env block pointing at staging
#      (HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY / HARMONY_API_TOKEN).
#   2. <dogfood-dir>/.claude/settings.json — disables the marketplace-installed
#      harmony-plugin so `claude --plugin-dir` loads only the local checkout.
#   3. Ensures `.claude/` is excluded in THIS repo checkout's git exclude file, so
#      dogfood residue can never trip promote-prod.sh's untracked-file preflight.
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

# --- 1 + 2. Write/merge the dogfood dir's .claude settings ------------------
mkdir -p "$DOGFOOD_DIR/.claude"

# Merge-safe JSON writes: python3 deep-merges our keys into any existing file.
# The patch JSON arrives on stdin (keeps the token out of argv, which `ps` can see).
MERGE_PY='
import json, os, sys

target = sys.argv[1]
patch = json.load(sys.stdin)

data = {}
if os.path.exists(target):
    try:
        with open(target) as f:
            data = json.load(f)
    except (ValueError, OSError):
        sys.stderr.write("Warning: %s was not valid JSON; rewriting it.\n" % target)
        data = {}

def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v

deep_merge(data, patch)
with open(target, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
'
merge_json() {
  python3 -c "$MERGE_PY" "$1"
}

SETTINGS_LOCAL="$DOGFOOD_DIR/.claude/settings.local.json"
merge_json "$SETTINGS_LOCAL" <<EOF
{
  "env": {
    "HARMONY_SUPABASE_URL": "$STAGING_URL",
    "HARMONY_SUPABASE_ANON_KEY": "$ANON_KEY",
    "HARMONY_API_TOKEN": "$API_TOKEN"
  }
}
EOF

SETTINGS_SHARED="$DOGFOOD_DIR/.claude/settings.json"
merge_json "$SETTINGS_SHARED" <<'EOF'
{
  "enabledPlugins": {
    "harmony-plugin@ycomplex": false
  }
}
EOF

# --- 3. Exclude .claude/ in this repo checkout ------------------------------
# In a worktree, .git is a FILE pointing at the real gitdir; rev-parse resolves it.
if GIT_COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)"; then
  case "$GIT_COMMON_DIR" in
    /*) : ;;
    *) GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR" ;;
  esac
  EXCLUDE_FILE="$GIT_COMMON_DIR/info/exclude"
  mkdir -p "$(dirname "$EXCLUDE_FILE")"
  touch "$EXCLUDE_FILE"
  if ! grep -qxF '.claude/' "$EXCLUDE_FILE"; then
    echo '.claude/' >>"$EXCLUDE_FILE"
    echo "Added .claude/ to $EXCLUDE_FILE"
  fi
else
  echo "Warning: $REPO_ROOT is not a git checkout; skipped the .claude/ exclude step." >&2
fi

echo "Staging channel configured in $DOGFOOD_DIR"
echo "  Supabase: $STAGING_URL (staging)"
echo "  Marketplace harmony-plugin disabled for that directory."
echo "Next: cd \"$DOGFOOD_DIR\" && claude --plugin-dir \"$REPO_ROOT\""
echo "Then confirm via get_project -> environment (target should be 'staging')."
