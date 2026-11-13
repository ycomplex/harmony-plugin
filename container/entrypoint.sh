#!/usr/bin/env bash
# B-694 minimal bootstrap — the ONLY provisioning logic baked into the image.
# Everything substantive runs FROM the runtime clone (container/provision.sh at
# the cloned plugin ref), so provisioning can never drift from the plugin it
# provisions. Keep this file to: validate env -> clone -> hand off.
set -euo pipefail

: "${GIT_TOKEN:?GIT_TOKEN is required (a GitHub token able to clone/push ycomplex repos) — see plugin/container/env.example (copy it and fill it in — container/README.md Quick start)}"

# Token-authenticated clones without the token landing in .git/config or argv:
# an askpass helper reads it from the env.
GIT_ASKPASS_HELPER="$(mktemp)"
cat >"$GIT_ASKPASS_HELPER" <<'EOF'
#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "$GIT_TOKEN" ;;
esac
EOF
chmod 700 "$GIT_ASKPASS_HELPER"
export GIT_ASKPASS="$GIT_ASKPASS_HELPER"
export GIT_TERMINAL_PROMPT=0

# B-788: cloud worker transcript persistence — fallback path per the accepted design's "open item
# 1" contingency (per-execution GCS mount-sub-path overriding may not be feasible on Cloud Run). A
# HOST step (not this file) mounts a GCS bucket ONCE, statically, at a fixed root via Cloud Run's
# native gcsfuse volume mount, and sets HARMONY_TRANSCRIPT_MOUNT_ROOT in the job definition to that
# root (see container/cloud-worker-launch.sh's HARMONY_TRANSCRIPT_GCS_MOUNT_ROOT knob, which
# forwards it under this name). This block then mirrors B-724's local docker bind-mount scheme in
# software: it symlinks the per-conduction subtree of that fixed mount onto the fixed absolute
# paths the rest of this codebase already reads/writes ($HOME/.claude/projects,
# $HOME/.claude/logs), so the worker's Claude session transcript survives past this ephemeral
# container's exit exactly like the local bind-mount does. HARMONY_TRANSCRIPT_MOUNT_ROOT is unset
# on every local-docker profile and every human machine ⇒ this whole block is a complete no-op —
# it is cloud-profile-only.
if [ -n "${HARMONY_TRANSCRIPT_MOUNT_ROOT:-}" ]; then
  : "${CONDUCTION_ID:?HARMONY_TRANSCRIPT_MOUNT_ROOT is set but CONDUCTION_ID is not — both are required together (cloud-worker-launch.sh already forwards CONDUCTION_ID via its exec-env-vars file)}"
  : "${TICKET:?HARMONY_TRANSCRIPT_MOUNT_ROOT is set but TICKET is not — both are required together (cloud-worker-launch.sh already forwards TICKET via its exec-env-vars file)}"

  # $TICKET is already the ticket's visual id (e.g. "B-788") here — same convention RUN_DIR uses
  # elsewhere (this file's fallback clone section below, and cloud-worker-launch.sh) — never
  # re-derive or reformat it.
  TRANSCRIPT_SUBTREE="$HARMONY_TRANSCRIPT_MOUNT_ROOT/$TICKET/$CONDUCTION_ID"
  mkdir -p "$TRANSCRIPT_SUBTREE/projects" "$TRANSCRIPT_SUBTREE/logs"

  # The image (Dockerfile) pre-creates $HOME/.claude/projects and $HOME/.claude/logs as real,
  # worker-owned directories (B-724 mount-parent ownership fix) — remove them before symlinking so
  # the symlink can take their place. mkdir -p $HOME/.claude first in case that ordering ever
  # changes.
  mkdir -p "$HOME/.claude"
  rm -rf "$HOME/.claude/projects" "$HOME/.claude/logs"
  ln -s "$TRANSCRIPT_SUBTREE/projects" "$HOME/.claude/projects"
  ln -s "$TRANSCRIPT_SUBTREE/logs" "$HOME/.claude/logs"

  # B-718 reopen, item 4 (diagnosis, not a fix — non-fatal, no runtime evidence to validate a code
  # change against): once these symlinks are live, everything this script itself does above targets
  # a normal tmpfs/overlay path ($HOME/.claude/*), never the gcsfuse mount directly — but anything
  # the `claude` CLI does on its OWN under $HOME/.claude/projects/... (including its own internal
  # project-directory housekeeping/pruning when starting with `--resume`, downstream in
  # provision.sh) transparently follows this symlink onto the gcsfuse-backed
  # $TRANSCRIPT_SUBTREE/projects path. Two non-fatal `fuse: Op ... *fuseops.RmDirOp] -> Error:
  # "directory not empty"` errors observed ~9s after the first successful `--resume` are most
  # likely explained by that CLI-internal housekeeping racing gcsfuse's object-storage-backed rmdir
  # semantics (e.g. eventual-consistency directory-emptiness checks, or a concurrent rename/write
  # racing a directory-delete) — a real filesystem wouldn't surface this. A future reader with
  # runtime logs/gcsfuse source access can confirm or refute this hypothesis.

  # B-718: cross-conduction resume discovery (cloud profile). The gcsfuse mount above is already
  # live and spans EVERY conduction of every ticket, so this is the one place the cloud path can
  # see a SIBLING conduction's session — a park + re-conduct gives the new conduction a fresh, empty
  # $TRANSCRIPT_SUBTREE, so the prior conduction's persisted session lives one directory level up,
  # under a different $CONDUCTION_ID. Same-conduction (multi-leg) resume is unrelated to this block
  # and needs no wiring here at all: it's already free (every leg mounts the SAME $TRANSCRIPT_SUBTREE
  # above), discovered by container/provision.sh right before it execs claude.
  #
  # Best-effort throughout, matching AC5's resume-is-best-effort property: `--resume` is a courtesy,
  # never a requirement, so every check below degrades to "inject nothing" (the existing cold-start
  # path) rather than failing this script. Gated on run_config.session_resume.enabled — read from
  # whichever of the two B-846 delivery vars the launch profile actually populated (HARMONY_RUN_CONFIG_PATH
  # is a local-docker-profile-only form; the cloud profile always uses the inline
  # HARMONY_RUN_CONFIG_JSON form, but both are checked here for robustness — see
  # src/config/run-config.ts's own precedence).
  RUN_CONFIG_JSON=""
  if [ -n "${HARMONY_RUN_CONFIG_PATH:-}" ] && [ -f "$HARMONY_RUN_CONFIG_PATH" ]; then
    RUN_CONFIG_JSON="$(cat "$HARMONY_RUN_CONFIG_PATH" 2>/dev/null || true)"
  elif [ -n "${HARMONY_RUN_CONFIG_JSON:-}" ]; then
    RUN_CONFIG_JSON="$(printf '%s' "$HARMONY_RUN_CONFIG_JSON" | base64 -d 2>/dev/null || true)"
  fi
  SESSION_RESUME_ENABLED="false"
  if [ -n "$RUN_CONFIG_JSON" ]; then
    # Same fix as container/provision.sh's sibling block: capture jq's stdout/stderr (2>&1) and its
    # real exit status via `&& ... || ...` (a bare `VAR="$(cmd)"` assignment trips this script's
    # `set -e` on a nonzero exit, which `&&`/`||` testing avoids) so a genuine parse failure is
    # logged loudly instead of being silently indistinguishable from a legitimate `enabled: false`.
    # The value still safely degrades to "false" either way — this only fixes the missing signal.
    JQ_RESULT="$(printf '%s' "$RUN_CONFIG_JSON" | jq -r '.session_resume.enabled // false' 2>&1)" && JQ_EXIT=0 || JQ_EXIT=$?
    if [ "$JQ_EXIT" -eq 0 ]; then
      SESSION_RESUME_ENABLED="$JQ_RESULT"
    else
      echo "entrypoint.sh: WARNING — failed to parse run_config JSON for session_resume.enabled (jq: $JQ_RESULT); defaulting to disabled" >&2
    fi
  fi

  # B-1148: a Codex run links the conduction's codex-sessions folder onto ~/.codex/sessions (the
  # local-docker and docker-host profiles bind-mount the same per-conduction folder), and its
  # cross-conduction discovery reads ONLY the Codex layout: the sibling's thread file (which must
  # name agent "codex") and its rollout are copied into THIS conduction's folder, and the id is
  # exported as HARMONY_CODEX_RESUME_THREAD — never through CLAUDE_HEADLESS_FLAGS. The Claude
  # discovery below runs only for a non-Codex run, so neither runtime ever adopts the other's id.
  ENTRY_AGENT_ADAPTER="claude-code"
  if [ -n "$RUN_CONFIG_JSON" ]; then
    ENTRY_AGENT_ADAPTER="$(printf '%s' "$RUN_CONFIG_JSON" | jq -r '.agent.adapter // "claude-code"' 2>/dev/null || echo claude-code)"
  fi
  if [ "$ENTRY_AGENT_ADAPTER" = "codex" ]; then
    mkdir -p "$TRANSCRIPT_SUBTREE/codex-sessions" "$HOME/.codex"
    rm -rf "$HOME/.codex/sessions"
    ln -s "$TRANSCRIPT_SUBTREE/codex-sessions" "$HOME/.codex/sessions"
    CODEX_THREAD_NAME=".harmony-codex-thread.json"
    if [ "$SESSION_RESUME_ENABLED" = "true" ] && [ ! -f "$TRANSCRIPT_SUBTREE/codex-sessions/$CODEX_THREAD_NAME" ] \
      && [ -d "$HARMONY_TRANSCRIPT_MOUNT_ROOT/$TICKET" ]; then
      SIBLING_CODEX_THREAD_FILE=""
      SIBLING_CODEX_THREAD_ID=""
      SIBLING_NEWEST_MTIME=0
      for sibling_dir in "$HARMONY_TRANSCRIPT_MOUNT_ROOT/$TICKET"/*/; do
        [ -d "$sibling_dir" ] || continue
        [ "$(basename "$sibling_dir")" = "$CONDUCTION_ID" ] && continue
        tf="${sibling_dir}codex-sessions/$CODEX_THREAD_NAME"
        [ -f "$tf" ] || continue
        tid="$(jq -r 'select(.agent == "codex") | .thread_id // empty' "$tf" 2>/dev/null || true)"
        case "$tid" in '' | *[!A-Za-z0-9_-]* | -*) continue ;; esac
        mtime="$(stat -c '%Y' "$tf" 2>/dev/null || echo 0)"
        if [ "$mtime" -gt "$SIBLING_NEWEST_MTIME" ]; then
          SIBLING_NEWEST_MTIME="$mtime"
          SIBLING_CODEX_THREAD_FILE="$tf"
          SIBLING_CODEX_THREAD_ID="$tid"
        fi
      done
      if [ -n "$SIBLING_CODEX_THREAD_ID" ]; then
        sibling_sessions="$(dirname "$SIBLING_CODEX_THREAD_FILE")"
        b1148_copied=1
        for rollout in "$sibling_sessions"/*/*/*/rollout-*-"$SIBLING_CODEX_THREAD_ID".jsonl; do
          [ -f "$rollout" ] || continue
          rel="${rollout#"$sibling_sessions"/}"
          mkdir -p "$TRANSCRIPT_SUBTREE/codex-sessions/$(dirname "$rel")" \
            && cp "$rollout" "$TRANSCRIPT_SUBTREE/codex-sessions/$rel" || b1148_copied=0
        done
        cp "$SIBLING_CODEX_THREAD_FILE" "$TRANSCRIPT_SUBTREE/codex-sessions/$CODEX_THREAD_NAME" || b1148_copied=0
        if [ "$b1148_copied" = "1" ]; then
          export HARMONY_CODEX_RESUME_THREAD="$SIBLING_CODEX_THREAD_ID"
          echo "entrypoint: B-1148 copied sibling Codex thread $SIBLING_CODEX_THREAD_ID into this conduction's codex-sessions." >&2
        else
          echo "entrypoint: B-1148 failed to copy sibling Codex thread $SIBLING_CODEX_THREAD_ID — cold-starting instead." >&2
        fi
      fi
    fi
  fi

  if [ "$SESSION_RESUME_ENABLED" = "true" ] && [ "$ENTRY_AGENT_ADAPTER" != "codex" ]; then
    CURRENT_HAS_SESSION=0
    for existing in "$TRANSCRIPT_SUBTREE"/projects/*/*.jsonl; do
      [ -f "$existing" ] && CURRENT_HAS_SESSION=1 && break
    done
    if [ "$CURRENT_HAS_SESSION" = "0" ] && [ -d "$HARMONY_TRANSCRIPT_MOUNT_ROOT/$TICKET" ]; then
      SIBLING_SESSION_PATH=""
      SIBLING_NEWEST_MTIME=0
      for sibling_dir in "$HARMONY_TRANSCRIPT_MOUNT_ROOT/$TICKET"/*/; do
        [ -d "$sibling_dir" ] || continue
        sibling_id="$(basename "$sibling_dir")"
        [ "$sibling_id" = "$CONDUCTION_ID" ] && continue
        for jsonl in "${sibling_dir}projects"/*/*.jsonl; do
          [ -f "$jsonl" ] || continue
          mtime="$(stat -c '%Y' "$jsonl" 2>/dev/null || echo 0)"
          if [ "$mtime" -gt "$SIBLING_NEWEST_MTIME" ]; then
            SIBLING_NEWEST_MTIME="$mtime"
            SIBLING_SESSION_PATH="$jsonl"
          fi
        done
      done
      if [ -n "$SIBLING_SESSION_PATH" ]; then
        # B-772 round 2: the ACTUAL --resume injection (+ the narrowed session-resume
        # context-budget guard, which needs a node accessor into the plugin's OWN committed dist)
        # is deferred to b772_finish_cross_conduction_resume, called once $PLUGIN_DIR is resolved
        # further down (this gcsfuse block runs BEFORE any repo is cloned — there is no dist/
        # on disk yet at this point in the script). Only the discovery itself (this whole `if`)
        # stays here, unchanged, since it needs no plugin code at all.
        SIBLING_SESSION_ID="$(basename "$SIBLING_SESSION_PATH" .jsonl)"
      fi
    fi
  fi
