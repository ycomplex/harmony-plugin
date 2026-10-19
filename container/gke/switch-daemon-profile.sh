#!/usr/bin/env bash
# B-1164: switch the running conductor daemon between the "cloud" (Cloud Run) and "gke" launch profiles
# in ONE command, and confirm the new daemon adopted every run the old one held.
#
#   bash container/gke/switch-daemon-profile.sh --to gke|cloud [--config <path>] [--log <path>]
#                                               [--dry-run] [--force]
#
# The FALLBACK for a switch is the same command pointed back: `--to cloud` undoes `--to gke`.
#
# What it does, in order:
#   1. Preflight (read-only). The target profile exists in the deployment config. For gke: kubectl reaches
#      the cluster, the base Secret exists, and the profile's launch line carries HARMONY_GKE_IMAGE=. For
#      cloud: the Cloud Run job exists. Also: HARMONY_API_TOKEN and HARMONY_PLUGIN_DIR are set (the new
#      daemon is started from this shell's environment), exactly one daemon is running, and the board is
#      readable.
#   2. In-flight guard. Refuses (exit 3) while a leg is running on the OUTGOING backend (an active k8s Job in
#      the legs namespace when leaving gke; a running Cloud Run execution when leaving cloud), and names each
#      leg by TICKET and CONDUCTION ID so you can say exactly what is being waited for. Wait for them to end
#      and run again. --force skips the guard: LAST RESORT ONLY — the new daemon reaps adopted leases with its
#      OWN profile's reap script, which cannot see a leg on the other backend, so a forced switch can leave a
#      leg running twice (the old one, orphaned, plus a re-fired one).
#   3. Records the conductions the old daemon holds (from the board), SIGTERMs it (it releases its leases
#      cleanly), waits for it to exit, restarts it under nohup with `--profile <target>`.
#   4. Confirms adoption FROM THE BOARD: every held conduction is, within 3 minutes, leased by the NEW
#      daemon with a fresh heartbeat (or has legitimately left the active state). The daemon's log is read
#      only as a secondary, fuzzy corroboration and never decides the outcome — log wording is not a contract.
#
# --dry-run runs the read-only parts (preflight, guard, held-lease record), lists the in-flight legs and the
# held conductions, and prints what it WOULD do; it signals and starts nothing.
#
# Not for a launchd-supervised daemon with KeepAlive: launchd would restart the old profile the moment the
# daemon exits. Use it for a daemon started by hand under nohup (the cutover's mode).
#
# Exit codes: 0 switched and adopted; 1 preflight / stop / start failure; 2 bad usage; 3 refused, a leg is in
# flight on the outgoing backend; 4 adoption not confirmed within the timeout.
#
# Every external command (pgrep, kill, nohup, node, kubectl, gcloud, hostname, sleep, harmony) is
# resolved through PATH so tests can stub them. Knobs: HARMONY_SWITCH_TIMEOUT_S (180), HARMONY_SWITCH_POLL_S (5),
# HARMONY_SWITCH_STOP_TIMEOUT_S (60), HARMONY_SWITCH_FRESH_S (120, how recent a heartbeat must be),
# HARMONY_SWITCH_BOARD_CMD (the board query: a command printing the JSON array of `harmony --json conductions
# active`; default is that CLI call), HARMONY_GKE_NAMESPACE / HARMONY_GKE_CONTEXT / HARMONY_GKE_BASE_SECRET,
# HARMONY_CLOUD_RUN_JOB / HARMONY_CLOUD_RUN_REGION / CLOUDSDK_CORE_PROJECT.
set -euo pipefail

HERE="$(dirname "${BASH_SOURCE[0]}")"
TARGET=""
CONFIG="${HOME:-}/.harmony/deployment.json"
LOG="${HOME:-}/.harmony/daemon.log"
DRY_RUN=0
FORCE=0

