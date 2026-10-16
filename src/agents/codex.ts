// B-1076: the Codex adapter — the second implementation of the ten-seam contract (src/agents/contract.ts).
//
// Pure data + pure functions: nothing here spawns anything or reads a file. Since B-1077 the worker
// (container/provision.sh) launches whatever `harmony agent argv` prints from this adapter, so this
// file IS the Codex launch; container/provision.sh additionally renders the config / AGENTS.md /
// skill link through `harmony agent render` (src/cli/commands/agent.ts). Every claim about the
// Codex CLI below was checked against @openai/codex 0.163.0 — see docs/codex-phase0-findings.md for
// what was run, what was run against a MOCK model provider, and what is still BLOCKED on a live plan
// login. src/agents/codex-drift.test.ts re-checks the CLI-facing claims against an installed CLI.
//
// The credential is a LOGIN-CACHE FILE (`auth.json` from `codex login --device-auth`, plan-included,
// B-934). Credential env discipline: the secret NEVER enters env. The AuthSeam maps `login-cache` to
// a non-secret PATH variable (HARMONY_CODEX_AUTH_FILE); resolveCredential is env-only and never
// opens the file; no script in this repo reads, cats or logs it (codex-auth-file.test.ts pins that).
// An API key (OPENAI_API_KEY / CODEX_API_KEY) beside it is refused, not preferred — no metered
// fallback (B-934).

import { posix as path } from 'node:path';
import type { AgentAdapter, CredentialResolution, HeadlessInput, McpConnection } from './contract.js';
import { PLUGIN_ROOT_PLACEHOLDER } from './contract.js';
import { deriveCostRegime } from './credentials.js';

// --- constants the scripts and tests share ------------------------------------------------------------

/** The non-secret env var carrying the PATH of the login-cache file inside the worker. */
export const CODEX_AUTH_FILE_ENV = 'HARMONY_CODEX_AUTH_FILE';
/** Credentials whose presence is a config error beside (or instead of) the login cache: metered
 *  and token credentials Codex would silently prefer over, or fall back to, the cache. */
export const CODEX_REFUSED_CREDENTIAL_ENV: readonly string[] = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];

/** Where the worker's Codex home lives (CODEX_HOME's default); sessions are mounted per conduction. */
export const CODEX_HOME_DIR = '/home/worker/.codex';
/** The file Codex reads its login from, relative to CODEX_HOME. */
export const CODEX_AUTH_FILE_NAME = 'auth.json';

/** The worker image's fixed plugin clone (container/provision.sh's PLUGIN_DIR). */
export const CODEX_DEFAULT_PLUGIN_ROOT = '/workspace/workspace/plugin';

export const CODEX_EXEC_SUBCOMMAND = 'exec';
export const CODEX_RESUME_SUBCOMMAND = 'resume';
export const CODEX_JSON_FLAG = '--json';
export const CODEX_CD_FLAG = '--cd';
export const CODEX_ADD_DIR_FLAG = '--add-dir';
export const CODEX_MODEL_FLAG = '-m';
/** The explicit bypass: the disposable single-ticket container IS the sandbox (B-694). */
export const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

/** The skills directory Codex discovers (`.agents/skills` between the cwd and the repo root). */
export const CODEX_SKILLS_LINK = '.agents/skills';

/** AGENTS.md ceiling. The three canonical CLAUDE.md files measure ≈49.5 KB today (Codex's default is
 *  32 KiB and silently TRUNCATES beyond it — verified); 256 KiB leaves ~5x headroom. */
export const CODEX_PROJECT_DOC_MAX_BYTES = 262144;

/** MCP server timeouts, explicit rather than Codex's 10s / 60s defaults. */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 60;
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 600;

/** The env the Codex MCP server is given (Codex forwards ONLY what is listed — verified: an unlisted
 *  variable does not reach the server). The harmony server's own HARMONY_* inputs, and no secret
 *  beyond the board token it already needs. */
export const CODEX_MCP_ENV_VARS: readonly string[] = [
  'HARMONY_API_TOKEN',
  'HARMONY_SUPABASE_URL',
  'HARMONY_SUPABASE_ANON_KEY',
  'HARMONY_LEG',
  'HARMONY_CONDUCTION_ID',
  'HARMONY_MODEL',
  'HARMONY_PLUGIN_POSTURE',
  'HARMONY_RUN_CONFIG_JSON',
  'HARMONY_RUN_CONFIG_PATH',
  'HARMONY_WEB_ROOT',
  'HARMONY_DEPLOYMENT_CONFIG',
  'HARMONY_CONFIG_DIR',
];

// --- 2. auth --------------------------------------------------------------------------------------------

function present(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  // provision.sh's --env-file blank-line shadow: a set-but-empty value counts as unset.
  const v = env[name];
  return typeof v === 'string' && v !== '';
}

