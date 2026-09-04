#!/usr/bin/env bash
# B-929: the toolchain contract, asserted against a REAL built worker image.
#
# Invoked by .github/workflows/ci.yml's `container-base` job (which already built the base target
# and asserted it is agent-free) — the workflow stays a thin caller and everything substantive lives
# HERE, committed, so the assertion depth is reviewable in the repo rather than buried in YAML.
#
# Run from the repo root, with `docker` available and $1 naming an ALREADY-BUILT image:
#   container/toolchain-contract.sh <image-tag>
#
# What it proves, in order:
#   1. AC2 INERTNESS — a fixture repo declaring NO pin still lands on the image's Node 22, creates
#      no persistence file, and downloads nothing. This is the shape of all three of Harmony's own
#      repos, so this is the assertion that says "shipping B-929 changed nothing for us".
#   2. AC1 HONOUR — a fixture declaring .nvmrc 24.14.1 AND packageManager pnpm@11.21.0 lands on
#      node v24.14.1 and pnpm 11.21.0, and `pnpm install --frozen-lockfile` completes.
#   3. The engines.node-only path resolves too (no .nvmrc anywhere).
#   4. The publish SMOKE (container/smoke.sh) — the exact script container/cloudbuild.yaml's publish
#      gate runs, so its depth is settled here, pre-merge, not only on a real Cloud Build run.
#   5. AC4 — an image BUILT FROM the requirements-list generator's output carries every declared
#      binary and still dispatches through the entrypoint.
set -euo pipefail

IMAGE="${1:?usage: toolchain-contract.sh <image-tag>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() { echo; echo "=== $* ==="; }

# The fixtures are COPIED out of the read-only mount into the container's own /tmp before use: the
# activation writes nothing into a repo, but `pnpm install` does, and a container-side uid must
# never write into the runner's checkout.
run_in_image() {
  docker run --rm -v "$REPO_ROOT:/plugin:ro" --entrypoint /bin/bash "$IMAGE" -euo pipefail -c "$1"
}

step "1. AC2 inertness — a repo declaring no pin is left completely alone"
run_in_image '
  cp -r /plugin/container/ci-fixtures/no-pins /tmp/fixture
  /plugin/container/activate-toolchain.sh /tmp/fixture

  test "$(node --version | cut -d. -f1)" = "v22" \
    || { echo "FAIL: node is $(node --version), expected the image default v22.x"; exit 1; }
  test ! -e "$HOME/.harmony-toolchain.sh" \
    || { echo "FAIL: the persistence file was created for a repo that declared nothing"; exit 1; }
  test -z "$(ls -A "${FNM_DIR:-$HOME/.fnm}" 2>/dev/null || true)" \
    || { echo "FAIL: fnm downloaded something for a repo that declared nothing"; exit 1; }
  if grep -q harmony-toolchain "$HOME/.bashrc" 2>/dev/null; then
    echo "FAIL: ~/.bashrc was edited for a repo that declared nothing"; exit 1
  fi

  # And a brand-new login shell is still the untouched image default.
  test "$(bash -lc "node --version" | cut -d. -f1)" = "v22" \
    || { echo "FAIL: a fresh login shell is not on the image default Node"; exit 1; }
  echo "ok: inert — node $(node --version), nothing persisted, nothing downloaded"
'

step "2. AC1 honour — .nvmrc 24.14.1 + packageManager pnpm@11.21.0"
run_in_image '
  cp -r /plugin/container/ci-fixtures/pinned /tmp/fixture
  /plugin/container/activate-toolchain.sh /tmp/fixture

  cd /tmp/fixture
  # A FRESH shell, loading only what the activation persisted — what the leg agent itself gets.
  bash -lc "
    set -euo pipefail
    cd /tmp/fixture
    test \"\$(node --version)\" = \"v24.14.1\" || { echo \"FAIL: node is \$(node --version), expected v24.14.1\"; exit 1; }
    test \"\$(pnpm --version)\" = \"11.21.0\" || { echo \"FAIL: pnpm is \$(pnpm --version), expected 11.21.0\"; exit 1; }
    # No hand-written lockfile is committed (see container/ci-fixtures/README.md): generate one with
    # the pinned pnpm itself, THEN prove the frozen install path completes against it.
    pnpm install --lockfile-only
    pnpm install --frozen-lockfile
    echo \"ok: node \$(node --version), pnpm \$(pnpm --version), frozen install completed\"
  "
'

step "3. engines.node-only — no .nvmrc anywhere"
run_in_image '
  cp -r /plugin/container/ci-fixtures/engines-only /tmp/fixture
  if [ -e /tmp/fixture/.nvmrc ] || [ -e /tmp/fixture/.node-version ]; then
    echo "FAIL: the engines-only fixture is not engines-only any more"; exit 1
  fi
  /plugin/container/activate-toolchain.sh /tmp/fixture
  bash -lc "
    test \"\$(node --version)\" = \"v24.14.1\" || { echo \"FAIL: node is \$(node --version), expected v24.14.1 from engines.node\"; exit 1; }
    echo \"ok: engines.node resolved to \$(node --version)\"
  "
'

step "4. The publish smoke — the SAME script the Cloud Build publish gate runs"
container/smoke.sh "$IMAGE"

step "5. AC4 — an image generated from a requirements LIST (no hand-written Dockerfile)"
GEN_DIR="$(mktemp -d)"
trap 'rm -rf "$GEN_DIR"' EXIT
node dist/bin/worker-image.js \
  --requirements container/worker-image/requirements.example.json \
  --base "$IMAGE" \
  --out "$GEN_DIR/Dockerfile"
echo "--- generated Dockerfile ---"
cat "$GEN_DIR/Dockerfile"
echo "----------------------------"
# The generated file ends in a `command -v` per declared bin, so this build FAILS on an unresolved
# requirement — that is the assertion, not a side effect of it.
docker build -f "$GEN_DIR/Dockerfile" -t b929-generated "$GEN_DIR"

# Re-assert at RUNTIME as well: build-time presence and what the worker actually resolves on PATH
# are different claims.
for bin in $(node -e '
  const fs = require("node:fs");
  const list = JSON.parse(fs.readFileSync("container/worker-image/requirements.example.json", "utf8"));
  console.log(list.map((r) => r.bin).join(" "));
'); do
  docker run --rm --entrypoint /bin/sh b929-generated -c "command -v $bin >/dev/null" \
    || { echo "FAIL: generated image is missing declared bin $bin"; exit 1; }
  echo "ok: generated image resolves $bin"
done

# …and the generated image is still a WORKER image: same entrypoint dispatch, same base toolchain.
container/smoke.sh b929-generated

echo
echo "=== toolchain contract: PASS ==="
