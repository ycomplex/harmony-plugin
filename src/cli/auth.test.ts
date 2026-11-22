// B-1070: getAuthenticatedContext() falls back to resolving a project from HARMONY_API_TOKEN alone
// when no ~/.harmony/config.json active project is configured — but an explicitly configured active
// project always takes precedence when both are present. The fallback lives ONLY in
// getAuthenticatedContext() (src/cli/auth.ts); getActiveProject() (src/cli/config.ts) is untouched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getAuthenticatedContext, resetAuthNoticesForTest } from './auth.js';
import { addProject, saveProject } from './config.js';

let tmpDir: string;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-auth-test-'));
  vi.stubEnv('HARMONY_CONFIG_DIR', tmpDir);
  // B-1501: the environment wins now, so no test may inherit the runner's own variables.
  for (const v of ['HARMONY_API_TOKEN', 'HARMONY_PROJECT', 'HARMONY_SUPABASE_URL', 'HARMONY_SUPABASE_ANON_KEY', 'HARMONY_SUPABASE_PUBLISHABLE_KEY']) {
    vi.stubEnv(v, '');
    vi.stubEnv(`EVAL_${v}`, '');
  }
  resetAuthNoticesForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getAuthenticatedContext() — B-1070 HARMONY_API_TOKEN fallback', () => {
  it('1. config-less env + valid token succeeds, with exactly ONE stderr notice line across two calls', async () => {
    vi.stubEnv('HARMONY_API_TOKEN', 'env-token-123');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: fakeJwt('u1'), expires_in: 3600, project_id: 'proj-env' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await getAuthenticatedContext();
    const second = await getAuthenticatedContext();

    expect(first.projectId).toBe('proj-env');
    expect(second.projectId).toBe('proj-env');

    const noticeCalls = errorSpy.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('using HARMONY_API_TOKEN')),
    );
    expect(noticeCalls).toHaveLength(1);
  });

  it('2. B-1501: active project configured + a different env token → the ENV token wins, with ONE override line naming the project', async () => {
    addProject('demo', 'configured-token');
    vi.stubEnv('HARMONY_API_TOKEN', 'env-token-wins');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: fakeJwt('u1'), expires_in: 3600, project_id: 'proj-configured' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ctx = await getAuthenticatedContext();

    expect(ctx.projectId).toBe('proj-configured');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse((requestInit as RequestInit).body as string);
    expect(sentBody.token).toBe('env-token-wins');

    await getAuthenticatedContext();
    const lines = errorSpy.mock.calls.flat().filter((a) => typeof a === 'string') as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('using HARMONY_API_TOKEN from the environment, not the active project "demo"');
    expect(lines.join('\n')).not.toContain('env-token-wins');
    expect(lines.join('\n')).not.toContain('configured-token');
  });

  it('2b. the env token equal to the active project token is no override: no line printed', async () => {
    addProject('demo', 'same-token');
    vi.stubEnv('HARMONY_API_TOKEN', 'same-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ access_token: fakeJwt('u1'), expires_in: 3600, project_id: 'p' })));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await getAuthenticatedContext();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('3. invalid token → the TokenExchangeError-derived message, never "No active project"', async () => {
    vi.stubEnv('HARMONY_API_TOKEN', 'bad-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid' }, { ok: false, status: 401 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getAuthenticatedContext()).rejects.toThrow(/rejected.*401|401.*rejected/i);
    await expect(getAuthenticatedContext()).rejects.not.toThrow(/No active project/);
  });

  it('4. a rejected fetch (network failure) → the distinct network-failure message', async () => {
    vi.stubEnv('HARMONY_API_TOKEN', 'some-token');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getAuthenticatedContext()).rejects.toThrow(/reach Harmony/i);
    // Distinguishable from test 3's "rejected (HTTP ...)" shape.
    await expect(getAuthenticatedContext()).rejects.not.toThrow(/rejected \(HTTP/i);
  });

  it('5. the fallback performs no write under HARMONY_CONFIG_DIR', async () => {
    vi.stubEnv('HARMONY_API_TOKEN', 'env-token-123');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ access_token: fakeJwt('u1'), expires_in: 3600, project_id: 'proj-env' })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await getAuthenticatedContext();

    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(false);
  });

  it('regression: still throws the ORIGINAL "No active project" error with no config AND no HARMONY_API_TOKEN', async () => {
    // '' is falsy, matching harmonyEnv()'s own empty-string-means-absent contract (src/env.ts).
    vi.stubEnv('HARMONY_API_TOKEN', '');

    await expect(getAuthenticatedContext()).rejects.toThrow('No active project. Run `harmony login` to add one.');
  });
});

