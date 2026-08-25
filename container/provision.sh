#!/usr/bin/env bash
# B-694 provisioning — runs FROM the runtime-cloned plugin (never baked into
# the image), so this logic is always the cloned ref's own. It wires the run
# directory's Harmony env via the same settings-triple mechanism the B-488
# staging channel uses (scripts/setup-channel-env.sh), configures git + gh,
# shims the harmony CLI, and CONFIRMS the environment pairing via get_project
# BEFORE any work — then drops to a shell (dogfood) or runs the headless agent.
set -euo pipefail

# B-726 (a): PLUGIN_DIR + WORKDIR now live INSIDE the cloned harmony-workspace
# checkout (mirrors the interactive layout — see entrypoint.sh's clone order)
# so all three CLAUDE.md levels (workspace, plugin, web) load by ordinary file
# ancestry, exactly as an interactive session gets.
PLUGIN_DIR=/workspace/workspace/plugin
WORKDIR="${HARMONY_WORKDIR:-/workspace/workspace}"
mkdir -p "$WORKDIR"

# Local-only git-exclude for .claude/ in the workspace clone (B-726 (a)) — NOT
# the committed .gitignore, so an interactive founder checkout of the same
# repo doesn't silently ignore a real .claude/. Harmless here: this container
# clone is ephemeral/--rm (B-694).
if [ -d "$WORKDIR/.git" ] && ! grep -qxF '.claude/' "$WORKDIR/.git/info/exclude" 2>/dev/null; then
  mkdir -p "$WORKDIR/.git/info"
  echo '.claude/' >> "$WORKDIR/.git/info/exclude"
fi

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

# B-800 AC2: a per-deployment config's launcher.supabase.url TAKES PRECEDENCE when present and
# non-empty. Read directly via `node .../dist/bin/harmony.js` (not the $HOME/bin/harmony shim,
# which is not wired yet at this point in the script, and not `harmony login`, which needs
# HARMONY_API_TOKEN which is not validated yet either). The hardcoded case statement below is the
# DOCUMENTED PER-DEPLOYMENT FACT fallback this AC accepts in place of a full migration — it MUST
# keep working byte-for-byte with no ~/.harmony/deployment.json present (true for the live dogfood
# daemon today), so this lookup is best-effort and never fails the script.
DEPLOYMENT_CONFIG_PATH="${HARMONY_DEPLOYMENT_CONFIG:-$HOME/.harmony/deployment.json}"
CONFIG_SUPABASE_URL=""
if [ -f "$DEPLOYMENT_CONFIG_PATH" ]; then
  CONFIG_SUPABASE_URL="$(node "$PLUGIN_DIR/dist/bin/harmony.js" config get launcher.supabase.url 2>/dev/null || true)"
fi

if [ -n "$CONFIG_SUPABASE_URL" ]; then
  SUPABASE_URL="$CONFIG_SUPABASE_URL"
else
  case "$HARMONY_TARGET" in
    prod)    SUPABASE_URL="https://eioxsunvhakmelhanmnn.supabase.co" ;;
    staging) SUPABASE_URL="https://meqkdgncdzromunylyxf.supabase.co" ;;
    custom)  SUPABASE_URL="${HARMONY_SUPABASE_URL:?HARMONY_TARGET=custom needs HARMONY_SUPABASE_URL — see plugin/container/env.example (copy it and fill it in — container/README.md Quick start)}" ;;
    *)
      echo "Unknown HARMONY_TARGET '$HARMONY_TARGET' (expected prod | staging | custom)" >&2
      exit 1
      ;;
  esac
fi

: "${HARMONY_API_TOKEN:?HARMONY_API_TOKEN is required (the board API token for the chosen target) — see plugin/container/env.example (copy it and fill it in — container/README.md Quick start)}"
# The plugin's shared core carries a baked prod anon-key default; staging and
# custom must supply theirs (Supabase dashboard > Project Settings > API keys).
if [ "$HARMONY_TARGET" != "prod" ] && [ -z "${HARMONY_SUPABASE_ANON_KEY:-}" ]; then
  echo "HARMONY_SUPABASE_ANON_KEY is required for HARMONY_TARGET=$HARMONY_TARGET — see plugin/container/env.example (copy it and fill it in — container/README.md Quick start)" >&2
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

