#!/usr/bin/env bash
# scripts/gated-install-check.sh — B-1477: a repeatable check of installing the plugin from the gated download
# (docs/plugin-release-artefact.md) the way the founder's walk does it (docs/gated-download-walk.md): the marketplace
# declared in user settings with a url-source headersHelper that reads a token file.
#
# Usage: scripts/gated-install-check.sh --base <base-address> --token-file <path> [--channel prod|staging]
#   --base        the gated download's base address (no default: this repository carries no Harmony value).
#   --token-file  a file holding a Harmony API token. It is copied, never printed; the copy is removed on exit.
#   --channel     prod (marketplace `harmony`, the default) or staging (marketplace `harmony-staging`).
#
# Everything runs with an isolated HOME and CLAUDE_CONFIG_DIR under a temp dir, removed on exit. It prints one
# PASS / FAIL / NOT-RUN line per case. Printed output never carries the token (lines holding it are dropped, and any
# bearer value is masked) nor the base address (replaced by `<BASE>`). Exit 0 when no case FAILs, 1 otherwise,
# 2 on a usage error.
set -uo pipefail

BASE=""
TOKEN_FILE=""
CHANNEL="prod"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || { echo "--base needs a value" >&2; exit 2; }; BASE="$2"; shift 2 ;;
    --token-file) [ $# -ge 2 ] || { echo "--token-file needs a value" >&2; exit 2; }; TOKEN_FILE="$2"; shift 2 ;;
    --channel) [ $# -ge 2 ] || { echo "--channel needs a value" >&2; exit 2; }; CHANNEL="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$BASE" ] || { echo "missing required --base <base-address>" >&2; exit 2; }
[ -n "$TOKEN_FILE" ] || { echo "missing required --token-file <path>" >&2; exit 2; }
[ -f "$TOKEN_FILE" ] || { echo "token file does not exist" >&2; exit 2; }
[ -s "$TOKEN_FILE" ] || { echo "token file is empty" >&2; exit 2; }
case "$CHANNEL" in
  prod) NAME="harmony" ;;
  staging) NAME="harmony-staging" ;;
  *) echo "--channel must be prod or staging" >&2; exit 2 ;;
esac
BASE="${BASE%/}"
case "$BASE" in https://*) ;; *) echo "--base must be an https:// address" >&2; exit 2 ;; esac
# Every usage check runs before the tool check, so a usage error is reported the same on a machine without
# Claude Code (CI) as on one with it.
tr -d '\r' < "$TOKEN_FILE" | grep -q -v '^[[:space:]]*$' || { echo "token file holds only blank lines" >&2; exit 2; }
for tool in claude node timeout; do command -v "$tool" >/dev/null || { echo "check: $tool is not on PATH" >&2; exit 2; }; done

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

ID="harmony-plugin@$NAME"
URL="$BASE/$CHANNEL/marketplace.json"
CLAUDE_VERSION="$(claude --version 2>/dev/null | head -n1)"

# The token copy and the helper live together, so the helper can find the token beside it.
SECRETS="$WORK/secrets"
mkdir -p "$SECRETS"; chmod 700 "$SECRETS"
(umask 077; cp "$TOKEN_FILE" "$SECRETS/token"; cp "$TOKEN_FILE" "$SECRETS/token.good")
chmod 600 "$SECRETS/token" "$SECRETS/token.good"
# the sanitizer's pattern: the token's non-blank lines (a blank pattern line would match, and drop, every line).
(umask 077; tr -d '\r' < "$TOKEN_FILE" | grep -v '^[[:space:]]*$' > "$SECRETS/pattern" || true)
[ -s "$SECRETS/pattern" ] || { echo "token file holds only blank lines" >&2; exit 2; }
cat > "$SECRETS/headers.sh" <<'SH'
#!/bin/sh
t=$(tr -d '\r\n' < "$(dirname "$0")/token")
printf '{"Authorization":"Bearer %s"}' "$t"
SH
chmod 700 "$SECRETS/headers.sh"

export HOME="$WORK/home" CLAUDE_CONFIG_DIR="$WORK/home/.claude"
mkdir -p "$CLAUDE_CONFIG_DIR"
node -e '
  const [file, name, url, helper] = process.argv.slice(1);
  const s = { extraKnownMarketplaces: { [name]: { source: { source: "url", url, headersHelper: helper }, autoUpdate: true } } };
  require("fs").writeFileSync(file, JSON.stringify(s, null, 2) + "\n");' \
  "$CLAUDE_CONFIG_DIR/settings.json" "$NAME" "$URL" "$SECRETS/headers.sh"