const LOGIN_HOWTO =
  `On the daemon host run 'CODEX_HOME=~/.harmony/codex-automation codex login --device-auth' once, ` +
  `then mount that auth.json into the worker (container/README.md "Codex credential runbook").`;

function resolveCodexCredential(env: Readonly<Record<string, string | undefined>>): CredentialResolution {
  const refused = CODEX_REFUSED_CREDENTIAL_ENV.filter((n) => present(env, n));
  if (refused.length > 0) {
    // Names only — never a value. B-934: an API key / access token beside the login cache is a config
    // error, not a precedence rule (it would silently move the leg to the metered regime).
    return {
      ok: false,
      error:
        `${refused.join(' and ')} ${refused.length > 1 ? 'are' : 'is'} set — the Codex adapter runs on the plan-included ` +
        `login cache (${CODEX_AUTH_FILE_ENV}) and refuses a metered or token credential beside it (B-934: no silent ` +
        `fallback between regimes). Unset ${refused.join(' and ')}.`,
    };
  }
  if (present(env, CODEX_AUTH_FILE_ENV)) return { ok: true, credential: 'login-cache' };
  return {
    ok: false,
    error: `headless Codex needs auth: set ${CODEX_AUTH_FILE_ENV} to the path of the mounted login-cache file (login-cache, plan-included). ${LOGIN_HOWTO}`,
  };
}

// --- 3. headless ----------------------------------------------------------------------------------------

/** Codex's explicit skill invocation is `$<plugin>:<skill>` — verified against 0.163.0 with a
 *  `.agents/skills` symlink to this plugin's skills/: `$harmony-plugin:harmony-conduct …` injects the
 *  skill body, `/harmony-plugin:harmony-conduct …` (the Claude slash form every launch template
 *  carries) does not. A leading slash-command is translated; any other prompt passes through. */
export function codexPrompt(prompt: string): string {
  const m = /^\/([A-Za-z0-9_-]+:[A-Za-z0-9_-]+)(?=\s|$)/.exec(prompt);
  return m ? `$${m[1]}${prompt.slice(m[0].length)}` : prompt;
}

function buildCodexArgv(input: HeadlessInput): string[] {
  const extra = [...(input.extraFlags ?? [])];
  const resume = input.resumeSessionId;
  const argv: string[] = [CODEX_EXEC_SUBCOMMAND];
  if (resume) {
    // `codex exec resume <id>` accepts neither --cd nor --add-dir (0.163.0 --help): the working root
    // is the process cwd, which provision.sh sets (cd "$WORKDIR") for every launch.
    argv.push(CODEX_RESUME_SUBCOMMAND, resume, CODEX_JSON_FLAG, CODEX_BYPASS_FLAG);
  } else {
    argv.push(CODEX_JSON_FLAG);
    // The workspace root is the plugin checkout's parent (…/workspace/plugin → …/workspace), where the
    // generated AGENTS.md lives. An upstream --cd/-C wins.
    if (!extra.includes(CODEX_CD_FLAG) && !extra.includes('-C')) argv.push(CODEX_CD_FLAG, path.dirname(input.pluginDir));
    argv.push(CODEX_ADD_DIR_FLAG, input.pluginDir, CODEX_BYPASS_FLAG);
  }
  if (input.model) argv.push(CODEX_MODEL_FLAG, input.model);
  argv.push(...extra);
  argv.push(codexPrompt(input.prompt));
  return argv;
}

// --- 4. session -----------------------------------------------------------------------------------------

const SESSION_ROOT = '$HOME/.codex/sessions';
const SESSION_EXT = '.jsonl';
// rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-id>.jsonl under sessions/YYYY/MM/DD/ (verified on 0.163.0 —
// a VERSION-PINNED layout the public docs do not promise; the thread.started event is the primary
// source of the id). `*` is accepted in the timestamp slot so a sessionGlob() result round-trips.
const ROLLOUT_PATH = /\/\.codex\/sessions\/(?:[^/]+\/){3}rollout-(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}|\*)-(.+)\.jsonl$/;

// --- 7. mcp ---------------------------------------------------------------------------------------------

/** A TOML basic string. JSON string escapes (\" \\ \n \uXXXX) are valid TOML basic-string escapes. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}
function tomlStringArray(a: readonly string[]): string {
  return `[${a.map(tomlString).join(', ')}]`;
}

/** Render the worker's Codex `config.toml` from the ONE canonical connection. `pluginRoot` resolves
 *  the `{pluginRoot}` placeholder (Codex's config has no variable expansion). */
