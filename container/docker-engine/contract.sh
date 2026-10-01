#!/usr/bin/env bash
# B-708: the engine-layer contract, asserted against a REAL built image.
#
# Called from the end of container/toolchain-contract.sh with the same image tag
# that script receives, so CI runs it with no workflow change. Also runnable by
# hand against any worker image:
#   docker build -f container/Dockerfile --target base -t b708-base container
#   container/docker-engine/contract.sh b708-base
#
# What it proves, in order:
#   1. the engine layer BUILDS on top of the given image;
#   2. PRIVILEGED, with a volume at /var/lib/docker (the shape the Docker-host
#      launch profile runs): the non-root worker starts the engine through the
#      one sudoers rule and runs a container inside it;
#   3. NOT privileged (every other launch profile): the start script exits
#      non-zero WITH a message — the path container/provision.sh turns into a
#      warning, never a failed leg;
#   4. container/provision.sh's B-708 block is silent and creates nothing on an
#      image WITHOUT the layer (the given image itself).
set -euo pipefail

BASE_IMAGE="${1:?usage: docker-engine/contract.sh <base-image-tag>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

ENGINE_IMAGE="b708-engine-contract"
VOLUME="b708-engine-contract-$$"

step() { echo; echo "=== $* ==="; }
fail() { echo "engine contract: FAIL — $*" >&2; exit 1; }

cleanup() {
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "B-708 1. the engine layer builds on $BASE_IMAGE"
docker build -f "$HERE/Dockerfile" --build-arg "BASE=$BASE_IMAGE" -t "$ENGINE_IMAGE" "$HERE"

step "B-708 2. privileged + engine volume — the worker starts the engine and runs a container"
docker volume create "$VOLUME" >/dev/null
docker run --rm --privileged -v "$VOLUME:/var/lib/docker" --entrypoint /bin/bash "$ENGINE_IMAGE" -euo pipefail -c '
  test "$(id -un)" = "worker" || { echo "FAIL: running as $(id -un), expected worker"; exit 1; }
  sudo -n /usr/local/bin/harmony-start-dockerd
  docker run --rm hello-world >/dev/null
  docker compose version >/dev/null
  # A second call must be a no-op on the already-running engine.
  sudo -n /usr/local/bin/harmony-start-dockerd
  echo "ok: engine up as $(id -un) — $(docker --version); hello-world ran; $(docker compose version)"
' || fail "the privileged run could not start the engine and run hello-world as the worker"

step "B-708 3. NOT privileged — the start script fails with a message (the non-fatal path)"
set +e
unpriv_out="$(docker run --rm --entrypoint /bin/bash "$ENGINE_IMAGE" -c \
  'sudo -n /usr/local/bin/harmony-start-dockerd' 2>&1)"
unpriv_exit=$?
set -e
[ "$unpriv_exit" -ne 0 ] \
  || fail "the start script exited 0 in an unprivileged container; output: $unpriv_out"
case "$unpriv_out" in
  *harmony-start-dockerd:*) echo "ok: exited $unpriv_exit with: $(printf '%s\n' "$unpriv_out" | grep -m1 'harmony-start-dockerd:')" ;;
  *) fail "the unprivileged failure carried no harmony-start-dockerd message; got: $unpriv_out" ;;
esac

step "B-708 4. provision.sh's block is inert on an image without the layer"
# The block is cut out of the real provision.sh between its own markers and run
# on its own, in the image that has no start script.
docker run --rm -v "$REPO_ROOT:/plugin:ro" --entrypoint /bin/bash "$BASE_IMAGE" -euo pipefail -c '
  awk "/^# --- B-708: /{on=1} /^# --- end B-708 /{on=0} on" /plugin/container/provision.sh > /tmp/b708-block.sh
  test -s /tmp/b708-block.sh || { echo "FAIL: could not extract the B-708 block from provision.sh"; exit 1; }
  test ! -e /usr/local/bin/harmony-start-dockerd || { echo "FAIL: this image already carries the start script"; exit 1; }
  before="$(ls -A "$HOME" /var/log | sort)"
  out="$(bash -euo pipefail /tmp/b708-block.sh 2>&1)"
  test -z "$out" || { echo "FAIL: the block printed on an image without the layer: $out"; exit 1; }
  test "$(ls -A "$HOME" /var/log | sort)" = "$before" || { echo "FAIL: the block created a file"; exit 1; }
  echo "ok: no output, nothing created"
' || fail "provision.sh's B-708 block is not inert without the start script"

echo
echo "=== engine contract: PASS ==="