# --- Install the declared build agent (B-719). ------------------------------
# Config levers (CLI flag / settings.json) do NOT reach Task-tool subagents in
# headless -p; a DECLARED agent's frontmatter permissionMode is the one lever
# that does. Clone-sourced so it never drifts from the provisioned ref.
mkdir -p "$HOME/.claude/agents"
cp "$PLUGIN_DIR/container/agents/harmony-build.md" "$HOME/.claude/agents/harmony-build.md"

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

# --- Ref/target fidelity (B-726 (d), re-keyed onto ONE var by B-803) — the B-383 invariant:
# plugin `prod` must never run against a board a `main`-ref plugin may not be schema-compatible
# with. B-383 is enforced by the marketplace pinning source.ref: "prod"; this container clones the
# ref directly and never reads that pin, so it needs its own check. Computed here (banner echo,
# always shown); ENFORCED only in headless mode below — shell/dogfood stays exempt unconditionally.
#
# B-803: ONE posture var, HARMONY_PLUGIN_POSTURE, replaces the old PLUGIN_REF +
# HARMONY_ACK_PLUGIN_AHEAD_OF_PROD pair (which could be set inconsistently, and the ack half was
# unreachable on the cloud profile — Cloud Run's --env-vars-file REPLACES the job env, and
# write_exec_env_file never forwarded it). Parsed ONCE, here, into {ref, acked}:
#   prod        -> ref=prod  (the safe default posture)
#   ack:<ref>   -> ref=<ref>, acked (the ahead-of-prod risk is explicitly accepted)
#   <ref>       -> ref=<ref>, NOT acked (a bare ref with no "ack:" prefix)
#   unset       -> defaults to "main", NOT acked (matches the daemon's historical default posture)
PLUGIN_POSTURE="${HARMONY_PLUGIN_POSTURE:-main}"
case "$PLUGIN_POSTURE" in
  ack:*)
    PLUGIN_REF="${PLUGIN_POSTURE#ack:}"
    AHEAD_OF_PROD_ACKED=1
    ;;
  *)
    PLUGIN_REF="$PLUGIN_POSTURE"
    AHEAD_OF_PROD_ACKED=0
    ;;
esac
AHEAD_OF_PROD_ACK=""
if [ "$ACTUAL_TARGET" = "prod" ] && [ "$PLUGIN_REF" != "prod" ] && [ "$AHEAD_OF_PROD_ACKED" = "1" ]; then
  AHEAD_OF_PROD_ACK=" (ACK'd ahead-of-prod override active)"
fi
echo "Environment confirmed: target=$ACTUAL_TARGET plugin_ref=$PLUGIN_REF plugin_version=$PLUGIN_VERSION workdir=$WORKDIR$AHEAD_OF_PROD_ACK"

