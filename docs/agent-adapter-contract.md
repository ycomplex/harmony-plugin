# The agent-adapter contract (B-1075, routed by B-1077)

An **agent adapter** describes, declaratively, how one coding-agent runtime runs a Harmony leg.
Claude Code is the first one (`src/agents/claude-code.ts`). Codex is next (B-1076). An adapter is pure
data and pure functions. It never spawns anything.

| File | What it is |
|---|---|
| `src/agents/contract.ts` | The ten seam types, the canonical MCP connection, the capability list |
| `src/agents/credentials.ts` | The B-934 credential vocabulary, `deriveCostRegime`, `validateCredentialDeclaration` |
| `src/agents/registry.ts` | Registry id → adapter. `getAdapter(id)` throws on an unknown id and names the registered ones |
| `src/agents/claude-code.ts` | The Claude Code adapter (registry id `claude-code`) |
| `src/agents/conformance.ts` | `runConformance(adapter)` → one `{seam, number, pass, problems[]}` per seam |
| `src/agents/runtime-command-guard.ts` | Detects source that builds a `claude`/`codex` command itself |
| `src/agents/launch-routing.ts` | B-1077 worker-side routing: run_config → adapter, launch command, credential verdict, NUL argv encoding |
| `src/cli/commands/agent.ts` | `harmony agent resolve / binary / check-credentials / argv` — what `provision.sh` calls |
| `src/daemon/agent-eligibility.ts` | B-1077 fire-time check: adapter registered AND on the profile's `agents` list, else park |

**The routing seam is live (B-1077): the adapter performs the launch.** `container/provision.sh`
no longer composes the runtime command. Each launch site (the B-718 resume attempt, its cold
fallback, and every B-772 cold/model-switch invocation) runs exactly the argv that
`harmony agent argv --plugin-dir <dir> --prompt <prompt> [--resume <id>] [--model <alias>] -- <upstream flags>`
prints. That argv is the adapter's binary followed by its `buildArgv`, NUL-separated, and read back
with `while IFS= read -r -d '' t`. The rest of the B-772/B-916/B-718 loop around those sites is
unchanged. provision.sh no longer adds `--output-format json` itself, because the adapter's argv
already carries it. The presence probe asks `harmony agent binary`.

- **Selecting an adapter.** It is set per run by `run_config.agent.adapter`. An absent key means
  `claude-code`, so every existing run launches exactly as before. Changing the value back to
  `claude-code` (or removing it) is a config-only rollback, and the launch command is then
  byte-identical to the pre-B-1077 one (`src/agents/launch-routing.test.ts`). A malformed value or
  an unregistered id is **refused**, both by the worker (`Refusing to start: Unknown agent adapter
  'codex' — registered: claude-code`) and by the daemon. It never falls back to `claude-code`.
- **Profiles.** Each launch profile has an optional `agents` list of registry ids, in both
  `deployment.json`'s `profiles.<name>` and the legacy profile file. An absent list means
  `["claude-code"]` only. Before a leg fires, `fireLaunch` checks that the run's adapter is
  registered and is in that list. It also refuses a non-default adapter on a launch template without
  `{run_config_json}`, because the worker would never see the choice. On a refusal it parks the
  ticket the way a fast-track admission refusal does: the conduction is parked
  (`last_worker_exit_class: agent-ineligible`), the ticket is advanced to `parking`, a comment names
  the registered adapters and the profile's list, and no worker is launched. The daemon only looks
  up an id and compares it to a list. It still builds no runtime command, and
  `src/agents/daemon-runtime-guard.test.ts` keeps it that way.
- **Credentials.** `harmony agent check-credentials` runs the adapter's `resolveCredential`.
  provision.sh **refuses to start** (non-zero exit, `Refusing to start: …` on stderr) when
  `ANTHROPIC_API_KEY` is set beside `CLAUDE_CODE_OAUTH_TOKEN`, and also when neither is set. Before
  B-1077 it only warned and let the API key win. Empty values are unset first.

The drift test (`src/agents/claude-code-drift.test.ts`) now asserts that provision.sh launches
*through* the adapter: every `_b772_run` site runs `"${AGENT_ARGV[@]}"`, each one has its own
`_agent_argv` build, and there is no hand-assembled `claude …` invocation and no literal
`--output-format`. For the seams the scripts still implement (session paths, agent-file delivery,
the env allowlist and MCP), it still compares the adapter against the scripts.

## The ten seams

