#!/usr/bin/env bash
# B-929 lever 1, the consumer half: activate ONE cloned repo's declared Node /
# package-manager toolchain inside the worker container.
#
# Called once per cloned repo by container/provision.sh, AFTER the clones exist
# and BEFORE provision.sh hands off to the mode dispatch. Lives in the clone
# (never baked into the image) for the same reason provision.sh does: the logic
# is always the provisioned ref's own.
#
# STRICTLY CONDITIONAL — this is the load-bearing property (B-929 AC2), not a
# nicety. A repo activates a toolchain ONLY when it DECLARES one, via exactly
# four sources:
#
#   .nvmrc                       Node version   (precedence 1)
#   .node-version                Node version   (precedence 2)
#   package.json engines.node    Node version   (precedence 3)
#   package.json packageManager  package manager (independent of the above)
#
# A repo that declares NONE of them is left completely alone: no fnm call, no
# corepack call, no shell-rc edit, no file created anywhere. It takes today's
# byte-for-byte Node 22 path. That matters because none of Harmony's own three
# repos (workspace, web, plugin) declares any pin today, so shipping this must
# be provably a no-op for every existing deployment.
#
# What "activate" means concretely:
#   Node  — `fnm use --install-if-missing <version>` downloads the version into
#           $FNM_DIR (worker-owned, see container/Dockerfile) and selects it for
#           THIS process; `fnm alias <version> default` then makes it the
#           version every LATER shell in this container gets, which is what the
#           leg's agent actually runs under.
#   PM    — `corepack enable --install-directory $HOME/bin <pm>` writes the shim
#           into the dir provision.sh already prepends to PATH (never into the
#           root-owned /usr/local/bin, which the non-root worker cannot write),
#           and `corepack prepare <spec> --activate` pre-fetches the exact
#           pinned version so the first `pnpm install` of the leg is not also a
#           download-and-prompt.
#
# Persistence: when (and only when) something was activated, this script writes
# $HOME/.harmony-toolchain.sh and sources it from ~/.bashrc + ~/.profile. That
# file re-establishes fnm (with --use-on-cd, so entering a repo directory that
# carries an .nvmrc/.node-version switches Node automatically) and $HOME/bin on
# PATH. provision.sh sources it too, so the leg's own agent process inherits it.
#
# Multi-repo caveat, documented rather than hidden: `default` is a single global
# alias, so with N repos pinning N DIFFERENT Node versions the default is the
# LAST activated repo's. Per-repo correctness in that case comes from the
# --use-on-cd hook (an .nvmrc/.node-version in the repo you cd into wins) or an
# explicit `fnm use` in the repo. The common shape this ticket exists for — one
# extra project, one pin — needs neither.
#
# Usage: container/activate-toolchain.sh <repo-path>
# Exit codes: 0 = activated or (deliberately) did nothing; non-zero = a declared
# pin could not be honoured. provision.sh treats a failure as a WARNING and
# continues on the image default rather than killing the leg.
set -euo pipefail

REPO_DIR="${1:?usage: activate-toolchain.sh <repo-path>}"

if [ ! -d "$REPO_DIR" ]; then
  echo "activate-toolchain: $REPO_DIR is not a directory — skipping" >&2
  exit 0
fi

log() { echo "activate-toolchain[$REPO_DIR]: $*"; }

# --- Read the four declaration sources ---------------------------------------
# package.json is read with node (always present in this image) rather than jq,
# so a malformed package.json degrades to "declares nothing" instead of failing
# the leg.
read_pkg_field() {
  # $1 = dot-path under the package.json root, e.g. "engines.node"
  node -e '
    const fs = require("node:fs");
    try {
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const value = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), pkg);
      if (typeof value === "string" && value.trim() !== "") process.stdout.write(value.trim());
    } catch {
      /* unreadable or malformed package.json: declares nothing */
    }
  ' "$REPO_DIR/package.json" "$1" 2>/dev/null || true
}

