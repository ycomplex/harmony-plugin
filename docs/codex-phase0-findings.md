# Codex Phase-0 spike findings (B-1076)

The Phase-0 deliverable of `docs/2026-09-03-codex-conductor-worker-plan.md` in the workspace repo, recorded
against the CLI the adapter was built on. Every row says exactly what was **run**, so nothing here is a claim
about a spike that was not executed.

## How the spikes were run

- **Resolved CLI version: `@openai/codex` 0.163.0** (`npm view @openai/codex version` on 2026-10-16;
  `codex --version` → `codex-cli 0.163.0`, linux-x64, installed into a scratch directory with
  `npm install @openai/codex@0.163.0`). The image does **not** pin it: `container/cloudbuild.yaml`
  resolves the current release with `npm view` at build time and passes it as `CODEX_VERSION`, the same
  policy as Claude Code (B-1074). The 0.163.0 figures below are what the adapter was verified against;
  `src/agents/codex-drift.test.ts` re-checks them against whatever CLI is installed.
- **No Codex install and no `~/.codex` existed in the build worker, and there is no ChatGPT plan login.**
  So there are three evidence classes:
  - **RAN** — executed against the real 0.163.0 binary with no model call (`--help`, `--version`,
    `mcp list/get`, `doctor`, `--strict-config`, `login --help`, `features list`).
  - **RAN (mock provider)** — the real 0.163.0 binary driven end to end at a local HTTP server that speaks
    the Responses-API SSE protocol (`[model_providers.mock]`, `wire_api = "responses"`,
    `env_key = "MOCK_KEY"`). Everything the CLI does *around* the model is real: config load, AGENTS.md and
    skill discovery, MCP startup, event stream, rollout files, resume, exit codes. What the *model* does is
    scripted. This is not a substitute for a plan-login run and is labelled separately everywhere.
  - **BLOCKED** — needs a live plan login, a live model, or a live Harmony MCP session against staging.
    Not run. What is needed is stated for each.
- The mock-provider harness is reproduced by `src/agents/codex-drift.test.ts` (it runs whenever a `codex`
  binary is on `PATH` or `HARMONY_CODEX_BIN` names one, and skips cleanly otherwise).

## Decisions (the Phase-0 exit criterion)

| Question | Decision | Basis |
|---|---|---|
| Packaging shape | No Codex plugin package. Render `config.toml` + one `AGENTS.md`, and symlink `.agents/skills` to the plugin's `skills/` | RAN (mock) |
| Auth method | The plan-included **login cache**: `auth.json` from `CODEX_HOME=~/.harmony/codex-automation codex login --device-auth`, addressed by a path variable, never an API key | policy (B-934); login itself BLOCKED |
| Build strategy | Root thread, no subagent (`capabilities.subagents = false`; start-work reads it) | design; subagent behaviour not spiked |
| Exit contract | `codex exec --json --cd <root> --add-dir <plugin> --dangerously-bypass-approvals-and-sandbox …`; exit 0 = complete, non-zero = failed | RAN (mock) |
| Resume | `codex exec resume <thread-id> --json … <prompt>`; since B-1148 provision.sh records each thread in `.harmony-codex-thread.json` and resumes it (Maintain session), and the switch loop resumes with `-m <new>` | RAN (mock) for the argv and the shell-level loop; cross-container remount not run live |
| Credential delivery | **Copy-in** at startup (read-only mount at `/home/worker/.codex-auth-src/auth.json`, copied to `~/.codex/auth.json`, mode 600) | rotation unproven — see Auth |

## Findings by spike

### CLI surface — RAN

- `codex exec [OPTIONS] [PROMPT]` with subcommands `resume`, `fork`, `review`. Options present on 0.163.0:
  `--json`, `-C/--cd <DIR>`, `--add-dir <DIR>`, `-m/--model`, `--dangerously-bypass-approvals-and-sandbox`,
  `--skip-git-repo-check`, `--ignore-user-config`, `--ephemeral`, `--output-schema`, `-o/--output-last-message`,
  `--strict-config`, `-c key=value`, `-s/--sandbox`, `--approve-for-me`. `--full-auto` is not listed (do not use).
