#!/usr/bin/env bash
# B-1162: the Docker-capable worker image smoke gate.
#
# Called by container/docker-engine/contract.sh (PR CI, against the image it builds) and by
# container/cloudbuild.yaml's smoke-docker step (before the image is published).
#
# Usage: container/docker-engine/smoke.sh <image-ref>
#
# Asserts:
#   (a) the default user is uid 1001 / worker;
#   (b) PRIVILEGED with a throwaway /var/lib/docker volume: the worker starts the engine through
#       the sudoers rule, `docker info` works and `docker run hello-world` runs;
#   (c) PLAYWRIGHT_BROWSERS_PATH is /home/worker/.cache/ms-playwright, exists, worker-writable;
#   (d) the harmony.claude_code_version label, when present, is non-empty (absent on the agent-less
#       base target the PR CI builds: skipped with a message);
#   (e) Chromium. Default: as the worker, download Chromium with Playwright into a temp browsers
#       path and launch it headless; must exit 0 (a missing shared library fails it).
#       SMOKE_CHROMIUM=lib-check: the cheap check instead. `npx -y playwright install-deps
#       --dry-run chromium` prints the apt command Playwright would run; every package named on
#       that command line must already be INSTALLED per dpkg-query (i.e. nothing left to install),
#       and at least one package must have been found on the line.
set -euo pipefail

IMAGE="${1:?usage: docker-engine/smoke.sh <image-ref>}"

fail() { echo "engine smoke: FAIL — $*" >&2; exit 1; }
ok()   { echo "engine smoke: ok — $*"; }

VOLUME="b1162-smoke-$$"
cleanup() {
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "engine smoke: probing $IMAGE"

# --- (a) default user ---------------------------------------------------------
uid="$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'id -u')" || fail "could not run id -u"
name="$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'id -un')" || fail "could not run id -un"
[ "$uid" = 1001 ] || fail "default uid is $uid, expected 1001"
[ "$name" = worker ] || fail "default user is $name, expected worker"
ok "default user is worker (uid 1001)"

# --- (b) engine, privileged ---------------------------------------------------
docker volume create "$VOLUME" >/dev/null
docker run --rm --privileged -v "$VOLUME:/var/lib/docker" --entrypoint /bin/bash "$IMAGE" -euo pipefail -c '
  test "$(id -u)" = 1001 || { echo "FAIL: running as uid $(id -u), expected 1001"; exit 1; }
  sudo -n /usr/local/bin/harmony-start-dockerd
  docker info >/dev/null
  docker run --rm hello-world >/dev/null
  echo "ok: engine started by uid 1001; docker info works; hello-world ran"
' || fail "the privileged run could not start the engine, run docker info and run hello-world"
ok "engine starts as the worker; docker info and hello-world work"

# --- (c) Playwright browsers path ---------------------------------------------
docker run --rm --entrypoint /bin/bash "$IMAGE" -euo pipefail -c '
  test "${PLAYWRIGHT_BROWSERS_PATH:-}" = /home/worker/.cache/ms-playwright \
    || { echo "FAIL: PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-<unset>}"; exit 1; }
  test -d "$PLAYWRIGHT_BROWSERS_PATH" || { echo "FAIL: $PLAYWRIGHT_BROWSERS_PATH does not exist"; exit 1; }
  test -w "$PLAYWRIGHT_BROWSERS_PATH" || { echo "FAIL: $PLAYWRIGHT_BROWSERS_PATH is not writable by the worker"; exit 1; }
  touch "$PLAYWRIGHT_BROWSERS_PATH/.smoke" && rm -f "$PLAYWRIGHT_BROWSERS_PATH/.smoke"
' || fail "PLAYWRIGHT_BROWSERS_PATH is not /home/worker/.cache/ms-playwright, or it is missing / not worker-writable"
ok "PLAYWRIGHT_BROWSERS_PATH set; directory exists and is worker-writable"

# --- (d) labels ---------------------------------------------------------------
label_present="$(docker inspect --format '{{ range $k, $v := .Config.Labels }}{{ if eq $k "harmony.claude_code_version" }}present{{ end }}{{ end }}' "$IMAGE")" \
  || fail "docker inspect failed"
if [ "$label_present" = present ]; then
  label_value="$(docker inspect --format '{{ index .Config.Labels "harmony.claude_code_version" }}' "$IMAGE")"
  [ -n "$label_value" ] || fail "label harmony.claude_code_version is present but empty"
  ok "label harmony.claude_code_version=$label_value"
else
  ok "no agent layer in this image (the base target) — harmony.claude_code_version label check skipped"
fi

# --- (e) Chromium -------------------------------------------------------------
if [ "${SMOKE_CHROMIUM:-}" = lib-check ]; then
  docker run --rm --entrypoint /bin/bash "$IMAGE" -euo pipefail -c '
    out="$(npx -y playwright install-deps --dry-run chromium 2>&1)" \
      || { echo "FAIL: playwright install-deps --dry-run failed: $out"; exit 1; }
    line="$(printf "%s\n" "$out" | grep -m1 -e "--no-install-recommends" || true)"
    test -n "$line" || { echo "FAIL: no apt command in the dry-run output: $out"; exit 1; }
    pkgs=""
    seen=0
    for tok in ${line#*--no-install-recommends}; do
      tok="${tok%\"}"
      case "$tok" in
        [a-z0-9]*) ;;
        *) continue ;;
      esac
      case "$tok" in *[!a-z0-9.+-]*) continue ;; esac
      seen=$((seen + 1))
      st="$(dpkg-query -W -f "\${Status}" "$tok" 2>/dev/null || true)"
      case "$st" in
        "install ok installed") ;;
        *) pkgs="$pkgs $tok" ;;
      esac
    done
    test "$seen" -gt 0 || { echo "FAIL: found no package names in: $line"; exit 1; }
    test -z "$pkgs" || { echo "FAIL: Chromium libraries not installed:$pkgs"; exit 1; }
    echo "ok: all $seen packages Playwright lists for chromium are installed"
  ' || fail "Chromium system libraries are not all installed (lib-check)"
  ok "Chromium libraries present (lib-check: dry-run package list all installed per dpkg)"
else
  # The launch script travels in an environment variable, never a bind mount: in Cloud Build this
  # script runs inside a step container that talks to the HOST's docker daemon, so a host path
  # created here would not exist where the daemon looks for it.
  LAUNCH_JS="$(cat <<'JS'
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('about:blank');
  await page.setContent('<p id="x">ok</p>');
  const text = await page.textContent('#x');
  await browser.close();
  if (text !== 'ok') { console.error('unexpected page text: ' + text); process.exit(1); }
  console.log('chromium launched headless and rendered a page');
})().catch((e) => { console.error(String(e)); process.exit(1); });
JS
)"
  export LAUNCH_JS
  out="$(docker run --rm -e LAUNCH_JS --entrypoint /bin/bash "$IMAGE" -euo pipefail -c '
    work="$(mktemp -d)"
    export PLAYWRIGHT_BROWSERS_PATH="$work/browsers"
    cd "$work"
    npm init -y >/dev/null
    npm i playwright >/dev/null
    npx -y playwright install chromium
    printf "%s\n" "$LAUNCH_JS" > launch.js
    node ./launch.js
  ' 2>&1)" || fail "Chromium did not install and launch as the worker; output: $out"
  case "$out" in
    *"error while loading shared libraries"*) fail "Chromium reported a missing shared library; output: $out" ;;
  esac
  ok "Chromium downloaded and launched headless as the worker"
fi

echo "engine smoke: PASS — $IMAGE"
