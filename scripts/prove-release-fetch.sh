#!/usr/bin/env bash
# scripts/prove-release-fetch.sh — B-1478: prove the worker image's baked entrypoint takes the plugin from the
# released download, and falls back to the clone, in the REAL image.
#
# Usage:
#   scripts/prove-release-fetch.sh [--image <tag>] [--no-build] [--port <port>]
#
# Builds the agent-neutral `base` target of container/Dockerfile (unless --no-build), then:
#   1. makes a FIXTURE plugin git repo in a temp dir (.claude-plugin/plugin.json, dist/index.js,
#      container/release-runtime and a stub container/provision.sh that prints what it received and exits 0),
#      with a prod branch (2.0.1), a staging branch (2.0.2) and a branch whose tree lacks the marker (2.0.3);
#   2. builds releases from it with scripts/build-release.mjs and serves them over HTTPS on 127.0.0.1 from a
#      throwaway self-signed CA, behind a bearer check (a wrong token gets 401), at
#      https://127.0.0.1:<port>/functions/v1/plugin-download/<channel>/...;
#   3. runs the image's entrypoint once per case with --network host, the CA mounted and named by CURL_CA_BUNDLE,
#      and HARMONY_REPOS_JSON naming file:// bare repos (a meta repo and the fixture plugin) so the clone fallback
#      works offline.
# Prints one PASS or FAIL line per case, then the server's request log. Exits 1 if any case failed.
# Needs docker, node, git, openssl and base64 on the host. Not run in CI. Removes its temp dir on exit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="harmony-build-env:b1478-proof"
BUILD=1
PORT=8478
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "prove-release-fetch: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
for tool in docker node git openssl base64; do
  command -v "$tool" >/dev/null 2>&1 || { echo "prove-release-fetch: $tool is required" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/b1478-proof.XXXXXX")"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
chmod 755 "$WORK"

TOKEN="hmy_proof_$(openssl rand -hex 12)"
BASE_PATH="/functions/v1/plugin-download"
BASE_URL="https://127.0.0.1:$PORT$BASE_PATH"

if [ "$BUILD" = "1" ]; then
  echo "== building the base target of container/Dockerfile as $IMAGE"
  docker build -q --target base -t "$IMAGE" "$REPO_ROOT/container" >/dev/null
fi
echo "== image: $IMAGE ($(docker image inspect --format '{{.Id}}' "$IMAGE"))"
echo "== baked entrypoint sha256: $(docker run --rm --entrypoint sha256sum "$IMAGE" /usr/local/bin/harmony-entrypoint.sh | cut -d' ' -f1)"
echo "== container/entrypoint.sh sha256: $(sha256sum "$REPO_ROOT/container/entrypoint.sh" | cut -d' ' -f1)"

# --- TLS: a throwaway CA-less self-signed certificate for 127.0.0.1 -------------------------------------------
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/ca.pem" -days 1 \
  -subj /CN=localhost -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' >/dev/null 2>&1
chmod 644 "$WORK/ca.pem"

# --- The fixture plugin repository -----------------------------------------------------------------------------
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
FIX="$WORK/fixture"
SRC="$FIX/src"
mkdir -p "$SRC"
git init -q -b prod "$SRC"
write_tree() { # $1 = version, $2 = marker (1|0)
  mkdir -p "$SRC/.claude-plugin" "$SRC/dist/bin" "$SRC/container"
  printf '{\n  "name": "harmony-plugin",\n  "version": "%s"\n}\n' "$1" >"$SRC/.claude-plugin/plugin.json"
  echo '// fixture bundle' >"$SRC/dist/index.js"
  echo '// fixture cli' >"$SRC/dist/bin/harmony.js"
  if [ "$2" = "1" ]; then echo '# fixture marker' >"$SRC/container/release-runtime"; else rm -f "$SRC/container/release-runtime"; fi
  cat >"$SRC/container/provision.sh" <<'STUB'
#!/bin/bash
# fixture provision.sh: print what the entrypoint handed over, then stop.
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ -w "$here" ]; then writable=yes; else writable=no; fi
echo "PROVISION-STUB from=$here version=$(jq -r .version "$here/.claude-plugin/plugin.json") writable=$writable HARMONY_PLUGIN_DIR=${HARMONY_PLUGIN_DIR:-<unset>} HARMONY_PLUGIN_SOURCE_RESULT=${HARMONY_PLUGIN_SOURCE_RESULT:-<unset>} args=$*"
exit 0
STUB
  chmod 755 "$SRC/container/provision.sh"
  git -C "$SRC" add -A
  git -C "$SRC" commit -q -m "fixture $1"
}
write_tree 2.0.1 1
git -C "$SRC" checkout -q -b staging
write_tree 2.0.2 1
git -C "$SRC" checkout -q -b nomarker
write_tree 2.0.3 0
git clone -q --bare "$SRC" "$FIX/plugin.git"
META_SRC="$WORK/meta-src"
git init -q -b main "$META_SRC"
echo '# fixture workspace' >"$META_SRC/CLAUDE.md"
git -C "$META_SRC" add -A && git -C "$META_SRC" commit -q -m meta
git clone -q --bare "$META_SRC" "$FIX/meta.git"
chmod -R a+rX "$FIX"