- **`codex exec resume [SESSION_ID] [PROMPT]` accepts a reduced set**: `--json`, `-m`,
  `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, `--ephemeral`, `--output-schema`,
  `-o`, `-c`, `-i`, `--last`, `--all`. It does **not** accept `--cd`, `--add-dir` or `--sandbox`. The
  adapter therefore relies on the process cwd for a resumed leg (provision.sh `cd "$WORKDIR"` always runs).
- `--strict-config` rejects an unknown config field at load (`unknown configuration field …`) and is not
  supported by `codex mcp`. Used by the drift test as the config-validity oracle.
- `codex exec` **blocks on a non-closed stdin** ("Reading additional input from stdin…") when stdin is not a
  TTY and not `/dev/null`. provision.sh backgrounds every invocation (`"$@" &`), so bash gives it
  `/dev/null`; a hand launch must redirect `</dev/null`.

### Instruction discovery and aggregation — RAN (mock)

- Codex reads `AGENTS.md` from the git root of `--cd` down to the cwd. With three independent nested repos
  (`ws/`, `ws/plugin/`, `ws/web/`, each its own `.git`, each with its own marker): `--cd ws` loaded **only**
  the root's; `--cd ws/plugin` **only** the plugin's; `--cd ws/web` **only** web's. Confirms the plan's reason
  for aggregation: guidance is never merged across independent repos.
- Default `project_doc_max_bytes` (32 KiB) **silently truncates**: a 40,453-byte AGENTS.md lost its tail
  marker; with `project_doc_max_bytes = 200000` the marker was present. The three canonical CLAUDE.md files
  measure **49,502 bytes** today (18,493 + 16,106 + 14,903); the adapter sets 262,144 (~5x headroom) and
  `verifyCodexAgentsMd` fails a render that exceeds it or drops a source marker.
- The generated file is `<workspace>/AGENTS.md` plus `.agents/` in `.git/info/exclude`, so it is never
  committed. `provisionCodex` refuses to overwrite an AGENTS.md that is not its own.

### Skills — RAN (mock)

- A symlinked `<workspace>/.agents/skills → <plugin>/skills` is discovered: all 15 skills listed (the skill
  list block was 11,184 bytes). **Claude frontmatter is accepted** (`allowed-tools`, long descriptions): no
  warning, no rejection. The skills appear namespaced **`harmony-plugin:<skill>`** (Codex read the plugin
  manifest next to the symlink target).
- **Explicit invocation**: a prompt of `$harmony-plugin:harmony-conduct B-1 --one-shot` injects the skill body
  into the request; `$harmony-conduct …` and the Claude form `/harmony-plugin:harmony-conduct …` do **not**.
  The adapter translates the leading slash-skill of every launch template's prompt (`codexPrompt`).
- Not measured: the skill-description budget on a live model, implicit-invocation suppression
  (`agents/openai.yaml`). **BLOCKED**: needs a live model.

### MCP — RAN (mock) / RAN

- `[mcp_servers.harmony]` with `required`, `startup_timeout_sec`, `tool_timeout_sec`,
  `default_tools_approval_mode`, `env_vars` is accepted by `--strict-config`; `codex mcp get harmony` echoes
  the timeouts, approval mode and (masked) env names.
- **`env_vars` forwards only what is listed**: an unlisted variable set in the launcher's env did not reach
  the server (`has_unlisted: false`); the listed `HARMONY_*` ones did.
- **`required = true` fails closed**: a server that cannot start ends the run **before any model request**
  with `required MCP servers failed to initialize: harmony: …`, exit 1. (Verified with an unreachable
  Supabase URL against the real `dist/index.js`, and with a missing server path in the drift test.)
- Tool presentation: the server's tools arrive as a namespace `mcp__harmony` containing the bare tool name
  (`get_task`), which concatenates to the skill corpus' `mcp__harmony__get_task`. How the *model* addresses
  it is model-side — BLOCKED.
- **BLOCKED**: `get_project` against **staging** with the real `dist/index.js` and a staging token (needs
  staging credentials and network); a trust/elicitation prompt in headless mode (needs a model that calls a
  tool needing approval).

### Events, exit codes, thread id — RAN (mock)

```
{"type":"thread.started","thread_id":"<uuid>"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"…"}}
{"type":"turn.completed","usage":{"input_tokens":111,"cached_input_tokens":22,"cache_write_input_tokens":0,"output_tokens":33,"reasoning_output_tokens":4}}
```

- Success exits **0**; a failed turn emits `error` + `turn.failed` and exits **1**; a failed required MCP
  server exits 1 with no event stream beyond the error. The exit code is authoritative.
- **Thread id from `thread.started` is reliable on 0.163.0** (also re-emitted, same id, on resume), so it is
  the primary source. The rollout fallback layout was also confirmed:
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-id>.jsonl`. State otherwise lives in
  sqlite (`state_5.sqlite`, `thread_history_1.sqlite`) and the CLI ships a `migrate-rollouts` command: the
  rollout layout is a version-pinned detail, not a promise.
