#!/usr/bin/env bash
# B-1076: local-docker worker LAUNCH wrapper — the "local-docker" launch profile's `launch` template
# target (container/daemon-profile.example.json).
#
# Until B-1076 the local-docker profile's launch was one inline `&&`-chained template. This script
# performs EXACTLY that launch for a non-Codex run — the same mkdir, the same mint invocation (the
# `--model` flag is passed even when empty, as the template always did), the same host-side resume
# discovery, and the same `docker run` argv, run in the foreground so its exit code is the leg's —
# and pins that by an executed parity test against the frozen pre-B-1076 template
# (src/daemon/local-docker-launch.test.ts). It exists so a Codex run can be wired in without
# growing the template into shell.
#
# A Codex run (run_config.agent.adapter == "codex", detected exactly as docker-host-worker-launch.sh
# does) additionally:
#   * bind-mounts the login cache ${HARMONY_CODEX_AUTH_SRC:-$HOME/.harmony/codex-automation/auth.json}
#     READ-ONLY at /home/worker/.codex-auth-src/auth.json (provision.sh's `harmony agent render`
#     copies it into ~/.codex — copy-in, never written back);
#   * mounts a per-conduction codex-sessions dir at /home/worker/.codex/sessions;
#   * sets HARMONY_CODEX_AUTH_FILE (a PATH — the secret never enters env or argv);
#   * refuses before minting anything when the file is missing or a metered variable is set (B-934);
#   * skips the host-side resume discovery, which only ever finds a CLAUDE session id — a Claude
#     session id must never reach another runtime (provision.sh disables resume for Codex legs too).
# This script never opens, prints or hashes the login cache; it only tests that it exists.
#
# Usage: docker-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model] [worker_image]
set -euo pipefail

CONDUCTION_ID="${1:?usage: docker-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model] [worker_image]}"
TICKET="${2:?usage: docker-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model] [worker_image]}"
DEFAULT_RUN_CONFIG='{}'
RUN_CONFIG_JSON="${3:-$DEFAULT_RUN_CONFIG}"
MODEL="${4:-}"
# The deployment's worker_image (the conductor always renders it; the schema default otherwise).
WORKER_IMAGE="${5:-harmony-build-env}"

: "${HARMONY_PLUGIN_DIR:?HARMONY_PLUGIN_DIR is required (checkout the mint and resume-discovery scripts run from)}"

# --- B-1076: which agent adapter this run launches — the SAME probe as docker-host-worker-launch.sh --
CODEX_RUN=0
CODEX_AUTH_SRC=""
CODEX_AUTH_CONTAINER_PATH="/home/worker/.codex-auth-src/auth.json"   # provision.sh copies it into ~/.codex
# run_config arrives as base64 JSON from the conductor (or raw JSON from a manual invocation): accept both.
ADAPTER_PROBE="$(node -e 'let s=process.argv[1];try{JSON.parse(s)}catch{try{s=Buffer.from(s,"base64").toString("utf8")}catch{}}try{const a=JSON.parse(s).agent;process.stdout.write(a&&typeof a.adapter==="string"?a.adapter:"")}catch{}' "$RUN_CONFIG_JSON" 2>/dev/null || true)"
if [ "$ADAPTER_PROBE" = "codex" ]; then CODEX_RUN=1; fi
if [ "$CODEX_RUN" = "1" ]; then
  CODEX_AUTH_SRC="${HARMONY_CODEX_AUTH_SRC:-$HOME/.harmony/codex-automation/auth.json}"
  if [ ! -f "$CODEX_AUTH_SRC" ]; then
    echo "docker-worker-launch: Refusing to start: this run selects the codex adapter but the login-cache file is missing at $CODEX_AUTH_SRC (see container/README.md \"Codex credential runbook\") — no worker launched" >&2
    exit 1
  fi
  for CODEX_REFUSED_VAR in OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN; do
    if [ -n "${!CODEX_REFUSED_VAR:-}" ]; then
      echo "docker-worker-launch: Refusing to start: $CODEX_REFUSED_VAR is set in the launcher's environment — a Codex leg runs on the plan-included login cache only (B-934: no metered fallback)" >&2
      exit 1
    fi
  done
fi

RUN_DIR="$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID"
ENV_FILE="$RUN_DIR/run.env"
RUN_CONFIG_FILE="$RUN_DIR/run-config.json"

# 1. Pre-create every mounted host DIRECTORY (B-724: Docker would create a missing bind source
#    root-owned, which the uid-1001 worker cannot write).
mkdir -p "$RUN_DIR/projects" "$RUN_DIR/logs"
if [ "$CODEX_RUN" = "1" ]; then
  mkdir -p "$RUN_DIR/codex-sessions"
fi

# 2. Mint the per-run env-file (B-732) and the run-config file (B-846) — the template's invocation.
node "$HARMONY_PLUGIN_DIR/scripts/mint-installation-token.mjs" --base "$HOME/.harmony-container.env" --out "$ENV_FILE" --conduction-id "$CONDUCTION_ID" --model "$MODEL" --run-config "$RUN_CONFIG_JSON" --run-config-path /home/worker/.claude/run-config.json

# 3. Cross-conduction resume discovery (B-718), host-side — Claude runs only (see the header).
if [ "$CODEX_RUN" != "1" ]; then
  node "$HARMONY_PLUGIN_DIR/scripts/resume-discovery.mjs" --conductions-root "$HOME/.harmony-conductions" --ticket "$TICKET" --conduction-id "$CONDUCTION_ID" --run-config-file "$RUN_CONFIG_FILE" --env-file "$ENV_FILE"
fi

# 4. The worker, in the foreground: exec, so docker's exit code IS this script's.
CODEX_ARGS=()
if [ "$CODEX_RUN" = "1" ]; then
  CODEX_ARGS=(-v "$RUN_DIR/codex-sessions:/home/worker/.codex/sessions" -v "$CODEX_AUTH_SRC:$CODEX_AUTH_CONTAINER_PATH:ro" -e "HARMONY_CODEX_AUTH_FILE=$CODEX_AUTH_CONTAINER_PATH")
fi
# B-1149: forced-refusal test hook — optional, inert when unset; only the exact values quota|rate-limit pass.
FORCE_REFUSAL_ARGS=()
case "${HARMONY_TEST_FORCE_REFUSAL:-}" in
  quota|rate-limit) FORCE_REFUSAL_ARGS=(-e "HARMONY_TEST_FORCE_REFUSAL=$HARMONY_TEST_FORCE_REFUSAL") ;;
esac
exec docker run --rm --name "harmony-worker-$CONDUCTION_ID" -v "$RUN_DIR/projects:/home/worker/.claude/projects" -v "$RUN_DIR/logs:/home/worker/.claude/logs" -v "$RUN_CONFIG_FILE:/home/worker/.claude/run-config.json:ro" ${CODEX_ARGS[@]+"${CODEX_ARGS[@]}"} ${FORCE_REFUSAL_ARGS[@]+"${FORCE_REFUSAL_ARGS[@]}"} --env-file "$ENV_FILE" "$WORKER_IMAGE" headless "/harmony-plugin:harmony-conduct $TICKET --one-shot"
