// B-1075: the conformance suite passes the Claude adapter on all ten seams, and catches a broken
// adapter seam by seam. Also covers the registry and the Claude argv/auth behaviour directly.

import { describe, it, expect } from 'vitest';
import { SEAMS, type AgentAdapter, type SeamId } from './contract.js';
import { runConformance } from './conformance.js';
import { claudeCodeAdapter } from './claude-code.js';
import { getAdapter, hasAdapter, listAdapterIds, DEFAULT_ADAPTER_ID } from './registry.js';

describe('the contract', () => {
  it('has exactly ten numbered seams', () => {
    expect(SEAMS).toHaveLength(10);
    expect(runConformance(claudeCodeAdapter).map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('runConformance(claudeCodeAdapter)', () => {
  it('passes all ten seams', () => {
    const results = runConformance(claudeCodeAdapter);
    expect(results.filter((r) => !r.pass)).toEqual([]);
    expect(results.map((r) => r.seam)).toEqual([...SEAMS]);
  });
});

// One deliberate break per seam. Each break must fail THAT seam and leave the other nine passing.
const BREAKS: Record<SeamId, (a: AgentAdapter) => AgentAdapter> = {
  launch: (a) => ({ ...a, launch: { ...a.launch, binary: '' } }),
  auth: (a) => ({
    ...a,
    // a silent fallback: both credentials present resolves instead of erroring
    auth: { ...a.auth, resolveCredential: (env) => (env.CLAUDE_CODE_OAUTH_TOKEN ? { ok: true, credential: 'subscription-token' } : a.auth.resolveCredential(env)) },
  }),
  headless: (a) => ({ ...a, headless: { ...a.headless, buildArgv: (i) => a.headless.buildArgv(i).filter((x) => x !== i.prompt) } }),
  session: (a) => ({ ...a, session: { ...a.session, sessionIdFromPath: () => null } }),
  instructions: (a) => ({ ...a, instructions: { ...a.instructions, render: () => ({ fileName: a.instructions.fileName, content: '' }) } }),
  skills: (a) => ({ ...a, skills: { ...a.skills, mechanism: '' } }),
  mcp: (a) => ({ ...a, mcp: { render: () => ({ fileName: '.mcp.json', content: '{"harmony":{"command":"node","args":["{pluginRoot}/dist/index.js"]}}' }) } }),
  env: (a) => ({ ...a, env: { ...a.env, allowlist: [...a.env.allowlist, 'CLAUDE_CODE_OAUTH_TOKEN'] } }),
  capabilities: (a) => {
    const { hooks: _dropped, ...rest } = a.capabilities;
    return { ...a, capabilities: rest as AgentAdapter['capabilities'] };
  },
  telemetry: (a) => ({
    ...a,
    // the adapter "chooses" a regime instead of deriving it
    telemetry: { ...a.telemetry, parse: (s, c) => { const r = a.telemetry.parse(s, c); return r && { ...r, costRegime: 'metered' }; } },
  }),
};

describe('runConformance(broken fake adapter)', () => {
  it.each(SEAMS.map((s) => [s]))('a broken %s seam fails that seam only', (seam) => {
    const results = runConformance(BREAKS[seam](claudeCodeAdapter));
    const broken = results.find((r) => r.seam === seam)!;
    expect(broken.pass).toBe(false);
    expect(broken.problems.length).toBeGreaterThan(0);
    expect(results.filter((r) => r.seam !== seam && !r.pass)).toEqual([]);
  });

  it('reports a throwing seam as a failure, not a crash', () => {
    const throwing = { ...claudeCodeAdapter, mcp: { render: () => { throw new Error('boom'); } } };
    const r = runConformance(throwing).find((x) => x.seam === 'mcp')!;
    expect(r).toMatchObject({ pass: false, problems: ['threw: boom'] });
  });
});

describe('registry', () => {
  it('registers claude-code as the default', () => {
    expect(listAdapterIds()).toEqual(['claude-code']);
    expect(DEFAULT_ADAPTER_ID).toBe('claude-code');
    expect(getAdapter('claude-code')).toBe(claudeCodeAdapter);
    expect(hasAdapter('codex')).toBe(false);
  });
  it('throws a clear error on an unknown id', () => {
    expect(() => getAdapter('codex')).toThrow("Unknown agent adapter 'codex' — registered: claude-code");
  });
});

describe('Claude adapter behaviour', () => {
  const build = claudeCodeAdapter.headless.buildArgv;
  it('composes the cold-start argv the way provision.sh does', () => {
    expect(build({ pluginDir: '/p', prompt: 'go' })).toEqual(['--plugin-dir', '/p', '-p', 'go', '--output-format', 'json']);
  });
  it('adds --resume after the prompt and --model last', () => {
    expect(build({ pluginDir: '/p', prompt: 'go', resumeSessionId: 'abc', model: 'opus', extraFlags: ['--verbose'] })).toEqual([
      '--plugin-dir', '/p', '-p', 'go', '--resume', 'abc', '--verbose', '--output-format', 'json', '--model', 'opus',
    ]);
  });
  it('leaves an upstream --output-format alone', () => {
    expect(build({ pluginDir: '/p', prompt: 'go', extraFlags: ['--output-format', 'stream-json'] })).toEqual([
      '--plugin-dir', '/p', '-p', 'go', '--output-format', 'stream-json',
    ]);
  });
  it('refuses ANTHROPIC_API_KEY beside the OAuth token (no silent fallback)', () => {
    const r = claudeCodeAdapter.auth.resolveCredential({ CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' });
    expect(r.ok).toBe(false);
  });
  it('treats an empty ANTHROPIC_API_KEY as unset', () => {
    expect(claudeCodeAdapter.auth.resolveCredential({ CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: '' })).toEqual({ ok: true, credential: 'subscription-token' });
  });
  it('telemetry reports runtime, model, credential, derived regime, cost and session id', () => {
    expect(claudeCodeAdapter.telemetry.parse(claudeCodeAdapter.telemetry.sampleOutput, { model: 'opus', credential: 'subscription-token' })).toEqual({
      runtime: 'claude-code',
      model: 'opus',
      credential: 'subscription-token',
      costRegime: 'plan-included',
      costUsd: 0.42,
      sessionId: '00000000-0000-4000-8000-000000000000',
      isError: false,
    });
  });
});
