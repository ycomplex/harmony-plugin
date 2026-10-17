// B-1076: the Codex adapter passes the conformance suite on all ten seams with NO exceptions, and its
// seams behave as documented (docs/agent-adapter-contract.md, docs/codex-phase0-findings.md).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HARMONY_MCP_CONNECTION, SEAMS } from './contract.js';
import { runConformance } from './conformance.js';
import {
  CODEX_AUTH_FILE_ENV,
  CODEX_MCP_ENV_VARS,
  CODEX_PROJECT_DOC_MAX_BYTES,
  CODEX_WORKER_OVERLAY,
  codexAdapter as A,
  codexPrompt,
  parseCodexThreadId,
  parseCodexUsage,
  renderCodexAgentsMd,
  renderCodexConfig,
  verifyCodexAgentsMd,
} from './codex.js';
import { getAdapter, listAdapterIds } from './registry.js';
import { redactSecrets } from './redaction.js';
import { deriveCostRegime } from './credentials.js';

describe('runConformance(codexAdapter)', () => {
  it('passes all ten seams with no exceptions', () => {
    const results = runConformance(A);
    expect(results.filter((r) => !r.pass)).toEqual([]);
    expect(results.map((r) => r.seam)).toEqual([...SEAMS]);
  });
  it('is registered beside claude-code, and claude-code stays the default', () => {
    expect(listAdapterIds()).toEqual(['claude-code', 'codex']);
    expect(getAdapter('codex')).toBe(A);
  });
});

describe('1. launch', () => {
  it('launches `codex` and probes it with `codex --version`', () => {
    expect(A.launch.binary).toBe('codex');
    expect(A.launch.probeArgv).toEqual(['codex', '--version']);
  });
});

