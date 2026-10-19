import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGithubTokenProvider } from './github-app-token.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const tokenRes = (token: string, expiresInMs = 3600_000) =>
  ({ ok: true, json: async () => ({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }) }) as unknown as Response;

describe('createGithubTokenProvider (B-1170)', () => {
  it('is undefined with no App identity and no static token', () => {
    expect(createGithubTokenProvider({ env: {} })).toBeUndefined();
    expect(createGithubTokenProvider({ env: { HARMONY_APP_ID: '1' } })).toBeUndefined();
  });

  it('falls back to a static GH_TOKEN', async () => {
    const get = createGithubTokenProvider({ env: { GITHUB_TOKEN: 't' } })!;
    expect(await get()).toBe('t');
  });

  it('mints once and caches until near expiry, then re-mints', async () => {
    let t = 1_000_000;
    const fetchImpl = vi.fn(async () => tokenRes('inst', 10 * 60_000));
    const get = createGithubTokenProvider({
      env: { HARMONY_APP_ID: '7', HARMONY_APP_INSTALLATION_ID: '99', HARMONY_APP_PRIVATE_KEY_PATH: '/k' },
      fetchImpl: fetchImpl as any,
      readFile: () => pem,
      now: () => t,
    })!;
    expect(await get()).toBe('inst');
    expect(await get()).toBe('inst');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://api.github.com/app/installations/99/access_tokens');
    t += 20 * 60_000;
    // the fake expires_at is relative to the real clock, so only the call count after time travel matters
    await get();
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('appOverride supplies host-file defaults; env wins per field', async () => {
    const urls: string[] = [];
    const keys: string[] = [];
    const get = createGithubTokenProvider({
      env: { HARMONY_APP_INSTALLATION_ID: '555' },
      appOverride: { app_id: '7', installation_id: '99', private_key_path: '/host.pem' },
      fetchImpl: (async (u: string) => { urls.push(u); return tokenRes('x'); }) as any,
      readFile: (p) => { keys.push(p); return pem; },
    })!;
    expect(await get()).toBe('x');
    expect(urls[0]).toContain('/app/installations/555/');
    expect(keys).toEqual(['/host.pem']);
  });

  it('appOverride alone is enough; env key path beats the override path', async () => {
    const keys: string[] = [];
    const get = createGithubTokenProvider({
      env: { HARMONY_APP_PRIVATE_KEY_PATH: '/env.pem' },
      appOverride: { app_id: '7', installation_id: '99', private_key_path: '/host.pem' },
      fetchImpl: (async () => tokenRes('x')) as any,
      readFile: (p) => { keys.push(p); return pem; },
    })!;
    await get();
    expect(keys).toEqual(['/env.pem']);
  });

  it('a refused mint is null', async () => {
    const get = createGithubTokenProvider({
      env: { HARMONY_APP_ID: '1', HARMONY_APP_INSTALLATION_ID: '2', HARMONY_APP_PRIVATE_KEY: pem },
      fetchImpl: (async () => ({ ok: false }) as Response) as any,
    })!;
    expect(await get()).toBeNull();
  });
});
