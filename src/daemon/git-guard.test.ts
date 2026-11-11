// B-1451: the push-only git wrapper, the pre-push guard and the dirty check, exercised in scratch
// repos with a local bare remote. Fake tokens are built at runtime so no fixture is token-shaped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'container', 'git-guard');
let root: string;
let bin: string;
let guardHome: string;
let pluginDir: string;
let env: NodeJS.ProcessEnv;

function sh(cmd: string, cwd = root, input?: string) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8', input });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function newRepo(name: string): string {
  const dir = join(root, name);
  const bare = join(root, `${name}.git`);
  sh(`git init -q --bare "${bare}" && git init -q -b feature "${dir}"`);
  sh(`git remote add origin "${bare}" && git commit -q --allow-empty -m init`, dir);
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'b1451-guard-'));
  bin = join(root, 'bin');
  guardHome = join(root, 'guard');
  pluginDir = join(root, 'plugin');
  env = {
    ...process.env,
    HOME: root,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  };
  writeFileSync(join(root, 'gitconfig'), '');
  newRepo('plugin');
  const r = sh(`"${join(HERE, 'install.sh')}" "${guardHome}" "${bin}" "${pluginDir}"`);
  expect(r.code, r.out).toBe(0);
  env.PATH = `${bin}:${process.env.PATH}`;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('B-1451 install', () => {
  it('resolves an absolute real git that is not the wrapper, and sets no global hooksPath', () => {
    const real = readFileSync(join(guardHome, 'real-git'), 'utf8').trim();
    expect(real.startsWith('/')).toBe(true);
    expect(real).not.toBe(join(bin, 'git'));
    expect(sh('git config --global --get core.hooksPath').out.trim()).toBe('');
    expect(spawnSync('ls', [join(guardHome, 'hooks')], { encoding: 'utf8' }).stdout.trim()).toBe('pre-push');
  });
});

describe('B-1451 pre-push guard', () => {
  it.each(['staging', 'prod', 'main'])('refuses an update of %s', (b) => {
    const dir = newRepo(`upd-${b}`);
    const r = sh(`git push origin HEAD:refs/heads/${b}`, dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`B-1451 push guard: refusing to push to refs/heads/${b}`);
  });
  it('refuses a delete of a protected branch and allows a feature branch', () => {
    const dir = newRepo('del');
    expect(sh('git --git-dir="$(git rev-parse --git-dir)" push origin HEAD:refs/heads/feature', dir).code).toBe(0);
    const bare = join(root, 'del.git');
    sh(`git --git-dir="${bare}" update-ref refs/heads/main "$(git rev-parse HEAD)"`, dir);
    const r = sh('git push origin :refs/heads/main', dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('refusing to delete refs/heads/main');
  });

  const fakes: Array<[string, string]> = [
    ['figma-token', 'fig' + 'u_' + 'A'.repeat(24)],
    ['figma-token', 'fig' + 'd_' + 'B'.repeat(24)],
    ['github-token', 'gh' + 'p_' + 'C'.repeat(36)],
    ['github-token', 'github' + '_pat_' + 'D'.repeat(40)],
    ['openai-style-key', 's' + 'k-' + 'E'.repeat(30)],
    ['jwt', 'ey' + 'J' + 'F'.repeat(12) + '.ey' + 'J' + 'G'.repeat(12) + '.' + 'H'.repeat(12)],
  ];
  it.each(fakes)('refuses an added %s line without printing the value', (name, fake) => {
    const dir = newRepo(`tok-${name}-${fake.length}`);
    writeFileSync(join(dir, 'a.txt'), `one\nkey = "${fake}"\n`);
    sh('git add a.txt && git commit -q -m add', dir);
    const r = sh('git push origin HEAD:refs/heads/feature', dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`a.txt line 2`);
    expect(r.out).toContain(`the ${name} pattern`);
    expect(r.out).not.toContain(fake);
  });
  it('allows look-alikes and a deletion of a token line', () => {
    const dir = newRepo('lookalike');
    writeFileSync(join(dir, 'a.txt'), 'risk-class-floor-and-more-words-here-long\ntask-123\n');
    sh('git add a.txt && git commit -q -m add', dir);
    expect(sh('git push -q origin HEAD:refs/heads/feature', dir).code).toBe(0);
  });
  it('refuses the recorded plugin main worktree, allows its linked worktree', () => {
    const r = sh('git push origin HEAD:refs/heads/feature', pluginDir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('refusing a push from the plugin code checkout');
    const wt = join(root, 'plugin-wt');
    sh(`git worktree add -q -b wt-branch "${wt}"`, pluginDir);
    expect(sh('git push -q origin HEAD:refs/heads/wt-branch', wt).code).toBe(0);
  });
});

describe('B-1451 wrapper transparency', () => {
  it('guards git -C dir push and git -c a=b push', () => {
    const dir = newRepo('flags');
    expect(sh(`git -C "${dir}" push origin HEAD:refs/heads/main`).out).toContain('B-1451 push guard');
    expect(sh('git -c a.b=c push origin HEAD:refs/heads/main', dir).out).toContain('B-1451 push guard');
    expect(sh('git --no-pager push origin HEAD:refs/heads/main', dir).out).toContain('B-1451 push guard');
  });
  it('does not treat `commit -m push` as a push and still runs the repo pre-commit hook', () => {
    const dir = newRepo('commit');
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho repo-pre-commit-ran >&2\n');
    chmodSync(hook, 0o755);
    const r = sh('git commit --allow-empty -m push', dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('repo-pre-commit-ran');
  });
  it('preserves args with spaces, exit codes and stdin', () => {
    const dir = newRepo('args');
    expect(sh('git commit -q --allow-empty -m "two words here" && git log -1 --format=%s', dir).out.trim()).toBe('two words here');
    expect(sh('git rev-parse --verify no-such-ref', dir).code).toBe(128);
    const viaWrapper = sh('git hash-object --stdin', dir, 'hello\n').out.trim();
    expect(viaWrapper).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(sh('git --version').code).toBe(0);
  });
  it('chains to a husky-style local core.hooksPath pre-push, whose failure fails the push', () => {
    const dir = newRepo('husky');
    mkdirSync(join(dir, '.husky', '_'), { recursive: true });
    const hook = join(dir, '.husky', '_', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\necho "repo-pre-push-ran $1"\nread l r\n[ -n "$r" ] || exit 9\n[ ! -f FAIL ]\n');
    chmodSync(hook, 0o755);
    sh('git config --local core.hooksPath .husky/_', dir);
    const ok = sh('git push origin HEAD:refs/heads/feature', dir);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain('repo-pre-push-ran origin');
    writeFileSync(join(dir, 'FAIL'), '');
    sh('git add FAIL && git commit -q -m f', dir);
    const bad = sh('git push origin HEAD:refs/heads/feature', dir);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('repo-pre-push-ran origin');
  });
});

describe('B-1451 dirty check', () => {
  it('passes a clean checkout and names only the paths of a dirty one', () => {
    const dir = newRepo('dirty');
    expect(sh(`"${join(HERE, 'dirty-check.sh')}" "${dir}"`).code).toBe(0);
    writeFileSync(join(dir, '.mcp.json'), '{"x":1}');
    writeFileSync(join(dir, 'b.txt'), 'secret-ish content');
    const r = sh(`"${join(HERE, 'dirty-check.sh')}" "${dir}"`);
    expect(r.code).toBe(1);
    expect(r.out.trim()).toBe('B-1451: refusing to start the agent: the plugin checkout has uncommitted changes: .mcp.json, b.txt');
  });
});
