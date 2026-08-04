#!/usr/bin/env bash
# B-694 minimal bootstrap — the ONLY provisioning logic baked into the image.
# Everything substantive runs FROM the runtime clone (container/provision.sh at
# the cloned plugin ref), so provisioning can never drift from the plugin it
# provisions. Keep this file to: validate env -> clone -> hand off.
set -euo pipefail

: "${GIT_TOKEN:?GIT_TOKEN is required (a GitHub token able to clone/push ycomplex repos) — see plugin/container/env.example (copy it and fill it in — container/README.md Quick start)}"
WEB_REPO="${WEB_REPO:-https://github.com/ycomplex/harmony-web.git}"
PLUGIN_REPO="${PLUGIN_REPO:-https://github.com/ycomplex/harmony-plugin.git}"
WORKSPACE_REPO="${WORKSPACE_REPO:-https://github.com/ycomplex/harmony-workspace.git}"
WEB_REF="${WEB_REF:-main}"
export PLUGIN_REF="${PLUGIN_REF:-main}"
WORKSPACE_REF="${WORKSPACE_REF:-main}"

# Token-authenticated clones without the token landing in .git/config or argv:
# an askpass helper reads it from the env.
GIT_ASKPASS_HELPER="$(mktemp)"
cat >"$GIT_ASKPASS_HELPER" <<'EOF'
#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "$GIT_TOKEN" ;;
esac
EOF
chmod 700 "$GIT_ASKPASS_HELPER"
export GIT_ASKPASS="$GIT_ASKPASS_HELPER"
export GIT_TERMINAL_PROMPT=0

# Fresh clone per start is the accepted v1 tradeoff (see the B-694 design
# entry); idempotent when a persistent volume already carries the clones.
clone() { # $1 = url, $2 = ref, $3 = dir
  if [ ! -e "$3/.git" ]; then
    git clone --branch "$2" "$1" "$3"
  fi
}
# B-726 (a/a1): clone the meta-repo FIRST, then web+plugin INSIDE it — mirrors
# the interactive layout so all three CLAUDE.md levels load by ordinary file
# ancestry (workspace/CLAUDE.md, web/CLAUDE.md, plugin/CLAUDE.md). web/ and
# plugin/ are gitignored placeholders in the workspace repo (see its
# .gitignore) precisely for this.
clone "$WORKSPACE_REPO" "$WORKSPACE_REF" /workspace/workspace
clone "$WEB_REPO" "$WEB_REF" /workspace/workspace/web
clone "$PLUGIN_REPO" "$PLUGIN_REF" /workspace/workspace/plugin

exec /workspace/workspace/plugin/container/provision.sh "$@"
