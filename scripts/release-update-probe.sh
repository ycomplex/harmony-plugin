#!/usr/bin/env bash
# scripts/release-update-probe.sh — B-1475: a repeatable local experiment of how Claude Code installs and updates the
# plugin from an archive (URL) marketplace. Results are recorded in docs/plugin-release-artefact.md.
#
# Usage: scripts/release-update-probe.sh [--commit <ref>] [--port <port>]
#   --commit  the commit to release (default origin/prod, fetched first). Must carry a real version and dist/.
#   --port    the HTTPS port (default 8443).
#
# What it does:
#   1. builds the release with scripts/build-release.mjs and publishes it with scripts/publish-release.sh into a local
#      "bucket" directory (the same layout as the real bucket);
#   2. serves that bucket's channels/ over HTTPS on this machine's first non-loopback IPv4, with a throwaway
#      self-signed certificate (IP SAN). The server logs each request path and whether an
#      `Authorization: Bearer <probe token>` header matched (the token is a fake, and its value is never printed);
#   3. runs `claude plugin ...` with an isolated HOME and CLAUDE_CONFIG_DIR under a temp dir, trusting the cert
#      through NODE_EXTRA_CA_CERTS, and prints one PASS / FAIL / NOT-RUN line per case.
# Everything it starts is stopped, by recorded PID, and every temp dir removed on exit.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
COMMIT="origin/prod"
PORT=8443
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

RESULTS=()
result() { RESULTS+=("$1"); echo "$1"; }
die() { echo "probe: $*" >&2; exit 1; }

for tool in node python3 openssl git claude; do command -v "$tool" >/dev/null || die "$tool is not on PATH"; done
CLAUDE_VERSION="$(claude --version 2>/dev/null | head -n1)"
echo "Claude Code: $CLAUDE_VERSION"

if [ "$COMMIT" = origin/prod ]; then git -C "$REPO" fetch --quiet origin prod || echo "probe: could not fetch origin/prod; using the local ref" >&2; fi
IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -n1)"
[ -n "$IP" ] || die "no non-loopback IPv4 address (hostname -I)"
BASE="https://$IP:$PORT"
echo "Serving on $BASE"

# 1. build and publish into a local bucket.
node "$HERE/build-release.mjs" --repo "$REPO" --commit "$COMMIT" --channel prod --base-url "$BASE" --out "$WORK/build" || die "build failed"
bash "$HERE/publish-release.sh" "$WORK/build" "$WORK/bucket" >/dev/null || die "local publish failed"
VERSION="$(node -e "console.log(require('$WORK/build/release.json').version)")"
CHANNEL_DIR="$WORK/bucket/channels/prod"

# 2. HTTPS server.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1 || die "openssl could not make the certificate"
cat > "$WORK/server.py" <<'PY'
import http.server, ssl, sys, os
root, port, cert, key, log = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
TOKEN = "probe-token"
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        auth = self.headers.get("Authorization")
        state = "none" if auth is None else ("match" if auth == "Bearer " + TOKEN else "mismatch")
        with open(log, "a") as f: f.write("GET %s auth=%s\n" % (self.path, state))
        super().do_GET()
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
srv = http.server.ThreadingHTTPServer(("0.0.0.0", port), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY
: > "$WORK/requests.log"
python3 -I "$WORK/server.py" "$WORK/bucket/channels" "$PORT" "$WORK/cert.pem" "$WORK/key.pem" "$WORK/requests.log" 2>"$WORK/server.err" &
SERVER_PID=$!
sleep 1
kill -0 "$SERVER_PID" 2>/dev/null || die "the HTTPS server did not start: $(cat "$WORK/server.err")"

# 3. isolated Claude Code.
export HOME="$WORK/home" CLAUDE_CONFIG_DIR="$WORK/home/.claude" NODE_EXTRA_CA_CERTS="$WORK/cert.pem"
mkdir -p "$CLAUDE_CONFIG_DIR"
cc() { timeout 180 claude plugin "$@" >"$WORK/cc.out" 2>&1; local rc=$?; sed 's/^/    | /' "$WORK/cc.out"; return $rc; }
installed() { # prints "<version> <installPath>"
  node -e '
    const f = process.argv[1]; let j; try { j = require(f); } catch { process.exit(0); }
    const e = (j.plugins || {})["harmony-plugin@harmony"]; const r = Array.isArray(e) ? e[0] : e;
    if (r) console.log(`${r.version} ${r.installPath}`);' "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
}
zip_gets() { grep -c '\.zip ' "$WORK/requests.log" || true; }
# respin <src zip> <dst zip> <new version> [extra file name]: rewrite plugin.json's version, optionally add a file.
respin() {
  python3 -I - "$@" <<'PY'
import sys, zipfile, json
src, dst, version = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4] if len(sys.argv) > 4 else None
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for info in zin.infolist():
        data = zin.read(info.filename)
        if info.filename == ".claude-plugin/plugin.json":
            m = json.loads(data); m["version"] = version; data = (json.dumps(m, indent=2) + "\n").encode()
        zout.writestr(info, data)
    if extra: zout.writestr(extra, "probe\n")
PY
}
# serve <zip> <entry version>: place the zip under releases/<entry version>/ and point the channel marketplace at it.
serve() {
  local zip="$1" entry="$2" dir="$CHANNEL_DIR/releases/$2" name
  name="harmony-plugin-$entry.zip"
  mkdir -p "$dir"; cp "$zip" "$dir/$name"
  node -e '
    const fs = require("fs"); const [file, url, sha, version] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.metadata.version = version; Object.assign(m.plugins[0], { version }); Object.assign(m.plugins[0].source, { url, sha256: sha });
    fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");' \
    "$CHANNEL_DIR/marketplace.json" "$BASE/prod/releases/$entry/$name" "$(sha256sum "$zip" | cut -d' ' -f1)" "$entry"
}
update() { cc marketplace update harmony; cc update harmony-plugin@harmony; }