| # | Seam | What an adapter must declare | Claude Code today |
|---|---|---|---|
| 1 | **launch** (install) | The binary on PATH and an argv that probes it is present | `claude`; `command -v claude` |
| 2 | **auth** | Accepted credentials, all from its family's vocabulary; the env var for each; a primary; `resolveCredential(env)`. Two credentials at once, or none, is an error. An empty value counts as unset | `subscription-token` = `CLAUDE_CODE_OAUTH_TOKEN` (primary); `api-key` = `ANTHROPIC_API_KEY` |
| 3 | **headless** invocation + exit semantics | `buildArgv({pluginDir, prompt, resumeSessionId?, model?, extraFlags?})`; success exit code; non-zero fails the leg; the structured error field | `--plugin-dir <dir> -p <prompt> [--resume <id>] <extra flags> [--output-format json, unless the extra flags already set one] [--model <alias>]`; exit 0; `is_error` |
| 4 | **session** storage + resume | Transcript root and extension, resume flag, `sessionGlob(id)`, `sessionIdFromPath(path)` | `$HOME/.claude/projects/*/<id>.jsonl`; `--resume` |
| 5 | **instructions** rendering | The instruction file the runtime reads, and `render(body)` | `CLAUDE.md` |
| 6 | **skills** delivery | How skills reach the runtime, the skills root, any agent files copied into place | `--plugin-dir`; `skills/`; `container/agents/harmony-build.md` → `$HOME/.claude/agents/harmony-build.md` |
| 7 | **mcp** rendering | `render(connection)` from the ONE canonical `HARMONY_MCP_CONNECTION` | The plugin's `.mcp.json`, with `{pluginRoot}` rendered as `${CLAUDE_PLUGIN_ROOT}` |
| 8 | **env** allowlist | The per-leg env vars forwarded into the worker, and the standing secrets bound separately | `cloud-worker-launch.sh` `write_exec_env_file()`'s eleven vars; secrets `HARMONY_API_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| 9 | **capabilities** | A boolean for each of `subagents`, `hooks`, `skills`, `mcp`, `resume`, `modelSwitch`, `structuredOutput`. `mcp` is required | All true |
| 10 | **telemetry** | `parse(stdout, {model, credential})` → `{runtime, model, credential, costRegime, costUsd, sessionId, isError}` or null; a sample output | The `--output-format json` result envelope, via `src/tools/claude-result-parse.ts` |

Seams 7 and 8 are the ticket's "MCP rendering from one canonical connection definition + the worker
env allowlist", split in two so that there are ten seams.

## Credentials and cost regime (B-934)

| Runtime | Credential vocabulary |
|---|---|
| Claude Code | `subscription-token` (long-lived `CLAUDE_CODE_OAUTH_TOKEN`), `api-key` |
| Codex | `login-cache`, `api-key`, `workload-identity`, `enterprise-access-token` |

- **The cost regime is derived from the credential and is never chosen.** `login-cache`,
  `enterprise-access-token` and `subscription-token` are `plan-included`. `api-key` and
  `workload-identity` are `metered`. The function is `deriveCostRegime(credential)`. The conformance
  suite fails an adapter whose telemetry reports any other regime.
- **Dogfood** permits plan-included only.
- **Production** permits plan-included. It permits metered only with a declared spend ceiling,
  counted per deployment per calendar month, with no default. `warn_at` defaults to 80% of the
  ceiling. A metered credential without a ceiling is a loud config error. The function is
  `validateCredentialDeclaration({deployment, credential, runtime?, spendCeiling?, warnAt?})`.
- **No silent fallback between regimes.** `ANTHROPIC_API_KEY` set beside `CLAUDE_CODE_OAUTH_TOKEN` is
  a config error, not a precedence rule. Since B-1077 this is enforced at launch: `provision.sh`
  refuses to start on the adapter's verdict (`harmony agent check-credentials`).

## Running the conformance suite

```bash
npx vitest run src/agents
```

`src/agents/conformance.test.ts` runs `runConformance` against the Claude adapter, where all ten seams
must pass. It also runs it against ten deliberately broken copies, one per seam. Each copy must fail
its broken seam and only that seam, which proves the suite catches a failure at each seam. A seam
that throws is reported as a failure of that seam. It does not crash the suite.

A new adapter passes when:

```ts
expect(runConformance(myAdapter).filter((r) => !r.pass)).toEqual([]);
```

## Where the next tickets plug in

- **B-1076 (Codex adapter): all ten seams.** Add `src/agents/codex.ts` implementing `AgentAdapter`
  with `family: 'codex'`, using only the Codex credential vocabulary above. Register it in
  `registry.ts` and pass the same `runConformance` with no exceptions. Add a drift test of its own if
  it gets launch-script support.
- **B-1077 (per-leg launch-profile routing): done.** See "The routing seam is live" above.
  `buildArgv` and the auth resolution are now the launch. The env allowlist is still
  implemented by the launch scripts and pinned by the drift test. A new adapter (B-1076) becomes
  launchable once it is registered and listed in a profile's `agents`.
- **B-1078 (observability): seam 10 (telemetry).** Read `telemetry.parse` for runtime, model,
  credential and cost regime per invocation. Do not re-derive the regime. Use `deriveCostRegime`.
