#!/bin/sh
# B-708: start the Docker engine INSIDE a worker container (Docker-in-Docker).
#
# Baked into the engine layer (container/docker-engine/Dockerfile) as
# /usr/local/bin/harmony-start-dockerd and run as root by the non-root worker
# through the image's single sudoers rule:
#   sudo -n /usr/local/bin/harmony-start-dockerd
# container/provision.sh calls it once per leg, non-fatally.
#
# Exit 0 = `docker info` answers (the engine was already up, or came up here). When it came up
#          here, the previous leg's containers, volumes and networks are removed first; images
#          and the build cache are kept.
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

# A leg starts from a CLEAN runtime. The engine volume outlives the leg so that pulled images and
# build layers are reused (a warm stack start is seconds, a cold one minutes) — but the previous
# leg's containers, networks and data volumes are NOT this leg's: a container with a restart policy
# comes straight back up when the engine starts, holding its ports and its old data, and binds its
# mounts into a checkout that is no longer the one it was started from. Seen on the B-708 proof
# host: a second leg on the same engine volume found the first leg's ten Supabase containers
# already running. So, only when THIS call started the engine: remove every container, then every
# volume and unused network. Images and the build cache are untouched.
clean_runtime() {
  ids="$(docker ps -aq 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086 # one id per word, on purpose
    docker rm -f $ids >/dev/null 2>&1 || true
  fi
  docker volume prune -af >/dev/null 2>&1 || true
  docker network prune -f >/dev/null 2>&1 || true
}

waited=0
while [ "$waited" -lt "$WAIT_S" ]; do
  if docker info >/dev/null 2>&1; then
    clean_runtime
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
