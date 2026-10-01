#!/usr/bin/env bash
# B-708: shared resolution + SSH helper for the "Docker host" launch profile's three wrappers
# (docker-host-worker-launch.sh / -reap.sh / -probe.sh). SOURCED, never executed.
#
# The profile runs each worker on ONE remote Linux Docker host, reached over SSH from the daemon's
# machine. Everything here runs on the DAEMON'S MACHINE, so it must stay bash-3.2 safe (macOS still
# ships 3.2 — see cloud-worker-launch.sh's B-772 hotfix note).
#
# Config, not constants (B-711): every value is an env var first, then the deployment config's
# profiles.<profile>.docker_host block read via `harmony config get` — the same best-effort read the
# cloud wrappers use for profiles.cloud.gcloud_project (a missing HARMONY_PLUGIN_DIR, an unbuilt
# dist/, or no deployment config all just read as "not configured").
#
#   HARMONY_DOCKER_HOST_PROFILE         which profiles.<name> to read            (default docker-host)
#   HARMONY_DOCKER_HOST_SSH             ssh target      | docker_host.ssh_target  (required)
#   HARMONY_DOCKER_HOST_WAKE            wake command    | docker_host.wake        (optional)
#   HARMONY_DOCKER_HOST_WAKE_TIMEOUT_S  seconds to wait | docker_host.wake_timeout_s (default 180)
#   HARMONY_DOCKER_HOST_SSH_OPTS        extra ssh options, word-split (e.g. "-i ~/.ssh/harmony-host")

DH_PROFILE="${HARMONY_DOCKER_HOST_PROFILE:-docker-host}"

# Print the deployment config's value at $1, or nothing. Never fails.
dh_config_get() {
  if [ -n "${HARMONY_PLUGIN_DIR:-}" ] && [ -f "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" ]; then
    node "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" config get "$1" 2>/dev/null || true
  fi
}

# Sets DH_SSH_TARGET. Returns 1 with a clear message when neither source names a host — the caller
# decides what that means for its own exit-code contract.
dh_resolve_target() {
  DH_SSH_TARGET="${HARMONY_DOCKER_HOST_SSH:-}"
  if [ -z "$DH_SSH_TARGET" ]; then
    DH_SSH_TARGET="$(dh_config_get "profiles.$DH_PROFILE.docker_host.ssh_target")"
  fi
  if [ -z "$DH_SSH_TARGET" ]; then
    echo "$1: no Docker host is configured — set HARMONY_DOCKER_HOST_SSH, or profiles.$DH_PROFILE.docker_host.ssh_target in the deployment config" >&2
    return 1
  fi
}

# The conduction id and ticket become path segments and a container name on the host, and are
# spliced into commands a REMOTE shell parses. Both are daemon-supplied ids (a uuid, a ticket id);
# anything outside this alphabet is refused rather than quoted.
dh_require_safe_id() {
  case "$2" in
    '' | *[!A-Za-z0-9._-]* | .*)
      echo "$1: refusing $3 '$2' — only letters, digits, '.', '_' and '-' are allowed (it becomes a path and a container name on the host)" >&2
      return 1
      ;;
  esac
}

# Single-quote $1 for the REMOTE shell. ssh joins its command arguments with spaces and hands the
# result to the remote login shell, so anything that must arrive as ONE argument has to be quoted
# for that second parse.
dh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Run ONE remote command line on the host. BatchMode: never prompt (the daemon has no terminal).
# ServerAlive*: a dead connection is noticed in about two minutes instead of hanging a leg forever.
# Callers that do not feed stdin redirect it from /dev/null, so ssh never eats the caller's own.
dh_ssh() {
  # shellcheck disable=SC2086 # HARMONY_DOCKER_HOST_SSH_OPTS is word-split on purpose
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=4 \
    ${HARMONY_DOCKER_HOST_SSH_OPTS:-} "$DH_SSH_TARGET" "$1"
}

# dh_ssh_setup <stdin-file> <remote command>: dh_ssh for the launch's IDEMPOTENT setup steps (make the
# directories, ship a per-run file, chown), retried when the CONNECTION itself fails (ssh's own exit
# 255). A freshly woken host answers SSH once and then drops connections for a few seconds while its
# network and sshd settle — seen on the B-708 proof host: the wait loop's `true` succeeded and the
# very next step timed out connecting. Any other exit status is the remote command's own and is
# returned at once. Never use this for the worker run itself: that step is not idempotent and has its
# own `docker wait` recovery.
dh_ssh_setup() {
  local stdin_file="$1" cmd="$2" attempt=0 rc
  while :; do
    rc=0
    dh_ssh "$cmd" < "$stdin_file" || rc=$?
    [ "$rc" -eq 255 ] || return "$rc"
    attempt=$((attempt + 1))
    [ "$attempt" -lt "${HARMONY_DOCKER_HOST_SETUP_RETRIES:-6}" ] || return 255
    sleep "${HARMONY_DOCKER_HOST_WAKE_POLL_S:-5}"
  done
}

# Remote layout, under the SSH user's home. These strings are expanded by the REMOTE shell ($HOME is
# the SSH user's), so they are only ever used inside double quotes in a remote command line.
# shellcheck disable=SC2016 # $HOME must reach the remote shell unexpanded
DH_REMOTE_ROOT='$HOME/.harmony-conductions'
