#!/usr/bin/env bash
# B-708: one-time setup of the Docker host — the remote Linux machine the "docker-host" launch
# profile runs workers on. Run it ON THE HOST, from a checkout of this repo, as the user the daemon's
# machine will SSH in as (a sudo-capable user; do not run it as root):
#
#   bash container/docker-host/bootstrap.sh
#
# What it does (Debian or Ubuntu; safe to run again):
#   1. installs Docker Engine from Docker's apt repository;
#   2. adds the invoking user to the `docker` group;
#   3. installs the idle check (idle.sh -> /usr/local/bin/harmony-docker-host-idle) with its
#      systemd service + timer, and writes /etc/default/harmony-docker-host if it is not there yet;
#   4. prints the next steps (building the two worker images on this host).
#
# What it does NOT do: it puts no credential on the host. Nothing long-lived belongs here — see
# container/README.md "Docker-host launch profile" for why.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_USER="$(id -un)"

if [ "$(id -u)" -eq 0 ]; then
  echo "bootstrap: run this as the SSH user the daemon's machine will log in as, not as root (it uses sudo where it needs to)." >&2
  exit 1
fi

if [ ! -r /etc/os-release ]; then
  echo "bootstrap: /etc/os-release not found — this script supports Debian and Ubuntu only." >&2
  exit 1
fi
# shellcheck source=/dev/null
. /etc/os-release
case "${ID:-}" in
  debian | ubuntu) ;;
  *)
    echo "bootstrap: unsupported distribution '${ID:-unknown}' — this script supports Debian and Ubuntu only." >&2
    exit 1
    ;;
esac

step() { echo; echo "=== $* ==="; }

step "1. Docker Engine (from Docker's apt repository for $ID ${VERSION_CODENAME:-})"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "already installed: $(docker --version)"
else
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
fi
sudo systemctl enable --now docker

step "2. $HOST_USER in the docker group"
if id -nG "$HOST_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "already a member"
else
  sudo usermod -aG docker "$HOST_USER"
  echo "added — takes effect on the NEXT login (new SSH sessions, which is all the launch wrapper uses)"
fi

step "3. The idle check (powers this host off when no worker has run for a while)"
sudo install -m 0755 "$HERE/idle.sh" /usr/local/bin/harmony-docker-host-idle
sudo install -m 0644 "$HERE/harmony-docker-host-idle.service" /etc/systemd/system/harmony-docker-host-idle.service
sudo install -m 0644 "$HERE/harmony-docker-host-idle.timer" /etc/systemd/system/harmony-docker-host-idle.timer
if [ -f /etc/default/harmony-docker-host ]; then
  echo "/etc/default/harmony-docker-host already exists — left as it is"
else
  printf '%s\n' \
    "# B-708: settings for /usr/local/bin/harmony-docker-host-idle (container/docker-host/idle.sh)." \
    "HARMONY_HOST_USER=$HOST_USER" \
    "IDLE_MINUTES=30" \
    "PRUNE_DAYS=7" \
    "SLEEP_CMD=\"systemctl poweroff\"" \
    | sudo tee /etc/default/harmony-docker-host >/dev/null
  echo "wrote /etc/default/harmony-docker-host (HARMONY_HOST_USER=$HOST_USER, IDLE_MINUTES=30, PRUNE_DAYS=7)"
fi
sudo systemctl daemon-reload
sudo systemctl enable --now harmony-docker-host-idle.timer

step "Done. Next steps"
cat <<'NEXT'
Log out and back in (so the docker group applies), then from a checkout of harmony-plugin
on THIS host build the two images the profile runs:

  docker build -f container/Dockerfile --target agent -t harmony-build-env container
  docker build -f container/docker-engine/Dockerfile --build-arg BASE=harmony-build-env \
    -t harmony-build-env-docker container/docker-engine

Then, on the DAEMON'S machine, set worker_image to harmony-build-env-docker and add the
docker-host profile to the deployment config — container/README.md, "Docker-host launch
profile (B-708)".

This host powers itself off after IDLE_MINUTES without a running worker
(/etc/default/harmony-docker-host). While you are setting it up, stop the timer so it does
not power off under you:
  sudo systemctl stop harmony-docker-host-idle.timer     # and `start` it again when done
NEXT
