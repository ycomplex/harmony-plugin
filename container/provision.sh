#!/usr/bin/env bash
# B-694 provisioning — runs FROM the runtime-cloned plugin (never baked into
# the image), so this logic is always the cloned ref's own. It wires the run
# directory's Harmony env via the same settings-triple mechanism the B-488
# staging channel uses (scripts/setup-channel-env.sh), configures git + gh,
# shims the harmony CLI, and CONFIRMS the environment pairing via get_project
# BEFORE any work — then drops to a shell (dogfood) or runs the headless agent.
set -euo pipefail

PLUGIN_DIR=/workspace/plugin
WORKDIR="${HARMONY_WORKDIR:-/workspace/run}"
mkdir -p "$WORKDIR"

# --- Resolve the READ PLANE: which Harmony/Supabase the MCP + CLI talk to. --
# This is NOT deploy targeting. Deploys happen in CI from GitHub secrets after
# a merge; HARMONY_TARGET=staging does NOT deploy anything to staging — this
# container only ever pushes a branch and opens a PR.
#
# The URL pair below mirrors the canonical environment map (workspace
# CLAUDE.md deploy table, B-707) and src/tools/environment.ts KNOWN_REFS —
# reviewed together in this repo. Drift cannot slip through: the get_project
# confirmation below resolves the target through the REAL KNOWN_REFS and
# aborts on mismatch.
HARMONY_TARGET="${HARMONY_TARGET:-prod}"
case "$HARMONY_TARGET" in
  prod)    SUPABASE_URL="https://eioxsunvhakmelhanmnn.supabase.co" ;;
  staging) SUPABASE_URL="https://meqkdgncdzromunylyxf.supabase.co" ;;
  custom)  SUPABASE_URL="${HARMONY_SUPABASE_URL:?HARMONY_TARGET=custom needs HARMONY_SUPABASE_URL}" ;;
  *)
    echo "Unknown HARMONY_TARGET '$HARMONY_TARGET' (expected prod | staging | custom)" >&2
    exit 1
    ;;
esac

: "${HARMONY_API_TOKEN:?HARMONY_API_TOKEN is required (the board API token for the chosen target)}"
# The plugin's shared core carries a baked prod anon-key default; staging and
# custom must supply theirs (Supabase dashboard > Project Settings > API keys).
if [ "$HARMONY_TARGET" != "prod" ] && [ -z "${HARMONY_SUPABASE_ANON_KEY:-}" ]; then
  echo "HARMONY_SUPABASE_ANON_KEY is required for HARMONY_TARGET=$HARMONY_TARGET" >&2
  exit 1
fi
ANON_KEY="${HARMONY_SUPABASE_ANON_KEY:-}"

# --- Wire the run directory via the shared channel mechanism (B-488). -------
if [ -n "$ANON_KEY" ]; then
  "$PLUGIN_DIR/scripts/setup-channel-env.sh" "$WORKDIR" "$SUPABASE_URL" "$ANON_KEY" "$HARMONY_API_TOKEN"
else
  # Prod with the baked default key: write the triple minus the anon key.
  "$PLUGIN_DIR/scripts/setup-channel-env.sh" "$WORKDIR" "$SUPABASE_URL" "" "$HARMONY_API_TOKEN"
fi
export HARMONY_SUPABASE_URL="$SUPABASE_URL"
[ -n "$ANON_KEY" ] && export HARMONY_SUPABASE_ANON_KEY="$ANON_KEY"
export HARMONY_API_TOKEN

# --- Git identity + gh auth (works for founder PAT now, bot creds later). ---
git config --global user.name  "${GIT_USER_NAME:-Harmony Worker}"
git config --global user.email "${GIT_USER_EMAIL:-worker@ycomplex.com}"
if command -v gh >/dev/null 2>&1; then
  printf '%s' "$GIT_TOKEN" | gh auth login --with-token >/dev/null 2>&1 || \
    echo "Warning: gh auth login failed; PR creation will not work until it succeeds." >&2
fi

# --- Shim the harmony CLI from the cloned plugin's committed dist. ----------
mkdir -p "$HOME/bin"
cat >"$HOME/bin/harmony" <<EOF
#!/bin/sh
exec node "$PLUGIN_DIR/dist/bin/harmony.js" "\$@"
EOF
chmod 755 "$HOME/bin/harmony"
export PATH="$HOME/bin:$PATH"

# --- Confirm the environment pairing (AC2) BEFORE any work. -----------------
# harmony login writes ~/.harmony/config.json (the CLI has no env-token
# fallback); get_project then resolves the target through the plugin's real
# KNOWN_REFS — the mechanical cross-check on the URL pair above.
harmony login --token "$HARMONY_API_TOKEN" >/dev/null
ENV_JSON="$(harmony --json project info)"
ACTUAL_TARGET="$(printf '%s' "$ENV_JSON" | jq -r '.environment.target // empty')"
PLUGIN_VERSION="$(printf '%s' "$ENV_JSON" | jq -r '.environment.plugin_version // empty')"
if [ "$ACTUAL_TARGET" != "$HARMONY_TARGET" ]; then
  echo "Environment mismatch: requested HARMONY_TARGET=$HARMONY_TARGET but get_project reports '$ACTUAL_TARGET'." >&2
  echo "Refusing to proceed — fix the config before running any build." >&2
  exit 1
fi
echo "Environment confirmed: target=$ACTUAL_TARGET plugin_version=$PLUGIN_VERSION workdir=$WORKDIR"

# --- Hand off. --------------------------------------------------------------
MODE="${1:-shell}"
case "$MODE" in
  shell)
    echo "Dogfood shell. For an agent session: cd $WORKDIR && claude --plugin-dir $PLUGIN_DIR"
    cd "$WORKDIR"
    exec bash
    ;;
  headless)
    shift || true
    PROMPT="${1:?headless mode needs a prompt argument}"
    command -v claude >/dev/null 2>&1 || {
      echo "headless mode needs the agent image (this looks like the base target — no claude installed)." >&2
      exit 1
    }
    # Empty-value shadow guard (same class as the anon-key omit): --env-file
    # turns a blank line into a set-but-empty var, and an empty
    # ANTHROPIC_API_KEY would shadow the OAuth token.
    [ -z "${ANTHROPIC_API_KEY:-}" ] && unset ANTHROPIC_API_KEY
    [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && unset CLAUDE_CODE_OAUTH_TOKEN
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      echo "Warning: ANTHROPIC_API_KEY is set — it OVERRIDES subscription auth and bills per-token." >&2
      echo "Unset it and set CLAUDE_CODE_OAUTH_TOKEN (minted via 'claude setup-token') for subscription runs." >&2
    elif [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      echo "headless mode needs auth: set CLAUDE_CODE_OAUTH_TOKEN (primary; mint via 'claude setup-token')" >&2
      echo "or ANTHROPIC_API_KEY (fallback; per-token API billing)." >&2
      exit 1
    fi
    cd "$WORKDIR"
    # The flags are deliberately word-split.
    # shellcheck disable=SC2086
    exec claude --plugin-dir "$PLUGIN_DIR" -p "$PROMPT" ${CLAUDE_HEADLESS_FLAGS:-}
    ;;
  *)
    echo "Unknown mode '$MODE' (expected: shell | headless <prompt>)" >&2
    exit 1
    ;;
esac
