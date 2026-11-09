import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TokenExchangeError } from '../auth.js';
import { healthEvent, type WatchEvent } from './classify.js';
import { createGuardedClient, guardedTokenGetter, installProcessGuards, isAuthError, isBrokenPipe, safeErrorMessage, type GuardHealth } from './guarded-client.js';

describe('guardedTokenGetter (AC3: TokenExchangeError on the accessToken path)', () => {
  it('returns the last good token and reports auth-failed when the exchange is rejected', async () => {
    const getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValueOnce('tok-1').mockRejectedValueOnce(new TokenExchangeError('/functions/v1/auth-token', 401, {}));
    const health: GuardHealth[] = [];
    const get = guardedTokenGetter({ getAccessToken }, (h) => health.push(h));
    expect(await get()).toBe('tok-1');
    expect(await get()).toBe('tok-1');
    expect(health.map((h) => h.kind)).toEqual(['auth-failed']);
  });

  it('reports offline for a network failure', async () => {
    const getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValueOnce('tok-1').mockRejectedValueOnce(new TypeError('fetch failed'));
    const health: GuardHealth[] = [];
    const get = guardedTokenGetter({ getAccessToken }, (h) => health.push(h));
    await get();
    expect(await get()).toBe('tok-1');
    expect(health.map((h) => h.kind)).toEqual(['offline']);
  });

  it('rethrows when there is no good token yet', async () => {
    const err = new TypeError('fetch failed');
    const get = guardedTokenGetter({ getAccessToken: () => Promise.reject(err) }, () => {});
    await expect(get()).rejects.toBe(err);
  });

  it('a throwing health sink does not break the request path', async () => {
    const get = guardedTokenGetter({ getAccessToken: vi.fn<() => Promise<string>>().mockResolvedValueOnce('a').mockRejectedValueOnce(new Error('x')) }, () => {
      throw new Error('sink');
    });
    await get();
    expect(await get()).toBe('a');
  });

  it('createGuardedClient routes the token through the guard (supabase-js asks once at construction for realtime)', async () => {
    const getAccessToken = vi.fn(async () => 'tok');
    const client = createGuardedClient({ getAccessToken, getSupabaseUrl: () => 'http://127.0.0.1:1', getSupabaseAnonKey: () => 'anon' }, () => {});
    expect(typeof client.from).toBe('function');
    await new Promise((r) => setTimeout(r, 0));
    expect(getAccessToken).toHaveBeenCalled();
    client.realtime.disconnect();
  });
});

describe('isAuthError', () => {
  it('recognises rejected credentials, not network failures', () => {
    expect(isAuthError(new TokenExchangeError('/x', 401, {}))).toBe(true);
    expect(isAuthError(new TokenExchangeError('/x', 403, {}))).toBe(true);
    expect(isAuthError(new TokenExchangeError('/x', 500, {}))).toBe(false);
    expect(isAuthError({ code: 'PGRST301', message: 'JWT' })).toBe(true);
    expect(isAuthError({ code: 'PGRST303', message: 'JWT expired' })).toBe(true);
    expect(isAuthError({ code: '', message: 'Token exchange failed (401)' })).toBe(true);
    expect(isAuthError({ code: '', message: 'TypeError: fetch failed' })).toBe(false);
    expect(isAuthError(new TypeError('fetch failed'))).toBe(false);
  });
});

describe('installProcessGuards (AC3)', () => {
  it('turns an unhandledRejection into a health line and does not exit', () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const lines: WatchEvent[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dispose = installProcessGuards((h) => lines.push(healthEvent(0, 'warning', null, { detail: `${h.kind}: ${safeErrorMessage(h.error)}` })), proc);
    try {
      proc.emit('unhandledRejection', new Error('realtime socket blew up'), Promise.resolve());
      proc.emit('uncaughtException', new Error('boom'));
      expect(lines.map((l) => [l.event, l.status, l.detail])).toEqual([
        ['health', 'warning', 'unhandled-rejection: realtime socket blew up'],
        ['health', 'warning', 'uncaught-exception: boom'],
      ]);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      dispose();
      exit.mockRestore();
    }
    expect((proc as unknown as EventEmitter).listenerCount('unhandledRejection')).toBe(0);
    expect((proc as unknown as EventEmitter).listenerCount('uncaughtException')).toBe(0);
  });

  it('ignores broken-pipe errors (EPIPE, ERR_STREAM_DESTROYED): no health line, no write (B-1429)', () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const kinds: string[] = [];
    const dispose = installProcessGuards((h) => kinds.push(`${h.kind}: ${safeErrorMessage(h.error)}`), proc);
    try {
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      const destroyed = Object.assign(new Error('Cannot call write after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' });
      for (const e of [epipe, destroyed]) {
        proc.emit('uncaughtException', e);
        proc.emit('unhandledRejection', e, Promise.resolve());
      }
      expect(kinds).toEqual([]);
      // every other error keeps today's behaviour
      proc.emit('uncaughtException', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      proc.emit('unhandledRejection', new TokenExchangeError('/x', 401, {}), Promise.resolve());
      expect(kinds).toHaveLength(2);
      expect(kinds[0]).toBe('uncaught-exception: connect ECONNREFUSED');
      expect(kinds[1]).toMatch(/^unhandled-rejection: /);
    } finally {
      dispose();
    }
  });

  it('isBrokenPipe recognises only EPIPE and ERR_STREAM_DESTROYED', () => {
    expect(isBrokenPipe({ code: 'EPIPE' })).toBe(true);
    expect(isBrokenPipe(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true);
    expect(isBrokenPipe({ code: 'ECONNRESET' })).toBe(false);
    expect(isBrokenPipe(new Error('EPIPE'))).toBe(false);
    expect(isBrokenPipe(null)).toBe(false);
    expect(isBrokenPipe('EPIPE')).toBe(false);
  });

  it('on the real process, registers and disposes exactly its own handlers', () => {
    const before = [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')];
    const dispose = installProcessGuards(() => {});
    expect(process.listenerCount('unhandledRejection')).toBe(before[0] + 1);
    expect(process.listenerCount('uncaughtException')).toBe(before[1] + 1);
    dispose();
    expect([process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')]).toEqual(before);
  });
});

describe('safeErrorMessage', () => {
  it('redacts JWTs, bearer tokens and given secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_def';
    expect(safeErrorMessage(new Error(`bad ${jwt} Bearer xyz secret-123`), ['secret-123'])).toBe('bad [redacted] Bearer [redacted] [redacted]');
  });
});