- **Usage on a resumed thread is cumulative.** Two requests of 111/22/33/4 tokens each reported
  222/44/66/8 on the second `turn.completed`. A per-invocation cost must subtract the previous figure
  (B-1078). The adapter exposes `parseCodexUsage` and reports `costUsd: null` (plan-included).
- `--output-schema` was not used as a control plane (plan, issue #15451).

### Resume — RAN (mock)

- `codex exec resume <id> --json --dangerously-bypass-approvals-and-sandbox -m other-model "next"` against the
  same `CODEX_HOME` continued the thread (history carried the first prompt) and **`-m` is legal and
  effective on resume** (the CLI warns that the session was recorded with another model). A model change
  therefore resumes in place.
- **B-1148 wiring.** After every Codex invocation `provision.sh` writes `.harmony-codex-thread.json`
  (`{agent: "codex", thread_id, model, time}`, id from the `thread.started` event via
  `harmony agent write-thread`) into the conduction's sessions folder. With Maintain session on, the next
  leg resumes that id (else `HARMONY_CODEX_RESUME_THREAD` from a re-conducted ticket's sibling, else the
  newest `sessions/*/*/*/rollout-*-<id>.jsonl` — the version-pinned glob). A failed resume falls back to a
  cold start (B-718 shape). The B-772 size guard weighs the rollout against
  `harmony model context-budget --agent codex <model>`. The adapter declares `modelSwitch: true`: a
  switch resumes the current thread with `-m <new>` ("switched in place") and falls back to a new thread
  ("started a new thread"). Cross-conduction: `resume-discovery.mjs` (docker profiles) and `entrypoint.sh`
  (cloud) copy the sibling's thread file and rollout and pass the id as `HARMONY_CODEX_RESUME_THREAD`,
  never in `CLAUDE_HEADLESS_FLAGS`.
- **Still not run live**: resume from a *remounted* `CODEX_HOME` on a different container (the tests reuse
  one directory, or stub the CLI).

### Shell tool and environment — RAN (mock)

- Scripted `exec_command` calls ran: under `--dangerously-bypass-approvals-and-sandbox` the model's shell
  inherits the **full** environment, including `*_TOKEN`/`*_KEY` names (no default exclusion applied), so
  `git`, `gh` and the `harmony` CLI see what they see under Claude.
- A command that outlives 10 seconds **yields** with a session id (`Process running with session ID …`) and
  is continued by the model via `write_stdin`; no inner hard kill was observed at 25 s. The 90-minute
  worker deadline stays authoritative. **BLOCKED**: the behaviour for a multi-minute build under a live
  model (does the session survive until the model polls, is there a ceiling above 25 s).

### Auth — RAN / BLOCKED

- RAN: `codex login --help` offers `--device-auth`, `--with-api-key`, `--with-access-token`;
  `codex login status` with an empty home prints `Not logged in`; `codex doctor` reports
  `no Codex credentials were found`. Credential env names present in the binary: `OPENAI_API_KEY`,
  `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`; the login file is `auth.json` under `CODEX_HOME`.
  The adapter refuses all three beside the login cache (no metered fallback, B-934).
- **BLOCKED — needs a founder ChatGPT plan login on the conductor host**
  (`CODEX_HOME=~/.harmony/codex-automation codex login --device-auth`), then a run with that `auth.json`:
  1. that a headless `codex exec` authenticates from a copied `auth.json`;
  2. **whether Codex rewrites `auth.json` on token refresh and whether refresh tokens rotate (single-use)**.
     This decides copy-in versus a read-write file mount. Until it is known the launcher does **copy-in**
     (read-only mount, then copy): a refresh inside a leg works on the copy, but the conductor host's master
     file is **not** updated. If tokens do rotate, the master goes stale after the first refreshing leg and
     needs a re-login, or a write-back step must be added;
  3. quota/rate-limit classification (429 versus an exhausted plan) — needs a live account.

### Other plan items

| Plan item | Status |
|---|---|
| `codex exec` can edit, run tests, commit, push, `gh` in the container | **BLOCKED** (needs a live model + GitHub token; the shell tool path itself was RAN with scripted calls) |
| Approval/elicitation behaviour headless | **BLOCKED** (needs a live model); mitigated by `approval_policy = "never"` and `default_tools_approval_mode = "auto"` |
| Network behaviour per sandbox envelope | **BLOCKED**; v1 uses the bypass envelope, so no sandbox network policy applies |
| Skill-description budget, implicit-invocation restriction | **BLOCKED** (live model) |
| Subagent (`multi_agent_v1` is present in the tool list) as an alternative build strategy | not spiked; root-thread build chosen |
| Hooks (`SessionStart`/`Stop`/`PreToolUse`) | **RAN (mock), B-1150**: wired. `$CODEX_HOME/hooks.json` runs Claude-shaped hooks only with `--dangerously-bypass-hook-trust` (now on both argvs); the real gate scripts fire. See "Hooks — RAN (mock), B-1150" below |
| Cloud Run profile (Phase 4) | wired (B-1076 send-back), not run live — see "Local-docker and cloud profiles" below |
| Provider-qualified model catalog (Phase 3) | not built. Interim: a Codex leg ignores the conductor's `HARMONY_MODEL` (a Claude alias) and takes `HARMONY_CODEX_MODEL` from the base env, or the CLI default |

### Hooks — RAN (mock), B-1150

Superseding the Phase-0 "out of scope" row. Run against codex-cli 0.163.0 at the mock provider, with
`$CODEX_HOME/hooks.json` rendered from the canonical hooks onto a temporary plugin root holding the REAL
`hooks/stop-gate.sh`, `hooks/pretooluse-gate.sh` and their built `dist/bin/*.js`; only the board read
(`dist/bin/harmony.js tasks clean-check`) was a stub returning an unclean row.

- **SessionStart** fired with the thread id as `session_id` (the conduct-session hook wrote it).
- **PreToolUse** fired on a scripted `exec_command` with `tool_name: "Bash"`, `tool_input.command`, `cwd`,
  `session_id`, `transcript_path`. The real gate allowed that fixture call (exit 0), and it gave the same
  verdict when run directly outside Codex on the captured payload; a Codex-side deny was not reproduced.
- **Stop** with a breadcrumb for the session (`codex exec resume`): the real gate blocked the turn-end. The
  turn made three model requests instead of one, the `[harmony stop-gate]` reason reached the model, the
  gate wrote its per-session block counter, and the gate's own block cap then let the turn end (exit 0, a
  `turn.completed`).