export function renderCodexConfig(
  connection: McpConnection,
  opts: { pluginRoot?: string } = {},
): { fileName: string; content: string } {
  const root = opts.pluginRoot ?? CODEX_DEFAULT_PLUGIN_ROOT;
  const args = connection.args.map((a) => a.split(PLUGIN_ROOT_PLACEHOLDER).join(root));
  const lines = [
    '# Generated by `harmony agent render` (B-1076) from the canonical MCP connection. Do not edit.',
    '# approval_policy never: an unattended worker must never wait on an approval UI.',
    'approval_policy = "never"',
    '# The aggregated AGENTS.md is larger than Codex\'s 32 KiB default, which TRUNCATES silently.',
    `project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}`,
    '',
    `[mcp_servers.${connection.name}]`,
    `command = ${tomlString(connection.command)}`,
    `args = ${tomlStringArray(args)}`,
    '# required: a worker without Harmony tools must fail BEFORE doing repository work.',
    'required = true',
    `startup_timeout_sec = ${CODEX_MCP_STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${CODEX_MCP_TOOL_TIMEOUT_SEC}`,
    'default_tools_approval_mode = "auto"',
    `env_vars = ${tomlStringArray(CODEX_MCP_ENV_VARS)}`,
    '',
  ];
  return { fileName: 'config.toml', content: lines.join('\n') };
}

// --- 5. instructions ------------------------------------------------------------------------------------

export const CODEX_WORKER_OVERLAY = [
  '## Codex worker overlay (B-1076)',
  '',
  'You are running as a Codex worker inside a disposable single-ticket container. The sections above are the',
  'repository guidance written for Claude Code; read them with these substitutions:',
  '',
  '- Skills are invoked as `$harmony-plugin:<skill>` (for example `$harmony-plugin:harmony-conduct`), not as',
  '  `/harmony-plugin:<skill>`. Harmony tools are the `harmony` MCP server\'s tools.',
  '- There are no subagents and no `harmony-build` agent: do the build in this thread.',
  '- There is no in-worker model switch: skip any step that asks you to compare or switch models.',
  '- There are no hooks: do not rely on a session-start or stop hook having run.',
  '',
].join('\n');

export interface InstructionSource {
  /** Shown in the source header, e.g. `workspace/CLAUDE.md`. */
  label: string;
  content: string;
}

/** First line of a generated AGENTS.md — what lets a re-render overwrite its own file and nothing else. */
export const GENERATED_AGENTS_HEADER = '# Harmony worker instructions (generated)';

const SOURCE_MARKER = (label: string) => `<!-- harmony-agents-md source: ${label} -->`;

/** One generated AGENTS.md: the canonical guidance files in the given (deterministic) order, each under an
 *  explicit source header, then the Codex overlay. */
export function renderCodexAgentsMd(sources: readonly InstructionSource[], overlay: string = CODEX_WORKER_OVERLAY): string {
  const parts = [
    GENERATED_AGENTS_HEADER,
    '',
    'Generated by `harmony agent render` from the canonical CLAUDE.md files. Do not edit; do not commit.',
    '',
  ];
  for (const s of sources) {
    parts.push(SOURCE_MARKER(s.label), `# Source: ${s.label}`, '', s.content.replace(/\s+$/, ''), '');
  }
  parts.push(SOURCE_MARKER('codex-overlay'), overlay.replace(/\s+$/, ''), '');
  return parts.join('\n');
}

/** The preflight: every source marker is present and the file fits the byte ceiling. */
export function verifyCodexAgentsMd(
  content: string,
  sources: readonly InstructionSource[],
  maxBytes: number = CODEX_PROJECT_DOC_MAX_BYTES,
): string[] {
  const problems: string[] = [];
  for (const s of [...sources.map((x) => x.label), 'codex-overlay']) {
    if (!content.includes(SOURCE_MARKER(s))) problems.push(`source '${s}' is missing from AGENTS.md`);
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxBytes) problems.push(`AGENTS.md is ${bytes} bytes, over project_doc_max_bytes (${maxBytes}) — Codex would truncate it`);
  return problems;
}

// --- 10. telemetry --------------------------------------------------------------------------------------

interface CodexEvent {
  type?: string;
  thread_id?: string;
  usage?: Record<string, unknown>;
}

function events(stdout: string): CodexEvent[] {
  const out: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && typeof (v as CodexEvent).type === 'string') out.push(v as CodexEvent);
    } catch {
      /* not an event line */
    }
  }
  return out;
}

