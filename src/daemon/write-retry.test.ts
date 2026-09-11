// B-845: a flaky auth-token exchange (PGRST303) or a transient network blip must self-heal within
// the same daemon tick. This file tests classifyRetrySafety's table-driven classification and
// withWriteRetry's retry policy in isolation, with fake deps (no real timers, no real fetch).

import { describe, it, expect, vi } from 'vitest';
import { classifyRetrySafety, withWriteRetry, type WriteRetryDeps } from './write-retry.js';

function fakeDeps(): WriteRetryDeps & { sleeps: number[]; refreshCalls: number } {
  const sleeps: number[] = [];
  let refreshCalls = 0;
  return {
    sleeps,
    get refreshCalls() {
      return refreshCalls;
    },
    forceRefresh: async () => {
      refreshCalls += 1;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  } as WriteRetryDeps & { sleeps: number[]; refreshCalls: number };
}

describe('classifyRetrySafety — table-driven', () => {
  // Realistic undici/Node error shapes: a system error is a real Error instance with its OWN
  // `.code` (e.g. `Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })`),
  // and a raw fetch() TypeError nests one of these one level down via `.cause` — the SAME shape
  // error-format.ts's describeCause walks, and findCauseCode (its sibling export) reuses that exact
  // traversal, so these fixtures build the real chain rather than a hand-wavy `{ cause: { code } }`
  // literal that skips the traversal's own instanceof-Error branch.
  function sysErr(code: string): Error {
    return Object.assign(new Error(`system error ${code}`), { code });
  }
  function fetchFailed(code: string): TypeError {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = sysErr(code);
    return err;
  }

  const cases: Array<{ name: string; err: unknown; expected: 'pre-send' | 'post-send' | 'pgrst303' }> = [
    // pre-send: the request never reached the server — retry freely. Each also exercised via a
    // one-level-nested fetch() TypeError, the shape auth.ts's raw fetch() actually throws.
    { name: 'ECONNREFUSED (direct)', err: sysErr('ECONNREFUSED'), expected: 'pre-send' },
    { name: 'ECONNREFUSED (nested under a fetch TypeError)', err: fetchFailed('ECONNREFUSED'), expected: 'pre-send' },
    { name: 'ENOTFOUND', err: fetchFailed('ENOTFOUND'), expected: 'pre-send' },
    { name: 'EAI_AGAIN', err: fetchFailed('EAI_AGAIN'), expected: 'pre-send' },
    {
      name: 'TLS handshake: UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      err: fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
      expected: 'pre-send',
    },
    {
      name: 'TLS handshake: CERT_HAS_EXPIRED',
      err: fetchFailed('CERT_HAS_EXPIRED'),
      expected: 'pre-send',
    },
    // post-send / ambiguous — server-side outcome unknown, never retry a CAS write.
    { name: 'ETIMEDOUT (direct)', err: sysErr('ETIMEDOUT'), expected: 'post-send' },
    { name: 'ETIMEDOUT (nested under a fetch TypeError)', err: fetchFailed('ETIMEDOUT'), expected: 'post-send' },
    { name: 'ECONNRESET', err: fetchFailed('ECONNRESET'), expected: 'post-send' },
    { name: 'UND_ERR_SOCKET', err: fetchFailed('UND_ERR_SOCKET'), expected: 'post-send' },
    {
      name: "the literal message 'socket hang up' (the one string-match exception)",
      err: new Error('socket hang up'),
      expected: 'post-send',
    },
    {
      name: 'a response stream failing mid-read (no code at all)',
      err: new Error('terminated'),
      expected: 'post-send',
    },
    // pgrst303 — the JWT expired mid-tick.
    { name: 'PGRST303', err: { code: 'PGRST303', message: 'JWT expired' }, expected: 'pgrst303' },
    // none/unknown code — defaults to the CONSERVATIVE ambiguous bucket, never the permissive one.
    {
      name: 'an empty code (the real supabase-js client-side-network-error shape)',
      err: { code: '', message: 'x', details: '', hint: '' },
      expected: 'post-send',
    },
    { name: 'an unrecognized code', err: fetchFailed('ESOMETHINGNEW'), expected: 'post-send' },
    { name: 'no code anywhere', err: new Error('boom'), expected: 'post-send' },
    { name: 'a non-object, non-Error rejection', err: 'just a string', expected: 'post-send' },
  ];

  for (const { name, err, expected } of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyRetrySafety(err)).toBe(expected);
    });
  }

  it('walks a chained .cause the same way error-format.ts does (TypeError -> Error -> {code})', () => {
    const inner = { code: 'ECONNREFUSED', errno: -61 };
    const middle = new Error('connect ECONNREFUSED');
    (middle as { cause?: unknown }).cause = inner;
    const outer = new TypeError('fetch failed');
    (outer as { cause?: unknown }).cause = middle;

    expect(classifyRetrySafety(outer)).toBe('pre-send');
  });
});

