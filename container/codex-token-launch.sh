#!/usr/bin/env bash
# B-1306 names-only context; sourcing this performs no credential or cluster read.
codex_token_context() {
  CODEX_TOKEN_ONLY=0
  [ "${CODEX_RUN:-0}" = 1 ] && [ "${CODEX_PROVIDER:-openai}" = openai ] || return 0
  case "${HARMONY_CODEX_TOKEN_ONLY:-0}" in
    0|'') return 0 ;;
    1) ;;
    *) echo 'codex-login-configuration-missing: invalid delivery switch' >&2; exit 1 ;;
  esac
  if ! printf '%s' "${HARMONY_CODEX_ACCESS_RESOURCE:-}" | grep -Eq '^projects/[a-zA-Z0-9-]+/secrets/harmony-codex-access$'; then
    echo 'codex-login-configuration-missing: set the access-only resource name' >&2
    exit 1
  fi
  CODEX_TOKEN_ONLY=1
}

# Enabled-only extension; the legacy adapter's per-leg allowlist is unchanged.
codex_token_exec_env() {
  printf 'HARMONY_CODEX_TOKEN_ONLY: "1"\nHARMONY_CODEX_ACCESS_RESOURCE: "%s"\n' "$HARMONY_CODEX_ACCESS_RESOURCE"
}