fi

# B-772 round 2: finish what the B-718 cross-conduction discovery above started — called ONLY once
# $PLUGIN_DIR is resolved and cloned (both dispatch sites below call this immediately before
# handing off to provision.sh), because the narrowed session-resume guard needs
# `harmony model context-budget` from the plugin's OWN committed dist, which does not exist on disk
# any earlier in this script (see the discovery block's own comment above). A no-op when discovery
# found nothing (`$SIBLING_SESSION_PATH` unset — including the ordinary case where
# HARMONY_TRANSCRIPT_MOUNT_ROOT is unset entirely, the local-docker profile). Best-effort throughout,
# matching every other guard in this file: a lookup failure (no node/dist yet, a malformed budget)
# degrades to "inject the resume" — the SAME AC5 --resume-is-best-effort fallback downstream in
# provision.sh already covers a resume that turns out to be unusable for any OTHER reason.
b772_finish_cross_conduction_resume() {
  local plugin_dir="$1"
  [ -n "${SIBLING_SESSION_PATH:-}" ] || return 0
  if [ -n "${HARMONY_MODEL:-}" ]; then
    local sibling_size_bytes context_budget_bytes
    sibling_size_bytes="$(stat -c '%s' "$SIBLING_SESSION_PATH" 2>/dev/null || echo 0)"
    context_budget_bytes="$(node "$plugin_dir/dist/bin/harmony.js" model context-budget "$HARMONY_MODEL" 2>/dev/null || true)"
    if [ -n "$context_budget_bytes" ] && [ "$sibling_size_bytes" -gt "$context_budget_bytes" ] 2>/dev/null; then
      echo "entrypoint: B-772 sibling session $SIBLING_SESSION_ID is ${sibling_size_bytes} bytes, over model '$HARMONY_MODEL''s ${context_budget_bytes}-byte resume budget — NOT injecting --resume (session-resume guard)." >&2
      return 0
    fi
  fi
  # B-895: the CLI resolves `--resume <id>` purely by scanning $HOME/.claude/projects — which, for
  # THIS conduction, is symlinked (above) onto $TRANSCRIPT_SUBTREE/projects, NOT onto the SIBLING
  # conduction's own $TRANSCRIPT_SUBTREE/projects subtree the discovery above found the session
  # file under. Injecting --resume with an id the CLI can never locally resolve is confirmed — twice,
  # in production — to ALWAYS fail to attach. So before injecting, copy the sibling's session file
  # into THIS conduction's own projects/<slug> tree (reusing the SAME slug directory name the
  # sibling used — deterministic per-workdir, so it is exactly where the CLI will look for THIS
  # conduction too). Best-effort, matching this function's own AC5 promise: any copy failure
  # (permission error, disk error, a racing reap of the sibling directory, ...) must NOT inject a
  # --resume already known to fail — decline and let the leg cold-start instead, logging why.
  local sibling_slug dest_dir dest_file
  sibling_slug="$(basename "$(dirname "$SIBLING_SESSION_PATH")")"
  dest_dir="$TRANSCRIPT_SUBTREE/projects/$sibling_slug"
  dest_file="$dest_dir/$(basename "$SIBLING_SESSION_PATH")"
  if ! mkdir -p "$dest_dir" 2>/dev/null || ! cp "$SIBLING_SESSION_PATH" "$dest_file" 2>/dev/null; then
    echo "entrypoint: B-895 failed to copy sibling session $SIBLING_SESSION_ID into this conduction's own projects tree ($dest_dir) — the CLI could never resolve it there, so declining to inject --resume and cold-starting instead" >&2
    return 0
  fi

  export CLAUDE_HEADLESS_FLAGS="${CLAUDE_HEADLESS_FLAGS:-} --resume $SIBLING_SESSION_ID"
  echo "entrypoint: B-718 cross-conduction resume — found a prior $TICKET session ($SIBLING_SESSION_ID) from another conduction, injecting --resume" >&2
}

