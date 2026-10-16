// B-1075: the Claude Code adapter — a declarative description of how a leg launches TODAY.
//
// Nothing here spawns anything, and nothing here is (yet) on the launch path: container/provision.sh
// still composes the invocation itself. This file is the description of what it does, pinned to the
// shell by src/agents/claude-code-drift.test.ts so either side drifting fails CI. B-1077 rewires
// provision.sh to dispatch through the registry; until then a change to the launch must change
// both. Every value below cites the script line it mirrors.

import type { AgentAdapter, CredentialResolution, HeadlessInput, McpConnection } from './contract.js';
import { PLUGIN_ROOT_PLACEHOLDER } from './contract.js';
import { deriveCostRegime } from './credentials.js';
import { parseClaudeResultJson, resolveCost } from '../tools/claude-result-parse.js';

/** provision.sh: `EXTRA_HEADLESS_FLAGS_BASE+=(--output-format json)`, added only when the
 *  upstream CLAUDE_HEADLESS_FLAGS carry no `--output-format` of their own (B-916). */
export const CLAUDE_OUTPUT_FORMAT_FLAGS: readonly string[] = ['--output-format', 'json'];
/** provision.sh: `EXTRA_HEADLESS_FLAGS+=(--model "$CURRENT_MODEL")`, layered last (B-772). */
export const CLAUDE_MODEL_FLAG = '--model';
export const CLAUDE_RESUME_FLAG = '--resume';
export const CLAUDE_PLUGIN_DIR_FLAG = '--plugin-dir';
export const CLAUDE_PROMPT_FLAG = '-p';

const OAUTH_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const API_KEY_ENV = 'ANTHROPIC_API_KEY';

function present(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  // provision.sh unsets a set-but-empty value before checking (the --env-file blank-line shadow).
  const v = env[name];
  return typeof v === 'string' && v !== '';
}

function resolveClaudeCredential(env: Readonly<Record<string, string | undefined>>): CredentialResolution {
  const oauth = present(env, OAUTH_ENV);
  const apiKey = present(env, API_KEY_ENV);
  if (oauth && apiKey) {
    // B-934: no silent fallback between regimes. (provision.sh today only WARNS here and lets the
    // API key win; the refusal is the policy, enforced when B-1077 routes the launch through this.)
    return { ok: false, error: `${API_KEY_ENV} is set beside ${OAUTH_ENV} — two credentials at once is a config error (B-934: no silent fallback between regimes). Unset one.` };
  }
  if (oauth) return { ok: true, credential: 'subscription-token' };
  if (apiKey) return { ok: true, credential: 'api-key' };
  return { ok: false, error: `headless mode needs auth: set ${OAUTH_ENV} (subscription-token; mint via 'claude setup-token') or ${API_KEY_ENV} (api-key, metered).` };
}

function buildClaudeArgv(input: HeadlessInput): string[] {
  // provision.sh: claude --plugin-dir "$PLUGIN_DIR" -p "$PROMPT" [--resume "$RESUME_SESSION_ID"] "${EXTRA_HEADLESS_FLAGS[@]}"
  // where EXTRA_HEADLESS_FLAGS = CLAUDE_HEADLESS_FLAGS (+ --output-format json unless already set)
  // (+ --model "$CURRENT_MODEL" when non-empty).
  const argv = [CLAUDE_PLUGIN_DIR_FLAG, input.pluginDir, CLAUDE_PROMPT_FLAG, input.prompt];
  if (input.resumeSessionId) argv.push(CLAUDE_RESUME_FLAG, input.resumeSessionId);
  const extra = [...(input.extraFlags ?? [])];
  argv.push(...extra);
  if (!extra.includes(CLAUDE_OUTPUT_FORMAT_FLAGS[0])) argv.push(...CLAUDE_OUTPUT_FORMAT_FLAGS);
  if (input.model) argv.push(CLAUDE_MODEL_FLAG, input.model);
  return argv;
}

const SESSION_ROOT = '$HOME/.claude/projects';
const SESSION_EXT = '.jsonl';

function renderClaudeMcp(connection: McpConnection): { fileName: string; content: string } {
  // .mcp.json: { "<name>": { "command": ..., "args": [...] } }, plugin root as ${CLAUDE_PLUGIN_ROOT}.
  const args = connection.args.map((a) => a.split(PLUGIN_ROOT_PLACEHOLDER).join('${CLAUDE_PLUGIN_ROOT}'));
  const doc = { [connection.name]: { command: connection.command, args } };
  return { fileName: '.mcp.json', content: JSON.stringify(doc, null, 2) + '\n' };
}

