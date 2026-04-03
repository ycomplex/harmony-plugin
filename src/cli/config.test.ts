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
      { name: 'a', active: false },
      { name: 'b', active: true },
    ]);
  });
});
