#!/usr/bin/env bash
# B-1163: delete a ticket's per-ticket disk (a PersistentVolumeClaim named `ticket-<key>-<number>`,
# e.g. ticket-b-1060 for B-1060) once the ticket is Verified, Cancelled or archived. Run it on the
# conductor host on a schedule (cron / launchd). It uses the CURRENT kubeconfig and kubectl context — it
# creates none.
#
#   bash container/gke/sweep-ticket-disks.sh [--namespace <ns>] [--env-file <path>|none] [--dry-run]
#
#   --env-file <path>  the conductor's KEY=VALUE settings (HARMONY_API_TOKEN for the ticket-state reads), loaded
#                      first. Default ~/.harmony/conductor.env, else the legacy ~/.harmony/daemon.env, skipped when absent; `none` skips it. Under
#                      launchd there is no login shell, so without it every state read fails and the sweep
#                      keeps every disk (exit 3).
#   --namespace <ns>   default $HARMONY_GKE_NAMESPACE, else harmony-legs
#   --dry-run          print the `kubectl delete` it would run instead of running it (reads still run)
#
# Why it never looks INSIDE a disk (B-1164): the "keep a disk whose checkout has unpushed commits" rule
# is replaced by an invariant. The git checkout lives at /workspace/workspace in the CONTAINER filesystem,
# which dies with the pod; the ticket disk carries only the engine cache (docker), transcripts and the
# Playwright cache (LEG_DISK_MOUNTS in gke-render-leg.mjs). Nothing on a ticket disk can hold unpushed
# work, and gke-render-leg.test.ts asserts that no LEG_DISK_MOUNTS entry is a checkout. So the sweep decides on
# ticket state alone and never mounts or inspects a disk.
#
# Rules:
#   * Only PVCs named ticket-<letters>-<digits> are ever considered; every other PVC is not touched.
#   * Verified, Cancelled or archived => delete. Anything else (Parked included — it can resume) => keep.
#   * Taken away from the conductor (conductor_excluded_at set) => the disk is kept until 24 hours after that
#     timestamp, with a line saying when it will be deleted; after that it is deleted.
#   * A PVC a live pod still mounts is kept.
#   * FAIL CLOSED: if a ticket's state cannot be read or parsed, its PVC is kept, a warning names it, and
#     the run ends with exit code 3 (after processing the rest). Otherwise exit 0.
#   * The ticket's state is read with the harmony CLI (`node $HARMONY_PLUGIN_DIR/dist/bin/harmony.js` when
#     HARMONY_PLUGIN_DIR is set, else `harmony` on PATH). Output: PVC names, ticket ids, states, a summary.
set -euo pipefail

NAMESPACE="${HARMONY_GKE_NAMESPACE:-harmony-legs}"
DRY_RUN=0
# B-1171: conductor.env is the file to create; daemon.env is the legacy fallback.
if [ -f "${HOME:-}/.harmony/conductor.env" ]; then ENV_FILE="${HOME:-}/.harmony/conductor.env"; else ENV_FILE="${HOME:-}/.harmony/daemon.env"; fi
ENV_FILE_EXPLICIT=0
TAKE_AWAY_GRACE_S=86400

usage() {
  cat <<'USAGE'
Usage: sweep-ticket-disks.sh [--namespace <ns>] [--env-file <path>|none] [--dry-run]

Deletes the per-ticket disk (PVC ticket-<key>-<number>) of every Verified, Cancelled or archived ticket,
and of every ticket taken away from the conductor (conductor_excluded_at) more than 24 hours ago.
  --namespace <ns>   [$HARMONY_GKE_NAMESPACE, else harmony-legs]
  --env-file <path>  load the conductor's settings first; `none` skips  [~/.harmony/conductor.env, else the legacy daemon.env, if present]
  --dry-run          show the deletes instead of running them
  -h, --help         this text
Exit codes: 0 ok; 1 could not list PVCs / pods; 2 bad usage; 3 some ticket's state could not be read (its disk was kept).
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --namespace)
      [ $# -ge 2 ] || { echo "sweep: --namespace needs a value" >&2; usage >&2; exit 2; }
      NAMESPACE="$2"; shift 2 ;;
    --env-file)
      [ $# -ge 2 ] || { echo "sweep: --env-file needs a value" >&2; usage >&2; exit 2; }
      ENV_FILE="$2"; ENV_FILE_EXPLICIT=1; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "sweep: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$ENV_FILE" != "none" ]; then
  if [ -f "$ENV_FILE" ]; then
    bash -n "$ENV_FILE" >/dev/null 2>&1 || { echo "sweep: env file is not valid shell syntax: $ENV_FILE" >&2; exit 2; }
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE" 2>/dev/null || { set +a; echo "sweep: env file could not be loaded: $ENV_FILE" >&2; exit 2; }
    set +a
    echo "loaded env file $ENV_FILE (values not shown)"
  elif [ "$ENV_FILE_EXPLICIT" -eq 1 ]; then
    echo "sweep: env file not found: $ENV_FILE" >&2; exit 2
  fi
