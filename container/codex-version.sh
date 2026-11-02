#!/usr/bin/env bash
# Read the single supported CLI pin. Never fall back to npm latest or an image marker.
codex_supported_version() {
  local pin
  pin="$(cat "${1:?version file required}" 2>/dev/null)" || return 1
  [[ "$pin" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s\n' "$pin"
}

codex_version_matches() {
  local pin
  pin="$(codex_supported_version "$1")" || return 1
  [ "$2" = "codex-cli $pin" ]
}
