// B-1082 — the release-gate eval step's PATH CONDITION (scripts/eval-smoke-if-clarify-touched.sh),
// proven against a throwaway git repository in dry-run mode: a change that touches nothing the
// clarify-replay suite measures must skip in well under a second; one that does must decide to run.
// The eval itself is never invoked here (EVAL_SMOKE_DRY_RUN=1 exits before the runner).

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'eval-smoke-if-clarify-touched.sh');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

/** A repo with a `main` base commit and a branch that changes `changedPath`. */
function repoWithChange(changedPath: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'eval-smoke-'));
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'README.md'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'base');
  git(cwd, 'checkout', '-q', '-b', 'feature');
  mkdirSync(join(cwd, changedPath, '..'), { recursive: true });
  writeFileSync(join(cwd, changedPath), 'changed\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'change');
  return cwd;
}

function run(cwd: string) {
  // The script cd's to its own repo root; point its git at the throwaway repo via GIT_DIR/GIT_WORK_TREE.
  const r = spawnSync('bash', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, EVAL_SMOKE_DRY_RUN: '1', EVAL_SMOKE_BASE: 'main', GIT_DIR: join(cwd, '.git'), GIT_WORK_TREE: cwd },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('eval-smoke-if-clarify-touched.sh — path condition', () => {
  it('skips (exit 0, says why) when the diff touches nothing the suite measures', () => {
    const { code, out } = run(repoWithChange('src/tools/whatever.ts'));
    expect(code).toBe(0);
    expect(out).toMatch(/eval-smoke: skipped — no changed path affects/);
    expect(out).not.toMatch(/would run/);
  });

  it.each([
    'skills/harmony-clarify/SKILL.md',
    'skills/harmony-shared/brief-authoring.md',
    'evals/clarify-replay/cases/B-293/prompt.md',
  ])('decides to run when the diff touches %s', (p) => {
    const { code, out } = run(repoWithChange(p));
    expect(code).toBe(0);
    expect(out).toMatch(/eval-smoke: running — changed paths the suite measures/);
    expect(out).toContain(p);
    expect(out).toMatch(/DRY RUN — would run the smoke set \(threshold 0\.50, ceiling \$5\)/);
  });

  it('does not treat other skill prose as a trigger (the suite measures the clarify skill only)', () => {
    const { code, out } = run(repoWithChange('skills/finish-work/SKILL.md'));
    expect(code).toBe(0);
    expect(out).toMatch(/skipped/);
  });
});
