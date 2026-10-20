#!/usr/bin/env bash
# B-1184: put ONE cloned repo's Playwright chromium into the Playwright cache, once per ticket disk.
#
# Called once per cloned repo by container/provision.sh, after the toolchain activation and before the
# hand-off. On a GKE leg /home/worker/.cache/ms-playwright is the ticket disk's `playwright` subPath
# (B-1162, gke-render-leg.mjs), so a browser installed by the first leg is found by every later leg of
# the ticket. The browsers are deliberately NOT baked into the image (size, and version coupling to
# every repo).
#
# STRICTLY CONDITIONAL: a repo whose package.json declares neither `@playwright/test` nor `playwright`
# is left alone. The Playwright version is read from the repo (installed node_modules first, then
# package-lock.json), because provisioning runs before the leg's own `npm ci`. A repo with no resolvable
# version is skipped with a note rather than guessing "latest", which would install a browser build the
# repo's tests cannot launch.
#
# Idempotent: a marker file in the cache, keyed by the Playwright version, records a successful install,
# so a second leg does no network work. No `--with-deps`: the image already carries the system deps.
#
# NON-FATAL by contract: any failure warns on stderr and exits 0 — a browser convenience must never be
# able to fail a leg.
#
# Usage: container/install-playwright.sh <repo-path>
set -uo pipefail

REPO_DIR="${1:?usage: install-playwright.sh <repo-path>}"
PKG="$REPO_DIR/package.json"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

warn() { echo "install-playwright: WARNING — $* (continuing; the leg is not affected)" >&2; }

[ -f "$PKG" ] || exit 0
jq -e '[.dependencies, .devDependencies] | map(. // {}) | add | (has("@playwright/test") or has("playwright"))' "$PKG" >/dev/null 2>&1 || exit 0

VERSION=""
for f in "$REPO_DIR/node_modules/playwright-core/package.json" "$REPO_DIR/node_modules/@playwright/test/package.json"; do
  [ -f "$f" ] && VERSION="$(jq -r '.version // empty' "$f" 2>/dev/null)" && [ -n "$VERSION" ] && break
done
if [ -z "$VERSION" ] && [ -f "$REPO_DIR/package-lock.json" ]; then
  VERSION="$(jq -r '.packages["node_modules/playwright-core"].version // .packages["node_modules/playwright"].version // .packages["node_modules/@playwright/test"].version // empty' "$REPO_DIR/package-lock.json" 2>/dev/null)"
fi
if [ -z "$VERSION" ]; then
  warn "$REPO_DIR declares Playwright but its version could not be resolved; no browser installed"
  exit 0
fi

MARKER="$PLAYWRIGHT_BROWSERS_PATH/.harmony-chromium-$VERSION"
if [ -f "$MARKER" ]; then
  echo "install-playwright: chromium for Playwright $VERSION already cached — nothing to install"
  exit 0
fi

mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null || { warn "cannot create $PLAYWRIGHT_BROWSERS_PATH"; exit 0; }
echo "install-playwright: installing chromium for Playwright $VERSION into $PLAYWRIGHT_BROWSERS_PATH"
if (cd "$REPO_DIR" && npx --yes "playwright@$VERSION" install chromium); then
  : > "$MARKER" 2>/dev/null || warn "installed, but could not write the cache marker (the next leg will re-check)"
else
  warn "'playwright install chromium' failed for $REPO_DIR"
fi
exit 0
