#!/usr/bin/env bash
# B-1173: the remote-conductor image publish gate.
#
# ONE script, TWO callers (same discipline as container/smoke.sh): container/conductor/cloudbuild.yaml runs it
# BETWEEN the build and every push, so an image that fails never gets a version tag and never moves the channel
# tag; and src/daemon/conductor-image-files.test.ts pins that ordering and parses this file. Pre-merge, the
# assertions that can run without Docker (bash -n, the shape of this file) run in `npm test`.
#
# Usage: container/conductor/smoke.sh <image-ref> [expected-plugin-version]
#
# DEPTH ACHIEVED (credential-free, no network, no cluster):
#   1. gcloud, kubectl, jq, node, bash resolve for the image's default (non-root) user;
#   2. the entrypoint, the CLI wrapper, daemon.js and conductor-boot.js are present;
#   3. `harmony --version` runs (the bundle loads and the CLI parses);
#   4. the label harmony.plugin_version is present (and equals the expected version when given);
#   5. a host file loads: conductor-boot check-host against the baked conductor.host.example.json;
#   6. the leg-launch helpers are present and the token mint loads (prints its usage);
#   7. the entrypoint dispatches: a plain command runs, and `--with-secrets` in remote mode with NO host file
#      fails at the resolver's own guard (proving the resolver executes) without touching the network.
# NOT proved: a real Secret Manager read, a real cluster, a real rollout.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image-ref> [expected-plugin-version]}"
EXPECTED="${2:-}"

fail() { echo "smoke: FAIL — $*" >&2; exit 1; }
ok()   { echo "smoke: ok — $*"; }

echo "smoke: probing $IMAGE"

sh_in() { docker run --rm --entrypoint /bin/sh "$IMAGE" -c "$1"; }

for bin in gcloud kubectl jq node bash harmony; do
  sh_in "command -v $bin >/dev/null" || fail "$bin is not on PATH for the image's default user"
done
ok "tools present: gcloud kubectl jq node bash harmony"

[ "$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'id -u')" != "0" ] || fail "the image runs as root"
ok "runs as a non-root user"

for f in /opt/harmony-plugin/container/conductor/entrypoint.sh /usr/local/bin/harmony; do
  sh_in "[ -x $f ]" || fail "$f is missing or not executable"
done
for f in /opt/harmony-plugin/dist/bin/daemon.js /opt/harmony-plugin/dist/bin/harmony.js /opt/harmony-plugin/dist/bin/conductor-boot.js \
  /opt/harmony-plugin/container/conductor.host.example.json /opt/harmony-plugin/container/gke/sweep-ticket-disks.sh; do
  sh_in "[ -f $f ]" || fail "$f is missing (was the image built from a branch that carries dist/?)"
done
ok "entrypoint, CLI wrapper, daemon.js, conductor-boot.js and the sweep script present"

# Every leg launch runs the token mint before it creates a Job, so an image without it launches nothing (0.15.88).
# Run with no arguments it prints its usage and exits non-zero without a key or the network: proof it loads.
for f in /opt/harmony-plugin/scripts/mint-installation-token.mjs /opt/harmony-plugin/scripts/resume-discovery.mjs; do
  sh_in "[ -f $f ]" || fail "$f is missing: leg launches call it"
done
out="$(docker run --rm --entrypoint node "$IMAGE" /opt/harmony-plugin/scripts/mint-installation-token.mjs 2>&1)" || true
case "$out" in *"Usage: mint-installation-token.mjs"*) ok "the token mint loads" ;; *) fail "the token mint did not load: $out" ;; esac

version_out="$(docker run --rm --entrypoint harmony "$IMAGE" --version 2>&1)" || fail "harmony --version did not run: $version_out"
[ -n "$version_out" ] || fail "harmony --version printed nothing"
ok "harmony --version: $version_out"

label="$(docker inspect --format '{{ index .Config.Labels "harmony.plugin_version" }}' "$IMAGE")"
[ -n "$label" ] && [ "$label" != "unknown" ] || fail "label harmony.plugin_version is missing or 'unknown'"
if [ -n "$EXPECTED" ] && [ "$label" != "$EXPECTED" ]; then
  fail "label harmony.plugin_version is '$label', expected '$EXPECTED'"
fi
ok "label harmony.plugin_version=$label"

out="$(docker run --rm --entrypoint node "$IMAGE" /opt/harmony-plugin/dist/bin/conductor-boot.js check-host /opt/harmony-plugin/container/conductor.host.example.json 2>&1)" \
  || fail "the example host file did not load: $out"
case "$out" in *"host file ok"*) ok "host file loads: $out" ;; *) fail "unexpected check-host output: $out" ;; esac

out="$(docker run --rm "$IMAGE" echo entrypoint-dispatch-ok 2>&1)" || fail "the entrypoint did not run a plain command: $out"
[ "$out" = "entrypoint-dispatch-ok" ] || fail "entrypoint dispatch printed '$out'"
ok "entrypoint runs a plain command"

rc=0
out="$(docker run --rm -e HARMONY_CONDUCTOR_REMOTE=1 -e HARMONY_HOME=/nonexistent "$IMAGE" --with-secrets true 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "--with-secrets in remote mode with no host file should fail, but succeeded"
case "$out" in *"host file"*) ok "--with-secrets reached the secrets resolver's host-file guard" ;; *) fail "--with-secrets failed somewhere else: $out" ;; esac

echo "smoke: PASS"