build() { # $1 = branch, $2 = channel, $3 = out dir
  node "$REPO_ROOT/scripts/build-release.mjs" --repo "$SRC" --commit "$1" --channel "$2" --base-url "$BASE_URL" --out "$3" >/dev/null
}
build prod prod "$WORK/rel-prod"
build staging staging "$WORK/rel-staging"
build nomarker prod "$WORK/rel-nomarker"

SERVE="$WORK/serve"
publish() { # $1 = channel, $2 = built dir, [$3 = jq filter applied to release.json]
  local v
  v="$(jq -r .version "$2/release.json")"
  rm -rf "${SERVE:?}/$1"
  mkdir -p "$SERVE/$1/releases/$v"
  cp "$2/harmony-plugin-$v.zip" "$SERVE/$1/releases/$v/"
  jq "${3:-.}" "$2/release.json" >"$SERVE/$1/release.json"
}
pristine() { rm -rf "$SERVE"; publish prod "$WORK/rel-prod"; publish staging "$WORK/rel-staging"; }

# --- The HTTPS server ------------------------------------------------------------------------------------------
cat >"$WORK/server.mjs" <<'SERVER'
import { createServer } from 'node:https';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const [, , key, cert, serve, port, prefix, log] = process.argv;
const token = process.env.PROOF_TOKEN;
createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const ok = req.headers.authorization === `Bearer ${token}`;
  const url = req.url ?? '';
  let status = 401;
  let body = 'unauthorized';
  if (ok) {
    const file = url.startsWith(`${prefix}/`) && !url.includes('..') ? join(serve, url.slice(prefix.length + 1)) : '';
    if (file && existsSync(file) && statSync(file).isFile()) { status = 200; body = readFileSync(file); } else { status = 404; body = 'not found'; }
  }
  appendFileSync(log, `${req.method} ${url} bearer=${ok ? 'valid' : 'invalid'} -> ${status}\n`);
  res.writeHead(status).end(body);
}).listen(Number(port), '127.0.0.1', () => appendFileSync(log, `listening on 127.0.0.1:${port}\n`));
SERVER
: >"$WORK/requests.log"
PROOF_TOKEN="$TOKEN" node "$WORK/server.mjs" "$WORK/key.pem" "$WORK/ca.pem" "$SERVE" "$PORT" "$BASE_PATH" "$WORK/requests.log" &
SERVER_PID=$!
for _ in $(seq 1 50); do grep -q listening "$WORK/requests.log" 2>/dev/null && break; sleep 0.1; done
grep -q listening "$WORK/requests.log" || { echo "prove-release-fetch: the server did not start" >&2; exit 1; }

REPOS_JSON="$(printf '[{"url":"file:///fixture/meta.git","path":"/workspace/workspace","meta_repo_role":true,"ref":"main"},{"url":"file:///fixture/plugin.git","path":"/workspace/workspace/plugin","is_plugin":true}]' | base64 | tr -d '\n')"

