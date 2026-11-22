// B-1501: `harmony download install`, `download token use|set` and `download status`, driven with a
// temporary HOME / CLAUDE_CONFIG_DIR / HARMONY_CONFIG_DIR, a stub `claude`, a stub download fetch and a
// stub token save. No test reads a real home, runs a real claude or reaches a real endpoint.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTALL_ID,
  START_ARGS,
  TODAYS_ID,
  helperScript,
  runDownloadInstall,
  runDownloadStatus,
  runDownloadTokenSet,
  runDownloadTokenUse,
  type ClaudeResult,
  type SavedToken,
  type SwitchDeps,
} from './download-switch.js';
import { readAllStdin } from '../cli/commands/download.js';

const TOKEN = 'fixture-new-token-123';
const URL_ = 'https://plugin.harmony.ad/prod/marketplace.json';

interface H {
  root: string;
  harmonyDir: string;
  claudeDir: string;
  store: string;
  helper: string;
  settings: string;
  record: string;
  out: string[];
  err: string[];
  calls: string[][];
  fetches: Array<{ url: string; auth: string | undefined }>;
  fetchStatus: number;
  saved: string[];
  saveResult: SavedToken;
  readCount: number;
  known: boolean;
  responses: Map<string, ClaudeResult>;
  deps: SwitchDeps;
}

let h: H;

function make(): H {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b1501-install-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const tmp = path.join(root, 'tmp');
  for (const d of [home, cwd, tmp]) fs.mkdirSync(d, { recursive: true });
  const harmonyDir = path.join(home, '.harmony');
  const claudeDir = path.join(home, '.claude');
  const x: H = {
    root, harmonyDir, claudeDir,
    store: path.join(harmonyDir, 'config.json'),
    helper: path.join(harmonyDir, 'download-headers.sh'),
    settings: path.join(claudeDir, 'settings.json'),
    record: path.join(harmonyDir, 'download-switch.json'),
    out: [], err: [], calls: [], fetches: [], fetchStatus: 200, saved: [],
    saveResult: { key: 'invented' }, readCount: 0, known: false, responses: new Map(),
    deps: undefined as unknown as SwitchDeps,
  };
  x.deps = {
    env: {},
    homedir: home,
    cwd,
    tmpdir: tmp,
    isTTY: false,
    out: (l) => x.out.push(l),
    err: (l) => x.err.push(l),
    ask: async () => 'n',
    runClaude: async (args) => {
      x.calls.push(args);
      const key = args.join(' ');
      const r = x.responses.get(key);
      if (r) return r;
      if (key === 'plugin marketplace list --json') return { code: 0, stdout: JSON.stringify(x.known ? [{ name: 'harmony' }] : []), stderr: '' };
      if (key === START_ARGS.join(' ')) x.known = true;
      if (key === `plugin disable ${TODAYS_ID} --scope user`) return { code: 1, stdout: '', stderr: `Plugin "${TODAYS_ID}" not found` };
      return { code: 0, stdout: '', stderr: '' };
    },
    saveToken: async (t) => {
      x.saved.push(t);
      fs.mkdirSync(x.harmonyDir, { recursive: true });
      const c = fs.existsSync(x.store) ? JSON.parse(fs.readFileSync(x.store, 'utf-8')) : { activeProject: null, projects: {} };
      c.projects[x.saveResult.key] = { name: x.saveResult.key, token: t, projectId: 'proj-invented' };
      fs.writeFileSync(x.store, JSON.stringify(c), { mode: 0o600 });
      return x.saveResult;
    },
    fetch: async (url, init) => {
      x.fetches.push({ url, auth: init.headers.Authorization });
      return { status: x.fetchStatus };
    },
    readToken: async () => {
      x.readCount++;
      return `${TOKEN}\n`;
    },
    now: () => new Date('2026-11-22T10:00:00Z'),
    pid: 777,
  };
  return x;
}

function store(obj: unknown) {
  fs.mkdirSync(h.harmonyDir, { recursive: true });
  fs.writeFileSync(h.store, JSON.stringify(obj));
}

function readStoreJson() {
  return JSON.parse(fs.readFileSync(h.store, 'utf-8'));
}

function everything() {
  return [...h.out, ...h.err, ...h.calls.flat()].join('\n');
}

beforeEach(() => {
  h = make();
});

