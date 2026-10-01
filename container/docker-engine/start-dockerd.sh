#!/bin/sh
# B-708: start the Docker engine INSIDE a worker container (Docker-in-Docker).
#
# Baked into the engine layer (container/docker-engine/Dockerfile) as
# /usr/local/bin/harmony-start-dockerd and run as root by the non-root worker
# through the image's single sudoers rule:
#   sudo -n /usr/local/bin/harmony-start-dockerd
# container/provision.sh calls it once per leg, non-fatally.
#
# Exit 0 = `docker info` answers (the engine was already up, or came up here).
# Exit 1 = it did not, with a one-line reason and the tail of the engine's log on
#          stderr. The usual cause is a container that was not run --privileged.
#
# Takes no arguments and reads no environment — the sudoers rule grants exactly
# this path, so nothing the worker controls may steer what runs as root.
set -eu

LOG=/var/log/dockerd.log
WAIT_S=60

if docker info >/dev/null 2>&1; then
  exit 0
fi

# nohup + a closed stdin: the engine must outlive this script (and the sudo
# session that ran it) for the rest of the leg.
nohup dockerd </dev/null >"$LOG" 2>&1 &
DOCKERD_PID=$!

waited=0
while [ "$waited" -lt "$WAIT_S" ]; do
  if docker info >/dev/null 2>&1; then
    exit 0
  fi
  # An engine that already exited (the unprivileged case fails in about a
  # second) will never answer — stop waiting for it.
  if ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
    echo "harmony-start-dockerd: dockerd exited before the engine came up (is this container running --privileged?)" >&2
    tail -n 20 "$LOG" >&2 || true
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

echo "harmony-start-dockerd: the engine did not answer \`docker info\` within ${WAIT_S}s" >&2
tail -n 20 "$LOG" >&2 || true
exit 1
