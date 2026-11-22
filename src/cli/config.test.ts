import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadConfig,
  saveConfig,
  getActiveProject,
  addProject,
  removeProject,
  switchProject,
  listProjects,
  saveProject,
} from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-test-'));
  vi.stubEnv('HARMONY_CONFIG_DIR', tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns empty config when no file exists', () => {
    const config = loadConfig();
    expect(config).toEqual({ activeProject: null, projects: {} });
  });

  it('reads existing config file', () => {
    const existing = {
      activeProject: 'my-proj',
      projects: { 'my-proj': { name: 'my-proj', token: 'tok' } },
    };
    fs.mkdirSync(path.join(tmpDir), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(existing));
    const config = loadConfig();
    expect(config.activeProject).toBe('my-proj');
    expect(config.projects['my-proj'].token).toBe('tok');
  });
});

describe('addProject', () => {
  it('adds a project and sets it as active', () => {
    addProject('demo', 'tok123');
    const config = loadConfig();
    expect(config.activeProject).toBe('demo');
    expect(config.projects['demo']).toEqual({ name: 'demo', token: 'tok123' });
  });

  it('overwrites an existing project with the same name', () => {
    addProject('demo', 'old-tok');
    addProject('demo', 'new-tok');
    const config = loadConfig();
    expect(config.projects['demo'].token).toBe('new-tok');
  });
});

describe('removeProject', () => {
  it('removes a project', () => {
    addProject('demo', 'tok');
    removeProject('demo');
    const config = loadConfig();
    expect(config.projects['demo']).toBeUndefined();
  });

  it('clears activeProject if the removed project was active', () => {
    addProject('demo', 'tok');
    removeProject('demo');
    const config = loadConfig();
    expect(config.activeProject).toBeNull();
  });

  it('throws if the project does not exist', () => {
    expect(() => removeProject('ghost')).toThrow('not found');
  });
});

describe('switchProject', () => {
  it('switches the active project', () => {
    addProject('a', 'tok-a');
    addProject('b', 'tok-b');
    switchProject('a');
    const config = loadConfig();
    expect(config.activeProject).toBe('a');
  });

  it('throws if the project does not exist', () => {
    expect(() => switchProject('ghost')).toThrow('not found');
  });
});

describe('getActiveProject', () => {
  it('returns the active project config', () => {
    addProject('demo', 'tok');
    const proj = getActiveProject();
    expect(proj).toEqual({ name: 'demo', token: 'tok' });
  });

  it('throws if no active project', () => {
    expect(() => getActiveProject()).toThrow('No active project');
  });
});

describe('listProjects', () => {
  it('returns all projects with active flag', () => {
    addProject('a', 'tok-a');
    addProject('b', 'tok-b');
    const list = listProjects();
    expect(list).toEqual([
      { name: 'a', active: false, download: false },
      { name: 'b', active: true, download: false },
    ]);
  });
});