usage() {
  cat <<'USAGE'
Usage: switch-daemon-profile.sh --to gke|cloud [options]

  --to gke|cloud     the launch profile the daemon should run under (required)
  --config <path>    deployment config holding profiles.<name>   [~/.harmony/deployment.json]
  --log <path>       where the restarted daemon's output goes    [~/.harmony/daemon.log]
  --dry-run          preflight, list in-flight legs and held conductions, change nothing
  --force            switch even though legs are in flight on the outgoing backend. LAST RESORT ONLY: the
                     new daemon reaps adopted leases with its own profile's reap script, so a forced
                     switch can leave a leg running twice
  -h, --help         this text
Needs HARMONY_API_TOKEN and HARMONY_PLUGIN_DIR in the environment. The fallback for a switch is the same
command with the other --to. Exit codes: 0 ok; 1 preflight/stop/start failed; 2 usage; 3 refused (legs in
flight); 4 adoption not confirmed.
USAGE
}

die() { echo "switch-daemon-profile: $*" >&2; exit 1; }
die_usage() { echo "switch-daemon-profile: $*" >&2; usage >&2; exit 2; }
need_value() { [ $# -ge 2 ] || die_usage "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --to) need_value "$@"; TARGET="$2"; shift 2 ;;
    --config) need_value "$@"; CONFIG="$2"; shift 2 ;;
    --log) need_value "$@"; LOG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die_usage "unknown argument: $1" ;;
  esac
done
case "$TARGET" in
  gke) OUTGOING=cloud ;;
  cloud) OUTGOING=gke ;;
  *) die_usage "--to must be gke or cloud, got '${TARGET:-}'" ;;
esac

TIMEOUT_S="${HARMONY_SWITCH_TIMEOUT_S:-180}"
POLL_S="${HARMONY_SWITCH_POLL_S:-5}"
STOP_TIMEOUT_S="${HARMONY_SWITCH_STOP_TIMEOUT_S:-60}"
FRESH_S="${HARMONY_SWITCH_FRESH_S:-120}"

# shellcheck source=gke-common.sh
. "$HERE/gke-common.sh"
gke_init_kubectl
: "${HARMONY_GKE_BASE_SECRET:=harmony-worker-secrets}"
: "${HARMONY_CLOUD_RUN_REGION:=us-central1}"
: "${HARMONY_CLOUD_RUN_JOB:=harmony-build-worker}"
: "${CLOUDSDK_CORE_PROJECT:=harmony-conductor}"
export CLOUDSDK_CORE_PROJECT

step() { echo; echo "=== $* ==="; }

# --- the board query: replaceable (HARMONY_SWITCH_BOARD_CMD), stubbed in tests. -----------------------
board_json() {
  if [ -n "${HARMONY_SWITCH_BOARD_CMD:-}" ]; then
    bash -c "$HARMONY_SWITCH_BOARD_CMD"
  elif [ -n "${HARMONY_PLUGIN_DIR:-}" ] && [ -f "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" ]; then
    node "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" --json conductions active
  else
    harmony --json conductions active
  fi
}

# stdin: board JSON. args: holder-prefix (e.g. "host:123:"). stdout: "<cid>\t<ticket>" per ACTIVE conduction
# whose lease holder starts with the prefix. Non-zero when the JSON is unreadable.
held_by() {
  node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let rows;
  try { rows = JSON.parse(s); } catch { process.exit(1); }
  if (!Array.isArray(rows)) process.exit(1);
  for (const r of rows)
    if (r && r.status === "active" && typeof r.lease_holder === "string" && r.lease_holder.startsWith(process.argv[1]))
      process.stdout.write(r.id + "\t" + (r.ticket || "?") + "\n");
});' "$1"
}

# stdin: board JSON. args: conduction id, new holder prefix, fresh-seconds.
# stdout: "ok" (new daemon holds it with a fresh heartbeat), "gone" (no longer active: it settled meanwhile),
# or "wait <why>". Non-zero when the JSON is unreadable.
adoption_state() {
  node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let rows;
  try { rows = JSON.parse(s); } catch { process.exit(1); }
  if (!Array.isArray(rows)) process.exit(1);
  const [cid, prefix, fresh] = process.argv.slice(1);
  const r = rows.find((x) => x && x.id === cid);
  if (!r) { process.stdout.write("gone\n"); return; }
  if (r.status !== "active") { process.stdout.write("gone\n"); return; }
  if (typeof r.lease_holder !== "string" || !r.lease_holder.startsWith(prefix)) {
    process.stdout.write("wait lease holder is " + (r.lease_holder || "none") + "\n"); return;
  }
  const hb = Date.parse(r.last_heartbeat_at || "");
  if (!Number.isFinite(hb) || Date.now() - hb > Number(fresh) * 1000) {
    process.stdout.write("wait heartbeat " + (r.last_heartbeat_at || "missing") + " is not fresh\n"); return;
  }
  process.stdout.write("ok\n");
});' "$1" "$2" "$3"
}

