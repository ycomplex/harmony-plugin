#!/usr/bin/env bash
# scripts/download-switch-fixture-check.sh — B-1479: check `harmony download switch` against a LOCAL fixture
# of the gated download, in a throwaway home, with a made-up token. It never uses a real token or a real home.
#
# Usage: scripts/download-switch-fixture-check.sh
#
# It builds, under one temp dir removed on exit:
#   - a self-signed HTTPS server on 127.0.0.1 that serves prod/marketplace.json only to
#     `Authorization: Bearer fixture-token`, and logs each request as auth=good|bad|none;
#   - a plain-HTTP stand-in for the model API (ANTHROPIC_BASE_URL, made-up key) that logs every request,
#     so the check can show the switch's session start sends no model request;
#   - an empty HOME, CLAUDE_CONFIG_DIR and HARMONY_CONFIG_DIR.
# Every `claude` and `harmony` call runs under `env -i` with only those variables, so no token of this machine
# reaches them. Claude Code refuses to install an archive from a loopback host, so the install itself cannot pass
# here: case D expects that refusal, named as the failing command.
#
# Cases: A the switch writes the helper and settings and its start fetches the marketplace with a good header and
# no model request; B the helper prints a good header (env token and store token); C a missing token makes the
# refresh fail cleanly; D the install is refused for the loopback archive (expected); E undo.
# Exit 0 when no case FAILs, 1 otherwise, 2 when a tool is missing.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for tool in claude node openssl timeout; do command -v "$tool" >/dev/null || { echo "check: $tool is not on PATH" >&2; exit 2; }; done
CLI="$ROOT/dist/bin/harmony.js"
if [ ! -f "$CLI" ] || ! grep -q 'download-headers.sh' "$CLI"; then
  (cd "$ROOT" && npm run build >/dev/null 2>&1) || { echo "check: npm run build failed" >&2; exit 2; }
fi

WORK="$(mktemp -d)"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

mkdir -p "$WORK/srv/prod" "$WORK/home" "$WORK/bin" "$WORK/cwd"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -days 1 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 || { echo "check: openssl failed" >&2; exit 2; }

cat > "$WORK/bin/download.mjs" <<'JS'
import https from 'node:https'; import fs from 'node:fs';
const [dir, log, portFile] = process.argv.slice(2);
const srv = https.createServer({ key: fs.readFileSync(dir + '/key.pem'), cert: fs.readFileSync(dir + '/cert.pem') }, (req, res) => {
  const a = req.headers.authorization;
  const auth = !a ? 'none' : a === 'Bearer fixture-token' ? 'good' : 'bad';
  fs.appendFileSync(log, `${req.method} ${req.url} auth=${auth}\n`);
  if (auth !== 'good') { res.writeHead(401); return res.end('Invalid or revoked Harmony token'); }
  const p = dir + '/srv' + req.url.split('?')[0];
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(fs.readFileSync(p));
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(srv.address().port)));
JS
cat > "$WORK/bin/api.mjs" <<'JS'
import http from 'node:http'; import fs from 'node:fs';
const [log, portFile] = process.argv.slice(2);
const srv = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    fs.appendFileSync(log, `${req.method} ${req.url}\n`);
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(srv.address().port)));
JS
: > "$WORK/download.log"; : > "$WORK/api.log"
node "$WORK/bin/download.mjs" "$WORK" "$WORK/download.log" "$WORK/download.port" & PIDS+=($!)
node "$WORK/bin/api.mjs" "$WORK/api.log" "$WORK/api.port" & PIDS+=($!)
for _ in $(seq 50); do [ -s "$WORK/download.port" ] && [ -s "$WORK/api.port" ] && break; sleep 0.1; done
PORT="$(cat "$WORK/download.port")"; API_PORT="$(cat "$WORK/api.port")"
BASE="https://127.0.0.1:$PORT"
ZIP_URL="$BASE/prod/releases/9.9.1/harmony-plugin-9.9.1.zip"
printf '{"name":"harmony","owner":{"name":"fixture"},"plugins":[{"name":"harmony-plugin","description":"fixture","version":"9.9.1","source":{"source":"archive","url":"%s","sha256":"%064d"}}]}\n' "$ZIP_URL" 0 \
  > "$WORK/srv/prod/marketplace.json"

H="$WORK/home"
HELPER="$H/.harmony/download-headers.sh"
# run <env...> -- <cmd...>: a clean environment holding only the throwaway paths, plus what the caller adds.
run() {
  local extra=()
  while [ "$1" != "--" ]; do extra+=("$1"); shift; done; shift
  (cd "$WORK/cwd" && env -i PATH="$PATH" HOME="$H" CLAUDE_CONFIG_DIR="$H/.claude" HARMONY_CONFIG_DIR="$H/.harmony" \
    NODE_EXTRA_CA_CERTS="$WORK/cert.pem" ANTHROPIC_BASE_URL="http://127.0.0.1:$API_PORT" ANTHROPIC_API_KEY=fixture-key \
    ${extra[@]+"${extra[@]}"} timeout 180 "$@")
}
show() { sed "s#$BASE#<BASE>#g; s#$WORK#<WORK>#g; s/^/    | /" "$1"; }
RESULTS=()
result() { RESULTS+=("$1"); echo "$1"; }

