#!/usr/bin/env bash
# B-1171: the ONE place the conductor's environment file is loaded, for launchd, systemd and nohup starts.
#
#   bash container/conductor-launch.sh [--config <path>] [--profile <name>]
#
# 1. Loads ~/.harmony/conductor.env (HARMONY_HOME replaces ~/.harmony) with `set -a`, so every KEY=VALUE in it
#    reaches the conductor. Values are NEVER printed.
# 2. If only the old ~/.harmony/daemon.env exists, loads that and prints ONE line telling the operator to
#    rename it.
# 3. exec's `node <this checkout>/dist/bin/daemon.js "$@"`, so the node process IS the process the supervisor
#    (or nohup) started: its pid is the one the lease holder carries and the one `harmony conductor status`
#    reports.
#
# The checkout is the one this script lives in (container/ is one level below its root), which is what makes
# the conductor "this checkout's conductor" to `harmony conductor stop|status`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$HERE")"
CONFIG_HOME="${HARMONY_HOME:-${HOME:-}/.harmony}"

ENV_FILE=""
if [ -f "$CONFIG_HOME/conductor.env" ]; then
  ENV_FILE="$CONFIG_HOME/conductor.env"
elif [ -f "$CONFIG_HOME/daemon.env" ]; then
  ENV_FILE="$CONFIG_HOME/daemon.env"
  echo "conductor-launch: reading ~/.harmony/daemon.env — rename it to ~/.harmony/conductor.env"
fi

if [ -n "$ENV_FILE" ]; then
  # bash -n and the source both discard stderr: a parse error would otherwise quote a line of the file.
  bash -n "$ENV_FILE" >/dev/null 2>&1 || { echo "conductor-launch: env file is not valid shell syntax: $ENV_FILE" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE" 2>/dev/null || { set +a; echo "conductor-launch: env file could not be loaded: $ENV_FILE" >&2; exit 1; }
  set +a
fi

: "${HARMONY_PLUGIN_DIR:=$PLUGIN_DIR}"
export HARMONY_PLUGIN_DIR

exec node "$PLUGIN_DIR/dist/bin/daemon.js" "$@"