read_version_file() {
  # First non-empty, non-comment line — the .nvmrc convention (a bare version,
  # optionally "v"-prefixed; comment lines are legal in the wild).
  grep -v '^[[:space:]]*#' "$1" 2>/dev/null | grep -m1 -E '[^[:space:]]' | tr -d '[:space:]' || true
}

NODE_DECL=""
NODE_DECL_SOURCE=""
if [ -f "$REPO_DIR/.nvmrc" ]; then
  NODE_DECL="$(read_version_file "$REPO_DIR/.nvmrc")"
  [ -n "$NODE_DECL" ] && NODE_DECL_SOURCE=".nvmrc"
fi
if [ -z "$NODE_DECL" ] && [ -f "$REPO_DIR/.node-version" ]; then
  NODE_DECL="$(read_version_file "$REPO_DIR/.node-version")"
  [ -n "$NODE_DECL" ] && NODE_DECL_SOURCE=".node-version"
fi
if [ -z "$NODE_DECL" ] && [ -f "$REPO_DIR/package.json" ]; then
  NODE_DECL="$(read_pkg_field engines.node)"
  [ -n "$NODE_DECL" ] && NODE_DECL_SOURCE="package.json engines.node"
fi

PM_DECL=""
if [ -f "$REPO_DIR/package.json" ]; then
  PM_DECL="$(read_pkg_field packageManager)"
fi

# --- AC2: no declaration => do NOTHING, visibly ------------------------------
if [ -z "$NODE_DECL" ] && [ -z "$PM_DECL" ]; then
  log "no toolchain pin declared (.nvmrc / .node-version / engines.node / packageManager) — leaving the image default untouched"
  exit 0
fi

# --- Resolve a declared Node version -----------------------------------------
# TWO paths, in this order:
#
#   1. fnm's OWN resolution — `fnm use --install-if-missing --resolve-engines`
#      with NO version argument, run from the repo directory. fnm then applies
#      its documented version-file strategy (.node-version / .nvmrc) and, when
#      neither exists, resolves `engines.node`, honouring a full semver RANGE
#      with the LATEST satisfying version. VERIFIED LIVE during the B-929 build
#      against the real fnm binary (1.39.0, the release this image installs):
#      a repo declaring only engines.node "24.14.1" landed on v24.14.1, and the
#      flag is documented as enabled by default there.
#
#   2. An explicit version we resolve OURSELVES, used only if (1) fails — an
#      older fnm without --resolve-engines, or any resolution error. The rule:
#      take the FIRST version-shaped token out of the declaration, i.e. honour a
#      range at its FLOOR (">=20.11.0" -> 20.11.0, "^22" -> 22, "v22.11.0" ->
#      22.11.0). fnm resolves a partial version to the newest matching release.
#
# Path 2 is what makes the engines.node case work regardless of --resolve-engines
# ever being present, which is why it exists at all; path 1 is preferred because
# it honours ranges the way the declaring project means them.
resolve_node_version() {
  printf '%s' "$1" | grep -oE '[0-9]+(\.[0-9]+)*' | head -1 || true
}

NODE_VERSION=""
if [ -n "$NODE_DECL" ]; then
  NODE_VERSION="$(resolve_node_version "$NODE_DECL")"
  if [ -z "$NODE_VERSION" ]; then
    log "WARNING: $NODE_DECL_SOURCE declares '$NODE_DECL', which carries no version-shaped token — ignoring the Node pin"
  fi
fi

ACTIVATED=0