describe('2. auth — login-cache file, never an API key', () => {
  const env = { [CODEX_AUTH_FILE_ENV]: '/home/worker/.codex/auth.json' };
  it('maps login-cache to a non-secret PATH variable and derives plan-included', () => {
    expect(A.auth.acceptedCredentials).toEqual(['login-cache']);
    expect(A.auth.credentialEnv['login-cache']).toBe('HARMONY_CODEX_AUTH_FILE');
    expect(deriveCostRegime('login-cache')).toBe('plan-included');
    expect(A.auth.resolveCredential(env)).toEqual({ ok: true, credential: 'login-cache' });
  });
  it('resolves from env only — the file is never opened (a path that does not exist still resolves)', () => {
    expect(A.auth.resolveCredential({ [CODEX_AUTH_FILE_ENV]: '/definitely/not/there/auth.json' })).toEqual({ ok: true, credential: 'login-cache' });
  });
  it.each(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'])('REFUSES %s beside the login cache (no metered fallback, B-934) — and never echoes its value', (name) => {
    const r = A.auth.resolveCredential({ ...env, [name]: 'sk-secret-value-123456' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(name);
    expect(r.error).not.toContain('sk-secret-value-123456');
  });
  it.each(['OPENAI_API_KEY', 'CODEX_API_KEY'])('refuses %s even with no login cache (it is never a way in)', (name) => {
    const r = A.auth.resolveCredential({ [name]: 'k' });
    expect(r).toMatchObject({ ok: false });
  });
  it('an empty API key is unset (the --env-file blank-line shadow), an empty path is unset', () => {
    expect(A.auth.resolveCredential({ ...env, OPENAI_API_KEY: '', CODEX_API_KEY: '' })).toEqual({ ok: true, credential: 'login-cache' });
    expect(A.auth.resolveCredential({ [CODEX_AUTH_FILE_ENV]: '' }).ok).toBe(false);
  });
  it('a missing credential explains how to mint one', () => {
    const r = A.auth.resolveCredential({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('codex login --device-auth');
  });
});

describe('3. headless', () => {
  const build = A.headless.buildArgv;
  it('cold start: exec --json --cd <root> … bypass, hook trust (B-1150), prompt last', () => {
    expect(build({ pluginDir: '/workspace/workspace/plugin', prompt: 'go' })).toEqual([
      'exec', '--json', '--cd', '/workspace/workspace', '--add-dir', '/workspace/workspace/plugin',
      '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', 'go',
    ]);
  });
  it('model is -m, extra flags are passed through in order, prompt stays last', () => {
    expect(build({ pluginDir: '/w/plugin', prompt: 'go', model: 'gpt-x', extraFlags: ['--skip-git-repo-check'] })).toEqual([
      'exec', '--json', '--cd', '/w', '--add-dir', '/w/plugin', '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust', '-m', 'gpt-x', '--skip-git-repo-check', 'go',
    ]);
  });
  it('an upstream --cd wins over the derived root', () => {
    const argv = build({ pluginDir: '/w/plugin', prompt: 'go', extraFlags: ['--cd', '/elsewhere'] });
    expect(argv.filter((a) => a === '--cd')).toHaveLength(1);
    expect(argv).toContain('/elsewhere');
  });
  it('resume: `exec resume <id>` with only the flags resume accepts (no --cd / --add-dir)', () => {
    const argv = build({ pluginDir: '/w/plugin', prompt: 'next', resumeSessionId: 'abc', model: 'm' });
    expect(argv).toEqual(['exec', 'resume', 'abc', '--json', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '-m', 'm', 'next']);
    expect(argv).not.toContain('--cd');
    expect(argv).not.toContain('--add-dir');
  });
  it('never carries a Claude-only flag by itself and uses the explicit bypass, not --full-auto', () => {
    const argv = build({ pluginDir: '/p/plugin', prompt: 'x' });
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--full-auto');
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('exit 0 is success; any non-zero fails the leg', () => {
    expect(A.headless.exit).toEqual({ successCode: 0, nonZeroIsFailure: true, structuredErrorField: null });
  });
  it('translates the Claude slash-skill prompt into Codex explicit invocation; leaves other prompts alone', () => {
    expect(codexPrompt('/harmony-plugin:harmony-conduct B-1076 --one-shot')).toBe('$harmony-plugin:harmony-conduct B-1076 --one-shot');
    expect(codexPrompt('/harmony-plugin:start-work')).toBe('$harmony-plugin:start-work');
    expect(codexPrompt('just do the thing')).toBe('just do the thing');
    expect(codexPrompt('/tmp/not-a-skill B-1')).toBe('/tmp/not-a-skill B-1');
    expect(build({ pluginDir: '/p/plugin', prompt: '/harmony-plugin:harmony-conduct B-1 --one-shot' }).pop()).toBe('$harmony-plugin:harmony-conduct B-1 --one-shot');
  });
});

describe('4. session', () => {
  const real = '/home/worker/.codex/sessions/2026/10/16/rollout-2026-10-16T16-23-56-01a14586-fc0a-7a73-b060-3faef73d6f68.jsonl';
  it('reads the thread id out of a real rollout path (0.163.0 layout)', () => {
    expect(A.session.sessionIdFromPath(real)).toBe('01a14586-fc0a-7a73-b060-3faef73d6f68');
    expect(A.session.sessionIdFromPath('/home/worker/.codex/sessions/2026/10/16/notes.jsonl')).toBeNull();
    expect(A.session.sessionIdFromPath('/home/worker/.claude/projects/x/abc.jsonl')).toBeNull();
  });
  it('the glob locates a thread id under CODEX_HOME/sessions', () => {
    expect(A.session.sessionGlob('abc')).toBe('$HOME/.codex/sessions/*/*/*/rollout-*-abc.jsonl');
    expect(A.session.resumeFlag).toBe('resume');
  });
  it('takes the thread id from the thread.started event', () => {
    expect(parseCodexThreadId('{"type":"thread.started","thread_id":"t-1"}\n{"type":"turn.started"}')).toBe('t-1');
    expect(parseCodexThreadId('no events here')).toBeNull();
  });
});

describe('5. instructions — one generated AGENTS.md', () => {
  const sources = [
    { label: 'workspace/CLAUDE.md', content: 'WS-BODY\n' },
    { label: 'plugin/CLAUDE.md', content: 'PLUGIN-BODY' },
    { label: 'web/CLAUDE.md', content: 'WEB-BODY\n\n' },
  ];
  const md = renderCodexAgentsMd(sources);
  it('B-1150: the overlay says the hooks run and no longer says there are none', () => {
    expect(CODEX_WORKER_OVERLAY).not.toMatch(/There are no hooks/);
    expect(CODEX_WORKER_OVERLAY).toMatch(/hooks run/);
    expect(CODEX_WORKER_OVERLAY).toMatch(/same turn/);
  });
  it('concatenates the sources in the given order under explicit headers, then the overlay', () => {
    const at = (s: string) => md.indexOf(s);
    expect(at('WS-BODY')).toBeGreaterThan(-1);
    expect(at('WS-BODY')).toBeLessThan(at('PLUGIN-BODY'));
    expect(at('PLUGIN-BODY')).toBeLessThan(at('WEB-BODY'));
    expect(at('WEB-BODY')).toBeLessThan(at('Codex worker overlay'));
    expect(md).toContain('# Source: plugin/CLAUDE.md');
  });
  it('is deterministic', () => {
    expect(renderCodexAgentsMd(sources)).toBe(md);
  });
  it('the preflight proves every source marker is present and the size fits', () => {
    expect(verifyCodexAgentsMd(md, sources)).toEqual([]);
    expect(verifyCodexAgentsMd(md.replace('plugin/CLAUDE.md', 'x'), sources)).not.toEqual([]);
    expect(verifyCodexAgentsMd(md, sources, 10)[0]).toContain('over project_doc_max_bytes');
  });
  it('the byte ceiling leaves headroom over the measured ~49.5 KB of canonical guidance', () => {
    expect(CODEX_PROJECT_DOC_MAX_BYTES).toBeGreaterThan(49_502 * 4);
    expect(CODEX_PROJECT_DOC_MAX_BYTES).toBeGreaterThan(32 * 1024);
  });
  it('declares AGENTS.md', () => {
    expect(A.instructions.render('BODY').fileName).toBe('AGENTS.md');
  });
});

describe('6. skills', () => {
  it('links .agents/skills to the plugin skills/, with no agent files (no subagents)', () => {
    expect(A.skills.mechanism).toContain('.agents/skills');
    expect(A.skills.skillsRoot).toBe('skills');
    expect(A.skills.agentFiles).toEqual([]);
  });
});

describe('7. mcp — config.toml from the one canonical connection', () => {
  const { fileName, content } = renderCodexConfig(HARMONY_MCP_CONNECTION);
  it('renders required = true with explicit timeouts and automatic tool approval', () => {
    expect(fileName).toBe('config.toml');
    expect(content).toContain('[mcp_servers.harmony]');
    expect(content).toContain('command = "node"');
    expect(content).toContain('args = ["/workspace/workspace/plugin/dist/index.js"]');
    expect(content).toContain('required = true');
    expect(content).toContain('startup_timeout_sec = 60');
    expect(content).toContain('tool_timeout_sec = 600');
    expect(content).toContain('default_tools_approval_mode = "auto"');
    expect(content).toContain('approval_policy = "never"');
    expect(content).toContain(`project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}`);
  });
  it('resolves the plugin root (Codex config has no variable expansion) and leaves no placeholder', () => {
    expect(content).not.toContain('{pluginRoot}');
    expect(renderCodexConfig(HARMONY_MCP_CONNECTION, { pluginRoot: '/opt/p' }).content).toContain('"/opt/p/dist/index.js"');
  });
  it('forwards the harmony server\'s HARMONY_* inputs and never a credential-file path or a git/provider secret', () => {
    for (const v of ['HARMONY_API_TOKEN', 'HARMONY_SUPABASE_URL', 'HARMONY_SUPABASE_ANON_KEY']) expect(CODEX_MCP_ENV_VARS).toContain(v);
    for (const v of CODEX_MCP_ENV_VARS) expect(v).toMatch(/^HARMONY_/);
    expect(CODEX_MCP_ENV_VARS).not.toContain(CODEX_AUTH_FILE_ENV);
    expect(content).not.toMatch(/OPENAI|CODEX_API|GIT_TOKEN/);
  });
});

describe('8/9. env + capabilities', () => {
  it('the login-cache path variable is a standing binding, never in the per-leg allowlist', () => {
    expect(A.env.allowlist).not.toContain(CODEX_AUTH_FILE_ENV);
    expect(A.env.standingSecrets).toContain(CODEX_AUTH_FILE_ENV);
    expect(A.env.allowlist).not.toContain('OPENAI_API_KEY');
  });
  it('declares no subagents and no model switch; hooks (B-1150), skills, mcp, resume and structured output', () => {
    expect(A.capabilities).toEqual({
      subagents: false,
      hooks: true,
      skills: true,
      mcp: true,
      resume: true,
      modelSwitch: false,
      structuredOutput: true,
    });
  });
});

describe('10. telemetry', () => {
  const ctx = { model: 'gpt-x', credential: 'login-cache' as const };
  const stream = [
    '{"type":"thread.started","thread_id":"t-9"}',
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":2,"cache_write_input_tokens":1,"output_tokens":7,"reasoning_output_tokens":3}}',
  ].join('\n');
  it('reports runtime, model, credential, derived plan-included regime, null cost and the thread id', () => {
    expect(A.telemetry.parse(stream, ctx)).toEqual({
      runtime: 'codex',
      model: 'gpt-x',
      credential: 'login-cache',
      costRegime: 'plan-included',
      costUsd: null,
      sessionId: 't-9',
      isError: false,
      // B-1076: the LAST turn.completed usage, in conduction_leg_costs' vocabulary
      usage: { inputTokens: 5, cacheReadInputTokens: 2, outputTokens: 7 },
    });
  });
  it('B-1076: usage is the LAST turn.completed of several (fixture capture), null when no terminal turn carried one', () => {
    const fixture = readFileSync(fileURLToPath(new URL('./fixtures/codex-exec-two-turns.jsonl', import.meta.url)), 'utf8');
    expect(A.telemetry.parse(fixture, ctx)?.usage).toEqual({ inputTokens: 5400, cacheReadInputTokens: 4100, outputTokens: 610 });
    const failedOnly = '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.failed","error":{"message":"boom"}}';
    expect(A.telemetry.parse(failedOnly, ctx)?.usage).toBeNull();
  });
  it('B-1150: the `error` items --dangerously-bypass-hook-trust adds do NOT make a completed turn an error (isError keys on turn.failed only)', () => {
    const withHookTrustNoise = [
      '{"type":"thread.started","thread_id":"t"}',
      // the two items codex 0.163.0 emitted under the flag in the B-1150 mock-provider run, verbatim
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"error","message":"`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation."}}',
      '{"type":"turn.started"}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}',
    ].join('\n');
    expect(A.telemetry.parse(withHookTrustNoise, ctx)).toMatchObject({ isError: false, sessionId: 't' });
    // and the same noise with a turn.failed IS an error (positive control)
    expect(A.telemetry.parse(withHookTrustNoise.replace('"turn.completed"', '"turn.failed"'), ctx)).toMatchObject({ isError: true });
  });
  it('a failed turn is an error', () => {
    const failed = '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.failed","error":{"message":"boom"}}';
    expect(A.telemetry.parse(failed, ctx)).toMatchObject({ isError: true, sessionId: 't' });
  });
  it('is not a result without a terminal turn event, and ignores non-JSON noise', () => {
    expect(A.telemetry.parse('{"type":"thread.started","thread_id":"t"}', ctx)).toBeNull();
    expect(A.telemetry.parse('WARNING: noise\n' + stream, ctx)).not.toBeNull();
    expect(A.telemetry.parse('', ctx)).toBeNull();
  });
  it('reads the LAST turn.completed usage into the four token categories', () => {
    expect(parseCodexUsage(stream)).toEqual({ inputTokens: 5, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 7, reasoningOutputTokens: 3 });
    expect(parseCodexUsage('{"type":"turn.started"}')).toBeNull();
  });
});

describe('redactSecrets — bearer / refresh-token patterns', () => {
  const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
  it.each<[string, string]>([
    ['Authorization: Bearer abcDEF123456789xyz', 'abcDEF123456789xyz'],
    ['{"refresh_token":"rt_abcdef123456"}', 'rt_abcdef123456'],
    ['{"access_token": "at-abcdef123456", "x":1}', 'at-abcdef123456'],
    ['refresh_token=rt_abcdef123456&x=1', 'rt_abcdef123456'],
    ['{\\"id_token\\":\\"abcdef123456\\"}', 'abcdef123456'],
    [`token ${JWT} leaked`, JWT],
    ['key sk-abcdefghijklmnopqrstuvwx used', 'sk-abcdefghijklmnopqrstuvwx'],
    ['OPENAI_API_KEY=sk-live-0123456789', 'sk-live-0123456789'],
    ['CODEX_ACCESS_TOKEN: cat_0123456789', 'cat_0123456789'],
  ])('redacts %s', (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });
  it('leaves ordinary text, and the key NAMES, alone', () => {
    const plain = 'turn failed: model not found (refresh_token handling is described in the runbook)';
    expect(redactSecrets(plain)).toBe(plain);
    expect(redactSecrets('')).toBe('');
  });
  it('keeps surrounding structure so a tail stays readable', () => {
    expect(redactSecrets('{"a":1,"refresh_token":"rt_abcdef123456","b":2}')).toBe('{"a":1,"refresh_token":"[REDACTED]","b":2}');
  });
});
