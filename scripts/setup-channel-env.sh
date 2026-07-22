#!/usr/bin/env bash
# Wire a directory's .claude settings to a CHOSEN Harmony Supabase project —
# the generic settings-triple writer behind every channel (B-694; extracted
# from the B-488 staging script, which is now a thin wrapper over this).
#
# Usage: setup-channel-env.sh <target-dir> <supabase-url> <anon-key> <api-token>
#        (pass '' as <anon-key> to omit it — e.g. prod, whose anon key is the
#        plugin's baked default; writing an EMPTY value would override that
#        default with "" and break the client)
#
# What it does (idempotent, merge-safe):
#   1. <target-dir>/.claude/settings.local.json — env block with the triple
#      (HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY / HARMONY_API_TOKEN).
#   2. <target-dir>/.claude/settings.json — disables the marketplace-installed
#      harmony-plugin so `claude --plugin-dir` loads only the local checkout.
#   3. Ensures `.claude/` is excluded in THIS repo checkout's git exclude file,
#      so channel residue can never trip promote-prod.sh's untracked preflight.
#
# The API token is never echoed.
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") <target-dir> <supabase-url> <anon-key> <api-token>" >&2
  exit 1
}

[ $# -eq 4 ] || usage
TARGET_DIR="$1"
SUPABASE_URL="$2"
ANON_KEY="$3"
API_TOKEN="$4"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- 1 + 2. Write/merge the target dir's .claude settings -------------------
mkdir -p "$TARGET_DIR/.claude"

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

SETTINGS_LOCAL="$TARGET_DIR/.claude/settings.local.json"
if [ -n "$ANON_KEY" ]; then
  merge_json "$SETTINGS_LOCAL" <<EOF
{
  "env": {
    "HARMONY_SUPABASE_URL": "$SUPABASE_URL",
    "HARMONY_SUPABASE_ANON_KEY": "$ANON_KEY",
    "HARMONY_API_TOKEN": "$API_TOKEN"
  }
}
EOF
else
  merge_json "$SETTINGS_LOCAL" <<EOF
{
  "env": {
    "HARMONY_SUPABASE_URL": "$SUPABASE_URL",
    "HARMONY_API_TOKEN": "$API_TOKEN"
  }
}
EOF
fi

SETTINGS_SHARED="$TARGET_DIR/.claude/settings.json"
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

echo "Channel configured in $TARGET_DIR"
echo "  Supabase: $SUPABASE_URL"
echo "  Marketplace harmony-plugin disabled for that directory."
