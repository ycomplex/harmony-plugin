// B-1501 fix 8: the real (default) lifecycle deps resolve the operator's project through the shared
// resolver. A throwaway HARMONY_CONFIG_DIR and a stubbed fetch: no real ~/.harmony, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLifecycleDeps } from './conductor-lifecycle-deps.js';
import { saveProject } from '../config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1501-conductor-'));
  vi.stubEnv('HARMONY_CONFIG_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('defaultLifecycleDeps operator credential (B-1501)', () => {
  it('HARMONY_PROJECT naming a stored project resolves; nothing at all says why', () => {
    saveProject({ name: 'invented', token: 'synthetic-stored', projectId: 'p-inv', activate: false });
    const deps = defaultLifecycleDeps();
    expect(deps.operatorCredential({ HARMONY_PROJECT: 'invented' })).toBeNull();
    expect(deps.operatorCredential({ HARMONY_API_TOKEN: 'synthetic-env' })).toBeNull();
    expect(deps.operatorCredential({})).toBe('No active project. Run `harmony login` to add one.');
    expect(deps.operatorCredential({ HARMONY_PROJECT: 'nope' })).toContain('HARMONY_PROJECT=nope names no project stored');
  });

  it("the registry client authenticates with the HARMONY_PROJECT entry's token, never asking for HARMONY_API_TOKEN", async () => {
    saveProject({ name: 'invented', token: 'synthetic-stored', projectId: 'p-inv', activate: false });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: `h.${Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url')}.s`, expires_in: 3600, project_id: 'p-inv' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await defaultLifecycleDeps().registryClient({ HARMONY_PROJECT: 'invented' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBe('synthetic-stored');
  });
});