describe('withWriteRetry', () => {
  it('returns the result on a first-try success — no sleep, no refresh', async () => {
    const deps = fakeDeps();
    const fn = vi.fn(async () => 'ok');

    const result = await withWriteRetry(deps, { class: 'idempotent' }, fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(deps.sleeps).toEqual([]);
    expect(deps.refreshCalls).toBe(0);
  });

  function sysErr(code: string): Error {
    return Object.assign(new Error(`system error ${code}`), { code });
  }

  it("'cas' class retries a pre-send network error (bounded 250ms then 750ms)", async () => {
    const deps = fakeDeps();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw sysErr('ECONNREFUSED');
      return 'ok';
    });

    const result = await withWriteRetry(deps, { class: 'cas' }, fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(deps.sleeps).toEqual([250, 750]);
  });

  it("'cas' class NEVER retries a post-send/ambiguous error — the server-side outcome is unknown", async () => {
    const deps = fakeDeps();
    const err = sysErr('ECONNRESET');
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(withWriteRetry(deps, { class: 'cas' }, fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(deps.sleeps).toEqual([]);
  });

  it("'idempotent' class DOES retry a post-send/ambiguous error — the write's own guard makes it safe", async () => {
    const deps = fakeDeps();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw sysErr('ECONNRESET');
      return 'ok';
    });

    const result = await withWriteRetry(deps, { class: 'idempotent' }, fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(deps.sleeps).toEqual([250]);
  });

  it('bounds network retries at two attempts — a third consecutive failure surfaces', async () => {
    const deps = fakeDeps();
    const err = sysErr('ECONNREFUSED');
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(withWriteRetry(deps, { class: 'cas' }, fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 backoff retries
    expect(deps.sleeps).toEqual([250, 750]);
  });

  describe('PGRST303 — the three named outcomes', () => {
    it('(a) forceRefresh() succeeds and the retried write lands → success', async () => {
      const deps = fakeDeps();
      let calls = 0;
      const fn = vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw { code: 'PGRST303', message: 'JWT expired' };
        return 'fresh-token-write-landed';
      });

      const result = await withWriteRetry(deps, { class: 'cas' }, fn);

      expect(result).toBe('fresh-token-write-landed');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(deps.refreshCalls).toBe(1);
      expect(deps.sleeps).toEqual([]); // no network backoff for an auth-shaped failure
    });

    it('(b) forceRefresh() itself fails → that failure surfaces directly, uncaught by the retry loop', async () => {
      const refreshErr = Object.assign(new Error('fetch failed'), {
        endpoint: '/functions/v1/auth-token',
      });
      const deps: WriteRetryDeps = {
        forceRefresh: async () => {
          throw refreshErr;
        },
        sleep: async () => {},
      };
      const fn = vi.fn(async () => {
        throw { code: 'PGRST303', message: 'JWT expired' };
      });

      await expect(withWriteRetry(deps, { class: 'cas', endpoint: 'conductions.x' }, fn)).rejects.toBe(
        refreshErr,
      );
      expect(fn).toHaveBeenCalledTimes(1); // never retried past the failed refresh
      // The refresh failure's OWN endpoint must survive untouched — never overwritten by this
      // write's endpoint label.
      expect((refreshErr as { endpoint?: string }).endpoint).toBe('/functions/v1/auth-token');
    });

    it('(c) the retried write fails again for a DIFFERENT reason → that error is reported, never the original expiry', async () => {
      const deps = fakeDeps();
      const secondErr = { code: '42501', message: 'permission denied for table conductions' };
      let calls = 0;
      const fn = vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw { code: 'PGRST303', message: 'JWT expired' };
        throw secondErr;
      });

      await expect(withWriteRetry(deps, { class: 'cas' }, fn)).rejects.toBe(secondErr);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(deps.refreshCalls).toBe(1); // exactly once — never a second forced refresh
    });

    it('never loops a second forced refresh even if the retried write ALSO comes back PGRST303', async () => {
      const deps = fakeDeps();
      const fn = vi.fn(async () => {
        throw { code: 'PGRST303', message: 'JWT expired' };
      });

      await expect(withWriteRetry(deps, { class: 'idempotent' }, fn)).rejects.toMatchObject({
        code: 'PGRST303',
      });
      expect(fn).toHaveBeenCalledTimes(2); // initial + exactly one retry, never a loop
      expect(deps.refreshCalls).toBe(1);
    });
  });

  describe('endpoint tagging', () => {
    it('tags a final (non-retried) failure with opts.endpoint, for a plain-object rejection', async () => {
      const err = { code: 'ECONNRESET' };
      const fn = vi.fn(async () => {
        throw err;
      });

      await expect(
        withWriteRetry(fakeDeps(), { class: 'cas', endpoint: 'conductions.stealConduction' }, fn),
      ).rejects.toBe(err);
      expect((err as { endpoint?: string }).endpoint).toBe('conductions.stealConduction');
    });

    it('never overwrites an endpoint the error already carries', async () => {
      const err = { code: 'ECONNRESET', endpoint: 'already-set' };
      const fn = vi.fn(async () => {
        throw err;
      });

      await expect(
        withWriteRetry(fakeDeps(), { class: 'cas', endpoint: 'conductions.stealConduction' }, fn),
      ).rejects.toBe(err);
      expect(err.endpoint).toBe('already-set');
    });
  });
});