# --- in-flight legs on a backend. Each prints "<ticket>\t<conduction id>" per running leg. -----------
gke_legs_in_flight() {
  local json
  json="$("${KUBECTL[@]}" get jobs -o json)" || return 1
  printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { process.exit(1); }
  for (const it of j.items || []) {
    const types = ((it.status && it.status.conditions) || []).filter((c) => c.status !== "False").map((c) => c.type);
    if (types.includes("Complete") || types.includes("Failed")) continue;
    const l = (it.metadata && it.metadata.labels) || {};
    process.stdout.write((l["harmony-ticket"] || "?") + "\t" + (l["conduction-id"] || "?") + "\n");
  }
});'
}

cloud_legs_in_flight() {
  local json
  json="$(gcloud run jobs executions list --job="$HARMONY_CLOUD_RUN_JOB" --region="$HARMONY_CLOUD_RUN_REGION" \
    --project="$CLOUDSDK_CORE_PROJECT" --format=json)" || return 1
  printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let list;
  try { list = JSON.parse(s); } catch { process.exit(1); }
  if (!Array.isArray(list)) process.exit(1);
  for (const e of list) {
    if (e && e.status && e.status.completionTime) continue;
    const l = (e.metadata && e.metadata.labels) || {};
    process.stdout.write("?\t" + (l["conduction-id"] || (e.metadata && e.metadata.name) || "?") + "\n");
  }
});'
}

# --- 1. Preflight ----------------------------------------------------------------------------------
step "1. Preflight: switch to '$TARGET'"
[ -f "$CONFIG" ] || die "deployment config not found: $CONFIG"
profile_launch="$(node -e '
let j;
try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (e) { process.stderr.write("cannot read config: " + e.message + "\n"); process.exit(1); }
const p = j && j.profiles && j.profiles[process.argv[2]];
if (!p || typeof p !== "object") process.exit(3);
process.stdout.write(String(p.launch || ""));' "$CONFIG" "$TARGET")" || {
  die "profile '$TARGET' does not exist in $CONFIG (profiles section)"
}
echo "profile '$TARGET' found in $CONFIG"
[ -n "${HARMONY_API_TOKEN:-}" ] || die "HARMONY_API_TOKEN is not set — the restarted daemon needs it"
[ -n "${HARMONY_PLUGIN_DIR:-}" ] || die "HARMONY_PLUGIN_DIR is not set — the restarted daemon runs \$HARMONY_PLUGIN_DIR/dist/bin/daemon.js"

if [ "$TARGET" = "gke" ]; then
  "${KUBECTL[@]}" get namespace "$HARMONY_GKE_NAMESPACE" >/dev/null 2>&1 \
    || die "kubectl cannot reach the cluster / namespace $HARMONY_GKE_NAMESPACE — check the kubeconfig context"
  echo "kubectl reaches the cluster (namespace $HARMONY_GKE_NAMESPACE)"
  "${KUBECTL[@]}" get secret "$HARMONY_GKE_BASE_SECRET" >/dev/null 2>&1 \
    || die "base Secret $HARMONY_GKE_NAMESPACE/$HARMONY_GKE_BASE_SECRET does not exist (run container/gke/setup-cluster.sh)"
  echo "base Secret $HARMONY_GKE_BASE_SECRET exists"
  case "$profile_launch" in
    *HARMONY_GKE_IMAGE=*) echo "launch line carries HARMONY_GKE_IMAGE=" ;;
    *) die "the gke profile's launch line in $CONFIG has no HARMONY_GKE_IMAGE= setting (see container/gke/daemon-profile.gke.example.json)" ;;
  esac
else
  gcloud run jobs describe "$HARMONY_CLOUD_RUN_JOB" --region="$HARMONY_CLOUD_RUN_REGION" --project="$CLOUDSDK_CORE_PROJECT" \
    '--format=value(name)' >/dev/null 2>&1 \
    || die "Cloud Run job $HARMONY_CLOUD_RUN_JOB (region $HARMONY_CLOUD_RUN_REGION, project $CLOUDSDK_CORE_PROJECT) does not exist or is unreadable"
  echo "Cloud Run job $HARMONY_CLOUD_RUN_JOB exists"
