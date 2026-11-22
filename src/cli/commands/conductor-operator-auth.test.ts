// B-1501 fix 8: the real (default) lifecycle deps resolve the operator's project through the shared
// resolver. A throwaway HARMONY_CONFIG_DIR and a stubbed fetch: no real ~/.harmony, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLifecycleDeps } from './conductor-lifecycle-deps.js';
import { saveProject } from '../config.js';
import { operatorTokenProblem, type ConductorSettings } from './conductor-preflight.js';
import { resolveProject } from '../../config/project-resolution.js';

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

// B-1501 second fix pass, item A: the operator path never falls to the CLI's active project.
describe('conductor operator path never uses the active project (B-1501 A)', () => {
  const settings = (env: Record<string, string | undefined>): ConductorSettings =>
    ({ env, paths: { hostFile: path.join(dir, 'conductor-host.json') }, envFile: null, merged: null, configIssues: [], pluginDir: dir }) as unknown as ConductorSettings;

  it('no HARMONY_API_TOKEN and no HARMONY_PROJECT: stops naming both, even with an active project stored', async () => {
    saveProject({ name: 'invented', token: 'synthetic-stored', projectId: 'p-inv', verifiedUrl: 'https://a.example.supabase.co', activate: true });
    const deps = defaultLifecycleDeps();
    const why = deps.operatorCredential({});
    expect(why).toContain('HARMONY_API_TOKEN');
    expect(why).toContain('HARMONY_PROJECT');
    const problem = operatorTokenProblem(deps, settings({}));
    expect(problem).toContain('HARMONY_API_TOKEN');
    expect(problem).toContain('HARMONY_PROJECT');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(deps.registryClient({})).rejects.toThrow(/HARMONY_PROJECT/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a URL without its key names the missing key, not "HARMONY_API_TOKEN is not set"', () => {
    const deps = defaultLifecycleDeps();
    const env = { HARMONY_API_TOKEN: 'synthetic-env', HARMONY_SUPABASE_URL: 'https://b.example.supabase.co' };
    const problem = operatorTokenProblem(deps, settings(env)) ?? '';
    expect(problem).toContain('HARMONY_SUPABASE_ANON_KEY');
    expect(problem).toContain('HARMONY_SUPABASE_PUBLISHABLE_KEY');
    expect(problem).not.toContain('HARMONY_API_TOKEN is not set');
    const noToken = operatorTokenProblem(deps, settings({ HARMONY_SUPABASE_URL: 'https://b.example.supabase.co' })) ?? '';
    expect(noToken).toContain('HARMONY_SUPABASE_ANON_KEY');
  });

  it('plain CLI: an active project saved against backend A is refused when the environment names backend B', () => {
    saveProject({ name: 'invented', token: 'synthetic-stored', projectId: 'p-inv', verifiedUrl: 'https://a.example.supabase.co', activate: true });
    const env = { HARMONY_SUPABASE_URL: 'https://b.example.supabase.co', HARMONY_SUPABASE_ANON_KEY: 'synthetic-b-key' };
    expect(() => resolveProject({ surface: 'cli', env })).toThrow(
      /active project "invented" was saved against https:\/\/a\.example\.supabase\.co but this call would use https:\/\/b\.example\.supabase\.co/,
    );
    let msg = '';
    try {
      resolveProject({ surface: 'cli', env });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('synthetic-b-key');
    expect(msg).not.toContain('synthetic-stored');
  });

  it('plain CLI: an entry saved before this change (no verifiedUrl) behaves as today', () => {
    saveProject({ name: 'legacy', token: 'synthetic-legacy', activate: true });
    const env = { HARMONY_SUPABASE_URL: 'https://b.example.supabase.co', HARMONY_SUPABASE_ANON_KEY: 'synthetic-b-key' };
    expect(resolveProject({ surface: 'cli', env }).token).toBe('synthetic-legacy');
  });
});