# Fresh clone per start is the accepted v1 tradeoff (see the B-694 design
# entry); idempotent when a persistent volume already carries the clones.
clone() { # $1 = url, $2 = ref, $3 = dir
  if [ ! -e "$3/.git" ]; then
    git clone --branch "$2" "$1" "$3"
  fi
}

# B-803 / B-814: HARMONY_PLUGIN_POSTURE (prod | ack:<ref> | bare <ref>) ALWAYS supplies/overrides
# the clone ref for the repo entry that carries the plugin — for a `repos[]` entry this means
# `repos[].ref` is NEVER read for the entry with `is_plugin: true`; in the fallback three-slot shape
# below it means PLUGIN_REF is derived from the posture, never from a separate knob. (PLUGIN_REF and
# HARMONY_ACK_PLUGIN_AHEAD_OF_PROD do not exist in code any more — B-803 collapsed both into this one
# var — so neither is an alternative source here.) Defaults to "prod" when unset, stripping the
# "ack:" prefix (that prefix matters only to provision.sh's fail-closed guard, downstream).
#
# B-1222: production is the default for new deployments. A staging project explicitly
# supplies ack:staging through the merged config, mint and both launchers (regression-tested).
# Both prod and staging carry generated dist/; main remains source-only.
plugin_ref_from_posture() {
  local posture="${HARMONY_PLUGIN_POSTURE:-prod}"
  printf '%s' "${posture#ack:}"
}

