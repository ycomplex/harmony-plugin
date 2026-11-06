import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarmonyAuth } from './auth.js';
import { createAuthenticatedClient } from './supabase.js';
import { resolveSupabaseTarget } from './cli/resolve-supabase-target.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-06T12:00:00Z');
  for (const name of ['HARMONY_SUPABASE_ANON_KEY', 'HARMONY_SUPABASE_PUBLISHABLE_KEY',
    'EVAL_HARMONY_SUPABASE_ANON_KEY', 'EVAL_HARMONY_SUPABASE_PUBLISHABLE_KEY']) vi.stubEnv(name, '');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const url = 'https://synthetic.supabase.co';
const key = 'sb_publishable_synthetic';
const jwt = (sequence: number, project = 'project-a') => `header.${Buffer.from(JSON.stringify({
  sub: 'user-a', project_id: project, role: 'authenticated', sequence,
})).toString('base64url')}.signature`;

describe('source-local public key aliases', () => {
  it.each([
    { flags: { url, publishableKey: key } },
    { project: { supabaseUrl: url, supabasePublishableKey: key } },
    { env: { HARMONY_SUPABASE_URL: url, HARMONY_SUPABASE_PUBLISHABLE_KEY: key } },
    { env: { EVAL_HARMONY_SUPABASE_URL: url, EVAL_HARMONY_SUPABASE_PUBLISHABLE_KEY: key } },
  ])('accepts each input source: %j', (input) => {
    expect(resolveSupabaseTarget({ env: {}, ...input })).toMatchObject({ url, anonKey: key });
  });
  it('accepts identical aliases and ignores conflicts below the URL owner', () => {
    expect(resolveSupabaseTarget({ flags: { url, anonKey: key, publishableKey: key },
      env: { HARMONY_SUPABASE_ANON_KEY: 'a', HARMONY_SUPABASE_PUBLISHABLE_KEY: 'b' },
    })).toMatchObject({ anonKey: key, source: 'flags' });
  });
  it.each([
    { flags: { url, anonKey: 'synthetic-old', publishableKey: key } },
    { project: { supabaseUrl: url, supabaseAnonKey: 'synthetic-old', supabasePublishableKey: key } },
    { env: { HARMONY_SUPABASE_URL: url, HARMONY_SUPABASE_ANON_KEY: 'synthetic-old', HARMONY_SUPABASE_PUBLISHABLE_KEY: key } },
  ])('rejects conflicting selected aliases without values: %j', (input) => {
    try { resolveSupabaseTarget({ env: {}, ...input }); expect.fail('must reject'); }
    catch (error) {
      expect((error as Error).message).toContain('Conflicting Supabase public key aliases');
      expect((error as Error).message).not.toContain('synthetic-old');
      expect((error as Error).message).not.toContain(key);
    }
  });
  it('never borrows a publishable key from a lower source', () => {
    expect(() => resolveSupabaseTarget({ flags: { url },
      env: { HARMONY_SUPABASE_PUBLISHABLE_KEY: key } })).toThrow('Missing Supabase anon key');
  });
  it('retains explicit-key-only default URL fallback', () => {
    expect(resolveSupabaseTarget({ flags: { publishableKey: key }, env: {} })).toMatchObject({ anonKey: key, source: 'default' });
  });
});

describe.each(['legacy.synthetic.jwt', key])('public transport and renewed user identity: %s', (publicKey) => {
  it('uses public apikey for bootstrap and renewed user JWT for every data request', async () => {
    let exchanges = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      expect(headers.get('apikey')).toBe(publicKey);
      if (requestUrl.endsWith('/auth-token')) {
        expect(headers.get('Authorization')).toBe(publicKey === key ? null : `Bearer ${publicKey}`);
        expect(JSON.parse(init!.body as string)).toEqual({ token: 'synthetic-harmony-token' });
        return Response.json({ access_token: jwt(++exchanges), expires_in: 100, project_id: 'project-a' });
      }
      expect(headers.get('Authorization')).toBe(`Bearer ${jwt(exchanges)}`);
      return Response.json([{ id: 'synthetic-row' }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const auth = new HarmonyAuth('synthetic-harmony-token', url, publicKey);
    const client = await createAuthenticatedClient(auth);
    expect((await client.from('projects').select('id')).error).toBeNull();
    vi.advanceTimersByTime(41_000);
    expect((await client.from('projects').select('id')).error).toBeNull();
    expect(exchanges).toBe(2);
    expect(auth.getUserId()).toBe('user-a');
    expect(auth.getProjectId()).toBe('project-a');
  });
  it('rejects a mismatched project claim before using the returned token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: jwt(1, 'other-project'),
      expires_in: 100, project_id: 'project-a' })));
    await expect(new HarmonyAuth('synthetic-token', url, publicKey).getAccessToken()).rejects.toThrow();
  });
});

it('rejects direct MCP environment alias conflicts before network access', async () => {
  vi.stubEnv('HARMONY_SUPABASE_ANON_KEY', 'synthetic-old');
  vi.stubEnv('HARMONY_SUPABASE_PUBLISHABLE_KEY', key);
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  await expect(new HarmonyAuth('synthetic-token').getAccessToken()).rejects.toThrow('Conflicting');
  expect(fetchMock).not.toHaveBeenCalled();
});
