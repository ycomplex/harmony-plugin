// B-845: HarmonyAuth.forceRefresh() is single-flight — concurrent PGRST303 callers on ONE instance
// must share ONE in-flight exchange (never one fetch per caller), and the single-flight promise
// must clear on BOTH resolution and rejection so a failed exchange can never poison the next
// caller. Also regression-covers getAccessToken()'s existing cache/expiry behaviour, which this
// ticket must leave byte-for-byte unchanged for the MCP server path (src/supabase.ts's per-request
// accessToken callback).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HarmonyAuth, TokenExchangeError } from './auth.js';

function tokenPayload(sub: string): string {
  return Buffer.from(JSON.stringify({ sub })).toString('base64url');
}

function fakeJwt(sub = 'user-1'): string {
  return `header.${tokenPayload(sub)}.signature`;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('HarmonyAuth.getAccessToken() — regression: cache/expiry unchanged (MCP server path)', () => {
  it('exchanges once, then serves the cached token until it nears expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: fakeJwt(), expires_in: 3600, project_id: 'proj-1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const auth = new HarmonyAuth('api-token');
    const first = await auth.getAccessToken();
    const second = await auth.getAccessToken();

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served entirely from cache
  });

  it('re-exchanges once the cached token is within 60s of expiry (the existing skew guard)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: fakeJwt('u1'), expires_in: 100, project_id: 'p' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: fakeJwt('u2'), expires_in: 100, project_id: 'p' }));
    vi.stubGlobal('fetch', fetchMock);

    const auth = new HarmonyAuth('api-token');
    const first = await auth.getAccessToken();
    vi.advanceTimersByTime(41_000); // 100s - 41s = 59s left — inside the 60s skew window
    const second = await auth.getAccessToken();

    expect(first).not.toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a bad token rejects getAccessToken() with the structured TokenExchangeError (endpoint/status/body)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'invalid token' }, { ok: false, status: 401 })),
    );

    const auth = new HarmonyAuth('bad-token');
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      endpoint: '/functions/v1/auth-token',
      status: 401,
      body: { message: 'invalid token' },
    });
  });

  it('exposes projectId/userId only after a successful exchange, unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ access_token: fakeJwt('the-user'), expires_in: 3600, project_id: 'the-project' })),
    );
    const auth = new HarmonyAuth('api-token');

    expect(() => auth.getProjectId()).toThrow('Not authenticated yet');
    expect(() => auth.getUserId()).toThrow('Not authenticated yet');

    await auth.getAccessToken();

    expect(auth.getProjectId()).toBe('the-project');
    expect(auth.getUserId()).toBe('the-user');
  });
});

describe('HarmonyAuth.forceRefresh() — B-845 single-flight', () => {
  it('two concurrent callers share ONE exchange fetch, and BOTH see the fresh token afterward', async () => {
    let resolveFetch: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(pending);
    vi.stubGlobal('fetch', fetchMock);

    const auth = new HarmonyAuth('api-token');

    const callA = auth.forceRefresh();
    const callB = auth.forceRefresh();

    expect(fetchMock).toHaveBeenCalledTimes(1); // ONE fetch for both concurrent callers

    const freshToken = fakeJwt('fresh');
    resolveFetch!(jsonResponse({ access_token: freshToken, expires_in: 3600, project_id: 'p' }));
    await callA;
    await callB;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Both retries downstream would now read the SAME fresh token via the shared cache — no second
    // fetch, and the cached token IS the fresh one the shared exchange landed.
    const cacheOnlyFetch = vi.fn();
    vi.stubGlobal('fetch', cacheOnlyFetch);
    const served = await auth.getAccessToken();
    expect(served).toBe(freshToken);
    expect(cacheOnlyFetch).not.toHaveBeenCalled();
  });

  it('a SECOND forceRefresh() call while the first is still in flight never fires a second fetch, even serialized', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: fakeJwt(), expires_in: 3600, project_id: 'p' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = new HarmonyAuth('api-token');

    const first = auth.forceRefresh();
    const second = auth.forceRefresh(); // called synchronously, before `first` resolves
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a FAILED exchange does not poison the next caller — the single-flight promise clears on rejection too', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'upstream down' }, { ok: false, status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: fakeJwt('recovered'), expires_in: 3600, project_id: 'p' }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new HarmonyAuth('api-token');

    await expect(auth.forceRefresh()).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second call after the failure must start a BRAND NEW exchange, not replay the dead promise.
    await expect(auth.forceRefresh()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.getUserId()).toBe('recovered');
  });

  it('two concurrent callers on a FAILED exchange both see the SAME rejection, and the guard still clears', async () => {
    let rejectFetch: (err: unknown) => void;
    const pending = new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(
      jsonResponse({ access_token: fakeJwt(), expires_in: 3600, project_id: 'p' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = new HarmonyAuth('api-token');

    const callA = auth.forceRefresh();
    const callB = auth.forceRefresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const networkErr = new TypeError('fetch failed');
    rejectFetch!(networkErr);

    await expect(callA).rejects.toBe(networkErr);
    await expect(callB).rejects.toBe(networkErr);
    // B-845: the raw fetch() rejection is tagged with .endpoint (mirrors TokenExchangeError).
    expect((networkErr as { endpoint?: string }).endpoint).toBe('/functions/v1/auth-token');

    // The guard cleared — a subsequent call starts fresh.
    await auth.forceRefresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh() does NOT call getAccessToken() — it forces a fresh exchange even with a live cached token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: fakeJwt('first'), expires_in: 3600, project_id: 'p' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: fakeJwt('second'), expires_in: 3600, project_id: 'p' }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new HarmonyAuth('api-token');

    const cached = await auth.getAccessToken(); // primes a well-within-expiry cached token
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await auth.forceRefresh(); // must NOT be short-circuited by the still-fresh cache
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const refreshed = await auth.getAccessToken(); // now served from the NEW cache, no 3rd fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toBe(cached);
  });
});

describe("src/auth.ts's exchange() — raw fetch() failure carries .endpoint (B-845)", () => {
  it('tags a network-level fetch() rejection with the auth-token endpoint, .cause untouched', async () => {
    const cause = { code: 'ECONNREFUSED', errno: -61 };
    const networkErr = new TypeError('fetch failed');
    (networkErr as { cause?: unknown }).cause = cause;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(networkErr)),
    );

    const auth = new HarmonyAuth('api-token');
    await expect(auth.getAccessToken()).rejects.toBe(networkErr);
    expect((networkErr as { endpoint?: string }).endpoint).toBe('/functions/v1/auth-token');
    expect((networkErr as { cause?: unknown }).cause).toBe(cause); // untouched
  });
});