# --- B-1478: take the plugin from the released download, when the project opts in. ------------
# .harmony/conductor.json "plugin_source": "release" (-> HARMONY_PLUGIN_SOURCE) with plugin_release.base_url
# (-> HARMONY_PLUGIN_RELEASE_URL) makes this leg fetch the channel's release from the gated download endpoint
# instead of cloning the plugin: <base>/<channel>/release.json, then the zip it names, both with the board API
# token as a bearer. The zip must match release.json's sha256, its own .claude-plugin/plugin.json version must
# equal release.json's version, and the tree must carry container/release-runtime. It is then extracted to
# $HOME/harmony-plugin, made read-only, exported as HARMONY_PLUGIN_DIR, and ITS container/provision.sh is exec'd
# exactly as a clone's would be. The repos[] entry with is_plugin is then not cloned; every other repo still is.
#
# ANY failure prints exactly one stderr line, `PLUGIN-SOURCE-FALLBACK: <reason>; cloning <ref>`, and the leg
# clones exactly as it does without the setting. The outcome reaches provision.sh as HARMONY_PLUGIN_SOURCE_RESULT
# (release | clone | clone-fallback(<reason>)). With the setting ABSENT nothing here runs and nothing new is
# exported: the leg is what it was before B-1478 (src/daemon/plugin-source-parity.test.ts). The token is only
# ever written to a mode-600 header file that is removed before the hand-off; it is never in argv or output.
B1478_RELEASE_DIR=""
B1478_REASON=""
B1478_WORK=""

