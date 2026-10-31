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
//
// B-1178: an offer whose catalog row names a NON-OpenAI provider (src/agents/codex-providers.ts) runs on
// that provider's metered API key instead — `api-key`, from the provider's own env var (OPENROUTER_API_KEY,
// …), mounted from the secret `harmony-provider-<name>-key`. The leg's provider reaches the auth seam as an
// explicit argument or as HARMONY_CODEX_PROVIDER (a NAME the launcher sets); with neither it is inferred
// from which credential env is present, and the login cache beside a provider key is a config error.
// OpenAI offers keep the login-cache path above exactly (argv and config byte-identical).

import { posix as path } from 'node:path';
import type { AgentAdapter, CredentialResolution, HeadlessInput, McpConnection, SkillCapabilityProjection, TelemetryUsage } from './contract.js';
import { PLUGIN_ROOT_PLACEHOLDER } from './contract.js';
import { classProblems, forbiddenClasses, forbiddenTool, type CapabilityClass } from './capabilities.js';
import { deriveCostRegime } from './credentials.js';
import { CODEX_PROVIDERS, CODEX_PROVIDER_ENV_KEYS, isDefaultCodexProvider, lookupCodexProvider, type CodexProvider } from './codex-providers.js';
import { absoluteResetTime, forcedRefusal, resetFromText, resetsInSeconds, type Refusal } from './refusal.js';

// --- constants the scripts and tests share ------------------------------------------------------------

/** The non-secret env var carrying the PATH of the login-cache file inside the worker. */
export const CODEX_AUTH_FILE_ENV = 'HARMONY_CODEX_AUTH_FILE';
/** Credentials whose presence is a config error beside (or instead of) the login cache: metered
 *  and token credentials Codex would silently prefer over, or fall back to, the cache. */
export const CODEX_REFUSED_CREDENTIAL_ENV: readonly string[] = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
/** B-1178: the non-secret env var naming the leg's model provider, set by the launcher for a provider leg
 *  (and for an OpenAI leg on a Cloud Run job that also binds a provider key). Never a credential. */
export const CODEX_PROVIDER_ENV = 'HARMONY_CODEX_PROVIDER';
/** B-1178: `-c model_provider=<name>` — a config override accepted by `exec` and `exec resume` alike. */
export const CODEX_CONFIG_FLAG = '-c';

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
/** B-1150: without it Codex 0.163 does not run $CODEX_HOME/hooks.json at all (verified). Accepted by both
 *  `exec` and `exec resume`. The hooks it trusts are the ones codex-provision.ts wrote from the canonical
 *  definition (src/agents/hooks.ts) into a worker-owned CODEX_HOME. */
export const CODEX_HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';

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
  `On the conductor host run 'CODEX_HOME=~/.harmony/codex-automation codex login --device-auth' once, ` +
  `then mount that auth.json into the worker (container/README.md "Codex credential runbook").`;

/** B-1178: the Codex credential verdict for one leg. `provider` is the offer's provider (absent →
 *  HARMONY_CODEX_PROVIDER → inferred from the env). `openai` is today's login-cache path exactly; any other
 *  provider needs its own key and refuses the login cache or an OpenAI key beside it. Names only — never a
 *  value — in every message. Never throws. */
