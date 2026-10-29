#!/usr/bin/env bash
# B-1337: the Figma refresh image publish gate.
#
# ONE script, TWO callers (same discipline as container/conductor/smoke.sh): container/figma/cloudbuild.yaml runs it
# BETWEEN the build and every push, so an image that fails never gets a version tag, never moves the channel tag and
# never reaches a CronJob repin; and src/daemon/figma-refresh-image-files.test.ts pins that ordering and parses this
# file. Pre-merge, the assertions that can run without Docker (bash -n, the shape of this file) run in `npm test`.
#
# Usage: container/figma/smoke.sh <image-ref> [expected-plugin-version]
#
# DEPTH ACHIEVED (credential-free, no network to Harmony or GCP: the runner is started with --network none and no env):
#   1. the bundled runner /app/dist/figma-refresh-runner.js and /app/dist/THIRD_PARTY_NOTICES are present;
#   2. the image runs as the non-root `node` user;
#   3. the label harmony.plugin_version is present (and equals the expected version when given);
#   4. the bundle carries the library-map version 2 marker (`LIBRARY_MAP_VERSION = 2;`, B-1321), so the image
#      rebuilds version-1 maps;
#   5. the entrypoint, run with no credentials, exits non-zero AT THE AUTH GUARD (getAuthenticatedContext's
#      "No active project" refusal), proving the bundle loads and reaches its first statement.
# NOT proved: a real board read or write, a real Secret Manager or Workload Identity call, a real Figma call, a real
# cluster repin (the build's repin step reads the CronJob back after it sets the image).
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image-ref> [expected-plugin-version]}"
EXPECTED="${2:-}"

RUNNER=/app/dist/figma-refresh-runner.js

fail() { echo "smoke: FAIL — $*" >&2; exit 1; }
ok()   { echo "smoke: ok — $*"; }

echo "smoke: probing $IMAGE"

sh_in() { docker run --rm --network none --entrypoint /bin/sh "$IMAGE" -c "$1"; }

for f in "$RUNNER" /app/dist/THIRD_PARTY_NOTICES; do
  sh_in "[ -f $f ]" || fail "$f is missing"
done
ok "runner bundle and THIRD_PARTY_NOTICES present"

user="$(sh_in 'id -un')"
uid="$(sh_in 'id -u')"
[ "$uid" != "0" ] || fail "the image runs as root"
[ "$user" = "node" ] || fail "the image runs as '$user', expected 'node'"
ok "runs as the non-root user node"

label="$(docker inspect --format '{{ index .Config.Labels "harmony.plugin_version" }}' "$IMAGE")"
[ -n "$label" ] && [ "$label" != "unknown" ] && [ "$label" != "<no value>" ] || fail "label harmony.plugin_version is missing or 'unknown'"
if [ -n "$EXPECTED" ] && [ "$label" != "$EXPECTED" ]; then
  fail "label harmony.plugin_version is '$label', expected '$EXPECTED'"
fi
ok "label harmony.plugin_version=$label"

# esbuild keeps the module constant as `var LIBRARY_MAP_VERSION = 2;` (no minify in the Dockerfile's bundle command).
sh_in "grep -Fq 'LIBRARY_MAP_VERSION = 2;' $RUNNER" || fail "the bundle does not carry library-map version 2 (LIBRARY_MAP_VERSION = 2;)"
ok "bundle carries library-map version 2"

# No env, no network: the runner's first statement is getAuthenticatedContext(), which with no config file and no
# HARMONY_API_TOKEN rethrows getActiveProject's refusal before any network call.
rc=0
out="$(docker run --rm --network none "$IMAGE" 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "the runner with no credentials should fail at the auth guard, but exited 0: $out"
case "$out" in
  *"No active project. Run \`harmony login\` to add one."*"getAuthenticatedContext"*) ok "the runner loads and stops at the auth guard (exit $rc)" ;;
  *) fail "the runner with no credentials failed somewhere other than the auth guard (exit $rc): $out" ;;
esac

echo "smoke: PASS"