# A: install.
echo "== A install"
if ! cc marketplace add "$BASE/prod/marketplace.json"; then
  if grep -qiE 'private|loopback|local address|not allowed|refus|blocked' "$WORK/cc.out"; then
    result "A install: NOT-RUN — this Claude Code refused the private-address HTTPS host: $(head -n1 "$WORK/cc.out")"
  else
    result "A install: FAIL — marketplace add failed: $(head -n1 "$WORK/cc.out")"
  fi
  for c in "B update" "C same version, new bytes" "D entry version only" "E nothing changed"; do result "$c: NOT-RUN — case A did not install"; done
else
  cc install harmony-plugin@harmony
  read -r GOT INSTALL_PATH <<<"$(installed)"
  missing=""
  for p in skills hooks/hooks.json .mcp.json dist/index.js dist/bin/harmony.js; do [ -e "${INSTALL_PATH:-/nonexistent}/$p" ] || missing="$missing $p"; done
  HV="$(node "${INSTALL_PATH:-/nonexistent}/dist/bin/harmony.js" --version 2>/dev/null | tail -n1)"
  if [ "${GOT:-}" = "$VERSION" ] && [ -z "$missing" ] && [ "$HV" = "$VERSION" ]; then
    result "A install: PASS — installed $GOT; skills/, hooks/hooks.json, .mcp.json, dist/ present; harmony --version prints $HV"
  else
    result "A install: FAIL — installed '${GOT:-none}' (want $VERSION); missing:${missing:- none}; harmony --version '$HV'"
  fi

  # B: a real version bump moves the install.
  echo "== B update"
  IFS=. read -r MA MI PA <<<"${VERSION%%-*}"
  V2="$MA.$MI.$((PA + 1000))"
  respin "$WORK/build/harmony-plugin-$VERSION.zip" "$WORK/b.zip" "$V2"
  serve "$WORK/b.zip" "$V2"
  update
  read -r GOT _ <<<"$(installed)"
  [ "${GOT:-}" = "$V2" ] && result "B update: PASS — installed version moved $VERSION -> $V2" || result "B update: FAIL — installed '${GOT:-none}' (want $V2)"

  # C: same version, different bytes.
  echo "== C same version, new bytes"
  respin "$WORK/build/harmony-plugin-$VERSION.zip" "$WORK/c.zip" "$V2" probe-extra.txt
  serve "$WORK/c.zip" "$V2"
  BEFORE="$(zip_gets)"
  update
  read -r GOT CPATH <<<"$(installed)"
  if [ "${GOT:-}" = "$V2" ] && [ ! -e "${CPATH:-/nonexistent}/probe-extra.txt" ]; then
    result "C same version, new bytes: PASS — no move (still $GOT, new file absent); zip downloads during the check: $(( $(zip_gets) - BEFORE ))"
  else
    result "C same version, new bytes: FAIL — installed '${GOT:-none}', new file present: $([ -e "${CPATH:-/nonexistent}/probe-extra.txt" ] && echo yes || echo no)"
  fi

  # D: entry version bumped, zip's plugin.json unchanged.
  echo "== D entry version only"
  V3="$MA.$MI.$((PA + 2000))"
  serve "$WORK/c.zip" "$V3"
  update
  read -r GOT _ <<<"$(installed)"
  [ "${GOT:-}" = "$V2" ] && result "D entry version only: PASS — no move (still $GOT; entry says $V3)" || result "D entry version only: FAIL — installed '${GOT:-none}' (expected no move from $V2)"

  # E: nothing changed.
  echo "== E nothing changed"
  BEFORE="$(zip_gets)"
  update
  AFTER="$(zip_gets)"
  read -r GOT _ <<<"$(installed)"
  result "E nothing changed: PASS — still ${GOT:-none}; the zip was downloaded $((AFTER - BEFORE)) time(s) by the check"
fi

result "F background auto-update: NOT-RUN — needs an interactive session over time (owned by B-1477)"
result "G 401 during background refresh: NOT-RUN — needs an interactive session over time (owned by B-1477)"

echo "== request log (path, whether the probe bearer matched)"
sed 's/^/    /' "$WORK/requests.log"
echo "== summary (Claude Code $CLAUDE_VERSION, release $VERSION)"
printf '%s\n' "${RESULTS[@]}"