b1478_channel_from_posture() {
  case "${HARMONY_PLUGIN_POSTURE:-prod}" in
    prod) printf 'prod' ;;
    ack:staging | staging) printf 'staging' ;;
    *) return 1 ;;
  esac
}

# $1 = url, $2 = output file, $3 = max bytes. Sets B1478_CODE to the HTTP status; fails (and sets B1478_REASON)
# on a transport error. Redirects are followed over https only; curl drops the bearer on a redirect to another
# host. The bearer is read from a mode-600 header file, never from argv.
B1478_CODE=""
b1478_get() {
  local rc=0
  B1478_CODE="$(curl -sS -L --proto '=https' --proto-redir '=https' --max-redirs 3 --connect-timeout 10 --max-time 300 \
    --max-filesize "$3" -H "@$B1478_WORK/auth-header" -o "$2" -w '%{http_code}' "$1" 2>"$B1478_WORK/curl-err")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    B1478_REASON="$(basename "$2") request failed (curl exit $rc: $(head -c 200 "$B1478_WORK/curl-err" | tr -d '\r\n'))"
    return 1
  fi
  return 0
}

# $1 = what was fetched, $2 = HTTP code. Sets B1478_REASON for a non-200.
b1478_http_ok() {
  case "$2" in
    200) return 0 ;;
    401 | 403) B1478_REASON="$1: token refused (HTTP $2)" ;;
    *) B1478_REASON="$1: HTTP $2" ;;
  esac
  return 1
}