// B-1501: project identity by id, the non-activating save, and the download pin.
describe('saveProject', () => {
  it('stores projectId and does not activate over an existing active project', () => {
    addProject('active-one', 'tok-a');
    const r = saveProject({ name: 'invented', token: 'tok-i', projectId: 'proj-i', activate: false });
    expect(r).toEqual({ key: 'invented', collidedWith: undefined, activated: false });
    const c = loadConfig();
    expect(c.activeProject).toBe('active-one');
    expect(c.projects.invented).toEqual({ name: 'invented', token: 'tok-i', projectId: 'proj-i' });
  });

  it('fix 6: a non-activating save NEVER sets activeProject, even into an empty store', () => {
    expect(saveProject({ name: 'invented', token: 't', projectId: 'p', activate: false }).activated).toBe(false);
    expect(loadConfig().activeProject).toBeNull();
  });

  it('fix 6: a non-activating save never repairs a dangling active project either', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ activeProject: 'gone', projects: {} }));
    expect(saveProject({ name: 'invented', token: 't', projectId: 'p', activate: false }).activated).toBe(false);
    expect(loadConfig().activeProject).toBe('gone');
  });

  it('never overwrites a different project under the same name: a distinct key, and says which', () => {
    saveProject({ name: 'invented', token: 'tok-1', projectId: 'aaaaaaaa-1111', activate: true });
    const r = saveProject({ name: 'invented', token: 'tok-2', projectId: 'bbbbbbbb-2222', activate: false });
    expect(r.collidedWith).toBe('invented');
    expect(r.key).toBe('invented-bbbbbbbb');
    const c = loadConfig();
    expect(c.projects.invented.token).toBe('tok-1');
    expect(c.projects['invented-bbbbbbbb'].token).toBe('tok-2');
  });

  it('the same project saved again updates its own entry, wherever it is stored', () => {
    saveProject({ name: 'invented', token: 'tok-1', projectId: 'aaaaaaaa', activate: true });
    saveProject({ name: 'other', token: 'tok-x', projectId: 'bbbbbbbb', activate: false });
    const r = saveProject({ name: 'invented', token: 'tok-rotated', projectId: 'aaaaaaaa', activate: false });
    expect(r).toEqual({ key: 'invented', collidedWith: undefined, activated: false });
    expect(loadConfig().projects.invented.token).toBe('tok-rotated');
  });

  it('an entry saved before B-1501 (no projectId) with a different token and no checked backend is not overwritten', () => {
    addProject('invented', 'legacy-token');
    const r = saveProject({ name: 'invented', token: 'new-token', projectId: 'cccccccc', activate: false });
    expect(r.key).toBe('invented-cccccccc');
    expect(loadConfig().projects.invented.token).toBe('legacy-token');
  });

  it('an entry saved before B-1501 with the same token is the same project, upgraded in place', () => {
    addProject('invented', 'same-token');
    expect(saveProject({ name: 'invented', token: 'same-token', projectId: 'cccccccc', activate: false }).key).toBe('invented');
    expect(loadConfig().projects.invented.projectId).toBe('cccccccc');
  });

  // Fix 4: rotating the token of a project saved before B-1501.
  describe('fix 4 — a stored entry with no projectId', () => {
    const DEFAULT = 'https://eioxsunvhakmelhanmnn.supabase.co';
    beforeEach(() => {
      for (const v of ['HARMONY_SUPABASE_URL', 'HARMONY_SUPABASE_ANON_KEY', 'HARMONY_SUPABASE_PUBLISHABLE_KEY']) {
        vi.stubEnv(v, '');
        vi.stubEnv(`EVAL_${v}`, '');
      }
    });

    it('same key, same backend, new token: the SAME project, updated in place and stamped with the id', () => {
      addProject('invented', 'legacy-token');
      const r = saveProject({ name: 'invented', token: 'rotated-token', projectId: 'cccccccc', verifiedUrl: DEFAULT, activate: false });
      expect(r).toEqual({ key: 'invented', collidedWith: undefined, activated: false });
      const c = loadConfig();
      expect(Object.keys(c.projects)).toEqual(['invented']);
      expect(c.projects.invented).toMatchObject({ token: 'rotated-token', projectId: 'cccccccc', verifiedUrl: DEFAULT });
    });

    it('same key, its stored pair names the backend the token was checked against: the same project, pair kept', () => {
      addProject('invented', 'legacy-token', { supabaseUrl: 'https://scratch.example.supabase.co', supabaseAnonKey: 'scratch-key' });
      const r = saveProject({ name: 'invented', token: 'rotated', projectId: 'dddddddd', verifiedUrl: 'https://scratch.example.supabase.co/', activate: false });
      expect(r.key).toBe('invented');
      expect(r.collidedWith).toBeUndefined();
      expect(loadConfig().projects.invented).toMatchObject({
        token: 'rotated', projectId: 'dddddddd', supabaseUrl: 'https://scratch.example.supabase.co', supabaseAnonKey: 'scratch-key',
      });
    });

    it('same key, a DIFFERENT backend: still a collision, the old entry untouched', () => {
      addProject('invented', 'legacy-token', { supabaseUrl: 'https://scratch.example.supabase.co', supabaseAnonKey: 'scratch-key' });
      const r = saveProject({ name: 'invented', token: 'other', projectId: 'eeeeeeee', verifiedUrl: DEFAULT, activate: false });
      expect(r.collidedWith).toBe('invented');
      expect(r.key).toBe('invented-eeeeeeee');
      expect(loadConfig().projects.invented.token).toBe('legacy-token');
    });

    it('a known, different id is a collision even on the same backend', () => {
      saveProject({ name: 'invented', token: 'tok-1', projectId: 'aaaaaaaa', verifiedUrl: DEFAULT, activate: false });
      const r = saveProject({ name: 'invented', token: 'tok-2', projectId: 'bbbbbbbb', verifiedUrl: DEFAULT, activate: false });
      expect(r.collidedWith).toBe('invented');
    });

    it('re-saving with no flags keeps the stored Supabase pair', () => {
      saveProject({
        name: 'invented', token: 'tok-1', projectId: 'aaaaaaaa', verifiedUrl: 'https://scratch.example.supabase.co',
        supabaseUrl: 'https://scratch.example.supabase.co', supabasePublishableKey: 'sb_publishable_x', activate: false,
      });
      saveProject({ name: 'invented', token: 'tok-2', projectId: 'aaaaaaaa', verifiedUrl: 'https://scratch.example.supabase.co', activate: false });
      expect(loadConfig().projects.invented).toEqual({
        name: 'invented', token: 'tok-2', projectId: 'aaaaaaaa', verifiedUrl: 'https://scratch.example.supabase.co',
        supabaseUrl: 'https://scratch.example.supabase.co', supabasePublishableKey: 'sb_publishable_x',
      });
    });
  });

  it('fix 5: saveConfig writes atomically (temp file in the same dir, renamed), mode 600, no temp left behind', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    saveConfig({ activeProject: null, projects: {} });
    const file = path.join(tmpDir, 'config.json');
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [from, to] = renameSpy.mock.calls[0] as [string, string];
    expect(path.dirname(String(from))).toBe(tmpDir);
    expect(String(to)).toBe(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(tmpDir)).toEqual(['config.json']);
    renameSpy.mockRestore();
  });

  it('reads a config with no projects key tolerantly', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ activeProject: null }));
    expect(loadConfig()).toEqual({ activeProject: null, projects: {} });
  });
});
