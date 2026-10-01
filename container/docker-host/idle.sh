#!/usr/bin/env bash
# B-708: the Docker host's idle check — installed by bootstrap.sh as
# /usr/local/bin/harmony-docker-host-idle and run every 5 minutes, as root, by
# harmony-docker-host-idle.timer.
#
# The host exists only to run workers, so it powers itself off when none has run for a while; the
# launch wrapper on the daemon's machine (container/docker-host-worker-launch.sh) wakes it again.
#
# Configured by /etc/default/harmony-docker-host:
#   HARMONY_HOST_USER   the SSH user the launch wrapper logs in as (required)
#   IDLE_MINUTES        power off after this many idle minutes            (default 30)
#   PRUNE_DAYS          drop a ticket's engine volume after this many days unused (default 7)
#   SLEEP_CMD           what "power off" means on this host               (default systemctl poweroff)
#
# Logic, in order:
#   1. A worker container (harmony-worker-*) is running -> touch the launch stamp, done.
#   2. idle minutes = the SMALLER of (minutes since the launch stamp was last touched — or since
#      boot, when there is no stamp) and (minutes of uptime). The uptime bound is what protects a
#      freshly woken host: its stamp is as old as its last launch, but it must not be powered off
#      before the launch that woke it has had time to arrive.
#   3. idle minutes < IDLE_MINUTES -> done.
#   4. Otherwise: remove every engine volume whose ticket stamp is older than PRUNE_DAYS, then run
#      SLEEP_CMD.
#
# Test seams (environment, all optional — a unit test drives this with no Docker and no systemd):
#   HARMONY_IDLE_DEFAULTS   path of the defaults file     (default /etc/default/harmony-docker-host)
#   HARMONY_IDLE_HOME       the host user's home          (default: looked up from HARMONY_HOST_USER)
#   HARMONY_IDLE_NOW        "now", epoch seconds          (default: date +%s)
#   HARMONY_IDLE_UPTIME_S   uptime in seconds             (default: /proc/uptime)
#   HARMONY_IDLE_DOCKER     the docker command            (default: docker)
#   SLEEP_CMD               already a config variable; the environment wins over the defaults file
set -euo pipefail

# Environment first, then the defaults file for anything still unset — so a test (or an operator's
# one-off run) can override any single value without editing the file.
ENV_SLEEP_CMD="${SLEEP_CMD:-}"
ENV_IDLE_MINUTES="${IDLE_MINUTES:-}"
ENV_PRUNE_DAYS="${PRUNE_DAYS:-}"
ENV_HOST_USER="${HARMONY_HOST_USER:-}"
DEFAULTS_FILE="${HARMONY_IDLE_DEFAULTS:-/etc/default/harmony-docker-host}"
if [ -f "$DEFAULTS_FILE" ]; then
  # shellcheck source=/dev/null
  . "$DEFAULTS_FILE"
fi
HARMONY_HOST_USER="${ENV_HOST_USER:-${HARMONY_HOST_USER:-}}"
IDLE_MINUTES="${ENV_IDLE_MINUTES:-${IDLE_MINUTES:-30}}"
PRUNE_DAYS="${ENV_PRUNE_DAYS:-${PRUNE_DAYS:-7}}"
SLEEP_CMD="${ENV_SLEEP_CMD:-${SLEEP_CMD:-systemctl poweroff}}"
DOCKER="${HARMONY_IDLE_DOCKER:-docker}"

log() { echo "harmony-docker-host-idle: $*"; }

USER_HOME="${HARMONY_IDLE_HOME:-}"
if [ -z "$USER_HOME" ]; then
  if [ -z "$HARMONY_HOST_USER" ]; then
    echo "harmony-docker-host-idle: HARMONY_HOST_USER is not set in $DEFAULTS_FILE — cannot find the launch stamp, doing nothing" >&2
    exit 1
  fi
  USER_HOME="$(getent passwd "$HARMONY_HOST_USER" | cut -d: -f6)"
  if [ -z "$USER_HOME" ]; then
    echo "harmony-docker-host-idle: no home directory found for user '$HARMONY_HOST_USER' — doing nothing" >&2
    exit 1
  fi
fi

ROOT="$USER_HOME/.harmony-conductions"
STAMP="$ROOT/.last-launch"
VOLUME_STAMPS="$ROOT/.engine-volumes"

NOW="${HARMONY_IDLE_NOW:-$(date +%s)}"
if [ -n "${HARMONY_IDLE_UPTIME_S:-}" ]; then
  UPTIME_S="$HARMONY_IDLE_UPTIME_S"
else
  UPTIME_S="$(cut -d. -f1 /proc/uptime)"
fi

# A file's modification time, epoch seconds (GNU stat, then the BSD spelling so the unit test also
# runs on a macOS development machine).
mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

# 1. Never while a worker is running. Each pass that sees one refreshes the stamp, so the idle
#    clock starts when the LAST worker stops, not when it started. A docker that cannot answer is
#    read as "no worker": with the engine down no container is running either, and a host whose
#    engine is broken must not stay powered on forever.
RUNNING="$($DOCKER ps --filter 'name=^harmony-worker-' --filter status=running -q 2>/dev/null || true)"
if [ -n "$RUNNING" ]; then
  mkdir -p "$ROOT"
  touch "$STAMP"
  # This runs as root; the launch wrapper touches the same file as the SSH user.
  if [ -n "$HARMONY_HOST_USER" ]; then
    chown "$HARMONY_HOST_USER" "$ROOT" "$STAMP" 2>/dev/null || true
  fi
  exit 0
fi

# 2. Idle minutes: the smaller of "since the last launch" and "since boot".
UPTIME_MIN=$((UPTIME_S / 60))
if [ -f "$STAMP" ]; then
  SINCE_LAUNCH_MIN=$(((NOW - $(mtime "$STAMP")) / 60))
else
  SINCE_LAUNCH_MIN=$UPTIME_MIN
fi
IDLE_MIN=$SINCE_LAUNCH_MIN
if [ "$UPTIME_MIN" -lt "$IDLE_MIN" ]; then
  IDLE_MIN=$UPTIME_MIN
fi

# 3.
if [ "$IDLE_MIN" -lt "$IDLE_MINUTES" ]; then
  exit 0
fi

# 4. Prune, then sleep. A volume still in use cannot be removed and is simply left (its stamp stays,
#    so the next idle pass tries again).
if [ -d "$VOLUME_STAMPS" ]; then
  for stamp in "$VOLUME_STAMPS"/*; do
    [ -f "$stamp" ] || continue
    AGE_DAYS=$(((NOW - $(mtime "$stamp")) / 86400))
    if [ "$AGE_DAYS" -ge "$PRUNE_DAYS" ]; then
      ticket="$(basename "$stamp")"
      if $DOCKER volume rm "harmony-engine-$ticket" >/dev/null 2>&1; then
        log "removed engine volume harmony-engine-$ticket (unused for $AGE_DAYS days)"
        rm -f "$stamp"
      elif ! $DOCKER volume inspect "harmony-engine-$ticket" >/dev/null 2>&1; then
        rm -f "$stamp" # the volume is already gone — drop the stale stamp
      fi
    fi
  done
fi

log "idle for $IDLE_MIN minutes (limit $IDLE_MINUTES) — running: $SLEEP_CMD"
exec bash -c "$SLEEP_CMD"