# --- Hand off. --------------------------------------------------------------
if [ $# -eq 0 ] && [ ! -t 0 ]; then
  # A mis-provisioned non-interactive invocation (e.g. a Cloud Run job execution with no
  # --args) must fail loud, not silently drop into the dogfood shell and exit 0 having done
  # no work — that exact silent-empty-run cost a park and a live diagnosis (B-754, 2026-08-03).
  echo "ERROR: no mode argument given and stdin is not a TTY — refusing to silently drop into the dogfood shell." >&2
  echo "Pass 'shell' explicitly for an interactive dogfood session, or 'headless <prompt>' for an agent run." >&2
  exit 1
fi
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

    # B-726 (d) / B-803: fail closed, headless-mode only, if this worker would run a plugin ref
    # ahead of the prod board it just confirmed against — unless the founder has explicitly ack'd
    # that posture via HARMONY_PLUGIN_POSTURE=ack:<ref>. HARMONY_PLUGIN_POSTURE must ride the BASE
    # container env (~/.harmony-container.env) so the mint script folds it into every per-leg env
    # file — on the cloud profile, per-leg --env-vars-file REPLACES the job's literal env, so a
    # flag wired anywhere else never reaches this check on cloud.
    if [ "$ACTUAL_TARGET" = "prod" ] && [ "$PLUGIN_REF" != "prod" ] && [ "$AHEAD_OF_PROD_ACKED" != "1" ]; then
      echo "Refusing to start: HARMONY_PLUGIN_POSTURE=$PLUGIN_POSTURE resolves to plugin_ref=$PLUGIN_REF, ahead of the prod board this worker just confirmed against (target=$ACTUAL_TARGET) — the B-383 invariant." >&2
      echo "Set HARMONY_PLUGIN_POSTURE=ack:$PLUGIN_REF in ~/.harmony-container.env to explicitly accept this dev-heavy posture (echoed in the banner above), or pin HARMONY_PLUGIN_POSTURE=prod." >&2
      exit 1
    fi

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
      echo "or ANTHROPIC_API_KEY (fallback; per-token API billing) — see plugin/container/env.example (copy it and fill it in — container/README.md Quick start)." >&2
      exit 1
    fi
    # B-825: never let the headless runtime's 600s background-task ceiling kill a
    # still-running delegated build (B-688's build died exactly this way — twice).
    # Build subagents are foreground by rule (start-work O3); this export is the
    # safety net for anything that still slips into the background. The daemon's
    # 90-minute worker deadline (B-739) remains the outer bound on the leg.
    export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
    cd "$WORKDIR"

    # --- B-718: same-conduction resume discovery + best-effort --resume wiring (AC5). -----------
    # Both launch profiles already mount/symlink the SAME {ticket}/{conduction_id}/projects
    # directory for every leg of ONE conduction (container/daemon-profile.example.json's `launch`
    # template; container/entrypoint.sh's cloud-profile symlink block), so a prior leg's session
    # file already physically sits at $HOME/.claude/projects before this leg's claude invocation
    # ever starts — nothing to mount, just discover the id already there. Cross-conduction (after a
    # park + re-conduct) is handled UPSTREAM of this script: container/entrypoint.sh (cloud profile)
    # and scripts/resume-discovery.mjs (local docker profile, host-side) may have already injected
    # `--resume <id>` into CLAUDE_HEADLESS_FLAGS by the time this script runs — this block only ever
    # ADDS a resume flag when $HOME/.claude/projects (the SAME-conduction tier) itself already has a
    # session, which by construction (see both upstream scripts' own "current conduction already has
    # a session" skip check) never collides with an upstream cross-conduction injection.
    #
    # Gated on run_config.session_resume.enabled (v1: a plain on/off boolean, no reshape-count
    # heuristic) — read from whichever B-846 delivery form this launch actually used. Best-effort
    # throughout: any failure below (a malformed run-config, an unreadable projects dir) degrades to
    # "no resume id found", never blocks the leg.
    RUN_CONFIG_JSON=""
    if [ -n "${HARMONY_RUN_CONFIG_PATH:-}" ] && [ -f "$HARMONY_RUN_CONFIG_PATH" ]; then
      RUN_CONFIG_JSON="$(cat "$HARMONY_RUN_CONFIG_PATH" 2>/dev/null || true)"
    elif [ -n "${HARMONY_RUN_CONFIG_JSON:-}" ]; then
      RUN_CONFIG_JSON="$(printf '%s' "$HARMONY_RUN_CONFIG_JSON" | base64 -d 2>/dev/null || true)"
    fi
    SESSION_RESUME_ENABLED="false"
    if [ -n "$RUN_CONFIG_JSON" ]; then
      # Capture jq's stdout/stderr (2>&1) and its real exit status without letting a jq parse
      # failure trip this script's `set -e` (a bare `VAR="$(cmd)"` assignment DOES trip set -e on
      # a nonzero exit — testing it via `&& ... || ...` is what keeps this best-effort). A parse
      # failure is logged loudly to stderr (matching this script's existing >&2 convention) instead
      # of being silently indistinguishable from a legitimate `enabled: false` — the value still
      # safely degrades to "false" either way; this only fixes the missing signal.
      JQ_RESULT="$(printf '%s' "$RUN_CONFIG_JSON" | jq -r '.session_resume.enabled // false' 2>&1)" && JQ_EXIT=0 || JQ_EXIT=$?
      if [ "$JQ_EXIT" -eq 0 ]; then
        SESSION_RESUME_ENABLED="$JQ_RESULT"
      else
        echo "provision.sh: WARNING — failed to parse run_config JSON for session_resume.enabled (jq: $JQ_RESULT); defaulting to disabled" >&2
      fi
    fi

    RESUME_SESSION_ID=""
    if [ "$SESSION_RESUME_ENABLED" = "true" ]; then
      NEWEST_MTIME=0
      for f in "$HOME/.claude/projects"/*/*.jsonl; do
        [ -f "$f" ] || continue
        mtime="$(stat -c '%Y' "$f" 2>/dev/null || echo 0)"
        if [ "$mtime" -gt "$NEWEST_MTIME" ]; then
          NEWEST_MTIME="$mtime"
          RESUME_SESSION_ID="$(basename "$f" .jsonl)"
        fi
      done
    fi

    # The flags are deliberately word-split.
    # shellcheck disable=SC2206
    EXTRA_HEADLESS_FLAGS=(${CLAUDE_HEADLESS_FLAGS:-})

    if [ -z "$RESUME_SESSION_ID" ]; then
      # No prior session to resume (disabled, first leg ever, or nothing resumable) — the existing
      # cold-start path, byte-for-byte unchanged from before this ticket. CLAUDE_HEADLESS_FLAGS may
      # still carry a CROSS-conduction --resume an upstream script injected — that is passed through
      # untouched here, exactly as it always has been.
      exec claude --plugin-dir "$PLUGIN_DIR" -p "$PROMPT" "${EXTRA_HEADLESS_FLAGS[@]}"
    fi

    # B-718 AC5: --resume is BEST-EFFORT. A resumed invocation that fails to even ATTACH (corrupt/
    # truncated session file, a session id the CLI rejects, a stale id left over from an old
    # conduction, the CLI binary itself being unavailable, a permission error reading the session
    # file, ...) must fall back to a COLD start — never fail the leg — and log that the fallback
    # happened, so the degradation is visible to an operator rather than silently absorbed. The gate
    # is a bare nonzero exit code, deliberately NOT keyed to any specific stderr signature: discovery
    # here is deterministic, so a session that fails with an error string this gate doesn't recognize
    # would otherwise re-fail identically on every re-conduct, bricking the ticket with a park reason
    # that never mentions sessions. Only stderr is captured to a file here (stdout keeps streaming
    # live to the daemon's log exactly as before); the captured stderr is dumped verbatim right after
    # the attempt concludes either way, so nothing is lost — only its live interleaving with stdout
    # during the (expected-brief) resume-attach window. Dumping it verbatim is what keeps an
    # unfamiliar failure visible even though the fallback no longer requires recognizing it.
    echo "B-718: attempting to resume prior session $RESUME_SESSION_ID (run_config.session_resume.enabled=true)." >&2
    RESUME_STDERR_FILE="$(mktemp)"
    set +e
    claude --plugin-dir "$PLUGIN_DIR" -p "$PROMPT" --resume "$RESUME_SESSION_ID" "${EXTRA_HEADLESS_FLAGS[@]}" 2>"$RESUME_STDERR_FILE"
    RESUME_EXIT=$?
    set -e
    cat "$RESUME_STDERR_FILE" >&2
    if [ "$RESUME_EXIT" -ne 0 ]; then
      echo "B-718: --resume $RESUME_SESSION_ID failed to attach (exit $RESUME_EXIT; see stderr above) — falling back to a COLD start. Resume was attempted and degraded gracefully; this is expected to be rare — investigate the persisted transcript mount if it recurs." >&2
      rm -f "$RESUME_STDERR_FILE"
      exec claude --plugin-dir "$PLUGIN_DIR" -p "$PROMPT" "${EXTRA_HEADLESS_FLAGS[@]}"
    fi
    rm -f "$RESUME_STDERR_FILE"
    exit "$RESUME_EXIT"
    ;;
  *)
    echo "Unknown mode '$MODE' (expected: shell | headless <prompt>)" >&2
    exit 1
    ;;
esac
