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
  setDownloadProject,
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

  it('a non-activating save into an empty store activates (nothing else is active)', () => {
    expect(saveProject({ name: 'invented', token: 't', projectId: 'p', activate: false }).activated).toBe(true);
    expect(loadConfig().activeProject).toBe('invented');
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

  it('an entry saved before B-1501 (no projectId) with a different token is not overwritten', () => {
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

  it('reads a config with no projects key tolerantly', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ activeProject: null }));
    expect(loadConfig()).toEqual({ activeProject: null, projects: {} });
  });
});

describe('setDownloadProject', () => {
  it('pins a stored project and never changes activeProject', () => {
    addProject('a', 'tok-a');
    saveProject({ name: 'b', token: 'tok-b', projectId: 'pb', activate: false });
    setDownloadProject('b');
    const c = loadConfig();
    expect(c.downloadProject).toBe('b');
    expect(c.activeProject).toBe('a');
    expect(listProjects()).toEqual([
      { name: 'a', active: true, download: false },
      { name: 'b', active: false, download: true },
    ]);
  });

  it('refuses a name that is not stored', () => {
    expect(() => setDownloadProject('nope')).toThrow('Project "nope" not found');
  });
});