/** The thread id from the first `thread.started` event, or null. */
export function parseCodexThreadId(stdout: string): string | null {
  const e = events(stdout).find((x) => x.type === 'thread.started' && typeof x.thread_id === 'string' && x.thread_id !== '');
  return e ? (e.thread_id as string) : null;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** The usage of the LAST `turn.completed`, or null. NOTE (verified, 0.163.0): on a resumed thread the
 *  figure is CUMULATIVE for the thread, not per invocation — a consumer that wants this invocation's
 *  cost must subtract the previous leg's figure. */
export function parseCodexUsage(stdout: string): CodexUsage | null {
  const done = events(stdout).filter((x) => x.type === 'turn.completed' && x.usage && typeof x.usage === 'object');
  const u = done.length ? done[done.length - 1].usage! : null;
  if (!u) return null;
  const n = (k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k] as number) ? (u[k] as number) : 0);
  return {
    inputTokens: n('input_tokens'),
    cachedInputTokens: n('cached_input_tokens'),
    cacheWriteInputTokens: n('cache_write_input_tokens'),
    outputTokens: n('output_tokens'),
    reasoningOutputTokens: n('reasoning_output_tokens'),
  };
}

const SAMPLE_OUTPUT = [
  JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000000' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'done' } }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 4 },
  }),
].join('\n');

// --- the adapter ----------------------------------------------------------------------------------------

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  family: 'codex',
  displayName: 'Codex',

  // 1. launch — `codex --version` (the image's smoke gate runs the same probe).
  launch: { binary: 'codex', probeArgv: ['codex', '--version'] },

  // 2. auth — the login-cache file, addressed by a non-secret path variable. Plan-included (B-934).
  auth: {
    acceptedCredentials: ['login-cache'],
    credentialEnv: { 'login-cache': CODEX_AUTH_FILE_ENV },
    primaryCredential: 'login-cache',
    resolveCredential: resolveCodexCredential,
  },

  // 3. headless — `codex exec --json --cd <root> … <prompt>`; exit 0 = the leg completed, any other
  //    exit fails it (verified: a failed turn exits 1 with a turn.failed event). The exit code is
  //    authoritative, so there is no structured error field to consult.
  headless: {
    buildArgv: buildCodexArgv,
    exit: { successCode: 0, nonZeroIsFailure: true, structuredErrorField: null },
  },

  // 4. session — per-conduction CODEX_HOME/sessions (mounted per conduction by the launch profile);
  //    `codex exec resume <id>`; the id comes from the thread.started event, the rollout glob is the
  //    version-pinned fallback.
  session: {
    root: SESSION_ROOT,
    extension: SESSION_EXT,
    resumeFlag: CODEX_RESUME_SUBCOMMAND,
    sessionGlob: (id) => `${SESSION_ROOT}/*/*/*/rollout-*-${id}${SESSION_EXT}`,
    sessionIdFromPath: (p) => {
      const m = ROLLOUT_PATH.exec(p);
      return m ? m[1] : null;
    },
  },

  // 5. instructions — ONE generated AGENTS.md (workspace + plugin + web CLAUDE.md + a short overlay).
  instructions: {
    fileName: 'AGENTS.md',
    render: (body) => ({ fileName: 'AGENTS.md', content: body.endsWith('\n') ? body : body + '\n' }),
  },

  // 6. skills — `.agents/skills` symlinked to the plugin's skills/. No agent files: no subagents.
  skills: {
    mechanism: `${CODEX_SKILLS_LINK} symlink`,
    skillsRoot: 'skills',
    agentFiles: [],
  },

  // 7. mcp — config.toml rendered from the canonical connection, required = true.
  mcp: { render: (connection) => renderCodexConfig(connection) },

  // 8. worker env allowlist — the same per-leg set the launch scripts forward for every adapter
  //    (container/cloud-worker-launch.sh write_exec_env_file()). The login-cache PATH variable is a
  //    standing binding of the launcher, not a per-leg value, and the file itself never rides env.
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
    standingSecrets: ['HARMONY_API_TOKEN', CODEX_AUTH_FILE_ENV],
  },

  // 9. capabilities — Codex has subagents and hooks, but this adapter does not use them (build in the
  //    root thread, daemon one-shot workers need no hook), and `exec resume` cannot be relied on for an
  //    in-worker model switch (a switch cold-starts a new thread), so the loop is not offered.
  capabilities: {
    subagents: false,
    hooks: false,
    skills: true,
    mcp: true,
    resume: true,
    modelSwitch: false,
    structuredOutput: true,
  },

  // 10. telemetry — the `--json` JSONL stream: thread id from thread.started, the terminal turn event.
  //     Plan-included login cache ⇒ the cost regime is derived (never chosen) and costUsd is null.
  telemetry: {
    parse: (stdout, ctx) => {
      const evs = events(stdout);
      const terminal = [...evs].reverse().find((e) => e.type === 'turn.completed' || e.type === 'turn.failed');
      if (!terminal) return null;
      return {
        runtime: 'codex',
        model: ctx.model,
        credential: ctx.credential,
        costRegime: deriveCostRegime(ctx.credential),
        costUsd: null,
        sessionId: parseCodexThreadId(stdout),
        isError: terminal.type === 'turn.failed',
      };
    },
    sampleOutput: SAMPLE_OUTPUT,
  },
};