# sanitize: drop any line holding the real token, mask any bearer, replace the base address with <BASE>.
sanitize() {
  local line
  grep -v -F -f "$SECRETS/pattern" | sed -E 's/Bearer [^ "]+/Bearer <redacted>/g' | while IFS= read -r line; do
    printf '%s\n' "${line//"$BASE"/<BASE>}"
  done
}
RESULTS=()
result() { local l; l="$(printf '%s' "$1" | sanitize)"; RESULTS+=("$l"); echo "$l"; }
first() { sanitize < "$WORK/cc.out" | grep -v '^[[:space:]]*$' | head -n1; }
# cc <args…>: one `claude plugin` call, output shown indented and sanitized; returns claude's exit code.
cc() { timeout 180 claude plugin "$@" >"$WORK/cc.out" 2>&1; local rc=$?; sanitize < "$WORK/cc.out" | sed 's/^/    | /'; return $rc; }
installed() { # prints "<version> <installPath>"
  node -e '
    const [f, id] = process.argv.slice(1); let j; try { j = require(f); } catch { process.exit(0); }
    const e = (j.plugins || {})[id]; const r = Array.isArray(e) ? e[0] : e;
    if (r) console.log(`${r.version} ${r.installPath}`);' "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json" "$ID"
}
enabled() { # exit 0 when `claude plugin list` shows the plugin enabled
  timeout 60 claude plugin list >"$WORK/list.out" 2>&1 || return 1
  awk -v id="$ID" 'index($0, id) { found = 1; next } found && /Status:/ { print; exit } found && /❯|@/ { exit }' "$WORK/list.out" \
    | grep -qi 'enabled' && ! grep -A3 -F "$ID" "$WORK/list.out" | grep -qi 'disabled'
}
fingerprint() { (cd "$1" 2>/dev/null && find . -type f -print0 | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -c1-16); }

echo "Claude Code: $CLAUDE_VERSION"
echo "Channel: $CHANNEL (marketplace $NAME, <BASE>/$CHANNEL/marketplace.json)"

# A: once declared in user settings, `marketplace add` for the same address is refused.
echo "== A declared marketplace"
if cc marketplace add "$URL"; then
  result "A declared marketplace: FAIL — marketplace add was accepted while the marketplace is declared: $(first)"
else
  result "A declared marketplace: PASS — marketplace add refused while declared: $(first)"
fi

# B: a session start fetches the declared marketplace (it may then stop at "Not logged in").
echo "== B fetch at session start"
CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 timeout 180 env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude -p x >"$WORK/cc.out" 2>&1
echo "    | session exit $?: $(first)"
cc marketplace list
if grep -qF "$NAME" "$WORK/cc.out"; then
  result "B fetch at session start: PASS — marketplace list shows $NAME after one session start"
else
  result "B fetch at session start: FAIL — marketplace list does not show $NAME"
fi

# C: install from the gated marketplace.
echo "== C install"
VERSION="" INSTALL_PATH=""
if ! cc install "$ID"; then
  result "C install: FAIL — plugin install failed: $(first)"
else
  read -r VERSION INSTALL_PATH <<<"$(installed)"
  missing=""
  for p in skills hooks/hooks.json .mcp.json dist/index.js dist/bin/harmony.js; do [ -e "${INSTALL_PATH:-/nonexistent}/$p" ] || missing="$missing $p"; done
  HV="$(node "${INSTALL_PATH:-/nonexistent}/dist/bin/harmony.js" --version 2>/dev/null | tail -n1)"
  SKILLS="$(find "${INSTALL_PATH:-/nonexistent}/skills" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print 2>/dev/null | wc -l | tr -d ' ')"
  HOOKS="$(node -e 'try { const h = require(process.argv[1]).hooks || {}; console.log(Object.keys(h).join("/")); } catch { console.log("none"); }' "${INSTALL_PATH:-/nonexistent}/hooks/hooks.json")"
  MCP="$(node -e 'try { const m = require(process.argv[1]); console.log(Object.keys(m.mcpServers || m).join(",")); } catch { console.log("none"); }' "${INSTALL_PATH:-/nonexistent}/.mcp.json")"
  CACHE_REL="${INSTALL_PATH#"$CLAUDE_CONFIG_DIR"/}"
  cc list
  # Claude Code's own inventory of the installed copy (its counts can differ from the SKILL.md directories).
  timeout 60 claude plugin details harmony-plugin >"$WORK/cc.out" 2>&1
  DETAILS="$(sanitize < "$WORK/cc.out" | grep -E '^[[:space:]]*(Skills|Hooks|MCP servers|Agents)[[:space:]]*\(' \
    | sed -E 's/^[[:space:]]+//; s/^(Skills \([0-9]+\)).*/\1/; s/  \([^)]*\)[[:space:]]*$//; s/[[:space:]]+/ /g' | paste -sd ';' - | sed 's/;/; /g')"
  if [ -n "$VERSION" ] && [ -z "$missing" ] && [ "$HV" = "$VERSION" ] && enabled; then
    result "C install: PASS — installed $VERSION, enabled; cache \$CLAUDE_CONFIG_DIR/$CACHE_REL; skill directories: $SKILLS; hook events: $HOOKS; MCP servers: $MCP; details: ${DETAILS:-none}; harmony --version prints $HV"
  else
    result "C install: FAIL — installed '${VERSION:-none}'; enabled: $(enabled && echo yes || echo no); missing:${missing:- none}; harmony --version '$HV'"
  fi