fi

OLD_PIDS="$(pgrep -f 'dist/bin/daemon.js' || true)"
[ -n "$OLD_PIDS" ] || die "no running daemon found (pgrep -f dist/bin/daemon.js) — nothing to switch; start one with --profile $TARGET"
[ "$(printf '%s\n' "$OLD_PIDS" | wc -l | tr -d ' ')" = "1" ] \
  || die "more than one daemon is running (pids: $(printf '%s' "$OLD_PIDS" | tr '\n' ' ')) — stop the extras first"
OLD_PID="$OLD_PIDS"
echo "running daemon: pid $OLD_PID"

BOARD_JSON="$(board_json)" || die "the board query failed — cannot record or confirm held conductions"
HOST="$(hostname)"
OLD_PREFIX="$HOST:$OLD_PID:"
HELD="$(printf '%s' "$BOARD_JSON" | held_by "$OLD_PREFIX")" || die "the board query returned unreadable JSON"
if [ -n "$HELD" ]; then
  echo "conductions held by the running daemon:"
  while IFS=$'\t' read -r cid ticket; do echo "  - $ticket  conduction $cid"; done <<<"$HELD"
else
  echo "the running daemon holds no active conductions"
fi

# --- 2. In-flight guard ----------------------------------------------------------------------------
step "2. In-flight legs on the outgoing backend ($OUTGOING)"
if [ "$OUTGOING" = "gke" ]; then
  LEGS="$(gke_legs_in_flight)" || die "could not list Jobs in $HARMONY_GKE_NAMESPACE — cannot tell whether a leg is in flight"
else
  LEGS="$(cloud_legs_in_flight)" || die "could not list Cloud Run executions — cannot tell whether a leg is in flight"
fi
# Fill in a ticket the backend does not label (Cloud Run executions) from the board's held list.
if [ -n "$LEGS" ]; then
  LEGS_NAMED=""
  while IFS=$'\t' read -r ticket cid; do
    if [ "$ticket" = "?" ]; then
      known="$(printf '%s' "$BOARD_JSON" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try { const r = JSON.parse(s).find((x) => x && x.id === process.argv[1]); process.stdout.write((r && r.ticket) || "?"); } catch { process.stdout.write("?"); }
});' "$cid")"
      ticket="$known"
    fi
    LEGS_NAMED+="$ticket"$'\t'"$cid"$'\n'
  done <<<"$LEGS"
  LEGS="${LEGS_NAMED%$'\n'}"
  echo "legs running on $OUTGOING:"
  while IFS=$'\t' read -r ticket cid; do echo "  - $ticket  conduction $cid"; done <<<"$LEGS"
else
  echo "no leg is running on $OUTGOING"
fi

if [ -n "$LEGS" ] && [ "$FORCE" -eq 0 ]; then
  {
    echo "switch-daemon-profile: REFUSING to switch to '$TARGET': a leg is still running on $OUTGOING:"
    while IFS=$'\t' read -r ticket cid; do echo "  - $ticket  conduction $cid"; done <<<"$LEGS"
    echo "Wait for these to finish, then run again. --force overrides this check, but it is a LAST RESORT: the new"
    echo "daemon reaps adopted leases with its OWN profile's reap script, which cannot see a leg on the other"
    echo "backend, so a forced switch can leave a leg running twice."
  } >&2
  [ "$DRY_RUN" -eq 1 ] && echo "(dry-run: a real run would refuse here, exit 3)"
  exit 3
fi
if [ -n "$LEGS" ]; then
  echo "WARNING: --force given — switching with legs in flight on $OUTGOING (last resort; a leg may run twice)." >&2
fi

# --- dry run ends here -----------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  step "dry run: nothing changed"
  echo "would: kill -TERM $OLD_PID, wait up to ${STOP_TIMEOUT_S}s for it to exit,"
  echo "       nohup node \$HARMONY_PLUGIN_DIR/dist/bin/daemon.js --config $CONFIG --profile $TARGET >> $LOG,"
  echo "       then confirm from the board within ${TIMEOUT_S}s that each held conduction is leased by the new daemon"
  echo "       with a heartbeat under ${FRESH_S}s old."
  echo "fallback: the same command with --to $OUTGOING"
  exit 0
