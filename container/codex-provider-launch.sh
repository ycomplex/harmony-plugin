#!/usr/bin/env bash
# B-1178: the launchers' half of a Codex leg on a non-OpenAI model provider. Sourced by
# container/cloud-worker-launch.sh, container/gke/gke-worker-launch.sh and
# container/docker-host-worker-launch.sh. Runs on the conductor (a laptop's bash 3.2 included), so no
# bash-4 features. Names only: nothing here reads, prints or stores a key VALUE.
#
# codex_provider_context <launcher> <model> <refusal suffix>
#   Sets CODEX_PROVIDER ("openai" unless <model>'s catalog row names another provider),
#   CODEX_PROVIDER_ENV_KEY and CODEX_PROVIDER_SECRET (both empty for openai), by asking
#   `harmony agent provider` (src/cli/commands/agent.ts) — the live catalog, inactive rows included (the
#   run named the model). An empty model, no plugin bundle, a model the catalog does not know or an
#   unreachable catalog all read as openai: the leg launches exactly as it did before B-1178.
#   Refuses (exit 1, "<launcher>: Refusing to start: … — <suffix>") when the row names a provider this
#   build does not know, or a non-OpenAI provider missing from HARMONY_CODEX_PROVIDERS (the `providers`
#   list in .harmony/conductor.json, src/config/conductor-config.ts).

codex_provider_context() {
  local who="$1" model="$2" suffix="$3" cli err rc=0 facts parsed
  CODEX_PROVIDER="openai"
  CODEX_PROVIDER_ENV_KEY=""
  CODEX_PROVIDER_SECRET=""
  [ -n "$model" ] || return 0
  cli="${HARMONY_PLUGIN_DIR:-}/dist/bin/harmony.js"
  [ -f "$cli" ] || return 0
  err="$(mktemp)"
  facts="$(node "$cli" agent provider --agent codex --model "$model" --json 2>"$err")" || rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "$who: Refusing to start: model '$model' names a model provider this plugin does not know ($(head -c 300 "$err" | tr '\n' ' ')) — $suffix" >&2
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"
  [ "$rc" -eq 0 ] && [ -n "$facts" ] || return 0
  # provider|env_key|secret — validated as bare names before any of them reaches a command line.
  parsed="$(printf '%s' "$facts" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const f=JSON.parse(s);const p=String(f.provider||"");const k=f.env_key==null?"":String(f.env_key);const n=f.secret==null?"":String(f.secret);if(!/^[a-z0-9][a-z0-9_-]*$/.test(p)||!/^([A-Z][A-Z0-9_]*)?$/.test(k)||!/^([a-z0-9][a-z0-9-]*)?$/.test(n))process.exit(1);process.stdout.write(p+"|"+k+"|"+n)}catch{process.exit(1)}})' 2>/dev/null || true)"
  if [ -z "$parsed" ]; then
    echo "$who: Refusing to start: \`harmony agent provider\` answered for model '$model' with facts that are not bare names — $suffix" >&2
    exit 1
  fi
  CODEX_PROVIDER="${parsed%%|*}"
  parsed="${parsed#*|}"
  CODEX_PROVIDER_ENV_KEY="${parsed%%|*}"
  CODEX_PROVIDER_SECRET="${parsed#*|}"
  [ "$CODEX_PROVIDER" != "openai" ] || return 0
  if [ -z "$CODEX_PROVIDER_ENV_KEY" ] || [ -z "$CODEX_PROVIDER_SECRET" ]; then
    echo "$who: Refusing to start: model '$model' runs on provider '$CODEX_PROVIDER', which names no key variable or secret — $suffix" >&2
    exit 1
  fi
  case ",${HARMONY_CODEX_PROVIDERS:-}," in
    *",$CODEX_PROVIDER,"*) ;;
    *)
      echo "$who: Refusing to start: model '$model' runs on provider '$CODEX_PROVIDER', which is not in this conductor's providers list (\"providers\" in .harmony/conductor.json; listed: '${HARMONY_CODEX_PROVIDERS:-}') — $suffix" >&2
      exit 1
      ;;
  esac
  echo "$who: Codex leg on provider '$CODEX_PROVIDER' (key $CODEX_PROVIDER_ENV_KEY from secret $CODEX_PROVIDER_SECRET; no login cache)" >&2
}
