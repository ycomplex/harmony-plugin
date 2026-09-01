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

  if [ "$SESSION_RESUME_ENABLED" = "true" ]; then
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
# var — so neither is an alternative source here.) Defaults to "main" when unset, stripping the
# "ack:" prefix (that prefix matters only to provision.sh's fail-closed guard, downstream).
plugin_ref_from_posture() {
  local posture="${HARMONY_PLUGIN_POSTURE:-main}"
  printf '%s' "${posture#ack:}"
}

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

  # NOTE: split on ASCII 0x01, not a tab (@tsv) — bash's `read` treats tab as "IFS whitespace" and
  # SQUEEZES consecutive delimiters together regardless of what IFS is set to, silently dropping the
  # empty `ref` field (and shifting every field after it) for any non-plugin entry that omits `ref`.
  # 0x01 has no such special-casing, so an empty field reads back as empty, not absorbed.
  while IFS=$'\x01' read -r url ref path is_plugin_flag meta_flag; do
    # The meta entry, if any, was already cloned above.
    [ "$meta_flag" = "true" ] && continue
    if [ "$is_plugin_flag" = "true" ]; then
      # B-803/B-814 ref precedence (see plugin_ref_from_posture's own comment above): the posture
      # knob wins for the is_plugin entry — this entry's own `ref` (already read into $ref below,
      # from the deployment config) is deliberately discarded here, never consulted.
      ref="$(plugin_ref_from_posture)"
    elif [ -z "$ref" ]; then
      ref="main"
    fi
    clone "$url" "$ref" "$path"
  done < <(printf '%s' "$repos_json" | jq -r '.[] | [(.url|tostring), ((.ref // "")|tostring), (.path|tostring), ((.is_plugin // false)|tostring), ((.meta_repo_role // false)|tostring)] | join("\u0001")')

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
clone "$PLUGIN_REPO" "$PLUGIN_REF" /workspace/workspace/plugin

b772_finish_cross_conduction_resume /workspace/workspace/plugin
exec /workspace/workspace/plugin/container/provision.sh "$@"
