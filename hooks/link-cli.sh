#!/bin/sh
# B-808 — put `harmony` on the operator's PATH (Claude Code `SessionStart` hook).
#
# After the plugin is installed an operator should be able to run `harmony` in a fresh terminal with no repo
# checkout. On every session start this script keeps two things in place:
#
#   1. ${HARMONY_HOME:-$HOME/.harmony}/plugin-root   a one-line pointer to this plugin's directory. Rewritten
#                                                    whenever it differs, so a plugin update (new cache dir)
#                                                    repoints it. A --plugin-dir session repoints it too:
#                                                    last session wins.
#   2. ${HARMONY_BIN_DIR:-$HOME/.local/bin}/harmony  a tiny wrapper that reads the pointer at run time and execs
#                                                    node on dist/bin/harmony.js. The wrapper never changes on
#                                                    a plugin update; it is rewritten only when its marker
#                                                    version is older than WRAPPER_VERSION.
#
# Rules: never clobber a `harmony` this script did not write (no marker => leave it, say so); never edit a shell
# profile (a bin dir off PATH gets a one-line hint instead); no node, no network; every path exits 0 and prints
# at most one short line to stderr; safe to run concurrently (temp file + atomic mv).

WRAPPER_VERSION=1
MARKER='# harmony-plugin-shim v'

[ -n "${HARMONY_HOME:-}" ] || [ -n "${HOME:-}" ] || exit 0
HOME_DIR=${HARMONY_HOME:-$HOME/.harmony}
BIN_DIR=${HARMONY_BIN_DIR:-${HOME:-}/.local/bin}

ROOT=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$ROOT" ]; then
  ROOT=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) || exit 0
fi
[ -n "$ROOT" ] || exit 0

say() { printf 'harmony-plugin: %s\n' "$1" >&2; }

# --- 1. the pointer
POINTER="$HOME_DIR/plugin-root"
current=$(cat "$POINTER" 2>/dev/null)
if [ "$current" != "$ROOT" ]; then
  mkdir -p "$HOME_DIR" 2>/dev/null
  tmp="$HOME_DIR/.plugin-root.$$"
  if printf '%s\n' "$ROOT" 2>/dev/null > "$tmp" && mv -f "$tmp" "$POINTER" 2>/dev/null; then
    :
  else
    rm -f "$tmp" 2>/dev/null
    say "could not write $POINTER; \`harmony\` will not find the plugin"
    exit 0
  fi
fi

# --- 2. the wrapper
WRAPPER="$BIN_DIR/harmony"
if [ -L "$WRAPPER" ] || { [ -e "$WRAPPER" ] && [ ! -f "$WRAPPER" ]; }; then
  say "$WRAPPER exists and is not the plugin's wrapper; left untouched. Remove it to let the plugin manage \`harmony\`, or run the plugin's dist/bin/harmony.js directly."
  exit 0
fi
if [ -f "$WRAPPER" ]; then
  have=$(sed -n '2p' "$WRAPPER" 2>/dev/null | sed -n "s/^$MARKER\([0-9][0-9]*\)\$/\1/p")
  if [ -z "$have" ]; then
    say "$WRAPPER exists and is not the plugin's wrapper; left untouched. Move it aside to let the plugin manage \`harmony\`, or run the plugin's dist/bin/harmony.js directly."
    exit 0
  fi
fi
if [ -z "${have:-}" ] || [ "$have" -lt "$WRAPPER_VERSION" ]; then
  if mkdir -p "$BIN_DIR" 2>/dev/null; then
    tmp="$BIN_DIR/.harmony.$$"
    if {
      cat <<'WRAP'
#!/bin/sh
# harmony-plugin-shim v1
# Written by the Harmony plugin's SessionStart hook (hooks/link-cli.sh); rewritten only when the marker version above changes.
p="${HARMONY_HOME:-$HOME/.harmony}/plugin-root"
[ -r "$p" ] || { echo "harmony: no plugin pointer at $p (start a Claude Code session with the Harmony plugin installed)" >&2; exit 127; }
IFS= read -r root < "$p"
t="$root/dist/bin/harmony.js"
[ -f "$t" ] || { echo "harmony: $t not found (the plugin moved or is not built; start a Claude Code session to refresh)" >&2; exit 127; }
command -v node >/dev/null 2>&1 || { echo "harmony: node is not on PATH" >&2; exit 127; }
exec node "$t" "$@"
WRAP
    } 2>/dev/null > "$tmp" && chmod 755 "$tmp" 2>/dev/null && mv -f "$tmp" "$WRAPPER" 2>/dev/null; then
      :
    else
      rm -f "$tmp" 2>/dev/null
      say "could not write $WRAPPER; \`harmony\` is not on PATH"
      exit 0
    fi
  else
    say "could not create $BIN_DIR; \`harmony\` is not on PATH"
    exit 0
  fi
fi

# --- 3. PATH hint (never edits a profile)
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) say "$BIN_DIR is not on your PATH; add this to your shell profile to run \`harmony\`: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
exit 0