const SAMPLE_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: '00000000-0000-4000-8000-000000000000',
  num_turns: 3,
  duration_ms: 1200,
  total_cost_usd: 0.42,
  usage: { input_tokens: 10, output_tokens: 20 },
});

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  family: 'claude-code',
  displayName: 'Claude Code',

  // 1. launch — provision.sh: `command -v claude` (fails the leg when the image has no claude).
  launch: { binary: 'claude', probeArgv: ['command', '-v', 'claude'] },

  // 2. auth — provision.sh's headless auth block.
  auth: {
    acceptedCredentials: ['subscription-token', 'api-key'],
    credentialEnv: { 'subscription-token': OAUTH_ENV, 'api-key': API_KEY_ENV },
    primaryCredential: 'subscription-token',
    resolveCredential: resolveClaudeCredential,
  },

  // 3. headless invocation + exit semantics — every `_b772_run claude ...` line in provision.sh; the
  //    leg exits with claude's own status, and `is_error` (never `subtype`) marks an errored run.
  headless: {
    buildArgv: buildClaudeArgv,
    exit: { successCode: 0, nonZeroIsFailure: true, structuredErrorField: 'is_error' },
  },

  // 4. session storage + resume — `"$HOME/.claude/projects"/*/"$RESUME_SESSION_ID.jsonl"`.
  session: {
    root: SESSION_ROOT,
    extension: SESSION_EXT,
    resumeFlag: CLAUDE_RESUME_FLAG,
    sessionGlob: (id) => `${SESSION_ROOT}/*/${id}${SESSION_EXT}`,
    sessionIdFromPath: (path) => {
      const m = /\/\.claude\/projects\/[^/]+\/([^/]+)\.jsonl$/.exec(path);
      return m ? m[1] : null;
    },
  },

  // 5. instruction rendering — Claude Code reads the project's CLAUDE.md.
  instructions: {
    fileName: 'CLAUDE.md',
    render: (body) => ({ fileName: 'CLAUDE.md', content: body.endsWith('\n') ? body : body + '\n' }),
  },

  // 6. skill delivery — `--plugin-dir "$PLUGIN_DIR"` loads skills/; provision.sh copies the build
  //    subagent definition into ~/.claude/agents (config levers do not reach Task-tool subagents).
  skills: {
    mechanism: CLAUDE_PLUGIN_DIR_FLAG,
    skillsRoot: 'skills',
    agentFiles: [{ source: 'container/agents/harmony-build.md', target: '$HOME/.claude/agents/harmony-build.md' }],
  },

  // 7. MCP rendering — renders the canonical connection as the plugin's .mcp.json.
  mcp: { render: renderClaudeMcp },

  // 8. worker env allowlist — container/cloud-worker-launch.sh write_exec_env_file(): the per-leg
  //    literal env set (`--env-vars-file` REPLACES the job's literal env, so this is exhaustive).
  //    Credentials ride `--set-secrets` bindings, never this list.
  env: {
    allowlist: [
      'CONDUCTION_ID',
      'TICKET',
      'GIT_TOKEN',
      'HARMONY_TRANSCRIPT_MOUNT_ROOT',
      'HARMONY_PLUGIN_POSTURE',
      'HARMONY_REPOS_JSON',
      'HARMONY_RUN_CONFIG_JSON',
      'HARMONY_MODEL',
      'GIT_TOKEN_EXPIRES_AT',
      'HARMONY_LEG',
      'HARMONY_CONDUCTION_ID',
    ],
    standingSecrets: ['HARMONY_API_TOKEN', OAUTH_ENV],
  },

  // 9. capability map.
  capabilities: {
    subagents: true,
    hooks: true,
    skills: true,
    mcp: true,
    resume: true,
    modelSwitch: true,
    structuredOutput: true,
  },

  // 10. telemetry — the `--output-format json` result envelope (src/tools/claude-result-parse.ts).
  telemetry: {
    parse: (stdout, ctx) => {
      const parsed = parseClaudeResultJson(stdout);
      if (!parsed) return null;
      return {
        runtime: 'claude-code',
        model: ctx.model,
        credential: ctx.credential,
        costRegime: deriveCostRegime(ctx.credential),
        costUsd: resolveCost(parsed, ctx.model).total_cost_usd,
        sessionId: parsed.session_id,
        isError: parsed.is_error,
      };
    },
    sampleOutput: SAMPLE_RESULT,
  },
};
