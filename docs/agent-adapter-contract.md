# The agent-adapter contract (B-1075)

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

**Today the adapter describes the launch. It does not perform it.** `container/provision.sh` still
composes the `claude` invocation, and the launch scripts still forward the environment. The drift test
(`src/agents/claude-code-drift.test.ts`) reads those scripts as text and fails when the adapter and the
scripts disagree. A change to the launch therefore has to change both sides until B-1077 makes
provision.sh dispatch through the registry. The daemon assembles no runtime command, and
`src/agents/daemon-runtime-guard.test.ts` keeps it that way.

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
  a config error, not a precedence rule. *Known gap:* `provision.sh` today only **warns** in that case
  and lets the API key win. The adapter's `resolveCredential` encodes the policy, and enforcement
  lands when B-1077 routes the launch through the adapter. The drift test pins only that both sides
  name the same variables.

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
- **B-1077 (per-leg launch-profile routing): seam 1 (launch) and the registry.** Route each leg by
  registry id and rewire `provision.sh` to dispatch through the adapter, so that `buildArgv`, the
  auth resolution and the env allowlist stop being descriptions and become the launch. This is also
  where the API-key-beside-OAuth refusal becomes enforced. Update the drift test in the same change.
- **B-1078 (observability): seam 10 (telemetry).** Read `telemetry.parse` for runtime, model,
  credential and cost regime per invocation. Do not re-derive the regime. Use `deriveCostRegime`.
