// B-1184: container/install-playwright.sh's decision logic, executed for real with `npx` stubbed.
// Proves: inert for a repo without Playwright; installs once with the repo's version and no
// --with-deps; a second run installs nothing; a failed install warns and still exits 0.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../container/install-playwright.sh', import.meta.url));

function run(pkg: object | null, opts: { lockVersion?: string; npxFails?: boolean; home?: string } = {}) {
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
  const log = join(root, 'npx.log');
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\necho "npx $*" >> "${log}"\n${opts.npxFails ? 'exit 1' : 'exit 0'}\n`, { mode: 0o755 });
  const exec = () =>
    spawnSync('bash', [scriptPath, repo], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
      encoding: 'utf8',
    });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { exec, calls, home };
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
