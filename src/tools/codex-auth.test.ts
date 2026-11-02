import { describe, expect, it, vi } from 'vitest';
import { accessFromGrant, refreshCodex, validateAccess, type CodexGrant, type CodexRefreshPorts } from './codex-auth.js';
const now = 1793620800000;
function grant(generation = 1, user = 'user', expiry = now + 3600000): CodexGrant {
  const jwt = `e30.${Buffer.from(JSON.stringify({ exp: expiry / 1000,
    'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: 'account' }, generation })).toString('base64url')}.fixture`;
  return { id_token: jwt, access_token: jwt, refresh_token: 'fixture-refresh', account_id: 'account' };
}
const state = { generation: 1, grant_version: '1', in_flight: false, blocked: false };
describe('Codex access-only contract', () => {
  it('strips refresh authority and rejects stale, expired and changed identity generations', () => {
    const first = accessFromGrant(grant(), 1, now);
    expect(first.auth.tokens.refresh_token).toBe('');
    expect(validateAccess(accessFromGrant(grant(2), 2, now), first, now).generation).toBe(2);
    expect(() => validateAccess(first, accessFromGrant(grant(2), 2, now), now)).toThrow('identity-mismatch');
    expect(() => validateAccess(accessFromGrant(grant(2, 'other'), 2, now), first, now)).toThrow('identity-mismatch');
    expect(() => accessFromGrant(grant(1, ''), 1, now)).toThrow('identity-mismatch');
    expect(() => accessFromGrant(grant(1, 'user', now), 1, now)).toThrow('expired');
    expect(() => validateAccess({ ...first, auth: { ...first.auth, tokens: { ...first.auth.tokens, refresh_token: 'forbidden' } } }, null, now)).toThrow('identity-mismatch');
  });
  it('persists the rotated full grant before publishing access', async () => {
    const order: string[] = [];
    const ports: CodexRefreshPorts = { claim: async () => true, readGrant: async () => grant(), refresh: async () => grant(2),
      persistGrant: async () => { order.push('grant'); return '2'; }, publishAccess: async a => { order.push('access'); expect(a.auth.tokens.refresh_token).toBe(''); },
      finish: async () => { order.push('finish'); } };
    await expect(refreshCodex(state, ports, now)).resolves.toBe('ok');
    expect(order).toEqual(['grant', 'access', 'finish']);
  });
  it('only one overlapping owner calls OAuth', async () => {
    let claimed = false;
    const refresh = vi.fn(async () => grant(2));
    const ports: CodexRefreshPorts = { claim: async () => { if (claimed) return false; claimed = true; return true; },
      readGrant: async () => grant(), refresh, persistGrant: async () => '2', publishAccess: async () => {}, finish: async () => {} };
    expect(await Promise.all([refreshCodex(state, ports, now), refreshCodex(state, ports, now)])).toEqual(['ok', 'skipped']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it.each(['readGrant', 'refresh', 'persistGrant', 'publishAccess', 'finish'] as const)('fails closed at %s and cannot replay', async point => {
    const publishAccess = vi.fn(async () => {});
    const ports: CodexRefreshPorts = { claim: async () => true, readGrant: async () => grant(), refresh: async () => grant(2),
      persistGrant: async () => '2', publishAccess, finish: async () => {} };
    ports[point] = vi.fn(async () => { throw new Error('fixture-secret-never-output'); }) as never;
    await expect(refreshCodex(state, ports, now)).rejects.toThrow('codex-login-refresh-uncertain');
    if (['readGrant', 'refresh', 'persistGrant'].includes(point)) expect(publishAccess).not.toHaveBeenCalled();
    ports.claim = vi.fn();
    await expect(refreshCodex({ ...state, in_flight: true }, ports, now)).rejects.toThrow('uncertain');
    expect(ports.claim).not.toHaveBeenCalled();
  });
});