fi

# --- 3. Stop the old daemon, start the new one --------------------------------------------------------
step "3. Restart the daemon under profile '$TARGET'"
env kill -TERM "$OLD_PID" || die "could not signal daemon pid $OLD_PID"
waited=0
while env kill -0 "$OLD_PID" 2>/dev/null; do
  [ "$waited" -lt "$STOP_TIMEOUT_S" ] || die "daemon pid $OLD_PID did not exit within ${STOP_TIMEOUT_S}s after SIGTERM — it was NOT restarted; the fallback is not needed, it is still on '$OUTGOING'"
  sleep 1
  waited=$((waited + 1))
done
echo "old daemon exited"

LOG_OFFSET=0
[ -f "$LOG" ] && LOG_OFFSET="$(wc -c <"$LOG" | tr -d ' ')"
mkdir -p "$(dirname "$LOG")"
export HARMONY_API_TOKEN HARMONY_PLUGIN_DIR
nohup node "$HARMONY_PLUGIN_DIR/dist/bin/daemon.js" --config "$CONFIG" --profile "$TARGET" >>"$LOG" 2>&1 </dev/null &
NEW_PID=$!
disown "$NEW_PID" 2>/dev/null || true
echo "started daemon pid $NEW_PID (log $LOG)"
NEW_PREFIX="$HOST:$NEW_PID:"

# --- 4. Confirm adoption from the board ---------------------------------------------------------------
step "4. Confirm adoption (board, up to ${TIMEOUT_S}s)"
deadline=$(( $(date +%s) + TIMEOUT_S ))
pending="$HELD"
while :; do
  if ! env kill -0 "$NEW_PID" 2>/dev/null; then
    echo "switch-daemon-profile: the new daemon (pid $NEW_PID) is no longer running — see $LOG. Fallback: re-run with --to $OUTGOING" >&2
    exit 4
  fi
  still=""
  reasons=""
  if [ -n "$pending" ]; then
    board="$(board_json 2>/dev/null)" || board=""
    while IFS=$'\t' read -r cid ticket; do
      [ -n "$cid" ] || continue
      if [ -z "$board" ]; then st="wait board unreadable"; else st="$(printf '%s' "$board" | adoption_state "$cid" "$NEW_PREFIX" "$FRESH_S")" || st="wait board JSON unreadable"; fi
      case "$st" in
        ok) echo "  adopted: $ticket  conduction $cid" ;;
        gone) echo "  settled meanwhile (no longer active): $ticket  conduction $cid" ;;
        *) still+="$cid"$'\t'"$ticket"$'\n'; reasons+="  - $ticket  conduction $cid: ${st#wait }"$'\n' ;;
      esac
    done <<<"$pending"
  fi
  pending="${still%$'\n'}"
  if [ -z "$pending" ]; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    {
      echo "switch-daemon-profile: adoption NOT confirmed within ${TIMEOUT_S}s for:"
      printf '%s' "$reasons"
      echo "New daemon pid $NEW_PID, profile '$TARGET', log $LOG."
      echo "Fallback: re-run this command with --to $OUTGOING."
    } >&2
    exit 4
  fi
  sleep "$POLL_S"
done

# Secondary, fuzzy corroboration from the daemon's log: informational only, never decides the outcome.
if [ -n "$HELD" ] && [ -f "$LOG" ]; then
  new_log="$(tail -c +"$((LOG_OFFSET + 1))" "$LOG" 2>/dev/null || true)"
  while IFS=$'\t' read -r cid ticket; do
    [ -n "$cid" ] || continue
    if printf '%s\n' "$new_log" | grep -F -- "$cid" | grep -qiE 'adopt|took over|reconcil|re-attach|settle|reap'; then
      echo "  log corroborates $ticket ($cid)"
    else
      echo "  (log has no matching line for $ticket ($cid) — informational only; the board confirmed it)"
    fi
  done <<<"$HELD"
fi

echo
echo "switched to '$TARGET': daemon pid $NEW_PID; all held conductions confirmed on the board."
echo "fallback: the same command with --to $OUTGOING"
