#!/usr/bin/env bash
# B-1173: the remote conductor image's entrypoint.
#
#   entrypoint.sh <command> [args...]                 exec the command as is (the conductor: the daemon resolves its
#                                                     own secrets at boot, in src/bin/daemon.ts)
#   entrypoint.sh --with-secrets <command> [args...]  resolve the host file's secrets (HARMONY_API_TOKEN, and the
#                                                     GitHub App key) from Secret Manager into the command's
#                                                     environment first, then run it. For jobs that are not the
#                                                     daemon — the ticket-disk sweep CronJob.
#
# The resolver is dist/bin/conductor-boot.js (src/daemon/conductor-boot.ts, over src/config/conductor-secrets.ts):
# names only in argv, values only in the child's environment, never printed. Without HARMONY_CONDUCTOR_REMOTE=1 it
# resolves nothing and just runs the command.
set -euo pipefail

PLUGIN_DIR="${HARMONY_PLUGIN_DIR:-/opt/harmony-plugin}"

if [ "${1:-}" = "--with-secrets" ]; then
  shift
  if [ $# -eq 0 ]; then
    echo "conductor-entrypoint: --with-secrets needs a command to run" >&2
    exit 2
  fi
  exec node "$PLUGIN_DIR/dist/bin/conductor-boot.js" exec -- "$@"
fi

if [ $# -eq 0 ]; then
  echo "conductor-entrypoint: no command given" >&2
  exit 2
fi
exec "$@"
