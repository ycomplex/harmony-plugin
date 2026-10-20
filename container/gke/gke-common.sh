#!/usr/bin/env bash
# Shared helpers for the "gke" launch profile (sourced by gke-worker-launch.sh, -probe.sh, -reap.sh).
#
# gke_init_kubectl      builds the KUBECTL array: namespace from HARMONY_GKE_NAMESPACE (default
#                       harmony-legs), plus --context $HARMONY_GKE_CONTEXT when that is set — EXCEPT in a remote
#                       conductor pod (HARMONY_CONDUCTOR_REMOTE=1, B-1173): there is no kubeconfig, kubectl uses
#                       the pod's service account, and the context name the config derives
#                       (gke_<project>_<location>_<cluster>) does not exist, so --context would fail every call.
# gke_unsettled_jobs ID prints the names of the Jobs labelled conduction-id=<ID> that have neither a
#                       Complete nor a Failed condition (one per line). A kubectl error prints nothing.

gke_init_kubectl() {
  : "${HARMONY_GKE_NAMESPACE:=harmony-legs}"
  KUBECTL=(kubectl -n "$HARMONY_GKE_NAMESPACE")
  if [ -n "${HARMONY_GKE_CONTEXT:-}" ] && [ "${HARMONY_CONDUCTOR_REMOTE:-}" != "1" ]; then KUBECTL+=(--context "$HARMONY_GKE_CONTEXT"); fi
}

gke_unsettled_jobs() {
  local json
  json="$("${KUBECTL[@]}" get jobs -l "conduction-id=$1" -o json 2>/dev/null)" || return 0
  printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    for (const j of JSON.parse(s).items || []) {
      const types = ((j.status && j.status.conditions) || []).map((c) => c.type);
      if (!types.includes("Complete") && !types.includes("Failed")) process.stdout.write(j.metadata.name + "\n");
    }
  } catch {}
});' 2>/dev/null || true
}