export function resolveCodexCredential(env: Readonly<Record<string, string | undefined>>, provider?: string): CredentialResolution {
  let name = provider;
  if (name === undefined && present(env, CODEX_PROVIDER_ENV)) name = env[CODEX_PROVIDER_ENV];
  if (name === undefined) {
    // No provider said: infer it from the credential env, and refuse an ambiguous one (B-934).
    const keyed = CODEX_PROVIDERS.filter((p) => present(env, p.envKey));
    if (keyed.length > 0 && present(env, CODEX_AUTH_FILE_ENV)) {
      return {
        ok: false,
        error:
          `${CODEX_AUTH_FILE_ENV} (the login cache) and ${keyed.map((p) => p.envKey).join(' and ')} are both set — one Codex leg runs on ` +
          `the login cache OR one provider's API key, never both (B-934: no silent fallback between regimes). Mount only the ` +
          `credential the run's offer needs.`,
      };
    }
    if (keyed.length > 1) {
      return {
        ok: false,
        error: `${keyed.map((p) => p.envKey).join(' and ')} are all set and the leg names no provider (${CODEX_PROVIDER_ENV}) — refusing to pick one.`,
      };
    }
    name = keyed.length === 1 ? keyed[0].name : undefined;
  }
  if (isDefaultCodexProvider(name)) return resolveLoginCache(env);
  const found = lookupCodexProvider(name as string);
  if (!found.ok) return { ok: false, error: found.error };
  return resolveProviderKey(env, found.provider);
}

function resolveProviderKey(env: Readonly<Record<string, string | undefined>>, p: CodexProvider): CredentialResolution {
  const conflicting = [CODEX_AUTH_FILE_ENV, ...CODEX_REFUSED_CREDENTIAL_ENV].filter((n) => present(env, n));
  if (conflicting.length > 0) {
    // AC5: the login cache (or an OpenAI credential) beside a provider key is a config error.
    return {
      ok: false,
      error:
        `${conflicting.join(' and ')} ${conflicting.length > 1 ? 'are' : 'is'} set beside the ${p.displayName} key (${p.envKey}) — a ` +
        `${p.name} leg runs on ${p.envKey} alone (B-934: no silent fallback between regimes). Unset ${conflicting.join(' and ')}.`,
    };
  }
  if (!present(env, p.envKey)) {
    return {
      ok: false,
      error:
        `this leg runs a ${p.name} offer but ${p.envKey} is not set — mount the secret ${p.secretName} as ${p.envKey} ` +
        `(container/README.md "Provider API key runbook").`,
    };
  }
  return { ok: true, credential: 'api-key' };
}