- **A hook command that cannot run wedges the run.** With the Stop hook pointing at a missing script
  (`sh <root>/hooks/missing.sh`, exit 127), `codex exec` did not finish, and outlived a SIGKILL of the codex
  process (the test's pipes never closed). Cause not established. The worker always has the scripts (the
  plugin clone), and the mock e2e in `src/agents/codex-drift.test.ts` ships the real ones for this reason.
- `--dangerously-bypass-hook-trust` adds two `item.completed` items of type `error` ("Enabled hooks may run
  without review for this invocation") to every stream. They are not failures; telemetry ignores them.

The skills' `allowed-tools` / `disallowed-tools` keys are still not read by Codex. Since B-1150 they are a
generated Claude projection of the authored `capabilities:` key; Codex's mapping of those classes (one
envelope, `forbid:` classes as AGENTS.md rules) is in `docs/agent-adapter-contract.md`.

### Local-docker and cloud profiles — WIRED / BLOCKED

The B-1076 send-back gives Codex a launch path on all three profiles; each example profile now lists
`"agents": ["claude-code", "codex"]`. Every launcher detects a Codex run the same way: the
`run_config.agent.adapter` probe (`ADAPTER_PROBE`, base64 or raw JSON) copied from
`container/docker-host-worker-launch.sh`.