b1478_fetch_release() {
  local base channel tool release version object sha bytes rest zip_url actual tree zip_version dest
  base="${HARMONY_PLUGIN_RELEASE_URL:-}"
  base="${base%/}"
  if [ -z "$base" ]; then B1478_REASON="plugin_release.base_url (HARMONY_PLUGIN_RELEASE_URL) is not set"; return 1; fi
  if ! [[ "$base" =~ ^https://[A-Za-z0-9._~:/%@-]+$ ]]; then B1478_REASON="plugin_release.base_url is not a plain https:// URL"; return 1; fi
  if ! channel="$(b1478_channel_from_posture)"; then
    B1478_REASON="posture '${HARMONY_PLUGIN_POSTURE//[^A-Za-z0-9:._-]/?}' has no published release channel (only prod and staging do)"
    return 1
  fi
  if [ -z "${HARMONY_API_TOKEN:-}" ]; then B1478_REASON="HARMONY_API_TOKEN is not set"; return 1; fi
  for tool in curl jq sha256sum unzip; do
    command -v "$tool" >/dev/null 2>&1 || { B1478_REASON="$tool is not available in this image"; return 1; }
  done
  mkdir -p "$HOME" 2>/dev/null || true
  B1478_WORK="$(mktemp -d "$HOME/.harmony-plugin-release.XXXXXX" 2>/dev/null)" || { B1478_REASON="could not create a work directory under \$HOME"; return 1; }
  ( umask 077; printf 'Authorization: Bearer %s\n' "$HARMONY_API_TOKEN" >"$B1478_WORK/auth-header" ) || { B1478_REASON="could not write the request header"; return 1; }

  b1478_get "$base/$channel/release.json" "$B1478_WORK/release.json" 1048576 || return 1
  b1478_http_ok release.json "$B1478_CODE" || return 1
  release="$B1478_WORK/release.json"
  if ! jq -e '.schema == 1 and (.version | type == "string") and (.zip.object | type == "string") and (.zip.sha256 | type == "string")' "$release" >/dev/null 2>&1; then
    B1478_REASON="release.json is not a schema-1 release record"
    return 1
  fi
  version="$(jq -r '.version' "$release")"
  object="$(jq -r '.zip.object' "$release")"
  sha="$(jq -r '.zip.sha256' "$release")"
  bytes="$(jq -r '.zip.bytes // 0' "$release")"
  if ! [[ "$version" =~ ^[0-9A-Za-z.+-]+$ ]]; then B1478_REASON="release.json version is malformed"; return 1; fi
  if ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then B1478_REASON="release.json zip.sha256 is malformed"; return 1; fi
  case "$object" in
    "channels/$channel/"*) rest="${object#"channels/$channel/"}" ;;
    *) B1478_REASON="release.json zip.object is not under channels/$channel/"; return 1 ;;
  esac
  if ! [[ "$rest" =~ ^[A-Za-z0-9._/+-]+$ ]] || [[ "$rest" == *..* ]]; then B1478_REASON="release.json zip.object is malformed"; return 1; fi
  if ! [[ "$bytes" =~ ^[0-9]+$ ]]; then bytes=0; fi
  zip_url="$base/$channel/$rest"

  b1478_get "$zip_url" "$B1478_WORK/plugin.zip" 268435456 || return 1
  b1478_http_ok "the release zip" "$B1478_CODE" || return 1
  rm -f "$B1478_WORK/auth-header"
  actual="$(sha256sum "$B1478_WORK/plugin.zip" | cut -d' ' -f1)"
  if [ "$actual" != "$sha" ]; then B1478_REASON="checksum mismatch (zip sha256 $actual, release.json says $sha)"; return 1; fi

  tree="$B1478_WORK/tree"
  local unzip_rc=0
  unzip -q "$B1478_WORK/plugin.zip" -d "$tree" >/dev/null 2>&1 || unzip_rc=$?
  if [ "$unzip_rc" -ne 0 ]; then
    B1478_REASON="extract failed (unzip exit $unzip_rc)"
    return 1
  fi
  zip_version="$(jq -r '.version // empty' "$tree/.claude-plugin/plugin.json" 2>/dev/null || true)"
  if [ "$zip_version" != "$version" ]; then
    B1478_REASON="version mismatch (the zip's plugin.json says '${zip_version//[^0-9A-Za-z.+-]/?}', release.json says '$version')"
    return 1
  fi
  if [ ! -f "$tree/container/release-runtime" ]; then
    B1478_REASON="release $version has no container/release-runtime marker (it predates worker release support)"
    return 1
  fi
  if [ ! -x "$tree/container/provision.sh" ]; then
    B1478_REASON="release $version has no executable container/provision.sh"
    return 1
  fi

  dest="$HOME/harmony-plugin"
  if [ -e "$dest" ]; then
    chmod -R u+w "$dest" 2>/dev/null || true
    rm -rf "$dest" || { B1478_REASON="could not replace an existing $dest"; return 1; }
  fi
  mv "$tree" "$dest" || { B1478_REASON="could not install the release at $dest"; return 1; }
  chmod -R a-w "$dest" || { B1478_REASON="could not make $dest read-only"; return 1; }
  B1478_RELEASE_DIR="$dest"
  echo "entrypoint: B-1478 plugin from the $channel release $version (sha256 $sha, $(stat -c %s "$B1478_WORK/plugin.zip" 2>/dev/null || echo "$bytes") bytes) at $dest" >&2
  return 0
}