afterEach(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe('harmony download install', () => {
  it('on a bare machine: checks the token with the download, saves it, pins it, installs; the token is never printed or in an argv', async () => {
    expect(await runDownloadInstall({}, h.deps)).toBe(0);
    expect(h.fetches).toEqual([{ url: URL_, auth: `Bearer ${TOKEN}` }]);
    expect(h.saved).toEqual([TOKEN]);
    const c = readStoreJson();
    expect(c.downloadProject).toBe('invented');
    expect(fs.statSync(h.store).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(h.helper, 'utf-8')).toBe(helperScript());
    expect(fs.statSync(h.helper).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(h.settings, 'utf-8')).extraKnownMarketplaces.harmony.source).toEqual({ source: 'url', url: URL_, headersHelper: h.helper });
    expect(h.calls.map((a) => a.join(' '))).toEqual([
      'plugin marketplace list --json',
      START_ARGS.join(' '),
      'plugin marketplace list --json',
      `plugin install ${INSTALL_ID}`,
      `plugin disable ${TODAYS_ID} --scope user`,
    ]);
    expect(everything()).not.toContain(TOKEN);
    expect(fs.readFileSync(h.record, 'utf-8')).not.toContain(TOKEN);
    expect(JSON.parse(fs.readFileSync(h.record, 'utf-8'))).toMatchObject({ download_project: 'invented', via: 'install', disabled_ycomplex_user_scope: false });
    // the token is written in exactly one place: config.json.
    const files = fs.readdirSync(h.root, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(h.root, f)).isFile());
    const holding = files.filter((f) => fs.readFileSync(path.join(h.root, f), 'utf-8').includes(TOKEN));
    expect(holding).toEqual([path.relative(h.root, h.store)]);
  });

  it('never changes an existing active project', async () => {
    store({ activeProject: 'mine', projects: { mine: { name: 'mine', token: 'other-token' } } });
    expect(await runDownloadInstall({}, h.deps)).toBe(0);
    const c = readStoreJson();
    expect(c.activeProject).toBe('mine');
    expect(c.downloadProject).toBe('invented');
    expect(c.projects.mine.token).toBe('other-token');
  });

  it('a token the download refuses: exit 1, nothing saved, nothing written, no claude command', async () => {
    h.fetchStatus = 401;
    expect(await runDownloadInstall({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('the download refused this token (HTTP 401');
    expect(h.saved).toEqual([]);
    expect(fs.existsSync(h.harmonyDir)).toBe(false);
    expect(fs.existsSync(h.settings)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('a token Harmony refuses: exit 1, the message never carries the token, nothing pinned', async () => {
    h.deps.saveToken = async (t) => {
      throw new Error(`Token exchange failed (401) for ${t}`);
    };
    expect(await runDownloadInstall({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('Harmony did not accept the token');
    expect(everything()).not.toContain(TOKEN);
    expect(fs.existsSync(h.helper)).toBe(false);
  });

  it('an unreachable download: exit 1, the message never carries the token', async () => {
    h.deps.fetch = async () => {
      throw new Error(`connect ECONNREFUSED while sending ${TOKEN}`);
    };
    expect(await runDownloadInstall({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('could not reach');
    expect(everything()).not.toContain(TOKEN);
  });

  it('an empty token is refused before any check', async () => {
    h.deps.readToken = async () => '  \n';
    expect(await runDownloadInstall({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('no token was given');
    expect(h.fetches).toEqual([]);
  });

  it('a settings file that is not JSON is refused before the token is read', async () => {
    fs.mkdirSync(h.claudeDir, { recursive: true });
    fs.writeFileSync(h.settings, '{ broken');
    expect(await runDownloadInstall({}, h.deps)).toBe(1);
    expect(h.readCount).toBe(0);
    expect(h.err.join('\n')).toContain('is not valid JSON');
  });

  it('--dry-run reads no token, fetches nothing, writes nothing, runs nothing', async () => {
    expect(await runDownloadInstall({ dryRun: true }, h.deps)).toBe(0);
    expect(h.readCount).toBe(0);
    expect(h.fetches).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(fs.existsSync(h.harmonyDir)).toBe(false);
    expect(fs.existsSync(h.claudeDir)).toBe(false);
  });

  it('a name already held by a different project: says which key it went to and what HARMONY_PROJECT to use', async () => {
    h.saveResult = { key: 'invented-abcd1234', collidedWith: 'invented' };
    expect(await runDownloadInstall({}, h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('HARMONY_PROJECT=invented-abcd1234');
    expect(readStoreJson().downloadProject).toBe('invented-abcd1234');
  });

  it("any failure to disable today's copy is only a note on a first install", async () => {
    h.responses.set(`plugin disable ${TODAYS_ID} --scope user`, { code: 1, stdout: '', stderr: 'permission denied' });
    expect(await runDownloadInstall({}, h.deps)).toBe(0);
  });

  it('a failing install exits 1 naming the command', async () => {
    h.responses.set(`plugin install ${INSTALL_ID}`, { code: 1, stdout: 'HTTP 401', stderr: '' });
    expect(await runDownloadInstall({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain(`\`claude plugin install ${INSTALL_ID}\` failed`);
  });

  it('a non-https --base is refused; --base moves the check and the marketplace', async () => {
    expect(await runDownloadInstall({ base: 'http://download.invented.example' }, h.deps)).toBe(1);
    expect(await runDownloadInstall({ base: 'https://download.invented.example/' }, h.deps)).toBe(0);
    expect(h.fetches[0].url).toBe('https://download.invented.example/prod/marketplace.json');
  });

  it('when the start does not fetch the marketplace: exit 2, and the token stays pinned for the retry', async () => {
    h.deps.runClaude = async (args) => {
      h.calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') return { code: 0, stdout: '[]', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    expect(await runDownloadInstall({}, h.deps)).toBe(2);
    expect(readStoreJson().downloadProject).toBe('invented');
    // B-1501 fix 10a: a bare machine has no `harmony` command yet, so the retry is the installer.
    expect(h.err.join('\n')).toContain('run the installer again');
  });
});

describe('harmony download token use <project>', () => {
  beforeEach(() => {
    store({ activeProject: 'a', projects: { a: { name: 'a', token: 'token-a' }, b: { name: 'b', token: 'token-b' } } });
  });

  it('checks that project\'s token with the download, pins it, rewrites the helper; activeProject unchanged', async () => {
    fs.writeFileSync(h.helper, '#!/bin/sh\n# an older helper\n', { mode: 0o700 });
    expect(await runDownloadTokenUse('b', {}, h.deps)).toBe(0);
    expect(h.fetches).toEqual([{ url: URL_, auth: 'Bearer token-b' }]);
    const c = readStoreJson();
    expect(c.downloadProject).toBe('b');
    expect(c.activeProject).toBe('a');
    expect(fs.readFileSync(h.helper, 'utf-8')).toBe(helperScript());
    expect(h.out.join('\n')).toContain('harmony download install');
    expect(everything()).not.toContain('token-b');
  });

  it('a project that is not stored: exit 1, listing what is', async () => {
    expect(await runDownloadTokenUse('nope', {}, h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('(stored: a, b)');
    expect(readStoreJson().downloadProject).toBeUndefined();
  });

  it('a token the download refuses: exit 1, the pin is unchanged', async () => {
    h.fetchStatus = 403;
    expect(await runDownloadTokenUse('b', {}, h.deps)).toBe(1);
    expect(readStoreJson().downloadProject).toBeUndefined();
    expect(fs.existsSync(h.helper)).toBe(false);
  });
});

describe('harmony download token set', () => {
  it('reads a new token, checks it, saves it without activating, pins it', async () => {
    store({ activeProject: 'a', projects: { a: { name: 'a', token: 'token-a' } } });
    expect(await runDownloadTokenSet({}, h.deps)).toBe(0);
    expect(h.fetches).toEqual([{ url: URL_, auth: `Bearer ${TOKEN}` }]);
    expect(h.saved).toEqual([TOKEN]);
    const c = readStoreJson();
    expect(c.downloadProject).toBe('invented');
    expect(c.activeProject).toBe('a');
    expect(everything()).not.toContain(TOKEN);
  });

  it('a refused token is not saved', async () => {
    h.fetchStatus = 401;
    expect(await runDownloadTokenSet({}, h.deps)).toBe(1);
    expect(h.saved).toEqual([]);
  });
});

describe('harmony download status', () => {
  it('pinned: names the project and says nothing else is consulted; never a token', () => {
    store({ activeProject: 'a', downloadProject: 'b', projects: { a: { name: 'a', token: 'token-a' }, b: { name: 'b', token: 'token-b' } } });
    h.deps.env = { HARMONY_API_TOKEN: 'env-token' };
    expect(runDownloadStatus(h.deps)).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain('Pinned download project: "b"');
    expect(out).toContain('The helper will send: the pinned project "b" (nothing else is consulted)');
    expect(out).not.toMatch(/token-a|token-b|env-token/);
  });

  it('unpinned with an env token: says so and recommends a pin', () => {
    store({ activeProject: 'a', projects: { a: { name: 'a', token: 'token-a' } } });
    h.deps.env = { HARMONY_API_TOKEN: 'env-token' };
    expect(runDownloadStatus(h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('The helper will send: HARMONY_API_TOKEN');
    expect(h.out.join('\n')).toContain('harmony download token use <project>');
  });

  it('unpinned, no env: the active project', () => {
    store({ activeProject: 'a', projects: { a: { name: 'a', token: 'token-a' } } });
    expect(runDownloadStatus(h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('the active project "a"');
  });

  it('pinned to a project with no token: exit 1 and the fix', () => {
    store({ activeProject: null, downloadProject: 'gone', projects: {} });
    expect(runDownloadStatus(h.deps)).toBe(1);
    expect(h.out.join('\n')).toContain('harmony download token set');
  });
});

describe('readAllStdin', () => {
  it('reads everything piped in', async () => {
    expect(await readAllStdin(Readable.from(['abc', 'def\n']))).toBe('abcdef\n');
  });
});

// B-1501 fix round — the seat's review.
describe('fix 5: the helper fails closed on a config.json it cannot read and parse', () => {
  const ENV_TOKEN = 'env-fixture-must-not-leak';
  function writeHelperHere() {
    fs.mkdirSync(h.harmonyDir, { recursive: true });
    fs.writeFileSync(h.helper, helperScript(), { mode: 0o700 });
  }
  function runIt() {
    return spawnSync('sh', [h.helper], { env: { PATH: process.env.PATH, HARMONY_API_TOKEN: ENV_TOKEN }, encoding: 'utf-8' });
  }
  beforeEach(writeHelperHere);

  it('missing config.json: the legacy order (HARMONY_API_TOKEN)', () => {
    const r = runIt();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`{"Authorization":"Bearer ${ENV_TOKEN}"}`);
  });

  it('parsed with no downloadProject: the legacy order', () => {
    store({ activeProject: 'a', projects: { a: { name: 'a', token: 'store-fixture' } } });
    expect(runIt().stdout).toBe(`{"Authorization":"Bearer ${ENV_TOKEN}"}`);
  });

  it('pinned: the pinned token', () => {
    store({ activeProject: null, downloadProject: 'b', projects: { b: { name: 'b', token: 'pinned-fixture' } } });
    expect(runIt().stdout).toBe('{"Authorization":"Bearer pinned-fixture"}');
  });

  for (const [label, content] of [
    ['an empty file', ''],
    ['truncated JSON (no downloadProject in what was written)', '{"activeProject": "a", "proj'],
    ['truncated JSON that names downloadProject', '{"downloadProject": "b", "projects": {'],
    ['JSON null', 'null'],
  ] as const) {
    it(`${label}: exit 1, the fix named on stderr, HARMONY_API_TOKEN never sent`, () => {
      fs.writeFileSync(h.store, content);
      const r = runIt();
      if (content === 'null') {
        // `null` parses: it holds no pin, so the legacy order applies (it is not a half-written file).
        expect(r.status).toBe(0);
        return;
      }
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stdout + r.stderr).not.toContain(ENV_TOKEN);
      expect(r.stderr).toContain(h.store);
      expect(r.stderr).toContain('harmony download token use <project>');
    });
  }

  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(root)('an unreadable file (chmod 000): exit 1, HARMONY_API_TOKEN never sent (skipped as root: root reads a mode-000 file)', () => {
    store({ activeProject: null, projects: {} });
    fs.chmodSync(h.store, 0o000);
    try {
      const r = runIt();
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).not.toContain(ENV_TOKEN);
      expect(r.stderr).toContain('cannot be read');
    } finally {
      fs.chmodSync(h.store, 0o600);
    }
  });

  it('without node on PATH: an empty or half-written file stops too', () => {
    const bin = path.join(h.root, 'bin-no-node');
    fs.mkdirSync(bin);
    for (const tool of ['dirname', 'grep', 'tr', 'sed', 'printf']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
      if (found.startsWith('/')) fs.symlinkSync(found, path.join(bin, tool));
    }
    const noNode = () => spawnSync('/bin/sh', [h.helper], { env: { PATH: bin, HARMONY_API_TOKEN: ENV_TOKEN }, encoding: 'utf-8' });
    for (const content of ['', '{"activeProject": "a", "proj']) {
      fs.writeFileSync(h.store, content);
      const r = noNode();
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).not.toContain(ENV_TOKEN);
    }
    store({ activeProject: null, projects: {} });
    expect(noNode().stdout).toBe(`{"Authorization":"Bearer ${ENV_TOKEN}"}`);
  });
});

describe('fix 7: the settings write re-reads at the moment of writing, and writes through a symlink', () => {
  it('a concurrent edit made between the first read and the write survives', async () => {
    fs.mkdirSync(h.claudeDir, { recursive: true });
    fs.writeFileSync(h.settings, JSON.stringify({ theme: 'dark' }));
    h.deps.readToken = async () => {
      // someone (another Claude Code) edits settings.json while the token is being typed
      fs.writeFileSync(h.settings, JSON.stringify({ theme: 'dark', concurrent: { kept: true } }));
      return TOKEN;
    };
    expect(await runDownloadInstall({}, h.deps)).toBe(0);
    const s = JSON.parse(fs.readFileSync(h.settings, 'utf-8'));
    expect(s.concurrent).toEqual({ kept: true });
    expect(s.extraKnownMarketplaces.harmony).toBeDefined();
  });

  it('a symlinked settings.json stays a symlink, and its target gets the entry', async () => {
    const real = path.join(h.root, 'dotfiles', 'claude-settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify({ theme: 'light' }), { mode: 0o640 });
    fs.mkdirSync(h.claudeDir, { recursive: true });
    fs.symlinkSync(real, h.settings);
    expect(await runDownloadInstall({}, h.deps)).toBe(0);
    expect(fs.lstatSync(h.settings).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(h.settings)).toBe(real);
    const s = JSON.parse(fs.readFileSync(real, 'utf-8'));
    expect(s.theme).toBe('light');
    expect(s.extraKnownMarketplaces.harmony).toBeDefined();
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(path.dirname(real))).toEqual(['claude-settings.json']);
  });
});

describe('fix 10c: a failing claude command is reported with token-shaped text redacted', () => {
  it('redacts a token-shaped string in claude stderr from the printed failure', async () => {
    const leaked = `harmony_${'ab12'.repeat(16)}`;
    h.known = true;
    h.responses.set(`plugin install ${INSTALL_ID}`, { code: 1, stdout: '', stderr: `fetch failed with Authorization: Bearer ${leaked}\nsecond line` });
    expect(await runDownloadInstall({}, h.deps)).toBe(1);
    const printed = h.err.join('\n');
    expect(printed).toContain(`claude plugin install ${INSTALL_ID}\` failed (exit 1)`);
    expect(printed).toContain('[redacted]');
    expect(printed).not.toContain(leaked);
  });

  it('redacts the token just read even when it has no known shape', async () => {
    h.known = true;
    h.responses.set(`plugin install ${INSTALL_ID}`, { code: 1, stdout: `echoed ${TOKEN}`, stderr: '' });
    expect(await runDownloadInstall({}, h.deps)).toBe(1);
    expect(h.err.join('\n')).not.toContain(TOKEN);
  });
});

describe('fix 6: the non-activating save leaves no active project and says how to set one', () => {
  it('install on a bare machine names `harmony project switch <key>` when no project is active', async () => {
    expect(await runDownloadInstall({}, h.deps)).toBe(0);
    expect(readStoreJson().activeProject).toBeNull();
    expect(h.out.join('\n')).toContain('harmony project switch invented');
  });

  it('says nothing about switching when a project is already active', async () => {
    store({ activeProject: 'other', projects: { other: { name: 'other', token: 'other-fixture' } } });
    expect(await runDownloadInstall({}, h.deps)).toBe(0);
    expect(h.out.join('\n')).not.toContain('harmony project switch');
  });
});

describe('fix 10a: install stopping before the plugin is installed names a step that works without `harmony` on PATH', () => {
  it('says to start Claude Code once and run the installer again, not `harmony download switch`', async () => {
    h.responses.set(START_ARGS.join(' '), { code: 0, stdout: '', stderr: '' });
    // the start never makes the marketplace known
    const run = h.deps.runClaude;
    h.deps.runClaude = async (a, o) => (a.join(' ') === START_ARGS.join(' ') ? { code: 0, stdout: '', stderr: '' } : run(a, o));
    expect(await runDownloadInstall({}, h.deps)).toBe(2);
    const msg = h.err.join('\n');
    expect(msg).toContain('run the installer again');
    expect(msg).not.toContain('harmony download switch');
  });
});
