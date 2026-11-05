#!/usr/bin/env bash
# Credential-free pinned-runtime probe shared by BOTH image publication gates.
# Stream the script over stdin: Cloud Build's Docker daemon cannot see step-local
# bind mount paths. Every run has a fresh container/home and no credential mounts.
set -euo pipefail

IMAGE="${1:?usage: pinned-node-smoke.sh <image-ref>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "pinned-node smoke: probing $IMAGE"
tar -C "$SCRIPT_DIR" -cf - activate-toolchain.sh | docker run --rm -i --entrypoint /bin/bash "$IMAGE" -euo pipefail -c '
  work="$(mktemp -d)"
  trap '\''rm -rf "$work"'\'' EXIT
  tar -xf - -C "$work"
  mkdir "$work/repo"
  printf "26\n" > "$work/repo/.nvmrc"
  eval "$(fnm env --shell bash)"
  # Retry ONLY the network/install preparation, never the activation/execution
  # assertion. A CDN outage is still a failed publication after three attempts.
  installed=0
  for attempt in 1 2 3; do
    if fnm install 26; then installed=1; break; fi
    echo "pinned-node smoke: DOWNLOAD attempt $attempt/3 failed" >&2
    if [ "$attempt" -lt 3 ]; then sleep 2; fi
  done
  if [ "$installed" -ne 1 ]; then
    echo "pinned-node smoke: DOWNLOAD FAILED after 3 attempts; image rejected" >&2
    exit 1
  fi
  if ! bash "$work/activate-toolchain.sh" "$work/repo"; then
    echo "pinned-node smoke: ACTIVATION FAILED; image rejected" >&2
    exit 1
  fi
  # A separate shell must inherit the committed selection, not the probe shell.
  bash -euo pipefail -c '\''
    . "$HOME/.harmony-toolchain.sh"
    expected="$(fnm current)"
    if ! actual="$(node --version 2>&1)"; then
      echo "pinned-node smoke: EXECUTION FAILED: $actual" >&2; exit 1
    fi
    case "$actual" in v26.*) ;; *) echo "pinned-node smoke: VERSION FAILED: $actual" >&2; exit 1 ;; esac
    [ "$actual" = "$expected" ] || { echo "pinned-node smoke: VERSION FAILED: $actual != $expected" >&2; exit 1; }
    echo "pinned-node smoke: PASS — pinned Node $actual runs in a later shell"
  '\''
'