case "${HARMONY_PLUGIN_SOURCE:-}" in
  "") ;; # absent: the clone, exactly as before B-1478 — nothing exported
  clone) export HARMONY_PLUGIN_SOURCE_RESULT=clone ;;
  release)
    b1478_ok=0
    b1478_fetch_release && b1478_ok=1
    if [ -n "$B1478_WORK" ]; then rm -rf "$B1478_WORK"; fi
    if [ "$b1478_ok" = "1" ]; then
      export HARMONY_PLUGIN_DIR="$B1478_RELEASE_DIR"
      export HARMONY_PLUGIN_SOURCE_RESULT=release
    else
      B1478_RELEASE_DIR=""
      echo "PLUGIN-SOURCE-FALLBACK: $B1478_REASON; cloning $(plugin_ref_from_posture)" >&2
      export HARMONY_PLUGIN_SOURCE_RESULT="clone-fallback($B1478_REASON)"
    fi
    ;;
  *)
    B1478_REASON="plugin_source '${HARMONY_PLUGIN_SOURCE//[^A-Za-z0-9_-]/?}' is neither clone nor release"
    echo "PLUGIN-SOURCE-FALLBACK: $B1478_REASON; cloning $(plugin_ref_from_posture)" >&2
    export HARMONY_PLUGIN_SOURCE_RESULT="clone-fallback($B1478_REASON)"
    ;;
esac
# A clone leg's provision.sh runs from the clone; HARMONY_PLUGIN_DIR is the release's alone and never leaks in
# from the launch env (it is the conductor host's own plugin knob). Unsetting an unset variable changes nothing.
if [ -z "$B1478_RELEASE_DIR" ]; then unset HARMONY_PLUGIN_DIR; fi

