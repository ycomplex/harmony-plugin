// B-1479: `harmony download switch` — the core, driven with a temporary HOME / CLAUDE_CONFIG_DIR /
// HARMONY_CONFIG_DIR, a stub `claude` and a stub token login. No test reads a real home or runs a real claude.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_SUFFIX,
  INSTALL_ID,
  PROJECT_DISABLE_HINT,
  START_ARGS,
  TODAYS_ID,
  helperScript,
  runDownloadSwitch,
  type ClaudeResult,
  type FsOps,
  type SwitchDeps,
} from './download-switch.js';
import { spawnClaude } from '../cli/commands/download.js';

const URL_ = 'https://plugin.harmony.ad/prod/marketplace.json';

interface Harness {
  root: string;
  home: string;
  claudeDir: string;
  harmonyDir: string;
  cwd: string;
  tmp: string;
  settings: string;
  helper: string;
  record: string;
  store: string;
  calls: Array<{ args: string[]; cwd?: string; cwdEntriesAtCall?: string[] }>;
  out: string[];
  err: string[];
  asked: string[];
  saved: string[];
  known: boolean;
  /** what the stub claude returns for a call, by its joined args; default success. */
  responses: Map<string, ClaudeResult>;
  /** whether the headless start makes the marketplace known. */
  startFetches: boolean;
  deps: SwitchDeps;
}

let h: Harness;

function makeHarness(over: Partial<SwitchDeps> = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b1479-switch-'));
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  const harmonyDir = path.join(home, '.harmony');
  const cwd = path.join(root, 'project');
  const tmp = path.join(root, 'tmp');
  for (const d of [home, cwd, tmp]) fs.mkdirSync(d, { recursive: true });
  const hh: Harness = {
    root, home, claudeDir, harmonyDir, cwd, tmp,
    settings: path.join(claudeDir, 'settings.json'),
    helper: path.join(harmonyDir, 'download-headers.sh'),
    record: path.join(harmonyDir, 'download-switch.json'),
    store: path.join(harmonyDir, 'config.json'),
    calls: [], out: [], err: [], asked: [], saved: [],
    known: false, responses: new Map(), startFetches: true,
    deps: undefined as unknown as SwitchDeps,
  };
  hh.deps = {
    env: {},
    homedir: home,
    cwd,
    tmpdir: tmp,
    isTTY: false,
    out: (l) => hh.out.push(l),
    err: (l) => hh.err.push(l),
    ask: async (q) => {
      hh.asked.push(q);
      return 'y';
    },
    runClaude: async (args, opts) => {
      hh.calls.push({ args, cwd: opts?.cwd, cwdEntriesAtCall: opts?.cwd ? fs.readdirSync(opts.cwd) : undefined });
      const key = args.join(' ');
      const r = hh.responses.get(key);
      if (r) return r;
      if (key === 'plugin marketplace list --json') {
        return { code: 0, stdout: JSON.stringify(hh.known ? [{ name: 'harmony', source: 'url' }] : []), stderr: '' };
      }
      if (key === START_ARGS.join(' ') && hh.startFetches) hh.known = true;
      return { code: 0, stdout: '', stderr: '' };
    },
    saveToken: async (t) => {
      hh.saved.push(t);
      // like the real non-activating save: the entry lands in the store, the active project is untouched.
      fs.mkdirSync(hh.harmonyDir, { recursive: true });
      const c = fs.existsSync(hh.store) ? JSON.parse(fs.readFileSync(hh.store, 'utf-8')) : { activeProject: null, projects: {} };
      c.projects['invented-project'] = { name: 'invented-project', token: t, projectId: 'proj-invented' };
      fs.writeFileSync(hh.store, JSON.stringify(c));
      return { key: 'invented-project' };
    },
    fetch: async () => ({ status: 200 }),
    now: () => new Date('2026-11-20T10:00:00Z'),
    pid: 4242,
    ...over,
  };
  return hh;
}

function writeStore(token: string | null) {
  fs.mkdirSync(h.harmonyDir, { recursive: true });
  const cfg = token
    ? { activeProject: 'invented', projects: { invented: { name: 'invented', token } } }
    : { activeProject: null, projects: {} };
  fs.writeFileSync(h.store, JSON.stringify(cfg));
}