fi

if [ -z "$VERSION" ]; then
  result "D wrong token: NOT-RUN — case C did not install"
  result "E recovery: NOT-RUN — case C did not install"
else
  # D: a refused token fails both refreshes and leaves the install in place.
  echo "== D wrong token"
  BEFORE="$(fingerprint "$INSTALL_PATH")"
  printf 'not-a-harmony-token-%s' "$$" > "$SECRETS/token"
  cc marketplace update "$NAME"; MU_RC=$?; MU="$(first)"; grep -q '401' "$WORK/cc.out"; MU401=$?
  cc update "$ID"; PU_RC=$?; PU="$(sanitize < "$WORK/cc.out" | grep -m1 -i '401\|fail\|error' || first)"; grep -q '401' "$WORK/cc.out"; PU401=$?
  read -r V_AFTER P_AFTER <<<"$(installed)"
  AFTER="$(fingerprint "${P_AFTER:-/nonexistent}")"
  if [ "$MU_RC" -ne 0 ] && [ "$MU401" -eq 0 ] && [ "$PU_RC" -ne 0 ] && [ "$PU401" -eq 0 ] \
     && [ "${V_AFTER:-}" = "$VERSION" ] && [ "$AFTER" = "$BEFORE" ] && enabled; then
    result "D wrong token: PASS — marketplace update: \"$MU\"; plugin update: \"$PU\"; still $V_AFTER, enabled, cache unchanged"
  else
    result "D wrong token: FAIL — marketplace update rc $MU_RC (\"$MU\"); plugin update rc $PU_RC (\"$PU\"); installed '${V_AFTER:-none}'; enabled: $(enabled && echo yes || echo no); cache unchanged: $([ "$AFTER" = "$BEFORE" ] && echo yes || echo no)"
  fi

  # E: the good token restored, both refreshes work again.
  echo "== E recovery"
  cp "$SECRETS/token.good" "$SECRETS/token"
  cc marketplace update "$NAME"; MU_RC=$?; MU="$(first)"
  cc update "$ID"; PU_RC=$?; PU="$(sanitize < "$WORK/cc.out" | grep -m1 -i 'latest\|updated' || first)"
  read -r V_AFTER _ <<<"$(installed)"
  if [ "$MU_RC" -eq 0 ] && [ "$PU_RC" -eq 0 ] && printf '%s' "$PU" | grep -qi 'latest' && [ "${V_AFTER:-}" = "$VERSION" ]; then
    result "E recovery: PASS — marketplace update: \"$MU\"; plugin update: \"$PU\""
  elif [ "$MU_RC" -eq 0 ] && [ "$PU_RC" -eq 0 ]; then
    result "E recovery: PASS — marketplace update: \"$MU\"; plugin update: \"$PU\" (now ${V_AFTER:-none}: a newer release was published during the check)"
  else
    result "E recovery: FAIL — marketplace update rc $MU_RC (\"$MU\"); plugin update rc $PU_RC (\"$PU\")"
  fi
fi

result "F background auto-update: NOT-RUN — needs a logged-in interactive session and a newer published version (docs/gated-download-walk.md step 6)"
result "G logged-in session after a refused refresh: NOT-RUN — needs a logged-in session (docs/gated-download-walk.md step 7)"

echo "== summary (Claude Code $CLAUDE_VERSION, channel $CHANNEL, installed ${VERSION:-none})"
printf '%s\n' "${RESULTS[@]}"
case " ${RESULTS[*]}" in *": FAIL"*) exit 1 ;; esac
exit 0