if [ -n "${HARMONY_REPOS_JSON:-}" ]; then
  # B-814: this deployment declares its own arbitrary, ordered repo set — a `repos` section in
  # deployment.json, transported here as base64-encoded JSON (see scripts/mint-installation-token.mjs's
  # serializeReposSection() and container/cloud-worker-launch.sh's write_exec_env_file() for why
  # base64: it's the one encoding that survives BOTH the local env-file channel and the cloud path's
  # YAML exec-env-vars-file embedding unescaped). Iterate it instead of the fixed three-slot clone
  # below — this whole branch is a no-op (falls to the `else`) when the var is absent/empty, so every
  # existing deployment with no `repos` section behaves byte-for-byte as it did before this ticket
  # (AC3).
  repos_json="$(printf '%s' "$HARMONY_REPOS_JSON" | base64 -d 2>/dev/null || true)"
  if [ -z "$repos_json" ] || ! printf '%s' "$repos_json" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
    echo "entrypoint: HARMONY_REPOS_JSON is set but did not decode to a non-empty JSON array — aborting" >&2
    exit 1
  fi

  # Provisioning is plugin code — there is no plugin-less route, so exactly one entry must carry
  # is_plugin:true (the schema, src/config/deployment-config.ts, already enforces AT MOST one; this
  # is the runtime enforcement of AT LEAST one).
  PLUGIN_DIR="$(printf '%s' "$repos_json" | jq -r '[.[] | select(.is_plugin == true)][0].path // empty')"
  if [ -z "$PLUGIN_DIR" ]; then
    echo "entrypoint: no repos[] entry has is_plugin:true — provisioning is plugin code, there is no plugin-less route" >&2
    exit 1
  fi
  # B-1478: a release leg runs the release's provision.sh and does not clone the is_plugin entry.
  if [ -n "$B1478_RELEASE_DIR" ]; then PLUGIN_DIR="$B1478_RELEASE_DIR"; fi

  # B-726 (a/a1) preserved: when one entry declares meta_repo_role, clone it FIRST — every other
  # entry then clones nested inside it (when its own path falls inside the meta entry's path) or as
  # a sibling, mirroring the interactive layout so CLAUDE.md ancestry still loads by ordinary file
  # ancestry. When no entry declares the role, every entry just clones at its own configured path,
  # in list order.
  META_PATH="$(printf '%s' "$repos_json" | jq -r '[.[] | select(.meta_repo_role == true)][0].path // empty')"
  if [ -n "$META_PATH" ]; then
    META_URL="$(printf '%s' "$repos_json" | jq -r '[.[] | select(.meta_repo_role == true)][0].url')"
    META_REF="$(printf '%s' "$repos_json" | jq -r '[.[] | select(.meta_repo_role == true)][0].ref // "main"')"
    clone "$META_URL" "$META_REF" "$META_PATH"
  fi

  # NOTE: split on ASCII 0x1f (unit separator), not a tab (@tsv) — bash's `read` treats tab as
  # "IFS whitespace" and SQUEEZES consecutive delimiters together regardless of what IFS is set to,
  # silently dropping the empty `ref` field (and shifting every field after it) for any non-plugin
  # entry that omits `ref`. 0x1f has no such special-casing, so an empty field reads back as empty,
  # not absorbed. (Originally 0x01/CTLESC — B-869/B-826: bash <4, e.g. stock macOS bash 3.2, uses
  # byte 0x01 internally as its quote-removal escape marker, so IFS=$'\\x01' silently corrupts fields
  # containing it on those shells. 0x1f has no such internal meaning to bash at any version.)
  while IFS=$'\x1f' read -r url ref path is_plugin_flag meta_flag; do
    # The meta entry, if any, was already cloned above.
    [ "$meta_flag" = "true" ] && continue
    if [ "$is_plugin_flag" = "true" ]; then
      # B-1478: the plugin came from the released download (above); nothing to clone for this entry.
      [ -n "$B1478_RELEASE_DIR" ] && continue
      # B-803/B-814 ref precedence (see plugin_ref_from_posture's own comment above): the posture
      # knob wins for the is_plugin entry — this entry's own `ref` (already read into $ref below,
      # from the deployment config) is deliberately discarded here, never consulted.
      ref="$(plugin_ref_from_posture)"
    elif [ -z "$ref" ]; then
      ref="main"
    fi
    clone "$url" "$ref" "$path"
  done < <(printf '%s' "$repos_json" | jq -r '.[] | [(.url|tostring), ((.ref // "")|tostring), (.path|tostring), ((.is_plugin // false)|tostring), ((.meta_repo_role // false)|tostring)] | join("\u001f")')

  b772_finish_cross_conduction_resume "$PLUGIN_DIR"
  exec "$PLUGIN_DIR/container/provision.sh" "$@"
fi

# --- Fallback: HARMONY_REPOS_JSON absent/empty (AC3) -------------------------------------------
# No `repos` section anywhere in this deployment's config — behave BYTE-FOR-BYTE as this script did
# before B-814: the fixed three-slot WEB_REPO/PLUGIN_REPO/WORKSPACE_REPO clone.
WEB_REPO="${WEB_REPO:-https://github.com/ycomplex/harmony-web.git}"
PLUGIN_REPO="${PLUGIN_REPO:-https://github.com/ycomplex/harmony-plugin.git}"
WORKSPACE_REPO="${WORKSPACE_REPO:-https://github.com/ycomplex/harmony-workspace.git}"
WEB_REF="${WEB_REF:-main}"
export PLUGIN_REF="$(plugin_ref_from_posture)"
WORKSPACE_REF="${WORKSPACE_REF:-main}"

# B-726 (a/a1): clone the meta-repo FIRST, then web+plugin INSIDE it — mirrors
# the interactive layout so all three CLAUDE.md levels load by ordinary file
# ancestry (workspace/CLAUDE.md, web/CLAUDE.md, plugin/CLAUDE.md). web/ and
# plugin/ are gitignored placeholders in the workspace repo (see its
# .gitignore) precisely for this.
clone "$WORKSPACE_REPO" "$WORKSPACE_REF" /workspace/workspace
clone "$WEB_REPO" "$WEB_REF" /workspace/workspace/web
if [ -n "$B1478_RELEASE_DIR" ]; then
  # B-1478: the plugin came from the released download (above); it is not cloned.
  b772_finish_cross_conduction_resume "$B1478_RELEASE_DIR"
  exec "$B1478_RELEASE_DIR/container/provision.sh" "$@"
fi
clone "$PLUGIN_REPO" "$PLUGIN_REF" /workspace/workspace/plugin

b772_finish_cross_conduction_resume /workspace/workspace/plugin
exec /workspace/workspace/plugin/container/provision.sh "$@"