function writeSettings(obj: unknown | string, mode = 0o644) {
  fs.mkdirSync(h.claudeDir, { recursive: true });
  fs.writeFileSync(h.settings, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  fs.chmodSync(h.settings, mode);
}

function readSettings() {
  return JSON.parse(fs.readFileSync(h.settings, 'utf-8'));
}

function args() {
  return h.calls.map((c) => c.args.join(' '));
}

function runHelper(env: NodeJS.ProcessEnv) {
  const clean: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  return spawnSync('sh', [h.helper], { env: { ...clean, ...env }, encoding: 'utf-8' });
}

beforeEach(() => {
  h = makeHarness();
  // B-1501: the switch pins a stored project, so the default machine has one active project stored.
  writeStore('fixture-token');
});

afterEach(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe('token lookup', () => {
  it('B-1501: HARMONY_API_TOKEN alone (nothing stored) cannot be pinned: with no person, exits 2 naming `harmony download token set`, changes nothing', async () => {
    h.deps.env = { HARMONY_API_TOKEN: 'fixture-token' };
    fs.writeFileSync(h.store, '{ not json');
    expect(await runDownloadSwitch({}, h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('harmony download token set');
    expect(h.err.join('\n')).not.toContain('fixture-token');
    expect(fs.existsSync(h.helper)).toBe(false);
    expect(fs.existsSync(h.settings)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('B-1501: HARMONY_API_TOKEN alone with a person: offers to save it, and pins the saved project on yes', async () => {
    h.deps.env = { HARMONY_API_TOKEN: 'env-only-token' };
    h.deps.isTTY = true;
    writeStore(null);
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('Save HARMONY_API_TOKEN to the harmony store');
    expect(h.saved).toEqual(['env-only-token']);
    const c = JSON.parse(fs.readFileSync(h.store, 'utf-8'));
    expect(c.downloadProject).toBe('invented-project');
    expect(c.activeProject).toBeNull();
    expect(h.out.join('\n') + h.err.join('\n')).not.toContain('env-only-token');
  });

  it('pins the active project when nothing is pinned, leaving activeProject alone; mode 600', async () => {
    writeStore('store-token');
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    const c = JSON.parse(fs.readFileSync(h.store, 'utf-8'));
    expect(c.downloadProject).toBe('invented');
    expect(c.activeProject).toBe('invented');
    expect(fs.statSync(h.store).mode & 0o777).toBe(0o600);
    expect(h.out.join('\n')).toContain('Pinned the download to project "invented"');
  });

  it('keeps an existing usable pin, even when HARMONY_API_TOKEN is set and another project is active', async () => {
    fs.writeFileSync(h.store, JSON.stringify({ activeProject: 'a', downloadProject: 'b', projects: { a: { name: 'a', token: 'ta' }, b: { name: 'b', token: 'tb' } } }));
    h.deps.env = { HARMONY_API_TOKEN: 'env-token' };
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(JSON.parse(fs.readFileSync(h.store, 'utf-8')).downloadProject).toBe('b');
    expect(h.out.join('\n')).toContain('The download stays pinned to project "b"');
  });

  it('no active project but stored projects: asks which on a terminal, and pins the one chosen', async () => {
    fs.writeFileSync(h.store, JSON.stringify({ activeProject: null, projects: { a: { name: 'a', token: 'ta' }, b: { name: 'b', token: 'tb' } } }));
    h.deps.isTTY = true;
    h.deps.ask = async (q) => {
      h.asked.push(q);
      return '2';
    };
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(h.asked[0]).toContain('1. a');
    expect(h.asked[0]).toContain('2. b');
    const c = JSON.parse(fs.readFileSync(h.store, 'utf-8'));
    expect(c.downloadProject).toBe('b');
    expect(c.activeProject).toBeNull();
  });

  it('no active project but stored projects, no person: exits 2 naming `harmony download token use`', async () => {
    fs.writeFileSync(h.store, JSON.stringify({ activeProject: null, projects: { a: { name: 'a', token: 'ta' } } }));
    expect(await runDownloadSwitch({}, h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('harmony download token use <project>');
    expect(fs.existsSync(h.helper)).toBe(false);
  });

  it('with no token anywhere, exits 2 with instructions and changes nothing', async () => {
    h.deps.env = {};
    writeStore(null);
    expect(await runDownloadSwitch({}, h.deps)).toBe(2);
    const msg = h.err.join('\n');
    // B-1501 fix 3: never steer the token onto a command line.
    expect(msg).toContain('harmony download token set');
    expect(msg).not.toContain('--token <');
    expect(msg).toContain('HARMONY_API_TOKEN in your shell profile');
    expect(fs.existsSync(h.helper)).toBe(false);
    expect(fs.existsSync(h.settings)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("a project file token with no person present: exits 2, never asks, never reads or saves it", async () => {
    h.deps.env = {};
    writeStore(null);
    fs.mkdirSync(path.join(h.cwd, '.claude'), { recursive: true });
    const local = path.join(h.cwd, '.claude', 'settings.local.json');
    fs.writeFileSync(local, JSON.stringify({ env: { HARMONY_API_TOKEN: 'project-file-token' } }));
    const spyFs = spiedFs();
    h.deps.fs = spyFs.fs;
    expect(await runDownloadSwitch({}, h.deps)).toBe(2);
    expect(h.asked).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(spyFs.reads).not.toContain(local);
    expect(h.err.join('\n')).toContain('only offered when a person runs this in a terminal');
    expect(h.calls).toEqual([]);
  });

  it('a project file token with a person present: asks once, and saves it in-process on yes', async () => {
    h.deps.env = {};
    h.deps.isTTY = true;
    writeStore(null);
    fs.mkdirSync(path.join(h.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(h.cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { HARMONY_API_TOKEN: 'project-file-token' } }));
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('Save this token to the harmony store (~/.harmony/config.json) so the download can use it? [y/N]');
    expect(h.saved).toEqual(['project-file-token']);
    expect(JSON.parse(fs.readFileSync(h.store, 'utf-8')).downloadProject).toBe('invented-project');
    expect(h.out.join('\n')).not.toContain('project-file-token');
    expect(h.err.join('\n')).not.toContain('project-file-token');
  });

  it('a project file token with a person who says no: exits 2, nothing saved', async () => {
    h.deps.env = {};
    h.deps.isTTY = true;
    writeStore(null);
    h.deps.ask = async (q) => {
      h.asked.push(q);
      return '';
    };
    fs.mkdirSync(path.join(h.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(h.cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { HARMONY_API_TOKEN: 'project-file-token' } }));
    expect(await runDownloadSwitch({}, h.deps)).toBe(2);
    expect(h.saved).toEqual([]);
    expect(fs.existsSync(h.helper)).toBe(false);
  });

  it('a token that fails verification: exits 1, and the message never carries the token', async () => {
    h.deps.env = {};
    h.deps.isTTY = true;
    writeStore(null);
    h.deps.saveToken = async (t) => {
      throw new Error(`Token exchange failed (401) for ${t}`);
    };
    fs.mkdirSync(path.join(h.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(h.cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { HARMONY_API_TOKEN: 'project-file-token' } }));
    expect(await runDownloadSwitch({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('could not be verified');
    expect(h.err.join('\n')).not.toContain('project-file-token');
  });
});

/** An fs that records every path read, to prove what was not read. */
function spiedFs(): { fs: FsOps; reads: string[] } {
  const reads: string[] = [];
  const wrapped = {
    ...fs,
    readFileSync: ((p: any, o?: any) => {
      reads.push(String(p));
      return fs.readFileSync(p, o);
    }) as typeof fs.readFileSync,
  } as unknown as FsOps;
  return { fs: wrapped, reads };
}

describe('--dry-run', () => {
  it('writes nothing, runs no claude, and never reads the project token', async () => {
    h.deps.env = {};
    h.deps.isTTY = true;
    writeStore(null);
    fs.mkdirSync(path.join(h.cwd, '.claude'), { recursive: true });
    const local = path.join(h.cwd, '.claude', 'settings.local.json');
    fs.writeFileSync(local, JSON.stringify({ env: { HARMONY_API_TOKEN: 'project-file-token' } }));
    writeSettings({ theme: 'dark' });
    const before = fs.readFileSync(h.settings, 'utf-8');
    const spy = spiedFs();
    h.deps.fs = spy.fs;
    expect(await runDownloadSwitch({ dryRun: true }, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(spy.reads).not.toContain(local);
    expect(fs.existsSync(h.helper)).toBe(false);
    expect(fs.existsSync(h.settings + BACKUP_SUFFIX)).toBe(false);
    expect(fs.readFileSync(h.settings, 'utf-8')).toBe(before);
    const plan = h.out.join('\n');
    expect(plan).toContain(h.helper);
    expect(plan).toContain(`claude plugin install ${INSTALL_ID}`);
    expect(plan).toContain(`claude plugin disable ${TODAYS_ID} --scope user`);
    expect(plan).toContain(URL_);
  });

  it('with a token, prints the plan (including the pin) and exits 0, changing nothing', async () => {
    const store = fs.readFileSync(h.store, 'utf-8');
    expect(await runDownloadSwitch({ dryRun: true }, h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(fs.readdirSync(h.harmonyDir)).toEqual(['config.json']);
    expect(fs.readFileSync(h.store, 'utf-8')).toBe(store);
    expect(fs.existsSync(h.claudeDir)).toBe(false);
    expect(h.out.join('\n')).toContain('would pin the download to the active project "invented"');
  });

  it('an env token alone with no person: the dry run says a real run would stop, exit 2', async () => {
    writeStore(null);
    h.deps.env = { HARMONY_API_TOKEN: 'x' };
    expect(await runDownloadSwitch({ dryRun: true }, h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('harmony download token set');
  });
});

describe('settings', () => {
  it('merges the harmony entry and keeps every other key', async () => {
    writeSettings({ theme: 'dark', enabledPlugins: { [TODAYS_ID]: true }, extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'invented/market' } } } }, 0o640);
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    const s = readSettings();
    expect(s.theme).toBe('dark');
    expect(s.enabledPlugins).toEqual({ [TODAYS_ID]: true });
    expect(s.extraKnownMarketplaces.other).toEqual({ source: { source: 'github', repo: 'invented/market' } });
    expect(s.extraKnownMarketplaces.harmony).toEqual({ source: { source: 'url', url: URL_, headersHelper: h.helper }, autoUpdate: true });
    expect(path.isAbsolute(s.extraKnownMarketplaces.harmony.source.headersHelper)).toBe(true);
    expect(fs.statSync(h.settings).mode & 0o777).toBe(0o640);
  });

  it('creates the settings file when there is none (and no backup)', async () => {
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(readSettings().extraKnownMarketplaces.harmony.source.url).toBe(URL_);
    expect(fs.existsSync(h.settings + BACKUP_SUFFIX)).toBe(false);
  });

  it('refuses invalid JSON and leaves it untouched', async () => {
    writeSettings('{ "theme": "dark", ');
    expect(await runDownloadSwitch({}, h.deps)).toBe(1);
    expect(fs.readFileSync(h.settings, 'utf-8')).toBe('{ "theme": "dark", ');
    expect(h.err.join('\n')).toContain('is not valid JSON');
    expect(fs.existsSync(h.settings + BACKUP_SUFFIX)).toBe(false);
    expect(fs.existsSync(h.helper)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('refuses a differing harmony entry and points at --undo', async () => {
    const other = { extraKnownMarketplaces: { harmony: { source: { source: 'url', url: 'https://elsewhere.invalid/prod/marketplace.json', headersHelper: '/x' }, autoUpdate: true } } };
    writeSettings(other);
    const before = fs.readFileSync(h.settings, 'utf-8');
    expect(await runDownloadSwitch({}, h.deps)).toBe(1);
    expect(fs.readFileSync(h.settings, 'utf-8')).toBe(before);
    expect(h.err.join('\n')).toContain('harmony download switch --undo');
    expect(h.calls).toEqual([]);
  });

  it('saves a backup beside it with the original content, never overwritten by a re-run', async () => {
    writeSettings({ theme: 'dark' });
    const original = fs.readFileSync(h.settings, 'utf-8');
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    const backup = h.settings + BACKUP_SUFFIX;
    expect(path.dirname(backup)).toBe(h.claudeDir);
    expect(fs.readFileSync(backup, 'utf-8')).toBe(original);
    // the person removes the entry by hand and changes something; a re-run must keep the first backup.
    writeSettings({ theme: 'light' });
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(fs.readFileSync(backup, 'utf-8')).toBe(original);
  });

  it('writes atomically: a temp file in the same directory, fsync, rename; nothing left behind', async () => {
    writeSettings({ theme: 'dark' });
    const ops: string[] = [];
    const wrapped = {
      ...fs,
      openSync: ((p: any, ...rest: any[]) => {
        ops.push(`open ${p}`);
        return (fs.openSync as any)(p, ...rest);
      }) as typeof fs.openSync,
      fsyncSync: ((fd: number) => {
        ops.push('fsync');
        return fs.fsyncSync(fd);
      }) as typeof fs.fsyncSync,
      renameSync: ((a: any, b: any) => {
        ops.push(`rename ${a} -> ${b}`);
        return fs.renameSync(a, b);
      }) as typeof fs.renameSync,
    } as unknown as FsOps;
    h.deps.fs = wrapped;
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    const tmp = `${h.settings}.tmp-4242`;
    const storeTmp = `${h.store}.tmp-4242`;
    // the pin is written the same way, first.
    expect(ops).toEqual([`open ${storeTmp}`, 'fsync', `rename ${storeTmp} -> ${h.store}`, `open ${tmp}`, 'fsync', `rename ${tmp} -> ${h.settings}`]);
    expect(fs.readdirSync(h.harmonyDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(fs.readdirSync(h.claudeDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('a failed write leaves the original in place and no temp file', async () => {
    writeSettings({ theme: 'dark' });
    const original = fs.readFileSync(h.settings, 'utf-8');
    h.deps.fs = {
      ...fs,
      fsyncSync: (() => {
        throw new Error('disk full');
      }) as typeof fs.fsyncSync,
    } as unknown as FsOps;
    await expect(runDownloadSwitch({}, h.deps)).rejects.toThrow('disk full');
    expect(fs.readFileSync(h.settings, 'utf-8')).toBe(original);
    expect(fs.readdirSync(h.claudeDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('an identical re-run changes neither the settings nor the helper', async () => {
    writeSettings({ theme: 'dark', extraKnownMarketplaces: {} });
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    // Claude Code adds its own keys later; the entry itself is unchanged.
    const s = readSettings();
    s.enabledPlugins = { [INSTALL_ID]: true };
    fs.writeFileSync(h.settings, JSON.stringify(s));
    const settingsBefore = fs.readFileSync(h.settings, 'utf-8');
    const settingsMtime = fs.statSync(h.settings).mtimeMs;
    const helperMtime = fs.statSync(h.helper).mtimeMs;
    const ops: string[] = [];
    h.deps.fs = {
      ...fs,
      renameSync: ((a: any, b: any) => {
        ops.push('rename');
        return fs.renameSync(a, b);
      }) as typeof fs.renameSync,
      writeFileSync: ((p: any, ...rest: any[]) => {
        ops.push(`write ${p}`);
        return (fs.writeFileSync as any)(p, ...rest);
      }) as typeof fs.writeFileSync,
    } as unknown as FsOps;
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(fs.readFileSync(h.settings, 'utf-8')).toBe(settingsBefore);
    expect(fs.statSync(h.settings).mtimeMs).toBe(settingsMtime);
    expect(fs.statSync(h.helper).mtimeMs).toBe(helperMtime);
    expect(ops).toEqual([`write ${h.record}`]);
  });
});

describe('the helper', () => {
  beforeEach(async () => {
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
  });

  it('is mode 700 in a mode-700 directory, and holds no token', () => {
    expect(fs.statSync(h.helper).mode & 0o777).toBe(0o700);
    expect(fs.statSync(h.harmonyDir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(h.helper, 'utf-8')).not.toContain('fixture-token');
    expect(fs.readFileSync(h.helper, 'utf-8')).toBe(helperScript());
  });

  it('B-1501 pinned: prints the pinned project\'s token and consults nothing else (not HARMONY_API_TOKEN, not the active project)', () => {
    fs.writeFileSync(h.store, JSON.stringify({ activeProject: 'a', downloadProject: 'b', projects: { a: { name: 'a', token: 'active-fixture' }, b: { name: 'b', token: 'pinned-fixture' } } }));
    const r = runHelper({ HARMONY_API_TOKEN: 'env-fixture-token' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{"Authorization":"Bearer pinned-fixture"}');
    expect(r.stderr).toBe('');
  });

  it('B-1501 pinned to a project with no token: fails naming the fix, never falling back', () => {
    fs.writeFileSync(h.store, JSON.stringify({ activeProject: 'a', downloadProject: 'gone', projects: { a: { name: 'a', token: 'active-fixture' } } }));
    const r = runHelper({ HARMONY_API_TOKEN: 'env-fixture-token' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('pinned to project "gone"');
    expect(r.stderr).toContain('harmony download token use <project>');
    expect(r.stderr).toContain('harmony download token set');
    expect(r.stderr).not.toContain('fixture');
  });

  it('unpinned (a machine switched before B-1501): the env token first', () => {
    writeStore('store-fixture-token');
    const r = runHelper({ HARMONY_API_TOKEN: 'env-fixture-token' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{"Authorization":"Bearer env-fixture-token"}');
    expect(r.stderr).toBe('');
  });

  it('unpinned: then the active project in the store beside it', () => {
    writeStore('store-fixture-token');
    const r = runHelper({});
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer store-fixture-token' });
    expect(r.stderr).toBe('');
  });

  it('with no token, exits 1 with a stderr message naming the fix and prints no header', () => {
    writeStore(null);
    const r = runHelper({});
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe('harmony: no Harmony token found. Run `harmony download token use <project>` or `harmony download token set`.');
  });

  it('escapes a token with a quote or backslash into valid JSON', () => {
    fs.writeFileSync(h.store, JSON.stringify({ activeProject: null, downloadProject: 'b', projects: { b: { name: 'b', token: 'a"b\\c' } } }));
    expect(JSON.parse(runHelper({}).stdout)).toEqual({ Authorization: 'Bearer a"b\\c' });
  });

  it('without node on PATH: a pinned machine is told node is missing and how to retry', () => {
    const bin = path.join(h.root, 'bin-no-node');
    fs.mkdirSync(bin);
    for (const tool of ['dirname', 'grep', 'tr', 'sed', 'printf']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
      if (found.startsWith('/')) fs.symlinkSync(found, path.join(bin, tool));
    }
    const r = spawnSync('/bin/sh', [h.helper], { env: { PATH: bin, HARMONY_API_TOKEN: 'env-fixture-token' }, encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('node is not on the PATH');
    expect(r.stderr).toContain('claude plugin marketplace update harmony');
    // unpinned and no node: the env token still serves, as before.
    writeStore('store-fixture-token');
    const u = spawnSync('/bin/sh', [h.helper], { env: { PATH: bin, HARMONY_API_TOKEN: 'env-fixture-token' }, encoding: 'utf-8' });
    expect(u.stdout).toBe('{"Authorization":"Bearer env-fixture-token"}');
  });

  it('writes no file of its own', () => {
    writeStore('store-fixture-token');
    const before = fs.readdirSync(h.harmonyDir).sort();
    runHelper({});
    runHelper({ HARMONY_API_TOKEN: 'env-fixture-token' });
    expect(fs.readdirSync(h.harmonyDir).sort()).toEqual(before);
  });
});

describe('claude commands', () => {
  it('runs the headless start from an empty temporary directory, removed afterwards, then installs and disables', async () => {
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(args()).toEqual([
      'plugin marketplace list --json',
      START_ARGS.join(' '),
      'plugin marketplace list --json',
      `plugin install ${INSTALL_ID}`,
      `plugin disable ${TODAYS_ID} --scope user`,
    ]);
    const start = h.calls[1];
    expect(start.cwd).toBeDefined();
    expect(path.dirname(start.cwd!)).toBe(h.tmp);
    expect(start.cwdEntriesAtCall).toEqual([]);
    expect(fs.existsSync(start.cwd!)).toBe(false);
    expect(h.calls.filter((c) => c !== start).every((c) => c.cwd === undefined)).toBe(true);
  });

  it('START_ARGS is the no-prompt form: print mode, stream-json input, no prompt argument', () => {
    expect(START_ARGS).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  });

  it('skips the start when the marketplace is already known', async () => {
    h.known = true;
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(args()).not.toContain(START_ARGS.join(' '));
  });

  it('when the start does not fetch the marketplace, falls back to asking for one session start (exit 2), then a re-run continues', async () => {
    h.startFetches = false;
    expect(await runDownloadSwitch({}, h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('Start Claude Code once (open it, wait for the prompt, then /exit), then run `harmony download switch` again');
    expect(fs.existsSync(h.helper)).toBe(true);
    expect(readSettings().extraKnownMarketplaces.harmony).toBeDefined();
    expect(args()).not.toContain(`plugin install ${INSTALL_ID}`);
    // the person starts Claude Code once; the marketplace is now known.
    h.known = true;
    h.calls.length = 0;
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(args()).toEqual(['plugin marketplace list --json', `plugin install ${INSTALL_ID}`, `plugin disable ${TODAYS_ID} --scope user`]);
  });

  it('reads the text marketplace list when --json is not understood', async () => {
    h.known = true;
    h.responses.set('plugin marketplace list --json', { code: 1, stdout: '', stderr: "error: unknown option '--json'" });
    h.responses.set('plugin marketplace list', { code: 0, stdout: 'Configured marketplaces:\n\n  ❯ harmony\n    Source: URL (x)\n', stderr: '' });
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(args()).not.toContain(START_ARGS.join(' '));
  });

  it('a failing install exits 1 naming the command', async () => {
    h.known = true;
    h.responses.set(`plugin install ${INSTALL_ID}`, { code: 1, stdout: '✘ Failed to install plugin: HTTP 401', stderr: '' });
    expect(await runDownloadSwitch({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain(`\`claude plugin install ${INSTALL_ID}\` failed (exit 1)`);
    expect(fs.existsSync(h.record)).toBe(false);
  });

  it("tolerates today's copy being already disabled or not installed", async () => {
    h.known = true;
    h.responses.set(`plugin disable ${TODAYS_ID} --scope user`, {
      code: 1,
      stdout: '',
      stderr: `✘ Failed to disable plugin "${TODAYS_ID}": Plugin "${TODAYS_ID}" is already disabled at user scope`,
    });
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(JSON.parse(fs.readFileSync(h.record, 'utf-8')).disabled_ycomplex_user_scope).toBe(false);
  });

  it('a failing disable for another reason exits 1 naming the command', async () => {
    h.known = true;
    h.responses.set(`plugin disable ${TODAYS_ID} --scope user`, { code: 1, stdout: '', stderr: 'permission denied' });
    expect(await runDownloadSwitch({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain(`\`claude plugin disable ${TODAYS_ID} --scope user\` failed`);
  });

  it('records what it did, with no token, and prints the summary', async () => {
    writeSettings({ theme: 'dark' });
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    const raw = fs.readFileSync(h.record, 'utf-8');
    expect(raw).not.toContain('fixture-token');
    expect(JSON.parse(raw)).toEqual({
      base: 'https://plugin.harmony.ad',
      marketplace_url: URL_,
      helper_path: h.helper,
      settings_path: h.settings,
      backup_path: h.settings + BACKUP_SUFFIX,
      disabled_ycomplex_user_scope: true,
      download_project: 'invented',
      via: 'switch',
      switched_at: '2026-11-20T10:00:00.000Z',
    });
    const out = h.out.join('\n');
    expect(out).toContain('claude plugin list');
    expect(out).toContain('harmony --version');
    expect(out).toContain(h.settings + BACKUP_SUFFIX);
    expect(out + h.err.join('\n')).not.toContain('fixture-token');
  });

  it('--base sets the marketplace address; a non-https base is refused', async () => {
    expect(await runDownloadSwitch({ base: 'https://download.invented.example/' }, h.deps)).toBe(0);
    expect(readSettings().extraKnownMarketplaces.harmony.source.url).toBe('https://download.invented.example/prod/marketplace.json');
    expect(await runDownloadSwitch({ base: 'http://download.invented.example' }, h.deps)).toBe(1);
  });

  it('honours CLAUDE_CONFIG_DIR and HARMONY_CONFIG_DIR', async () => {
    const cdir = path.join(h.root, 'cc');
    const hdir = path.join(h.root, 'hh');
    h.deps.env = { CLAUDE_CONFIG_DIR: cdir, HARMONY_CONFIG_DIR: hdir };
    fs.mkdirSync(hdir, { recursive: true });
    fs.writeFileSync(path.join(hdir, 'config.json'), JSON.stringify({ activeProject: 'p', projects: { p: { name: 'p', token: 'tp' } } }));
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(hdir, 'config.json'), 'utf-8')).downloadProject).toBe('p');
    const s = JSON.parse(fs.readFileSync(path.join(cdir, 'settings.json'), 'utf-8'));
    expect(s.extraKnownMarketplaces.harmony.source.headersHelper).toBe(path.join(hdir, 'download-headers.sh'));
    expect(fs.existsSync(path.join(hdir, 'download-switch.json'))).toBe(true);
    expect(fs.existsSync(h.claudeDir)).toBe(false);
  });
});

describe('project settings', () => {
  it("prints the project-scope instruction and never edits the project's file", async () => {
    fs.mkdirSync(path.join(h.cwd, '.claude'), { recursive: true });
    const proj = path.join(h.cwd, '.claude', 'settings.json');
    const content = JSON.stringify({ enabledPlugins: { [TODAYS_ID]: true } }, null, 2);
    fs.writeFileSync(proj, content);
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(h.out).toContain(PROJECT_DISABLE_HINT);
    expect(fs.readFileSync(proj, 'utf-8')).toBe(content);
    expect(args().some((a) => a.includes('--scope project'))).toBe(false);
  });

  it('says nothing when the project does not enable it', async () => {
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    expect(h.out).not.toContain(PROJECT_DISABLE_HINT);
  });
});

describe('--undo', () => {
  it('removes the marketplace, enables today\'s copy, deletes helper and record, keeps backup and store', async () => {
    writeSettings({ theme: 'dark' });
    writeStore('store-token');
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    const backup = h.settings + BACKUP_SUFFIX;
    const backupContent = fs.readFileSync(backup, 'utf-8');
    const storeContent = fs.readFileSync(h.store, 'utf-8');
    h.calls.length = 0;
    expect(await runDownloadSwitch({ undo: true }, h.deps)).toBe(0);
    expect(args()).toEqual(['plugin marketplace remove harmony', `plugin enable ${TODAYS_ID} --scope user`]);
    expect(fs.existsSync(h.helper)).toBe(false);
    expect(fs.existsSync(h.record)).toBe(false);
    expect(fs.readFileSync(backup, 'utf-8')).toBe(backupContent);
    expect(fs.readFileSync(h.store, 'utf-8')).toBe(storeContent);
  });

  it('is idempotent: an already-removed marketplace and missing files are fine', async () => {
    h.responses.set('plugin marketplace remove harmony', { code: 1, stdout: '', stderr: "✘ Failed to remove marketplace: Marketplace 'harmony' not found" });
    expect(await runDownloadSwitch({ undo: true }, h.deps)).toBe(0);
    expect(await runDownloadSwitch({ undo: true }, h.deps)).toBe(0);
  });

  it("B-1501: a machine that never had today's copy (a first install) undoes cleanly", async () => {
    h.responses.set(`plugin enable ${TODAYS_ID} --scope user`, { code: 1, stdout: '', stderr: `✘ Plugin "${TODAYS_ID}" not found in installed plugins` });
    expect(await runDownloadSwitch({ undo: true }, h.deps)).toBe(0);
  });

  it('a failing enable exits 1 naming the command', async () => {
    h.responses.set(`plugin enable ${TODAYS_ID} --scope user`, { code: 1, stdout: '', stderr: 'boom' });
    expect(await runDownloadSwitch({ undo: true }, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain(`\`claude plugin enable ${TODAYS_ID} --scope user\` failed`);
  });

  it('reminds to re-enable at project scope where the project names today\'s copy', async () => {
    fs.mkdirSync(path.join(h.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(h.cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [TODAYS_ID]: false } }));
    expect(await runDownloadSwitch({ undo: true }, h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(`claude plugin enable ${TODAYS_ID} --scope project`);
  });

  it('--undo --dry-run runs nothing and deletes nothing', async () => {
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    h.calls.length = 0;
    expect(await runDownloadSwitch({ undo: true, dryRun: true }, h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(fs.existsSync(h.helper)).toBe(true);
  });
});

describe('spawnClaude with a stub claude (HARMONY_CLAUDE_BIN)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.HARMONY_CLAUDE_BIN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HARMONY_CLAUDE_BIN;
    else process.env.HARMONY_CLAUDE_BIN = saved;
  });

  it('drives a full switch and undo through a stub script that logs argv and cwd', async () => {
    const log = path.join(h.root, 'claude.log');
    const state = path.join(h.root, 'known');
    const stub = path.join(h.root, 'claude-stub.sh');
    fs.writeFileSync(
      stub,
      `#!/bin/sh
echo "$PWD :: $*" >> "${log}"
case "$*" in
  "plugin marketplace list --json") if [ -f "${state}" ]; then echo '[{"name":"harmony"}]'; else echo '[]'; fi ;;
  "-p --input-format stream-json --output-format stream-json --verbose") touch "${state}" ;;
  "plugin install ${INSTALL_ID}") echo "installed" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    process.env.HARMONY_CLAUDE_BIN = stub;
    h.deps.runClaude = spawnClaude;
    expect(await runDownloadSwitch({}, h.deps)).toBe(0);
    const lines = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(lines.map((l) => l.split(' :: ')[1])).toEqual([
      'plugin marketplace list --json',
      START_ARGS.join(' '),
      'plugin marketplace list --json',
      `plugin install ${INSTALL_ID}`,
      `plugin disable ${TODAYS_ID} --scope user`,
    ]);
    const startCwd = lines[1].split(' :: ')[0];
    expect(fs.realpathSync(path.dirname(startCwd))).toBe(fs.realpathSync(h.tmp));
    expect(fs.existsSync(startCwd)).toBe(false);
    expect(fs.readdirSync(h.tmp)).toEqual([]);

    fs.writeFileSync(log, '');
    expect(await runDownloadSwitch({ undo: true }, h.deps)).toBe(0);
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n').map((l) => l.split(' :: ')[1])).toEqual([
      'plugin marketplace remove harmony',
      `plugin enable ${TODAYS_ID} --scope user`,
    ]);
  });

  it('a stub that fails yields exit 1 naming the command', async () => {
    const stub = path.join(h.root, 'claude-fail.sh');
    fs.writeFileSync(stub, '#!/bin/sh\necho "nope" >&2\nexit 3\n', { mode: 0o755 });
    process.env.HARMONY_CLAUDE_BIN = stub;
    h.deps.runClaude = spawnClaude;
    expect(await runDownloadSwitch({ undo: true }, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('`claude plugin marketplace remove harmony` failed (exit 3): nope');
  });
});
