// B-1184: container/install-playwright.sh's decision logic, executed for real with `npx` stubbed.
// Proves: inert for a repo without Playwright; installs once with the repo's version and no
// --with-deps; a second run installs nothing; a failed install warns and still exits 0.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../container/install-playwright.sh', import.meta.url));

function run(pkg: object | null, opts: { lockVersion?: string; npxFails?: boolean; home?: string; files?: Record<string, unknown>; noPython?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'b1184-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const home = opts.home ?? join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (pkg) writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg));
  if (opts.lockVersion) {
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/playwright-core': { version: opts.lockVersion } } }),
    );
  }
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    const target = join(repo, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  if (opts.noPython) writeFileSync(join(bin, 'python3'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const log = join(root, 'npx.log');
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\necho "npx $*" >> "${log}"\n${opts.npxFails ? 'exit 1' : 'exit 0'}\n`, { mode: 0o755 });
  const exec = () =>
    spawnSync(process.env.PLAYWRIGHT_TEST_BASH ?? (process.platform === 'darwin' ? '/bin/bash' : 'bash'), [scriptPath, repo], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
      encoding: 'utf8',
    });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { exec, calls, home, repo };
}

describe('container/install-playwright.sh (B-1184)', () => {
  it('does nothing for a repo that does not declare Playwright', () => {
    const t = run({ devDependencies: { vitest: '1.0.0' } }, { lockVersion: '1.50.0' });
    const r = t.exec();
    expect(r.status).toBe(0);
    expect(t.calls()).toEqual([]);
  });

  it('installs chromium once, pinned to the repo version, without --with-deps; a second run installs nothing', () => {
    const t = run({ devDependencies: { '@playwright/test': '^1.50.0' } }, { lockVersion: '1.50.1' });
    expect(t.exec().status).toBe(0);
    expect(t.calls()).toEqual(['npx --yes playwright@1.50.1 install chromium']);
    expect(t.exec().status).toBe(0);
    expect(t.calls()).toHaveLength(1);
  });

  it('warns and exits 0 when the install fails, and retries on the next leg', () => {
    const t = run({ devDependencies: { playwright: '1.50.0' } }, { lockVersion: '1.50.0', npxFails: true });
    const r = t.exec();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).toContain("continuing with the image's available browser setup");
    expect(r.stderr).toContain('a compatible browser may still be missing');
    expect(r.stderr).not.toContain('the leg is not affected');
    t.exec();
    expect(t.calls()).toHaveLength(2);
  });

  it('skips with a warning when the version cannot be resolved', () => {
    const t = run({ devDependencies: { '@playwright/test': '^1.50.0' } });
    const r = t.exec();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('could not be resolved');
    expect(t.calls()).toEqual([]);
  });
});

const pw = (version: string) => ({ devDependencies: { '@playwright/test': version } });
const installed = (version: string) => ({ version });
const lock = (...versions: string[]) => `lockfileVersion: '9.0'\npackages:\n${versions.map(v => `  '@playwright/test@${v}': {}`).join('\n')}\nsnapshots:\n`;

describe('workspace discovery (B-1443)', () => {
  it.each([['apps/*', 'e2e'], { packages: ['apps/*', 'e2e'] }])('reads npm workspace shape %j', workspaces => {
    const t = run({ workspaces }, { files: {
      'e2e/package.json': pw('^1.50.0'),
      'e2e/node_modules/@playwright/test/package.json': installed('1.50.1'),
    } });
    expect(t.exec().status).toBe(0);
    expect(t.calls()).toEqual(['npx --yes playwright@1.50.1 install chromium']);
  });

  it.each(["packages:\n  - 'apps/**'\n  - '!apps/excluded'\n  - missing/*\n", "packages: ['apps/**', '!apps/excluded', 'missing/*']\n"])(
    'resolves pnpm recursive globs, exclusions and missing directories: %s', yaml => {
      const t = run({}, { files: {
        'pnpm-workspace.yaml': yaml,
        'apps/nested/ui/package.json': pw('1.50.1'),
        'apps/nested/ui/node_modules/@playwright/test/package.json': installed('1.50.1'),
        'apps/excluded/package.json': pw('1.51.0'),
        'apps/excluded/node_modules/@playwright/test/package.json': installed('1.51.0'),
      } });
      expect(t.exec().status).toBe(0);
      expect(t.calls()).toEqual(['npx --yes playwright@1.50.1 install chromium']);
      t.exec();
      expect(t.calls()).toHaveLength(1);
    });

  it.each([
    lock('1.50.1'),
    "lockfileVersion: '6.0'\npackages:\n  /@playwright/test@1.50.1:\n    resolution: {integrity: example}\n",
    "lockfileVersion: '5.4'\npackages:\n  /@playwright/test/1.50.1:\n    resolution: {integrity: example}\n",
  ])('installs from generated pnpm lock-only records: %s', pnpm => {
    const t = run({}, { files: { 'pnpm-lock.yaml': pnpm } });
    expect(t.exec().status).toBe(0);
    expect(t.calls()).toEqual(['npx --yes playwright@1.50.1 install chromium']);
  });

  it('installs from npm lock-only records and deduplicates family versions', () => {
    const t = run({}, { files: { 'package-lock.json': { packages: {
      'node_modules/@playwright/test': installed('1.50.1'),
      'node_modules/playwright-core': installed('1.50.1'),
    } } } });
    expect(t.exec().status).toBe(0);
    expect(t.calls()).toEqual(['npx --yes playwright@1.50.1 install chromium']);
  });

  it('caps distinct version attempts at three, names skipped versions and reuses all markers', () => {
    const t = run({}, { files: { 'pnpm-lock.yaml': lock('1.54.0', '1.52.0', '1.50.0', '1.51.0') } });
    const r = t.exec();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('skipped Playwright versions: 1.54.0');
    expect(t.calls()).toEqual(['1.50.0', '1.51.0', '1.52.0'].map(v => `npx --yes playwright@${v} install chromium`));
    t.exec();
    expect(t.calls()).toHaveLength(3);
  });

  it('continues after a version install fails and retries failed versions', () => {
    const t = run({}, { npxFails: true, files: { 'pnpm-lock.yaml': lock('1.50.0', '1.51.0') } });
    expect(t.exec().status).toBe(0);
    expect(t.calls()).toHaveLength(2);
    t.exec();
    expect(t.calls()).toHaveLength(4);
  });

  it.each([
    { 'pnpm-workspace.yaml': 'packages: &unsupported\n' },
    { 'pnpm-workspace.yaml': 'packages: ["unterminated]\n' },
    { 'pnpm-workspace.yaml': "packages: ['../outside']\n" },
    { 'package-lock.json': '{bad json' },
    { 'pnpm-workspace.yaml': "packages: ['packages/*']\n", ...Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`packages/p${i}/package.json`, {}])) },
    { 'pnpm-lock.yaml': ' '.repeat(16 * 1024 * 1024 + 1) },
  ])('falls back atomically on invalid input or resource caps', files => {
    const t = run(pw('1.50.0'), { lockVersion: '1.50.0', files: { ...files, 'node_modules/playwright-core/package.json': installed('1.50.0') } });
    const r = t.exec();
    expect(r.status).toBe(0);
    expect(r.stderr.match(/WARNING/g)).toHaveLength(1);
    expect(t.calls()).toEqual(['npx --yes playwright@1.50.0 install chromium']);
  });

  it('uses root fallback when Python is unavailable', () => {
    const t = run(pw('1.50.0'), { noPython: true, lockVersion: '1.50.0' });
    expect(t.exec().status).toBe(0);
    expect(t.calls()).toHaveLength(1);
  });

  it('rejects a workspace symlink escaping the repo', () => {
    const t = run({ workspaces: ['linked'] });
    symlinkSync(t.home, join(t.repo, 'linked'));
    expect(t.exec().stderr).toContain('root-only');
    expect(t.calls()).toEqual([]);
  });

  it.each([
    { 'pnpm-lock.yaml': "importers:\n  e2e:\n    devDependencies:\n      '@playwright/test':\n        specifier: ^1.50.0\n" },
    { 'package-lock.json': { packages: { 'node_modules/playwright-core': installed('1.50.0') } } },
  ])('does not guess versions or activate from playwright-core alone', files => {
    const t = run({}, { files });
    expect(t.exec().status).toBe(0);
    expect(t.calls()).toEqual([]);
  });
});

// Exercise the real deadline while a filesystem glob is stalled, not a timeout mock.
it('aborts stalled discovery with no partial version output', () => {
  const helper = fileURLToPath(new URL('../../container/playwright-versions.py', import.meta.url));
  const t = run({ workspaces: ['apps/**'] });
  const r = spawnSync('python3', ['-c', `import glob, runpy, sys, time
glob.iglob = lambda *a, **k: (time.sleep(4) or iter([]))
helper, repo = sys.argv[1:]
sys.argv = [helper, repo]
runpy.run_path(helper, run_name='__main__')`, helper, t.repo], { encoding: 'utf8', timeout: 5000 });
  expect(r.status).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('3-second discovery deadline');
}, 6000);