fi

harmony_cmd() {
  if [ -n "${HARMONY_PLUGIN_DIR:-}" ]; then
    node "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" "$@"
  else
    harmony "$@"
  fi
}

# stdin: the `tasks get` JSON. stdout: "<workflow_state><TAB><archived><TAB><excluded>" where <excluded> is
# the conductor_excluded_at time as epoch seconds, or "-" when unset; non-zero when unreadable (including
# a conductor_excluded_at that is set but is not a date).
parse_task() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        if (typeof j.workflow_state !== "string" || j.workflow_state === "") process.exit(1);
        let ex = "-";
        if (j.conductor_excluded_at !== undefined && j.conductor_excluded_at !== null) {
          const ms = Date.parse(j.conductor_excluded_at);
          if (!Number.isFinite(ms)) process.exit(1);
          ex = String(Math.floor(ms / 1000));
        }
        process.stdout.write(j.workflow_state + "\t" + (j.archived === true ? "true" : "false") + "\t" + ex);
      } catch {
        process.exit(1);
      }
    });
  '
}

if ! pvc_list="$(kubectl -n "$NAMESPACE" get pvc -o 'jsonpath={range .items[*]}{.metadata.name}{"\n"}{end}')"; then
  echo "sweep: could not list PVCs in namespace $NAMESPACE" >&2
  exit 1
fi
if ! mounted="$(kubectl -n "$NAMESPACE" get pods '--field-selector=status.phase!=Succeeded,status.phase!=Failed' \
  -o 'jsonpath={range .items[*]}{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{"\n"}{end}{end}')"; then
  echo "sweep: could not list pods in namespace $NAMESPACE — deleting nothing" >&2
  exit 1
fi

deleted=0 kept=0 skipped=0 unreadable=0
while IFS= read -r pvc; do
  [ -n "$pvc" ] || continue
  if [[ ! "$pvc" =~ ^ticket-([a-z]+)-([0-9]+)$ ]]; then
    skipped=$((skipped + 1))
    continue
  fi
  key="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]')"
  ticket="$key-${BASH_REMATCH[2]}"

  if grep -qxF -- "$pvc" <<<"$mounted"; then
    echo "keep $pvc ($ticket): mounted by a running pod"
    kept=$((kept + 1))
    continue
  fi

  if ! json="$(harmony_cmd --json tasks get "$ticket" 2>/dev/null </dev/null)" || ! parsed="$(printf '%s' "$json" | parse_task)"; then
    echo "WARNING: could not read the state of $ticket — keeping $pvc" >&2
    unreadable=$((unreadable + 1))
    kept=$((kept + 1))
    continue
  fi
  state="${parsed%%$'\t'*}"
  rest="${parsed#*$'\t'}"
  archived="${rest%%$'\t'*}"
  excluded="${rest#*$'\t'}"

  if [ "$state" = "Verified" ] || [ "$state" = "Cancelled" ] || [ "$archived" = "true" ]; then
    echo "delete $pvc ($ticket): state $state, archived $archived"
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "[dry-run] kubectl -n $NAMESPACE delete pvc $pvc --wait=false"
    else
      kubectl -n "$NAMESPACE" delete pvc "$pvc" --wait=false </dev/null
    fi
    deleted=$((deleted + 1))
  elif [ "$excluded" != "-" ]; then
    due=$((excluded + TAKE_AWAY_GRACE_S))
    if [ "$(date +%s)" -ge "$due" ]; then
      echo "delete $pvc ($ticket): taken away from the conductor more than 24h ago (state $state)"
      if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] kubectl -n $NAMESPACE delete pvc $pvc --wait=false"
      else
        kubectl -n "$NAMESPACE" delete pvc "$pvc" --wait=false </dev/null
      fi
      deleted=$((deleted + 1))
    else
      due_iso="$(node -e 'process.stdout.write(new Date(Number(process.argv[1]) * 1000).toISOString())' "$due")"
      echo "keep $pvc ($ticket): taken away from the conductor, will be deleted at $due_iso"
      kept=$((kept + 1))
    fi
  else
    echo "keep $pvc ($ticket): state $state"
    kept=$((kept + 1))
  fi
done <<<"$pvc_list"

echo "sweep summary: deleted $deleted, kept $kept, skipped $skipped (not ticket disks)$([ "$DRY_RUN" -eq 1 ] && echo ' [dry-run]')"
[ "$unreadable" -eq 0 ] || exit 3