FAILS=0
# $1 = case name, $2 = expectation (release:<version> | fallback:<reason regex>), $3.. = extra docker -e args
run_case() {
  local name="$1" expect="$2" out lines status=0
  shift 2
  echo
  echo "== case: $name"
  out="$(docker run --rm --network host \
    -v "$WORK/ca.pem:/etc/b1478-proof-ca.pem:ro" -v "$FIX:/fixture:ro" \
    -e CURL_CA_BUNDLE=/etc/b1478-proof-ca.pem \
    -e GIT_TOKEN=unused-for-file-urls \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e 'GIT_CONFIG_VALUE_0=*' \
    -e HARMONY_REPOS_JSON="$REPOS_JSON" \
    "$@" "$IMAGE" headless "/harmony-plugin:harmony-conduct B-1 --one-shot" 2>&1)" || status=$?
  printf '%s\n' "$out" | sed 's/^/   | /'
  local verdict="PASS" why=""
  if printf '%s' "$out" | grep -qF "$TOKEN"; then verdict="FAIL"; why="the token appeared in the output"; fi
  lines="$(printf '%s\n' "$out" | grep -c '^PLUGIN-SOURCE-FALLBACK:' || true)"
  case "$expect" in
    release:*)
      local v="${expect#release:}"
      if [ "$status" -ne 0 ]; then verdict="FAIL"; why="exit $status"
      elif [ "$lines" -ne 0 ]; then verdict="FAIL"; why="unexpected fallback"
      elif ! printf '%s\n' "$out" | grep -qE "^PROVISION-STUB from=/home/worker/harmony-plugin version=$v writable=no HARMONY_PLUGIN_DIR=/home/worker/harmony-plugin HARMONY_PLUGIN_SOURCE_RESULT=release "; then verdict="FAIL"; why="the release provision.sh did not run as expected"
      fi
      [ "$verdict" = PASS ] && why="ran the release $v provision.sh, read-only, HARMONY_PLUGIN_SOURCE_RESULT=release"
      ;;
    fallback:*)
      local re="${expect#fallback:}" line
      line="$(printf '%s\n' "$out" | grep '^PLUGIN-SOURCE-FALLBACK:' || true)"
      if [ "$status" -ne 0 ]; then verdict="FAIL"; why="exit $status"
      elif [ "$lines" -ne 1 ]; then verdict="FAIL"; why="$lines fallback lines (want exactly 1)"
      elif ! printf '%s' "$line" | grep -qE "^PLUGIN-SOURCE-FALLBACK: $re; cloning [a-z]+$"; then verdict="FAIL"; why="fallback reason did not match /$re/"
      elif ! printf '%s\n' "$out" | grep -qE '^PROVISION-STUB from=/workspace/workspace/plugin .*HARMONY_PLUGIN_DIR=<unset> HARMONY_PLUGIN_SOURCE_RESULT=clone-fallback\('; then verdict="FAIL"; why="the cloned provision.sh did not run as expected"
      fi
      [ "$verdict" = PASS ] && why="$line -> cloned provision.sh ran"
      ;;
  esac
  [ "$verdict" = PASS ] || FAILS=$((FAILS + 1))
  RESULTS+=("$verdict $name: $why")
}
RESULTS=()
REL=(-e HARMONY_PLUGIN_SOURCE=release -e "HARMONY_PLUGIN_RELEASE_URL=$BASE_URL" -e "HARMONY_API_TOKEN=$TOKEN")

pristine
run_case "success on prod" "release:2.0.1" "${REL[@]}" -e HARMONY_PLUGIN_POSTURE=prod
run_case "success on staging" "release:2.0.2" "${REL[@]}" -e HARMONY_PLUGIN_POSTURE=ack:staging
run_case "fallback: missing setting key (no base_url)" "fallback:plugin_release\\.base_url \\(HARMONY_PLUGIN_RELEASE_URL\\) is not set" \
  -e HARMONY_PLUGIN_SOURCE=release -e "HARMONY_API_TOKEN=$TOKEN" -e HARMONY_PLUGIN_POSTURE=prod
rm -rf "${SERVE:?}/prod"
run_case "fallback: HTTP error (no release on the channel)" "fallback:release\\.json: HTTP 404" "${REL[@]}" -e HARMONY_PLUGIN_POSTURE=prod
pristine
run_case "fallback: refused token (401)" "fallback:release\\.json: token refused \\(HTTP 401\\)" \
  -e HARMONY_PLUGIN_SOURCE=release -e "HARMONY_PLUGIN_RELEASE_URL=$BASE_URL" -e HARMONY_API_TOKEN=hmy_wrong_token -e HARMONY_PLUGIN_POSTURE=prod
publish prod "$WORK/rel-prod" '.zip.sha256 = ("0" * 64)'
run_case "fallback: checksum mismatch" "fallback:checksum mismatch \\(zip sha256 [0-9a-f]{64}, release\\.json says 0{64}\\)" "${REL[@]}" -e HARMONY_PLUGIN_POSTURE=prod
publish prod "$WORK/rel-prod" '.version = "2.0.9"'
run_case "fallback: version mismatch" "fallback:version mismatch \\(the zip's plugin\\.json says '2\\.0\\.1', release\\.json says '2\\.0\\.9'\\)" "${REL[@]}" -e HARMONY_PLUGIN_POSTURE=prod
publish prod "$WORK/rel-nomarker"
run_case "fallback: missing marker" "fallback:release 2\\.0\\.3 has no container/release-runtime marker.*" "${REL[@]}" -e HARMONY_PLUGIN_POSTURE=prod

echo
echo "== server request log"
sed 's/^/   /' "$WORK/requests.log"
echo
echo "== summary"
for r in "${RESULTS[@]}"; do echo "$r"; done
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS case(s) FAILED"
  exit 1
fi
echo "all ${#RESULTS[@]} cases PASS"