# --- Node, via fnm -----------------------------------------------------------
if [ -n "$NODE_VERSION" ]; then
  if ! command -v fnm >/dev/null 2>&1; then
    echo "activate-toolchain[$REPO_DIR]: ERROR: $NODE_DECL_SOURCE declares Node $NODE_DECL but fnm is not on PATH (base image too old?)" >&2
    exit 1
  fi
  export FNM_DIR="${FNM_DIR:-$HOME/.fnm}"
  mkdir -p "$FNM_DIR"
  # `fnm use` refuses to run in a shell fnm has not been wired into, so wire
  # this one first. --shell bash is explicit because this script is run
  # non-interactively (fnm's shell auto-detect keys on the parent process).
  eval "$(fnm env --shell bash)"
  log "$NODE_DECL_SOURCE declares Node '$NODE_DECL' -> activating (fnm resolution first, floor $NODE_VERSION as fallback)"
  if ! ( cd "$REPO_DIR" && fnm use --install-if-missing --resolve-engines ); then
    log "fnm's own resolution did not settle — falling back to the explicitly resolved $NODE_VERSION"
    ( cd "$REPO_DIR" && fnm use --install-if-missing "$NODE_VERSION" )
  fi
  # Make it the version every LATER shell in this container starts on. `fnm
  # current` is the CONCRETE version that just got activated (never the partial
  # token a range resolved from), so the default alias can never point at
  # something narrower or wider than what this repo actually got.
  ACTIVE_NODE="$(fnm current 2>/dev/null || true)"
  if [ -n "$ACTIVE_NODE" ] && [ "$ACTIVE_NODE" != "none" ]; then
    fnm alias "$ACTIVE_NODE" default >/dev/null 2>&1 \
      || log "WARNING: could not set $ACTIVE_NODE as the fnm default — later shells may fall back to the image Node"
  fi
  log "node is now $(node --version 2>/dev/null || echo '<unresolved>')"
  ACTIVATED=1
fi

# --- Package manager, via corepack -------------------------------------------
if [ -n "$PM_DECL" ]; then
  if ! command -v corepack >/dev/null 2>&1; then
    echo "activate-toolchain[$REPO_DIR]: ERROR: package.json declares packageManager '$PM_DECL' but corepack is not on PATH" >&2
    exit 1
  fi
  PM_NAME="${PM_DECL%%@*}"
  mkdir -p "$HOME/bin"
  log "package.json declares packageManager '$PM_DECL' -> enabling $PM_NAME"
  # Only the DECLARED manager is shimmed — a bare `corepack enable` would also
  # put an npm shim ahead of the image's own npm on PATH, which is a change no
  # repo asked for.
  corepack enable --install-directory "$HOME/bin" "$PM_NAME"
  ( cd "$REPO_DIR" && corepack prepare "$PM_DECL" --activate )
  log "$PM_NAME is now $(cd "$REPO_DIR" && "$HOME/bin/$PM_NAME" --version 2>/dev/null || echo '<unresolved>')"
  ACTIVATED=1
fi

# --- Persist for every later shell in this container -------------------------
if [ "$ACTIVATED" = "1" ]; then
  HOOK="$HOME/.harmony-toolchain.sh"
  cat >"$HOOK" <<'HOOK_BODY'
# B-929: written by container/activate-toolchain.sh when a cloned repo declared a
# Node/package-manager pin. Absent entirely when no repo declared one.
export FNM_DIR="${FNM_DIR:-$HOME/.fnm}"
case ":$PATH:" in
  *":$HOME/bin:"*) ;;
  *) export PATH="$HOME/bin:$PATH" ;;
esac
if command -v fnm >/dev/null 2>&1; then
  # --use-on-cd: entering a directory with an .nvmrc/.node-version switches Node
  # to it, which is how per-repo pins stay correct when several repos differ.
  eval "$(fnm env --use-on-cd --shell bash)"
fi
HOOK_BODY
  chmod 644 "$HOOK"
  for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    touch "$rc"
    if ! grep -qF '.harmony-toolchain.sh' "$rc"; then
      printf '\n# B-929: Harmony worker toolchain (fnm + corepack).\n[ -f "$HOME/.harmony-toolchain.sh" ] && . "$HOME/.harmony-toolchain.sh"\n' >> "$rc"
    fi
  done
  log "toolchain persisted to $HOOK (sourced from ~/.bashrc and ~/.profile)"
fi
