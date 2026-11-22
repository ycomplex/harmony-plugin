// B-1501: `harmony watch` builds its auth through the shared resolver. Started with NO
// HARMONY_API_TOKEN and no HARMONY_PROJECT it must follow the CLI's active project exactly as before:
// the active project's token, exchanged against its own stored pair.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCliAuth } from './watch.js';
import { addProject, saveProject } from '../config.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1501-watch-'));
  vi.stubEnv('HARMONY_CONFIG_DIR', dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

function okFetch(projectId: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ access_token: `h.${Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url')}.s`, expires_in: 3600, project_id: projectId }),
  });
}

describe('makeCliAuth (harmony watch)', () => {
  it('with no HARMONY_API_TOKEN and no HARMONY_PROJECT follows the active project and its stored pair', async () => {
    saveProject({ name: 'other', token: 'tok-other', projectId: 'p-other', activate: true });
    addProject('watched', 'tok-watched', { supabaseUrl: 'https://watched.example.supabase.co', supabaseAnonKey: 'watched-key' });
    const fetchMock = okFetch('p-watched');
    vi.stubGlobal('fetch', fetchMock);
    const auth = makeCliAuth({});
    expect(auth.getSupabaseUrl()).toBe('https://watched.example.supabase.co');
    await auth.getAccessToken();
    expect(auth.getProjectId()).toBe('p-watched');
    expect(fetchMock.mock.calls[0][0]).toBe('https://watched.example.supabase.co/functions/v1/auth-token');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBe('tok-watched');
  });

  it('with no project and no variable, the old "No active project" error', () => {
    expect(() => makeCliAuth({})).toThrow('No active project. Run `harmony login` to add one.');
  });

  it('HARMONY_PROJECT moves it to the named stored project', async () => {
    addProject('watched', 'tok-watched');
    saveProject({ name: 'invented', token: 'tok-inv', projectId: 'p-inv', activate: false });
    const fetchMock = okFetch('p-inv');
    vi.stubGlobal('fetch', fetchMock);
    const auth = makeCliAuth({ HARMONY_PROJECT: 'invented' });
    await auth.getAccessToken();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBe('tok-inv');
  });
});