function resolveLoginCache(env: Readonly<Record<string, string | undefined>>): CredentialResolution {
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

/** A provider name is a bare TOML key (it is spliced into `-c model_provider=<name>` and a table header). */
const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function buildCodexArgv(input: HeadlessInput): string[] {
  const extra = [...(input.extraFlags ?? [])];
  const resume = input.resumeSessionId;
  const argv: string[] = [CODEX_EXEC_SUBCOMMAND];
  if (resume) {
    // `codex exec resume <id>` accepts neither --cd nor --add-dir (0.163.0 --help): the working root
    // is the process cwd, which provision.sh sets (cd "$WORKDIR") for every launch.
    argv.push(CODEX_RESUME_SUBCOMMAND, resume, CODEX_JSON_FLAG, CODEX_BYPASS_FLAG, CODEX_HOOK_TRUST_FLAG);
  } else {
    argv.push(CODEX_JSON_FLAG);
    // The workspace root is the plugin checkout's parent (…/workspace/plugin → …/workspace), where the
    // generated AGENTS.md lives. An upstream --cd/-C wins.
    if (!extra.includes(CODEX_CD_FLAG) && !extra.includes('-C')) argv.push(CODEX_CD_FLAG, path.dirname(input.pluginDir));
    argv.push(CODEX_ADD_DIR_FLAG, input.pluginDir, CODEX_BYPASS_FLAG, CODEX_HOOK_TRUST_FLAG);
  }
  if (input.model) argv.push(CODEX_MODEL_FLAG, input.model);
  // B-1178: a non-OpenAI offer names its provider beside -m on BOTH exec and exec resume, so an in-place
  // switch on the same provider keeps it. Never a [profiles.*] table or --profile.
  if (!isDefaultCodexProvider(input.modelProvider)) {
    const name = input.modelProvider as string;
    if (!PROVIDER_NAME_RE.test(name)) throw new Error(`invalid model provider name '${name}'`);
    argv.push(CODEX_CONFIG_FLAG, `model_provider=${name}`);
  }
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
 *  the `{pluginRoot}` placeholder (Codex's config has no variable expansion).
 *  B-1178: for a non-OpenAI `provider` it also writes `model_context_window` (when known) and a
 *  `[model_providers.<name>]` table — the leg selects it with `-c model_provider=<name>`. For OpenAI (or
 *  no provider) the output is byte-identical to before, and a context window is ignored. */
export function renderCodexConfig(
  connection: McpConnection,
  opts: { pluginRoot?: string; provider?: CodexProvider | null; contextWindowTokens?: number | null } = {},
): { fileName: string; content: string } {
  const root = opts.pluginRoot ?? CODEX_DEFAULT_PLUGIN_ROOT;
  const args = connection.args.map((a) => a.split(PLUGIN_ROOT_PLACEHOLDER).join(root));
  const p = opts.provider ?? null;
  const window = p && typeof opts.contextWindowTokens === 'number' && Number.isInteger(opts.contextWindowTokens) && opts.contextWindowTokens > 0
    ? opts.contextWindowTokens
    : null;
  const lines = [
    '# Generated by `harmony agent render` (B-1076) from the canonical MCP connection. Do not edit.',
    '# approval_policy never: an unattended worker must never wait on an approval UI.',
    'approval_policy = "never"',
    '# The aggregated AGENTS.md is larger than Codex\'s 32 KiB default, which TRUNCATES silently.',
    `project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}`,
    // TOML: root keys must precede every table.
    ...(window !== null ? [`# B-1178: the ${p!.name} offer's context window, from the model catalog.`, `model_context_window = ${window}`] : []),
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
  if (p) {
    lines.push(
      `# B-1178: the ${p.displayName} provider; the key is read from ${p.envKey} (secret ${p.secretName}).`,
      `[model_providers.${p.name}]`,
      `name = ${tomlString(p.displayName)}`,
      `base_url = ${tomlString(p.baseUrl)}`,
      `env_key = ${tomlString(p.envKey)}`,
      `wire_api = ${tomlString(p.wireApi)}`,
      '',
    );
  }
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
  '- The in-worker model switch works here (B-1148): when a gate wants another model, request it with',
  '  `harmony model request-switch --agent codex <model>` and end your turn; the worker resumes this thread on',
  '  the new model (or starts a new thread if it cannot) and says which in the leg output.',
  '- Harmony\'s hooks run (B-1150): a session-start hook records your conduct-session id, and the stop and',
  '  pre-tool-use gates can block a turn-end or a `gh pr create` / `gh pr merge` with a reason. When one',
  '  blocks, fix what it names (usually this ticket\'s board row) in the same turn, then end the turn again.',
  '',
].join('\n');

// --- 9b. per-skill capabilities (B-1150) -----------------------------------------------------------------

/** Every Codex leg runs in ONE envelope, whatever the skill: the container is the sandbox. */
export const CODEX_SKILL_ENVELOPE = `sandbox bypassed + approval never (${CODEX_BYPASS_FLAG}); no per-skill tool narrowing`;

function codexForbidRule(skill: string, cls: `forbid:${string}`): string {
  const t = forbiddenTool(cls);
  const tool = t.harmonyMcp ? `the \`harmony\` MCP tool \`${t.name}\`` : `the \`${t.name}\` tool`;
  return `While running \`$harmony-plugin:${skill}\`, do not call ${tool}.`;
}

function projectCodexSkill(skill: string, classes: readonly CapabilityClass[]): SkillCapabilityProjection {
  for (const c of classes) {
    const problems = classProblems(c);
    if (problems.length) throw new Error(problems.join('; '));
  }
  // Codex reads no per-skill tool list, so no `forbid:` class is enforced: each one becomes a prose rule.
  const forbids = forbiddenClasses(classes);
  return { frontmatter: {}, envelope: CODEX_SKILL_ENVELOPE, unenforcedForbids: forbids, proseRules: forbids.map((f) => codexForbidRule(skill, f)) };
}

/** The overlay section listing every skill's unenforced `forbid:` rules, or '' when there are none. */
export function renderCodexSkillRules(skills: ReadonlyArray<{ name: string; classes: readonly CapabilityClass[] }>): string {
  const rules = skills.flatMap((s) => projectCodexSkill(s.name, s.classes).proseRules);
  if (rules.length === 0) return '';
  return [
    '### Skill tool rules Codex does not enforce (B-1150)',
    '',
    'Each skill declares runtime-neutral capability classes. Claude Code enforces the `forbid:` ones as',
    '`disallowed-tools`; Codex has no per-skill tool list, so they are rules you keep yourself:',
    '',
    ...rules.map((r) => `- ${r}`),
    '',
  ].join('\n');
}

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
  response_id?: string;
  payload?: { response_id?: string; usage?: Record<string, unknown> } | null;
  message?: unknown;
  error?: unknown;
  item?: { type?: unknown } | null;
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

/** B-1148: the per-conduction thread file provision.sh writes after every Codex invocation, in the
 *  conduction's Codex sessions folder ($HOME/.codex/sessions). It names its agent so a Claude
 *  discovery never adopts it and a Codex discovery never adopts a Claude session. */
export const CODEX_THREAD_FILE_NAME = '.harmony-codex-thread.json';

export interface CodexThreadRecord {
  agent: 'codex';
  thread_id: string;
  model: string | null;
  time: string;
}

/** A thread id is passed to `codex exec resume <id>` as one argv element; keep it to the characters
 *  Codex ids actually use so a corrupted file can never smuggle a flag in. */
const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isPlausibleCodexThreadId(id: string): boolean {
  return THREAD_ID_RE.test(id);
}

export function buildCodexThreadRecord(threadId: string, model: string | null | undefined, now: Date = new Date()): CodexThreadRecord {
  return { agent: 'codex', thread_id: threadId, model: model ? model : null, time: now.toISOString() };
}

/** Parse a thread file's text; null unless it is a well-formed record whose agent is "codex". */
export function parseCodexThreadRecord(text: string): CodexThreadRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (r.agent !== 'codex' || typeof r.thread_id !== 'string' || !isPlausibleCodexThreadId(r.thread_id)) return null;
  return {
    agent: 'codex',
    thread_id: r.thread_id,
    model: typeof r.model === 'string' && r.model !== '' ? r.model : null,
    time: typeof r.time === 'string' ? r.time : '',
  };
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

/** B-1076: the LAST `turn.completed` usage, mapped onto conduction_leg_costs' columns: input_tokens
 *  (as Codex reports it — OpenAI's figure INCLUDES the cached part), cached_input_tokens ->
 *  cache_read_input_tokens, output_tokens. Codex's cache_write / reasoning_output figures have no
 *  column with matching semantics and are not recorded (docs/codex-phase0-findings.md, "Cost capture").
 *  Null when no `turn.completed` carried a usage object. */
export function codexTelemetryUsage(stdout: string): TelemetryUsage | null {
  const u = parseCodexUsage(stdout);
  if (!u) return null;
  return { inputTokens: u.inputTokens, cacheReadInputTokens: u.cachedInputTokens, outputTokens: u.outputTokens };
}

/** Sum invocation-bounded request records from a rollout slice. Each response is counted once;
 * malformed records make the whole slice unknown so partial evidence cannot look complete. */
export function parseCodexRequestUsage(stdout: string): TelemetryUsage | null {
  const rows = events(stdout).filter((e) => e.type === 'token_usage_record');
  if (rows.length === 0) return null;
  const seen = new Set<string>();
  const total = { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
  for (const row of rows) {
    const id = row.response_id ?? row.payload?.response_id;
    const usage = row.payload?.usage ?? row.usage;
    if (typeof id !== 'string' || id.length === 0 || !usage) return null;
    if (seen.has(id)) continue;
    const input = usage.input_tokens;
    const cached = usage.cached_input_tokens ?? usage.cache_read_input_tokens;
    const output = usage.output_tokens;
    if (![input, cached, output].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return null;
    seen.add(id);
    total.inputTokens += input as number;
    total.cacheReadInputTokens += cached as number;
    total.outputTokens += output as number;
  }
  return total;
}

// --- B-1149: refusal verdict + turn count -----------------------------------------------------------

/** Plan-quota exhaustion, as Codex reports it: the ChatGPT-plan "You've hit your usage limit …"
 *  message (error code usage_limit_reached), and an API-side insufficient_quota. Checked BEFORE the
 *  rate-limit pattern: an exhausted quota is often delivered as an HTTP 429 too, and it is the
 *  longer outage. */
const CODEX_QUOTA_RE = /usage[ _-]?limit|usage_limit_reached|insufficient_quota|hit your (?:usage )?limit|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota|plan limit/i;
/** A transient rate limit: HTTP 429 / "rate limit" / "Too Many Requests" (e.g. Codex's "exceeded retry
 *  limit, last status: 429 Too Many Requests"). */
const CODEX_RATE_LIMIT_RE = /\b429\b|rate[ _-]?limit|too many requests/i;

function errorText(e: CodexEvent): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string') parts.push(v);
    else if (v && typeof v === 'object') parts.push(JSON.stringify(v));
  };
  push(e.message);
  push(e.error);
  return parts.join(' ');
}

function structuredReset(e: CodexEvent, text: string, now: Date): string | null {
  const err = e.error && typeof e.error === 'object' ? (e.error as Record<string, unknown>) : {};
  const fromField =
    resetsInSeconds(err.resets_in_seconds, now) ??
    absoluteResetTime(err.resets_at) ??
    resetsInSeconds(err.retry_after, now);
  if (fromField) return fromField;
  // The same fields serialised inside a message string (an upstream API error body).
  const inSec = /"?resets_in_seconds"?\s*[:=]\s*(\d+)/i.exec(text);
  if (inSec) return resetsInSeconds(Number(inSec[1]), now);
  const at = /"?resets_at"?\s*[:=]\s*"?([0-9T:.\-+Z]+)"?/i.exec(text);
  if (at) {
    const t = absoluteResetTime(/^\d+$/.test(at[1]) ? Number(at[1]) : at[1]);
    if (t) return t;
  }
  const retryAfter = /retry[- _]after\s*[:=]?\s*(\d+)\s*(?:s\b|sec|seconds)?/i.exec(text);
  if (retryAfter) return resetsInSeconds(Number(retryAfter[1]), now);
  return resetFromText(text, now);
}

/** B-1149: the refusal verdict of a Codex `--json` capture. Reads ONLY the run-level failure events —
 *  a top-level `error` event and `turn.failed` — never an `item.completed` item of type `error` (the
 *  hook-trust flag adds two of those to every run, B-1150). The LAST matching event wins. Null when no
 *  failure event names a quota or a rate limit. `HARMONY_TEST_FORCE_REFUSAL` overrides (test hook). */
export function parseCodexRefusal(
  stdout: string,
  now: Date = new Date(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Refusal | null {
  const forced = forcedRefusal(env);
  if (forced) return forced;
  const failures = events(stdout).filter((e) => e.type === 'error' || e.type === 'turn.failed');
  for (const e of failures.reverse()) {
    const text = errorText(e);
    if (text === '') continue;
    const kind = CODEX_QUOTA_RE.test(text) ? 'quota' : CODEX_RATE_LIMIT_RE.test(text) ? 'rate-limit' : null;
    if (kind) return { kind, resets_at: structuredReset(e, text, now) };
  }
  return null;
}

/** The item types that are a MODEL-INITIATED step: what the model said (agent_message) and every
 *  tool/command call it made (command_execution, mcp_tool_call, file_change — the apply-patch tool —
 *  and web_search). Reasoning, todo-list and `error` items are not counted. */
export const CODEX_TURN_ITEM_TYPES: readonly string[] = ['agent_message', 'command_execution', 'mcp_tool_call', 'file_change', 'web_search'];

/** B-1149: the Codex turn count — the number of `item.completed` events whose item is a
 *  model-initiated step (CODEX_TURN_ITEM_TYPES). Codex has no num_turns field of its own; this is the
 *  closest equivalent of Claude's (one per assistant message / tool round). Null when the capture holds
 *  no events at all. */
export function countCodexTurns(stdout: string): number | null {
  const evs = events(stdout);
  if (evs.length === 0) return null;
  return evs.filter((e) => e.type === 'item.completed' && typeof e.item?.type === 'string' && CODEX_TURN_ITEM_TYPES.includes(e.item.type as string)).length;
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
  //    B-1178: or a non-OpenAI provider's API key (metered, derived — never chosen). The api-key row names
  //    the first registered provider's variable; each provider reads its own (src/agents/codex-providers.ts).
  auth: {
    acceptedCredentials: ['login-cache', 'api-key'],
    credentialEnv: { 'login-cache': CODEX_AUTH_FILE_ENV, 'api-key': CODEX_PROVIDERS[0].envKey },
    primaryCredential: 'login-cache',
    resolveCredential: (env) => resolveCodexCredential(env),
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
  //    (container/cloud-worker-launch.sh write_exec_env_file()). The login-cache PATH variable is the
  //    credential env, outside this list: each launcher adds it only for a Codex run (B-1076 — on cloud
  //    in the per-execution env, since --env-vars-file replaces the job's literal env), and the file
  //    itself never rides env.
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
      // B-1149: optional test hook (quota | rate-limit only), inert when unset.
      'HARMONY_TEST_FORCE_REFUSAL',
    ],
    // B-1178: every registered provider's key is a standing secret too (bound to the job / pod, never
    // forwarded through the per-leg allowlist).
    standingSecrets: ['HARMONY_API_TOKEN', CODEX_AUTH_FILE_ENV, ...CODEX_PROVIDER_ENV_KEYS],
  },

  // 9. capabilities — Codex has subagents, but this adapter builds in the root thread (B-1076). Hooks ARE
  //    used since B-1150: the same Stop / PreToolUse / SessionStart hooks, written to $CODEX_HOME/hooks.json
  //    and trusted by --dangerously-bypass-hook-trust. B-1148: the in-worker model switch IS offered —
  //    provision.sh resumes the current thread with `-m <new>` (in place) and falls back to a new thread
  //    when that resume fails, logging which one happened.
  capabilities: {
    subagents: false,
    hooks: true,
    skills: true,
    mcp: true,
    resume: true,
    modelSwitch: true,
    structuredOutput: true,
  },

  // 9b. per-skill capabilities (B-1150) — one envelope; `forbid:` classes become AGENTS.md prose rules.
  skillCapabilities: { project: projectCodexSkill },

  // 10. telemetry — the `--json` JSONL stream: thread id from thread.started, the terminal turn event.
  //     Plan-included login cache ⇒ the cost regime is derived (never chosen) and costUsd is null.
  telemetry: {
    parse: (stdout, ctx) => {
      const evs = events(stdout);
      const terminal = [...evs].reverse().find((e) => e.type === 'turn.completed' || e.type === 'turn.failed');
      // B-1149: a refusal can arrive as a bare top-level `error` event with no terminal turn event.
      const refusal = parseCodexRefusal(stdout);
      if (!terminal && !refusal) return null;
      // isError keys on `turn.failed` ONLY: --dangerously-bypass-hook-trust adds two `error` items to
      // every stream (B-1150), which must not mark a completed turn as errored.
      return {
        runtime: 'codex',
        model: ctx.model,
        credential: ctx.credential,
        costRegime: deriveCostRegime(ctx.credential),
        costUsd: null,
        sessionId: parseCodexThreadId(stdout),
        isError: terminal ? terminal.type === 'turn.failed' : true,
        usage: codexTelemetryUsage(stdout),
        refusal,
        numTurns: countCodexTurns(stdout),
      };
    },
    sampleOutput: SAMPLE_OUTPUT,
  },
};
