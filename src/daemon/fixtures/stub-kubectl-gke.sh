#!/usr/bin/env bash
# ONE write per call: the launcher pipes two kubectl processes together, and two appends in flight would interleave.
node -e 'require("fs").appendFileSync(process.env.STUB_LOGS + "/kubectl.log", process.argv.slice(1).join("\n") + "\n--END--\n")' -- "$@"
args=("$@")
# drop the leading -n <ns> / --context <c>
while [ "${args[0]:-}" = "-n" ] || [ "${args[0]:-}" = "--context" ]; do args=("${args[@]:2}"); done
# Accept the real client's bounded request flag at any position.
filtered=()
for arg in "${args[@]}"; do case "$arg" in --request-timeout=*) ;; *) filtered+=("$arg") ;; esac; done
args=("${filtered[@]}")
all="${args[*]}"
next() {  # $1 = seq json env var, $2 = counter name -> prints the response for this call
  node -e '
    const fs = require("fs"); const seq = JSON.parse(process.env[process.argv[1]] || "[]");
    const f = process.env.STUB_LOGS + "/" + process.argv[2]; let n = 0;
    try { n = Number(fs.readFileSync(f, "utf8")); } catch {}
    fs.writeFileSync(f, String(n + 1));
    const r = seq.length ? seq[Math.min(n, seq.length - 1)] : null;
    fs.writeFileSync(process.env.STUB_LOGS + "/last-" + process.argv[2], typeof r === "string" ? r : "OBJ");
    process.stdout.write(typeof r === "string" ? r : JSON.stringify(r));
  ' "$1" "$2"
}
case "$all" in
  "get secret "*)
    name="${args[2]}"
    case ",${STUB_MISSING_SECRETS:-}," in *",$name,"*) exit 1 ;; esac
    exit 0 ;;
  "get storageclass "*)
    echo "storageclass-read" >> "$STUB_LOGS/storageclass-reads"
    if [ -n "${STUB_SC_FORBIDDEN:-}" ]; then echo 'Error from server (Forbidden): storageclasses.storage.k8s.io "harmony-ticket-disk" is forbidden: User "system:serviceaccount:harmony-conductor:harmony-conductor" cannot get resource "storageclasses"' >&2; exit 1; fi
    if [ -n "${STUB_NO_TICKET_SC:-}" ]; then echo 'Error from server (NotFound): storageclasses.storage.k8s.io "harmony-ticket-disk" not found' >&2; exit 1; fi
    exit 0 ;;
  "get serviceaccount "*)
    name="${args[2]}"
    case ",${STUB_MISSING_SERVICEACCOUNTS:-}," in *",$name,"*) exit 1 ;; esac
    exit 0 ;;
  "apply -f -") cat > "$STUB_LOGS/pvc.json" ;;
  "create secret generic "*)
    for a in "$@"; do case "$a" in --from-env-file=*)
      f="${a#--from-env-file=}"; stat -c %a "$f" > "$STUB_LOGS/envfile-mode"; cp "$f" "$STUB_LOGS/envfile-copy"; echo "$f" > "$STUB_LOGS/envfile-path" ;;
    esac; done
    # --dry-run=client -o json: print the manifest (a placeholder value; the real one stays in the env file)
    case "$all" in *"--dry-run=client"*) printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"%s"},"data":{"GIT_TOKEN":"eA=="}}' "${args[3]}" ;; esac ;;
  "create -f -")
    body="$(cat)"
    case "$body" in
      *'"kind":"Secret"'*) [ -n "${STUB_SECRET_CREATE_FAILS:-}" ] && { echo 'Error from server (Forbidden)' >&2; exit 1; }
                           printf '%s' "$body" > "$STUB_LOGS/secret.json" ;;
      *) printf '%s' "$body" > "$STUB_LOGS/job.json" ;;
    esac ;;
  "get job "*"jsonpath"*) printf 'uid-123' ;;
  "get job "*"--ignore-not-found"*)
    if [ "$(cat "$STUB_LOGS/last-jobctr" 2>/dev/null)" = "GONE" ]; then :; else echo "job.batch/x"; fi ;;
  "get job "*"-o json")
    r="$(next STUB_JOB_SEQ jobctr)"
    case "$r" in
      ERR) echo "Unable to connect to the server" >&2; exit 1 ;;
      GONE) echo 'Error from server (NotFound): jobs.batch "x" not found' >&2; exit 1 ;;
      GARBAGE) echo "<html>"; exit 0 ;;
      *) printf '%s' "$r" ;;
    esac ;;
  "get pods "*)
    echo "pods-read" >> "$STUB_LOGS/pods-reads"
    r="$(next STUB_PODS_SEQ podctr)"
    case "$r" in
      ERR) echo "Unable to connect to the server" >&2; exit 1 ;;
      GARBAGE) echo "<html>"; exit 0 ;;
      *) printf '%s' "$r" ;;
    esac ;;
  "get pvc "*) printf '%s' "${STUB_PVC_JSON:-null}" ;;
  "get events"*)
    if [ -n "${STUB_EVENTS_FORBIDDEN:-}" ]; then echo Forbidden >&2; exit 1; fi
    printf '%s' "${STUB_EVENTS_JSON:-null}" ;;
  "get jobs "*) printf '%s' "${STUB_JOBS_JSON:-{\"items\":[]\}}" ;;
  "patch secret "*) echo "launcher must not patch secrets (the remote conductor cannot read them)" >> "$STUB_LOGS/PATCH-SECRET"; exit 1 ;;
  "delete job "*) if [ -n "${STUB_DELETE_AUTH_FAILS:-}" ]; then echo 'Unauthorized' >&2; exit 1; fi
    if [ -n "${STUB_DELETE_FAILS:-}" ]; then echo 'Error from server (Forbidden)' >&2; exit 1; fi ;;
  *) echo "stub kubectl: unhandled: $all" >&2; exit 9 ;;
esac
