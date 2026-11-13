// B-1475: a throwaway plugin repository for the release build and publish tests. Hermetic: the developer's git config
// is never read and no remote is contacted.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_SCRIPT = fileURLToPath(new URL('../../scripts/build-release.mjs', import.meta.url));
export const PUBLISH_SCRIPT = fileURLToPath(new URL('../../scripts/publish-release.sh', import.meta.url));

export const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/nonexistent-b1475',
  GIT_CONFIG_SYSTEM: '/nonexistent-b1475',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
}

/** A repo with one commit per call to `commit(version, { dist })`; returns the sha. */
export function makeRepo(): { dir: string; root: string; commit: (version: string, opts?: { dist?: boolean; extra?: string }) => string } {
  const root = mkdtempSync(join(tmpdir(), 'b1475-'));
  const dir = join(root, 'repo');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  git(root, 'init', '-q', '-b', 'staging', dir);
  const commit = (version: string, opts: { dist?: boolean; extra?: string } = {}) => {
    writeFileSync(join(dir, '.claude-plugin/plugin.json'), `${JSON.stringify({ name: 'harmony-plugin', version }, null, 2)}\n`);
    mkdirSync(join(dir, 'skills/demo'), { recursive: true });
    writeFileSync(join(dir, 'skills/demo/SKILL.md'), `# demo ${opts.extra ?? ''}\n`);
    if (opts.dist !== false) {
      mkdirSync(join(dir, 'dist/bin'), { recursive: true });
      writeFileSync(join(dir, 'dist/index.js'), '// bundle\n');
      writeFileSync(join(dir, 'dist/bin/harmony.js'), '// bin\n');
    } else {
      git(dir, 'rm', '-rq', '--cached', '--ignore-unmatch', 'dist');
      execFileSync('rm', ['-rf', join(dir, 'dist')]);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', `release ${version}`);
    return git(dir, 'rev-parse', 'HEAD').trim();
  };
  return { dir, root, commit };
}

export function build(repo: string, args: { commit: string; channel?: string; baseUrl?: string; out: string }): { status: number; stderr: string } {
  try {
    execFileSync('node', [BUILD_SCRIPT, '--repo', repo, '--commit', args.commit, '--channel', args.channel ?? 'prod',
      '--base-url', args.baseUrl ?? 'https://downloads.example.test/plugin', '--out', args.out], { env: gitEnv, stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stderr: Buffer };
    return { status: e.status, stderr: e.stderr.toString() };
  }
}
