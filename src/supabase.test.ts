// B-696: createAuthenticatedClient must hand supabase-js the accessToken CALLBACK, not a static
// Authorization header — the header freezes the JWT at construction and the long-lived daemon
// client goes zombie ~1h later. The callback and the global header are mutually exclusive in
// supabase-js, so the header must be GONE, not merely accompanied.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HarmonyAuth } from './auth.js';

const createClientMock = vi.hoisted(() => vi.fn(() => ({ fake: 'client' })));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

import { createAuthenticatedClient } from './supabase.js';

type CapturedOptions = {
  accessToken?: () => Promise<string | null>;
  global?: { headers?: Record<string, string> };
  auth?: { persistSession?: boolean; autoRefreshToken?: boolean };
};

function fakeAuth(): HarmonyAuth & { calls: number } {
  const auth = {
    calls: 0,
    getAccessToken: vi.fn(async () => {
      auth.calls += 1;
      return `tok${auth.calls}`;
    }),
  };
  return auth as unknown as HarmonyAuth & { calls: number };
}

function capturedOptions(): CapturedOptions {
  expect(createClientMock).toHaveBeenCalledTimes(1);
  return createClientMock.mock.calls[0][2] as CapturedOptions;
}

beforeEach(() => {
  createClientMock.mockClear();
});

describe('createAuthenticatedClient', () => {
  it('passes an accessToken callback and NO static global Authorization header (mutually exclusive)', async () => {
    await createAuthenticatedClient(fakeAuth());
    const options = capturedOptions();
    expect(typeof options.accessToken).toBe('function');
    expect(options.global?.headers?.Authorization).toBeUndefined();
  });

  it('the callback asks auth.getAccessToken() per invocation and returns its CURRENT value (per-request refresh)', async () => {
    const auth = fakeAuth();
    await createAuthenticatedClient(auth); // construction consumes tok1 (fail-fast probe)
    const { accessToken } = capturedOptions();
    const first = await accessToken!();
    const second = await accessToken!();
    // Two invocations → two fresh getAccessToken() reads, each returning the value CURRENT at call
    // time — a frozen construction-time token would repeat the same value.
    expect(first).toBe('tok2');
    expect(second).toBe('tok3');
    expect(auth.getAccessToken).toHaveBeenCalledTimes(3);
  });

  it('keeps auth: { persistSession: false, autoRefreshToken: false }', async () => {
    await createAuthenticatedClient(fakeAuth());
    expect(capturedOptions().auth).toEqual({ persistSession: false, autoRefreshToken: false });
  });

  it('fails fast at construction: a bad token rejects createAuthenticatedClient itself, not the first query', async () => {
    const auth = {
      getAccessToken: vi.fn(async () => {
        throw new Error('token exchange failed');
      }),
    } as unknown as HarmonyAuth;
    await expect(createAuthenticatedClient(auth)).rejects.toThrow('token exchange failed');
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
