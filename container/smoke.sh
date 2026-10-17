#!/usr/bin/env bash
# B-929: the worker-image publish smoke gate.
#
# ONE script, TWO callers, so the assertion depth is identical in both and is settled pre-merge:
#   * container/cloudbuild.yaml — runs it BETWEEN `build` and the pushes, so a failing image never
#     becomes :latest and the fleet keeps running the last good image.
#   * .github/workflows/ci.yml (the toolchain-contract job) — runs it against the PR's own build,
#     so a smoke that would fail on publish fails on the PR instead.
#
# Usage: container/smoke.sh <image-ref>
#
# DEPTH ACHIEVED (recorded here and in container/README.md, per the B-929 plan's instruction to say
# exactly how deep this really goes):
#   1. the base toolchain binaries all resolve AS THE NON-ROOT WORKER;
#   2. the entrypoint is present at its baked path and is executable;
#   3. the entrypoint's mode dispatch genuinely RUNS, credential-free, in three progressively
#      deeper probes — the deepest of which executes base64 + jq + the whole HARMONY_REPOS_JSON
#      repo-selection branch before failing on a DELIBERATELY invalid repo set.
#
# The entrypoint has no --help and no no-op mode: its first act is to require GIT_TOKEN, and its
# next is to clone. So "runs clean" is not available at any depth — what IS available, and is what
# this asserts, is that it reaches each successive guard and fails there with THAT guard's own
# message, which is exactly what a broken image (missing bash/jq/base64, unexecutable entrypoint,
# wrong user, truncated COPY) would NOT do. A real clone/agent run needs a live GitHub credential
# and is out of scope for a publish gate.
#
# B-1076 adds step 4 (agent CLIs). It applies ONLY to an image that carries an agent layer — the
# PR's toolchain-contract job smokes the agent-neutral `base` target, which has neither CLI and is
# skipped there with a message. The published `agent-codex` image carries BOTH, and a missing or
# non-running `codex` fails the publish, so a bad Codex release never becomes :latest.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image-ref>}"

fail() { echo "smoke: FAIL — $*" >&2; exit 1; }
ok()   { echo "smoke: ok — $*"; }

echo "smoke: probing $IMAGE"

# --- 1. Base toolchain -------------------------------------------------------
# git/gh (clone + PRs), jq (provision.sh parses get_project), python3 (the settings-triple writer),
# node (everything), corepack + fnm (B-929 lever 1's toolchain manager). Resolved through the
# image's OWN default user, not root — a root-only PATH would be a real defect.
for bin in git gh jq python3 node corepack fnm; do
  docker run --rm --entrypoint /bin/sh "$IMAGE" -c "command -v $bin >/dev/null" \
    || fail "$bin is not on PATH for the image's default user"
done
ok "toolchain present: git gh jq python3 node corepack fnm"

echo "smoke: versions —"
docker run --rm --entrypoint /bin/sh "$IMAGE" -c \
  'echo "  node      $(node --version)"; echo "  corepack  $(corepack --version)"; echo "  fnm       $(fnm --version)"'

# --- 2. The baked entrypoint -------------------------------------------------
docker run --rm --entrypoint /bin/sh "$IMAGE" -c \
  '[ -x /usr/local/bin/harmony-entrypoint.sh ]' \
  || fail "/usr/local/bin/harmony-entrypoint.sh is missing or not executable"
ok "entrypoint present and executable"

# --- 3. Credential-free dispatch, three depths -------------------------------
# Every probe below MUST fail (the entrypoint refuses to do anything without credentials) — what is
# asserted is WHICH guard it reached, i.e. how far the script actually executed.

# 3a. No env at all: the entrypoint's very first guard.
out="$(docker run --rm "$IMAGE" shell 2>&1 || true)"
case "$out" in
  *GIT_TOKEN*) ok "dispatch runs: reached the GIT_TOKEN env-contract guard" ;;
  *) fail "no-env run did not reach the GIT_TOKEN guard; got: $out" ;;
esac

# 3b. Past that guard, into the repo-set branch — a deliberately undecodable HARMONY_REPOS_JSON.
# Reaching this proves the askpass helper was written, the transcript block was correctly skipped,
# and base64 ran.
out="$(docker run --rm -e GIT_TOKEN=smoke-not-a-real-token -e HARMONY_REPOS_JSON='!!!not-base64!!!' \
  "$IMAGE" shell 2>&1 || true)"
case "$out" in
  *"did not decode to a non-empty JSON array"*)
    ok "dispatch runs: reached the HARMONY_REPOS_JSON decode guard" ;;
  *) fail "invalid-repos run did not reach the decode guard; got: $out" ;;
esac

# 3c. Deepest credential-free point: a WELL-FORMED repo set that declares no is_plugin entry. This
# executes base64 -d AND jq AND the whole repo-selection branch before the runtime enforcement
# rejects it — i.e. the image's own tooling did real work, not just failed early.
repos_b64="$(printf '%s' '[{"url":"https://example.invalid/x.git","path":"/workspace/x"}]' | base64 | tr -d '\n')"
out="$(docker run --rm -e GIT_TOKEN=smoke-not-a-real-token -e HARMONY_REPOS_JSON="$repos_b64" \
  "$IMAGE" shell 2>&1 || true)"
case "$out" in
  *"no repos[] entry has is_plugin:true"*)
    ok "dispatch runs: base64 + jq + the repo-selection branch all executed" ;;
  *) fail "well-formed-repos run did not reach the is_plugin guard; got: $out" ;;
esac

# --- 4. Agent CLIs (B-1076) --------------------------------------------------
# Only meaningful for an image with an agent layer. `base` has no agent by design (CI asserts it).
if docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'command -v claude >/dev/null' 2>/dev/null; then
  docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'claude --version >/dev/null' \
    || fail "claude is on PATH but 'claude --version' does not run"
  docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'command -v codex >/dev/null' \
    || fail "codex is not on PATH for the image's default user (the agent-codex target installs it)"
  codex_out="$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'codex --version' 2>&1)" \
    || fail "'codex --version' does not run; got: $codex_out"
  baked="$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'cat /etc/harmony-codex-version' 2>/dev/null || true)"
  case "$codex_out" in
    *"$baked"*) [ -n "$baked" ] || fail "/etc/harmony-codex-version is missing or empty" ;;
    *) fail "'codex --version' ($codex_out) does not match the baked /etc/harmony-codex-version ($baked)" ;;
  esac
  # The flags src/agents/codex.ts emits must still exist on THIS image's CLI (an upstream rename would
  # otherwise only surface as a dead leg). src/agents/codex-drift.test.ts runs the same assertion plus a
  # mock-provider end-to-end whenever a codex binary is on the test machine's PATH.
  exec_help="$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'codex exec --help' 2>&1)" \
    || fail "'codex exec --help' does not run; got: $exec_help"
  for flag in --json --cd --add-dir --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --strict-config; do
    case "$exec_help" in
      *"$flag"*) ;;
      *) fail "'codex exec --help' no longer lists $flag (src/agents/codex.ts emits it)" ;;
    esac
  done
  ok "agent CLIs present: claude, codex ($codex_out); codex exec flags match the adapter"
  # The Codex home must be pre-created worker-owned (B-724 applied to ~/.codex).
  docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'test -w /home/worker/.codex && test -w /home/worker/.codex/sessions' \
    || fail "/home/worker/.codex (and sessions/) is not pre-created and writable by the worker"
  ok "~/.codex pre-created worker-owned"
else
  ok "no agent layer in this image (the base target) — agent CLI probes skipped"
fi

echo "smoke: PASS — $IMAGE"