echo "Claude Code: $(claude --version 2>/dev/null | head -n1)"

echo "== A switch: helper, settings, headless start"
: > "$WORK/download.log"; : > "$WORK/api.log"
run HARMONY_API_TOKEN=fixture-token -- node "$CLI" download switch --base "$BASE" > "$WORK/a.out" 2>&1; A_RC=$?
show "$WORK/a.out"
echo "    download server: $(tr '\n' ';' < "$WORK/download.log")"
echo "    model API: $(tr '\n' ';' < "$WORK/api.log")"
run -- claude plugin marketplace list > "$WORK/ml.out" 2>&1
MESSAGES="$(grep -c '/v1/messages' "$WORK/api.log")"
if [ -x "$HELPER" ] && grep -q '"harmony"' "$H/.claude/settings.json" && grep -q 'GET /prod/marketplace.json auth=good' "$WORK/download.log" \
   && [ "$MESSAGES" -eq 0 ] && grep -q 'harmony' "$WORK/ml.out"; then
  result "A switch: PASS — helper and settings written; the start fetched marketplace.json with auth=good; /v1/messages requests: $MESSAGES; marketplace list shows harmony"
else
  result "A switch: FAIL — exit $A_RC; helper $( [ -x "$HELPER" ] && echo present || echo missing ); /v1/messages: $MESSAGES; download log: $(tr '\n' ';' < "$WORK/download.log")"
fi

echo "== B the helper's header"
B_ENV="$(run HARMONY_API_TOKEN=fixture-token -- sh "$HELPER" 2>"$WORK/b.err")"
node -e 'const s={activeProject:"invented",projects:{invented:{name:"invented",token:"fixture-token"}}}; require("fs").writeFileSync(process.argv[1], JSON.stringify(s), {mode:0o600})' "$H/.harmony/config.json"
B_STORE="$(run -- sh "$HELPER" 2>>"$WORK/b.err")"
: > "$WORK/download.log"
run -- claude plugin marketplace update harmony > "$WORK/b.out" 2>&1; B_RC=$?
show "$WORK/b.out"
GOOD='{"Authorization":"Bearer fixture-token"}'
if [ "$B_ENV" = "$GOOD" ] && [ "$B_STORE" = "$GOOD" ] && [ ! -s "$WORK/b.err" ] && [ "$B_RC" -eq 0 ] \
   && grep -q 'auth=good' "$WORK/download.log" && ! grep -q 'auth=\(bad\|none\)' "$WORK/download.log"; then
  result "B helper header: PASS — env token and store token both give the header, nothing on stderr; refresh with the store token: auth=good"
else
  result "B helper header: FAIL — env header ok: $([ "$B_ENV" = "$GOOD" ] && echo yes || echo no); store header ok: $([ "$B_STORE" = "$GOOD" ] && echo yes || echo no); refresh rc $B_RC; log: $(tr '\n' ';' < "$WORK/download.log")"
fi

echo "== C missing token"
rm -f "$H/.harmony/config.json"
run -- sh "$HELPER" > "$WORK/c.helper.out" 2> "$WORK/c.helper.err"; C_HRC=$?
: > "$WORK/download.log"
run -- claude plugin marketplace update harmony > "$WORK/c.out" 2>&1; C_RC=$?
show "$WORK/c.out"
if [ "$C_HRC" -eq 1 ] && [ ! -s "$WORK/c.helper.out" ] && grep -qx 'harmony: no Harmony token found' "$WORK/c.helper.err" \
   && [ "$C_RC" -ne 0 ] && ! grep -q 'auth=good' "$WORK/download.log"; then
  result "C missing token: PASS — helper exit 1, no stdout, stderr 'harmony: no Harmony token found'; refresh failed (exit $C_RC) and the server saw no good request ($(tr '\n' ';' < "$WORK/download.log" | sed 's/;$//'))"
else
  result "C missing token: FAIL — helper rc $C_HRC; refresh rc $C_RC; log: $(tr '\n' ';' < "$WORK/download.log")"
fi

echo "== D install (loopback archive)"
if [ "$A_RC" -eq 1 ] && grep -q '`claude plugin install harmony-plugin@harmony` failed' "$WORK/a.out" && grep -qi 'loopback' "$WORK/a.out"; then
  result "D install: PASS (expected refusal) — the switch exits 1 naming \`claude plugin install harmony-plugin@harmony\`: Claude Code refuses an archive on a loopback host, so the install is not testable locally"
else
  result "D install: FAIL — switch exit $A_RC; see case A output"
fi

echo "== E undo"
run -- node "$CLI" download switch --undo > "$WORK/e.out" 2>&1; E_RC=$?
show "$WORK/e.out"
if [ "$E_RC" -eq 0 ] && [ ! -e "$HELPER" ] && ! grep -q '"harmony"' "$H/.claude/settings.json"; then
  result "E undo: PASS — marketplace removed, settings entry gone, helper deleted"
else
  result "E undo: FAIL — exit $E_RC"
fi

echo "== summary"
printf '%s\n' "${RESULTS[@]}"
case " ${RESULTS[*]}" in *": FAIL"*) exit 1 ;; esac
exit 0
