# Sourced by launchers. Nonsecret metadata only; values never appear in argv/logs.
figma_launch_context() {
  FIGMA_CONTEXT="$(node "$HARMONY_PLUGIN_DIR/dist/bin/harmony.js" figma context)" || { echo "Figma context unavailable; launching without Figma." >&2; FIGMA_CONTEXT='{"state":"disconnected","connections_enabled":false}'; }
  # Fail closed on absent/false enablement, even if stale metadata contains refs.
  FIGMA_CONTEXT="$(printf '%s' "$FIGMA_CONTEXT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const m=JSON.parse(s);process.stdout.write(JSON.stringify(m.connections_enabled===true?(m.state==="connected"&&(!Number.isFinite(Date.parse(m.access_expires_at))||Date.parse(m.access_expires_at)<=Date.now())?{...m,state:"reconnect",access_version:undefined,pat_version:undefined}:m):{state:"disconnected",connections_enabled:false}))})')" || return 1
  FIGMA_CONTEXT_B64="$(printf '%s' "$FIGMA_CONTEXT" | base64 | tr -d '\n')"
  FIGMA_ACCESS_REF="$(printf '%s' "$FIGMA_CONTEXT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const m=JSON.parse(s);if(m.state==="disconnected"||m.state==="reconnect")return;if(m.state!=="connected"||!Number.isFinite(Date.parse(m.access_expires_at))||Date.parse(m.access_expires_at)<=Date.now())process.exit(1);for(const k of ["access_version","pat_version"])if(!/^projects\/harmony-conductor\/secrets\/harmony-figma-ws-[a-f0-9-]{36}-(access|pat)\/versions\/\d+$/.test(m[k]||""))process.exit(1);process.stdout.write(m.access_version)})')" || { echo 'Figma needs reconnection; refusing launch.' >&2; return 1; }
  FIGMA_PAT_REF="$(printf '%s' "$FIGMA_CONTEXT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).state==="connected"?JSON.parse(s).pat_version||"":""))')" || return 1
}
figma_read_tokens() {
  # $1 is a private temporary directory on the launcher host, never the worker.
  [ -n "$FIGMA_ACCESS_REF" ] || return 0
  ( umask 077
    gcloud secrets versions access "${FIGMA_ACCESS_REF##*/}" --secret="$(printf '%s' "$FIGMA_ACCESS_REF" | cut -d/ -f4)" --project=harmony-conductor --out-file="$1/access-token" &&
    gcloud secrets versions access "${FIGMA_PAT_REF##*/}" --secret="$(printf '%s' "$FIGMA_PAT_REF" | cut -d/ -f4)" --project=harmony-conductor --out-file="$1/pat"
  )
}