- **Local-docker** (`container/docker-worker-launch.sh`, replacing the inline template). A Claude run is
  the old template's launch, argv for argv (executed parity test, `src/daemon/local-docker-launch.test.ts`).
  A Codex run bind-mounts `${HARMONY_CODEX_AUTH_SRC:-~/.harmony/codex-automation/auth.json}` read-only at
  `/home/worker/.codex-auth-src/auth.json`, mounts a per-conduction `codex-sessions` dir at
  `~/.codex/sessions`, sets `HARMONY_CODEX_AUTH_FILE`, skips the Claude-only host resume discovery, and
  refuses on a missing file or a metered variable.
- **Cloud** (`container/cloud-worker-launch.sh`). The login cache is a Secret Manager secret mounted on the
  **job** (container/README.md runbook). A Codex run checks `gcloud run jobs describe` for a secret volume
  at `/home/worker/.codex-auth-src` before minting, locking, updating or executing, refuses without it,
  and adds `HARMONY_CODEX_AUTH_FILE` to the per-execution env (`--env-vars-file` replaces the job's literal
  env, so it cannot be a standing job variable). A Claude run's gcloud calls are byte-identical to the
  previous script (executed against a fixture copy, `src/daemon/cloud-codex-launch.test.ts`).

**BLOCKED — pending the live leg.** None of this has run against a real Docker daemon or Cloud Run job
with a real login cache. Unproven:

1. **Local-docker file permissions.** The cache is bind-mounted as-is (mode 600, owned by the conductor
   host's user). Docker Desktop's file sharing presents it readable to the worker (uid 1001); on a native
   Linux conductor host whose user is not uid 1001 the worker cannot read it and `harmony agent render`
   refuses. The docker-host profile avoids this by chowning a shipped copy; local-docker does not.
2. **Cloud secret mount.** That `--update-secrets=/home/worker/.codex-auth-src/auth.json=…` produces a
   volume the describe parse recognises (a `secret` volume mounted at the directory, item `auth.json`) is
   taken from the documented Cloud Run shape, not observed. Secret-volume files are root-owned and
   read-only; whether the worker user can read them is unverified.
3. The image the deployment's `worker_image` names must be the `agent-codex` target on both profiles.

### Cost capture — RAN (fixture) / gaps

`harmony leg-cost record` now reads a Codex capture through the codex adapter's telemetry
(`TelemetryRecord.usage`, filled from the LAST `turn.completed`): `input_tokens`, `cached_input_tokens`
→ `cache_read_input_tokens`, `output_tokens`; `runtime=codex`, `credential_kind=login-cache`,
`cost_regime=plan-included`, `total_cost_usd` null with `cost_source='unknown'`, `session_id` = the thread
id, `is_error` from `turn.failed`. `provision.sh` already handed every invocation's stdout capture to
`leg-cost record` regardless of adapter, so no script change was needed. Gaps, recorded as null:

- **`input_tokens` semantics differ.** Codex's figure *includes* the cached part; Claude's excludes cache
  reads. The column holds what Codex reports; a cross-runtime comparison must subtract.
- **Cumulative on resume.** On a resumed thread the usage is cumulative for the thread. Codex legs
  cold-start today, so each row is per invocation; once Codex resume is wired, rows must subtract.
- **Not recorded:** `cache_write_input_tokens` and `reasoning_output_tokens` (no column with matching
  semantics — reasoning is a subset of output for OpenAI), `num_turns`, `duration_ms`, `duration_api_ms`,
  `service_tier` (not in the `--json` stream).
- **Live stream unverified.** The fixture follows the shape observed in the 0.163.0 mock runs; a live
  plan-backed stream is BLOCKED with the rest of Auth.

## What the contract needed

`src/agents/contract.ts` was unchanged by the first pass. Two places where the contract is a poor fit are absorbed in the
adapter rather than widening the contract: `HeadlessInput` has no working-directory field, so `--cd` is
derived from the plugin checkout's parent (an upstream `--cd`/`-C` in `extraFlags` wins), and the plugin
dir is also passed as `--add-dir` so it is an argv element as the conformance suite requires.

The send-back made one additive change: `TelemetryRecord` gained an optional `usage`
(`TelemetryUsage`: input, cache-read and output tokens), which the codex adapter fills and
`harmony leg-cost record` reads for a non-Claude capture. Claude legs keep their own envelope parse.