// B-1025: the stored pair (supabaseUrl + supabaseAnonKey) on the active project must reach the
// token exchange's URL and Authorization header — the old freeze at module import made the
// stored pair dead code. This test registers a project with a CUSTOM URL + KEY (NOT the prod
// built-in pair) and asserts fetch() was called against that URL with that key as the Bearer.
it('stored project pair reaches fetch URL and Authorization header', async () => {
  const customUrl = 'https://staging.example.supabase.co';
  const customKey = 'custom-anon-key-987654321';
  addProject('demo', 'demo-token', { supabaseUrl: customUrl, supabaseAnonKey: customKey });
  // Stub the env pair to the PROD defaults so the assertion is not about env (it'd otherwise
  // shadow the stored pair).
  vi.stubEnv('HARMONY_SUPABASE_URL', 'https://prod.example.supabase.co');
  vi.stubEnv('HARMONY_SUPABASE_ANON_KEY', 'prod-env-anon-key');
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse({ access_token: fakeJwt('u-stored'), expires_in: 3600, project_id: 'proj-stored' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const ctx = await getAuthenticatedContext();

  expect(ctx.projectId).toBe('proj-stored');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [calledUrl, requestInit] = fetchMock.mock.calls[0];
  expect(calledUrl).toBe(`${customUrl}/functions/v1/auth-token`);
  const headers = (requestInit as RequestInit).headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${customKey}`);
  expect(headers['Content-Type']).toBe('application/json');
});

it.each(["ENOTFOUND","ECONNRESET","UND_ERR_CONNECT_TIMEOUT","CERT_HAS_EXPIRED"])("shows %s and host without credentials",async code=>{
 vi.stubEnv("HARMONY_API_TOKEN","sensitive-token");vi.stubEnv("HARMONY_SUPABASE_URL","https://example.invalid");vi.stubEnv("HARMONY_SUPABASE_ANON_KEY","some-anon-key");
 vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("fetch failed",{cause:{code,message:"network failure sensitive-token Bearer hidden"}})));
 let message="";try{await getAuthenticatedContext();}catch(e){message=(e as Error).message;}
 expect(message).toBe(`Could not reach Harmony to validate HARMONY_API_TOKEN: fetch failed (host: example.invalid; cause: ${code}: network failure [redacted] Bearer [redacted])`);
 expect(message).not.toContain("sensitive-token");expect(message).not.toContain("hidden");
});

// B-1501: the CLI surface of the shared resolver's three rungs.
describe('getAuthenticatedContext() — B-1501 HARMONY_PROJECT rung', () => {
  function okFetch(projectId: string) {
    return vi.fn().mockResolvedValue(jsonResponse({ access_token: fakeJwt('u1'), expires_in: 3600, project_id: projectId }));
  }

  it('HARMONY_PROJECT picks the stored entry: its token and its own stored pair, with one override line', async () => {
    addProject('active-one', 'active-token');
    saveProject({ name: 'invented', token: 'invented-token', projectId: 'proj-inv', supabaseUrl: 'https://inv.example.supabase.co', supabaseAnonKey: 'inv-key', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'invented');
    const fetchMock = okFetch('proj-inv');
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ctx = await getAuthenticatedContext();
    expect(ctx.projectId).toBe('proj-inv');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://inv.example.supabase.co/functions/v1/auth-token');
    expect(JSON.parse((init as RequestInit).body as string).token).toBe('invented-token');
    const lines = errorSpy.mock.calls.flat() as string[];
    expect(lines).toEqual(['harmony: using HARMONY_PROJECT=invented from the environment, not the active project "active-one" (the environment wins; unset HARMONY_PROJECT to use "active-one")']);
  });

  it('HARMONY_API_TOKEN beats HARMONY_PROJECT', async () => {
    saveProject({ name: 'invented', token: 'invented-token', projectId: 'proj-inv', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'invented');
    vi.stubEnv('HARMONY_API_TOKEN', 'env-first');
    const fetchMock = okFetch('proj-env');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await getAuthenticatedContext();
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).token).toBe('env-first');
  });

  it('a HARMONY_PROJECT that names no stored entry is refused, never falling back to the active project', async () => {
    addProject('active-one', 'active-token');
    vi.stubEnv('HARMONY_PROJECT', 'missing');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(getAuthenticatedContext()).rejects.toThrow(/HARMONY_PROJECT=missing names no project stored .*stored: active-one/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a token that now reaches a different project than the one saved is refused, naming both ids', async () => {
    saveProject({ name: 'invented', token: 'invented-token', projectId: 'proj-saved', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'invented');
    vi.stubGlobal('fetch', okFetch('proj-other'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getAuthenticatedContext()).rejects.toThrow(/HARMONY_PROJECT=invented was saved for project proj-saved, but its token now reaches project proj-other/);
  });

  it('HARMONY_SUPABASE_URL contradicting the stored pair is refused by name, URLs only, before any call', async () => {
    saveProject({ name: 'invented', token: 'invented-token', projectId: 'p', supabaseUrl: 'https://a.example.supabase.co', supabaseAnonKey: 'secret-ish-key-a', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'invented');
    vi.stubEnv('HARMONY_SUPABASE_URL', 'https://b.example.supabase.co');
    vi.stubEnv('HARMONY_SUPABASE_ANON_KEY', 'secret-ish-key-b');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await getAuthenticatedContext().catch((e: Error) => e);
    expect((err as Error).message).toContain('HARMONY_PROJECT=invented is stored for https://a.example.supabase.co but HARMONY_SUPABASE_URL says https://b.example.supabase.co');
    expect((err as Error).message).not.toContain('secret-ish-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HARMONY_SUPABASE_PUBLISHABLE_KEY contradicting the stored key is refused by name, never printing either key', async () => {
    saveProject({ name: 'invented', token: 'invented-token', projectId: 'p', supabaseUrl: 'https://a.example.supabase.co', supabasePublishableKey: 'sb_publishable_a', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'invented');
    vi.stubEnv('HARMONY_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_b');
    vi.stubGlobal('fetch', vi.fn());
    const err = await getAuthenticatedContext().catch((e: Error) => e);
    expect((err as Error).message).toContain('HARMONY_SUPABASE_PUBLISHABLE_KEY');
    expect((err as Error).message).not.toContain('sb_publishable_');
  });

  it('a matching env pair is fine', async () => {
    saveProject({ name: 'invented', token: 'invented-token', projectId: 'p', supabaseUrl: 'https://a.example.supabase.co/', supabaseAnonKey: 'key-a', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'invented');
    vi.stubEnv('HARMONY_SUPABASE_URL', 'https://a.example.supabase.co');
    vi.stubEnv('HARMONY_SUPABASE_ANON_KEY', 'key-a');
    vi.stubGlobal('fetch', okFetch('p'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await getAuthenticatedContext()).projectId).toBe('p');
  });

  it('an entry with no stored pair saved against one backend is refused when this session would use another', async () => {
    saveProject({ name: 'invented', token: 'invented-token', projectId: 'p', verifiedUrl: 'https://staging.example.supabase.co', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'invented');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(getAuthenticatedContext()).rejects.toThrow(/was saved against https:\/\/staging\.example\.supabase\.co but this session would use .* \(from the built-in default\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with neither variable set, the active project is used exactly as before, with no line printed', async () => {
    addProject('active-one', 'active-token');
    const fetchMock = okFetch('proj-active');
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await getAuthenticatedContext()).projectId).toBe('proj-active');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).token).toBe('active-token');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
