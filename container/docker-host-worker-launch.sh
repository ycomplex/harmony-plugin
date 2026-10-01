#!/usr/bin/env bash
# B-708: Docker-host worker LAUNCH wrapper — the "docker-host" launch profile's `launch` template
# target.
#
# WHAT THIS PROFILE IS FOR. A worker on the local-docker or cloud profile cannot start containers,
# so a leg cannot run the project's own Compose stack. This profile runs the worker on ONE remote
# Linux Docker host as a PRIVILEGED container that starts its OWN Docker engine inside itself
# (the engine layer, container/docker-engine/, started by container/provision.sh). The project's
# stack then lives entirely inside the leg: its ports are on the worker's own 127.0.0.1, and it is
# torn down when the worker container is removed. The host powers itself off when idle
# (container/docker-host/idle.sh), so each launch first WAKES it.
#
# Like the cloud wrapper, this exists so the daemon's scheduler/classify code never changes and
# never parses stdout: the daemon runs this to completion and reads its exit code (0 = the worker
# exited 0, 1 = anything else — the same collapse cloud-worker-launch.sh applies).
#
# THE CREDENTIAL BOUNDARY. The GitHub App private key never leaves the daemon's machine: the
# per-run token is minted HERE, and only the two per-run files (run.env, run-config.json) are
# shipped — through ssh's stdin, never on a command line — and the host's run.env is removed again
# when this wrapper exits.
#
# Runs on the DAEMON'S MACHINE, so it stays bash-3.2 safe (see docker-host-common.sh).
#
# Usage: docker-host-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]
set -euo pipefail

CONDUCTION_ID="${1:?usage: docker-host-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]}"
TICKET="${2:?usage: docker-host-worker-launch.sh <conduction_id> <ticket> [run_config_json] [model]}"
# Same third/fourth positional args, with the same defaults, as cloud-worker-launch.sh (B-718 /
# B-743 run-config seam; B-772 per-leg model) — see that script for the full history.
DEFAULT_RUN_CONFIG='{}'
RUN_CONFIG_JSON="${3:-$DEFAULT_RUN_CONFIG}"
MODEL="${4:-}"

# shellcheck source=container/docker-host-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/docker-host-common.sh"

dh_require_safe_id docker-host-worker-launch "$CONDUCTION_ID" "conduction id"
dh_require_safe_id docker-host-worker-launch "$TICKET" "ticket"
dh_resolve_target docker-host-worker-launch

: "${HARMONY_PLUGIN_DIR:?HARMONY_PLUGIN_DIR is required (checkout the mint script runs from, same knob the docker profile uses)}"

# --- Config knobs (B-711 "config not constants") ----------------------------------------------
WAKE_CMD="${HARMONY_DOCKER_HOST_WAKE:-}"
[ -n "$WAKE_CMD" ] || WAKE_CMD="$(dh_config_get "profiles.$DH_PROFILE.docker_host.wake")"

WAKE_TIMEOUT_S="${HARMONY_DOCKER_HOST_WAKE_TIMEOUT_S:-}"
[ -n "$WAKE_TIMEOUT_S" ] || WAKE_TIMEOUT_S="$(dh_config_get "profiles.$DH_PROFILE.docker_host.wake_timeout_s")"
[ -n "$WAKE_TIMEOUT_S" ] || WAKE_TIMEOUT_S=180

# B-929 lever 2: the deployment's worker_image, used AS-IS on the host (the host builds or pulls its
# own images; there is no registry resolution here, unlike the cloud path). `config get worker_image`
# always answers when a deployment config exists (the schema defaults it); with no config at all
# this falls back to that same default name.
WORKER_IMAGE="$(dh_config_get worker_image)"
[ -n "$WORKER_IMAGE" ] || WORKER_IMAGE="harmony-build-env"

# Poll/retry cadences. Env-overridable so a test does not have to sit through them; the defaults
# are the contract.
WAKE_POLL_S="${HARMONY_DOCKER_HOST_WAKE_POLL_S:-5}"
WAIT_RETRY_S="${HARMONY_DOCKER_HOST_WAIT_RETRY_S:-15}"
WAIT_RETRY_BUDGET_S="${HARMONY_DOCKER_HOST_WAIT_BUDGET_S:-600}"

CONTAINER="harmony-worker-$CONDUCTION_ID"   # same name as the local profile
ENGINE_VOLUME="harmony-engine-$TICKET"       # the leg's engine state: one volume per ticket
REMOTE_RUN="$DH_REMOTE_ROOT/$TICKET/$CONDUCTION_ID"
IMAGE_Q="$(dh_quote "$WORKER_IMAGE")"

