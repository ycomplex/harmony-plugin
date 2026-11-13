// B-1475: scripts/build-release.mjs — the released download for one commit (docs/plugin-release-artefact.md).
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, git, makeRepo } from './test/release-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fresh() { const r = makeRepo(); roots.push(r.root); return r; }
function outDir() { const d = mkdtempSync(join(tmpdir(), 'b1475-out-')); roots.push(d); return d; }
const json = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

function claudeOnPath(): boolean {
  try { execFileSync('bash', ['-lc', 'command -v claude'], { stdio: 'pipe' }); return true; } catch { return false; }
}

describe('build-release.mjs', () => {
  it('two builds of the same commit are byte-identical', () => {
    const r = fresh();
    const c = r.commit('1.2.3');
    const a = outDir(); const b = outDir();
    expect(build(r.dir, { commit: c, out: a }).status).toBe(0);
    expect(build(r.dir, { commit: c, out: b }).status).toBe(0);
    const files = readdirSync(a).sort();
    expect(files).toEqual(['harmony-plugin-1.2.3.zip', 'manifest.json', 'manifest.txt', 'marketplace.json', 'release.json']);
    for (const f of files) expect(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), f).toBe(true);
  });

  it('the zip is git archive of the commit, plugin root at the top level', () => {
    const r = fresh();
    const c = r.commit('1.2.3');
    const out = outDir();
    build(r.dir, { commit: c, out });
    const expected = execFileSync('git', ['-C', r.dir, 'archive', '--format=zip', c]);
    expect(readFileSync(join(out, 'harmony-plugin-1.2.3.zip')).equals(expected)).toBe(true);
    const names = execFileSync('python3', ['-I', '-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', join(out, 'harmony-plugin-1.2.3.zip')], { encoding: 'utf8' });
    expect(names).toContain('.claude-plugin/plugin.json');
    expect(names).toContain('dist/index.js');
  });

  it.each([
    ['prod', 'harmony'],
    ['staging', 'harmony-staging'],
  ])('marketplace.json for %s is named %s and points at the zip with its digest', (channel, name) => {
    const r = fresh();
    const c = r.commit('0.17.51');
    const out = outDir();
    expect(build(r.dir, { commit: c, channel, baseUrl: 'https://downloads.example.test/plugin/', out }).status).toBe(0);
    const digest = sha(join(out, 'harmony-plugin-0.17.51.zip'));
    expect(json(out, 'marketplace.json')).toEqual({
      name,
      owner: { name: 'ycomplex' },
      description: `Harmony project management for Claude Code (${channel} channel)`,
      metadata: { version: '0.17.51' },
      plugins: [{
        name: 'harmony-plugin',
        description: 'Harmony project management integration for Claude Code — MCP tools and workflow skills',
        version: '0.17.51',
        source: { source: 'archive', url: `https://downloads.example.test/plugin/${channel}/releases/0.17.51/harmony-plugin-0.17.51.zip`, sha256: digest },
      }],
    });
    // Stable key order, pretty-printed.
    expect(readFileSync(join(out, 'marketplace.json'), 'utf8').split('\n')[1]).toBe(`  "name": "${name}",`);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const release = json(out, 'release.json');
    expect(release).toEqual({
      schema: 1, channel, version: '0.17.51', commit: c, built_at: '2026-01-02T03:04:05Z',
      zip: { object: `channels/${channel}/releases/0.17.51/harmony-plugin-0.17.51.zip`, sha256: digest, bytes: readFileSync(join(out, 'harmony-plugin-0.17.51.zip')).length },
      marketplace_object: `channels/${channel}/releases/0.17.51/marketplace.json`,
    });
    expect(readFileSync(join(out, 'manifest.txt'), 'utf8')).toBe([
      `immutable harmony-plugin-0.17.51.zip channels/${channel}/releases/0.17.51/harmony-plugin-0.17.51.zip`,
      `immutable marketplace.json channels/${channel}/releases/0.17.51/marketplace.json`,
      `immutable release.json channels/${channel}/releases/0.17.51/release.json`,
      `pointer marketplace.json channels/${channel}/marketplace.json`,
      `pointer release.json channels/${channel}/release.json`,
      '',
    ].join('\n'));
  });

  it('reads the version at the commit, not the working tree', () => {
    const r = fresh();
    const c = r.commit('2.0.0');
    r.commit('2.0.1');
    const out = outDir();
    build(r.dir, { commit: c, out });
    expect(json(out, 'release.json').version).toBe('2.0.0');
    expect(git(r.dir, 'rev-parse', 'HEAD').trim()).not.toBe(c);
  });

  it.each([
    ['the inert version', { version: '0.0.0-dev' }, /0\.0\.0-dev/],
    ['a non-semver version', { version: 'v1' }, /semver/],
    ['a commit without dist/', { version: '1.0.0', dist: false }, /dist\/index\.js/],
    ['a bad channel', { version: '1.0.0', channel: 'main' }, /--channel/],
    ['an http base URL', { version: '1.0.0', baseUrl: 'http://downloads.example.test' }, /https/],
    ['a missing base URL', { version: '1.0.0', baseUrl: '' }, /--base-url is required/],
    ['an unknown commit', { version: '1.0.0', commit: 'deadbeef' }, /not in the repository/],
  ])('refuses %s and writes nothing', (_what, opts: { version: string; dist?: boolean; channel?: string; baseUrl?: string; commit?: string }, message) => {
    const r = fresh();
    const c = r.commit(opts.version, { dist: opts.dist });
    const out = join(outDir(), 'never');
    const res = build(r.dir, { commit: opts.commit ?? c, channel: opts.channel, baseUrl: opts.baseUrl, out });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(message);
    expect(existsSync(out)).toBe(false);
  });

  it.skipIf(!claudeOnPath())('the built marketplace passes `claude plugin validate`', () => {
    const r = fresh();
    const c = r.commit('1.2.3');
    const out = outDir();
    build(r.dir, { commit: c, out });
    const home = outDir();
    const res = execFileSync('claude', ['plugin', 'validate', join(out, 'marketplace.json')], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }, encoding: 'utf8', stdio: 'pipe', timeout: 60_000,
    });
    expect(res).toMatch(/pass|valid/i);
  });
});
