// B-1522: the conduct watch resolves credentials through the shared resolver's MCP surface.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePollAuth } from './poll-auth.js';
import type { HarmonyConfig } from '../cli/config.js';

const cfg = (over: Partial<HarmonyConfig> = {}): HarmonyConfig => ({
  activeProject: 'other',
  projects: {
    other: { name: 'other', token: 'tok-other', projectId: 'proj-other', supabaseUrl: 'https://other.example.supabase.co', supabaseAnonKey: 'other-key' },
    invented: { name: 'invented', token: 'tok-invented', projectId: 'proj-inv', supabaseUrl: 'https://inv.example.supabase.co', supabaseAnonKey: 'inv-key' },
  },
  ...over,
});
const load = (c: HarmonyConfig) => () => c;

function stubExchange(projectId: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ access_token: `h.${Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url')}.s`, expires_in: 3600, project_id: projectId }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolvePollAuth (B-1522)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('token rung: HARMONY_API_TOKEN resolves, and the exchange carries that token', async () => {
    const r = resolvePollAuth({ HARMONY_API_TOKEN: 'tok-env' }, load(cfg()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fetchMock = stubExchange('proj-env');
    await r.auth.getAccessToken();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBe('tok-env');
    expect(r.auth.getProjectId()).toBe('proj-env');
  });

  it('HARMONY_PROJECT rung: the stored entry\'s token, its backend pair and its expected project id', async () => {
    const r = resolvePollAuth({ HARMONY_PROJECT: 'invented' }, load(cfg()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auth.getSupabaseUrl()).toBe('https://inv.example.supabase.co');
    expect(r.auth.getSupabaseAnonKey()).toBe('inv-key');
    const fetchMock = stubExchange('proj-inv');
    await r.auth.getAccessToken();
    expect(fetchMock.mock.calls[0][0]).toBe('https://inv.example.supabase.co/functions/v1/auth-token');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBe('tok-invented');
    expect(r.auth.getProjectId()).toBe('proj-inv');
  });

  it('HARMONY_PROJECT rung: a token that reaches another project is refused (the expected id is carried)', async () => {
    const r = resolvePollAuth({ HARMONY_PROJECT: 'invented' }, load(cfg()));
    if (!r.ok) throw new Error('expected ok');
    stubExchange('proj-x');
    await expect(r.auth.getAccessToken()).rejects.toThrow('proj-inv');
  });

  it('neither: ok:false, naming both variables', () => {
    const r = resolvePollAuth({}, load({ projects: {} }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('HARMONY_API_TOKEN');
    expect(r.message).toContain('HARMONY_PROJECT');
  });

  it('an unknown HARMONY_PROJECT: ok:false with the resolver\'s message, never a throw', () => {
    const r = resolvePollAuth({ HARMONY_PROJECT: 'nope' }, load(cfg()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('HARMONY_PROJECT=nope');
  });

  it('an unreadable config is returned as ok:false with the cause, never thrown', () => {
    const r = resolvePollAuth({ HARMONY_PROJECT: 'invented' }, () => {
      throw new Error('config unreadable');
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('config unreadable');
  });

  it('the active project is never used: env {} with an active project still fails', () => {
    const r = resolvePollAuth({}, load(cfg()));
    expect(r.ok).toBe(false);
  });

  it('HARMONY_PROJECT wins over a different active project: invented\'s token, never other\'s', async () => {
    const r = resolvePollAuth({ HARMONY_PROJECT: 'invented' }, load(cfg({ activeProject: 'other' })));
    if (!r.ok) throw new Error('expected ok');
    const fetchMock = stubExchange('proj-inv');
    await r.auth.getAccessToken();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.token).toBe('tok-invented');
    expect(body.token).not.toBe('tok-other');
    expect(fetchMock.mock.calls[0][0]).not.toContain('other.example');
  });
});

describe('src/bin/poll.ts source guard (B-1522)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, '..', 'bin', 'poll.ts'), 'utf8');

  it('reads no token from the environment directly, and resolves through resolvePollAuth', () => {
    expect(src).not.toContain('process.env.HARMONY_API_TOKEN');
    expect(src).toContain('resolvePollAuth');
  });

  it('keeps its exit codes', () => {
    expect(src).toMatch(/changed: 0/);
    expect(src).toMatch(/error: 1/);
    expect(src).toMatch(/timeout: 2/);
    expect(src).toMatch(/unwatchable: 3/);
  });
});