RUN_DIR="$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID"
ENV_FILE="$RUN_DIR/run.env"
RUN_CONFIG_FILE="$RUN_DIR/run-config.json"
mkdir -p "$RUN_DIR"

# 1. Wake the host. The command's exit status is IGNORED: "start" on an already-running machine
#    fails on some providers, and step 2 is the real test of whether the host is up.
if [ -n "$WAKE_CMD" ]; then
  echo "docker-host-worker-launch: waking the host" >&2
  bash -c "$WAKE_CMD" </dev/null >&2 || echo "docker-host-worker-launch: the wake command exited non-zero — ignored, waiting for SSH" >&2
fi

# 2. Wait for SSH to answer.
WAKE_STARTED=$SECONDS
until dh_ssh true </dev/null >/dev/null 2>&1; do
  if [ $((SECONDS - WAKE_STARTED)) -ge "$WAKE_TIMEOUT_S" ]; then
    echo "docker-host-worker-launch: $DH_SSH_TARGET did not answer SSH within ${WAKE_TIMEOUT_S}s — treating as a dirty exit" >&2
    exit 1
  fi
  sleep "$WAKE_POLL_S"
done

# 9 (installed here, runs last). ALWAYS on exit, from this point on: remove the host's copy of the
# minted token and the stopped worker container. The container is started WITHOUT --rm (step 7), so
# this is what removes it; removing it is also what tears down everything the leg started inside
# its own engine. Best-effort and silent — it must never change this wrapper's exit code.
cleanup() {
  dh_ssh "rm -f \"$REMOTE_RUN/run.env\"; docker rm $CONTAINER" </dev/null >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 3. Mint the per-run files LOCALLY — the same invocation as the local profile's launch template
#    (container/daemon-profile.example.json), including the mounted-file run-config delivery
#    (--run-config-path). --model only when non-empty, via the bash-3.2-safe empty-array expansion
#    (cloud-worker-launch.sh's B-772 hotfix note).
MINT_MODEL_FLAG=()
if [ -n "$MODEL" ]; then
  MINT_MODEL_FLAG=(--model "$MODEL")
fi
node "$HARMONY_PLUGIN_DIR/scripts/mint-installation-token.mjs" --base "$HOME/.harmony-container.env" --out "$ENV_FILE" --conduction-id "$CONDUCTION_ID" ${MINT_MODEL_FLAG[@]+"${MINT_MODEL_FLAG[@]}"} --run-config "$RUN_CONFIG_JSON" --run-config-path /home/worker/.claude/run-config.json >&2

# 4. Create the host-side run directory (private to the SSH user), stamp the two files the host's
#    idle script reads (.last-launch: "a launch happened now"; .engine-volumes/<ticket>: "this
#    ticket's engine volume was used now"), then ship the per-run files over ssh's STDIN. The token
#    is never an argument to anything.
dh_ssh "umask 077; mkdir -p \"$REMOTE_RUN/projects\" \"$REMOTE_RUN/logs\" \"$DH_REMOTE_ROOT/.engine-volumes\" && chmod 700 \"$DH_REMOTE_ROOT\" \"$DH_REMOTE_ROOT/$TICKET\" \"$REMOTE_RUN\" && touch \"$DH_REMOTE_ROOT/.last-launch\" \"$DH_REMOTE_ROOT/.engine-volumes/$TICKET\"" </dev/null
dh_ssh "umask 077; cat > \"$REMOTE_RUN/run.env\"" < "$ENV_FILE"
RUN_CONFIG_MOUNT=""
RUN_CONFIG_CHOWN=""
if [ -f "$RUN_CONFIG_FILE" ]; then
  dh_ssh "umask 077; cat > \"$REMOTE_RUN/run-config.json\"" < "$RUN_CONFIG_FILE"
  RUN_CONFIG_MOUNT="-v \"$REMOTE_RUN/run-config.json\":/home/worker/.claude/run-config.json:ro"
  RUN_CONFIG_CHOWN="/r/run-config.json"
fi

# 5. Cross-conduction resume discovery (B-718), ON THE HOST — that is where every sibling
#    conduction's transcripts live — inside the worker image (the host needs no node of its own),
#    as root (transcripts are worker-owned, run.env is the SSH user's). The script is piped over
#    stdin and written to a file in the throwaway container before it runs: `node -` cannot take
#    the script's own --flags, and the script only runs its main() when invoked by path.
#    Best-effort, by the script's own contract: a failure here is logged and ignored.
RESUME_SH='cat > /tmp/resume-discovery.mjs && exec node /tmp/resume-discovery.mjs "$@"'
dh_ssh "docker run --rm -i --user 0 --entrypoint sh -v \"$DH_REMOTE_ROOT\":/c $IMAGE_Q -c $(dh_quote "$RESUME_SH") resume-discovery --conductions-root /c --ticket $TICKET --conduction-id $CONDUCTION_ID --run-config-file /c/$TICKET/$CONDUCTION_ID/run-config.json --env-file /c/$TICKET/$CONDUCTION_ID/run.env" \
  < "$HARMONY_PLUGIN_DIR/scripts/resume-discovery.mjs" >&2 \
  || echo "docker-host-worker-launch: resume discovery failed on the host — ignored, the leg starts cold" >&2

# 6. Hand the worker what it must write. Done through the IMAGE, as root, so it resolves the
#    `worker` user's uid from the image and never depends on the host's own uid numbering.
#    run.env is deliberately NOT included: it stays the SSH user's, mode 600 — the docker CLI on the
#    host reads it for --env-file.
dh_ssh "docker run --rm --user 0 --entrypoint chown -v \"$REMOTE_RUN\":/r $IMAGE_Q -R worker:worker /r/projects /r/logs $RUN_CONFIG_CHOWN" </dev/null >&2

# 7. Run the worker, in the foreground over ssh.
#    --privileged + the engine volume at /var/lib/docker: what the in-container Docker engine needs.
#    NO --rm: if the SSH session drops, the container's exit code must still be there to ask for
#    (step 8). The trap above removes the container instead.
#    The prompt is one argument containing spaces — quoted for the remote shell (dh_quote).
PROMPT_Q="$(dh_quote "/harmony-plugin:harmony-conduct $TICKET --one-shot")"
set +e
dh_ssh "docker run --privileged --name $CONTAINER -v $ENGINE_VOLUME:/var/lib/docker -v \"$REMOTE_RUN/projects\":/home/worker/.claude/projects -v \"$REMOTE_RUN/logs\":/home/worker/.claude/logs $RUN_CONFIG_MOUNT --env-file \"$REMOTE_RUN/run.env\" $IMAGE_Q headless $PROMPT_Q" </dev/null
WORKER_EXIT=$?
set -e

# 8. ssh's own exit 255 means the CONNECTION failed, not the worker — the container may well still
#    be running. Ask the host for the real exit code: `docker wait` blocks until the container
#    stops and prints its code. Retried while the host stays unreachable, up to the budget; a wait
#    that connects and blocks for the rest of a long leg is not "retrying" and is not bounded here
#    (the daemon's own per-launch deadline bounds the whole wrapper).
if [ "$WORKER_EXIT" -eq 255 ]; then
  echo "docker-host-worker-launch: the SSH session to $DH_SSH_TARGET was lost — asking the host for $CONTAINER's exit code" >&2
  WAIT_SPENT_S=0
  while :; do
    set +e
    WAIT_OUTPUT="$(dh_ssh "docker wait $CONTAINER 2>&1" </dev/null)"
    WAIT_EXIT=$?
    set -e
    if [ "$WAIT_EXIT" -eq 0 ] && printf '%s' "$WAIT_OUTPUT" | grep -Eq '^[0-9]+$'; then
      WORKER_EXIT="$WAIT_OUTPUT"
      break
    fi
    if [ "$WAIT_EXIT" -ne 255 ]; then
      # The host answered and docker could not wait on it: the container is not there.
      echo "docker-host-worker-launch: could not find $CONTAINER on the host ($WAIT_OUTPUT) — treating as a dirty exit" >&2
      exit 1
    fi
    if [ "$WAIT_SPENT_S" -ge "$WAIT_RETRY_BUDGET_S" ]; then
      echo "docker-host-worker-launch: $DH_SSH_TARGET stayed unreachable for ${WAIT_RETRY_BUDGET_S}s after the session dropped — treating as a dirty exit" >&2
      exit 1
    fi
    sleep "$WAIT_RETRY_S"
    WAIT_SPENT_S=$((WAIT_SPENT_S + WAIT_RETRY_S))
  done
fi

if [ "$WORKER_EXIT" -eq 0 ]; then
  exit 0
fi
echo "docker-host-worker-launch: worker $CONTAINER exited $WORKER_EXIT" >&2
exit 1
