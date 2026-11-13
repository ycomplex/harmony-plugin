// B-1305: the default-branch declaration reader, against real temporary git repositories with a local
// bare remote. Each of the founder's three cases is its own test.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultBriefSectionsIO,
  FETCH_INTERVAL_MS,
  hasEnforcedSections,
  readBriefSectionDeclarations,
  repositoryFromUrl,
  type BriefSectionsIO,
} from './brief-sections.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: tmpdir(),
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const DECLARED = [
  'version: 1',
  'brief_sections:',
  '  clarify:',
  '    - id: ears',
  '      title: Requirements in EARS form',
  '      instruction: Restate each acceptance criterion.',
  '  verify:',
  '    - id: e2e-tests',
  '      title: End-to-end tests implemented',
  '      instruction: One or two sentences per test.',
].join('\n');

/** A bare remote at `<root>/<owner>/<name>.git` and a clone of it, with `project.yml` (or none) on main. */
function repoWithRemote(root: string, owner: string, name: string, projectYml: string | null): { clone: string; bare: string } {
  const bare = join(root, owner, `${name}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = join(root, `${name}-seed`);
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'x\n');
  if (projectYml !== null) {
    mkdirSync(join(seed, '.harmony'));
    writeFileSync(join(seed, '.harmony', 'project.yml'), projectYml);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  // Seed the bare remote by fetching INTO it (no `git push`, which a worker's push guard intercepts).
  git(bare, 'fetch', '-q', seed, 'main:main');
  const clone = join(root, name);
  git(root, 'clone', '-q', bare, clone);
  return { clone, bare };
}

function ioAt(cwd: string, over: Partial<BriefSectionsIO> = {}): BriefSectionsIO {
  return { ...defaultBriefSectionsIO(), cwd: () => cwd, fetchLog: new Map(), ...over };
}

describe('repositoryFromUrl', () => {
  it('names owner/name from https, ssh and local paths', () => {
    expect(repositoryFromUrl('https://github.com/acme-co/widget-app.git')).toBe('acme-co/widget-app');
    expect(repositoryFromUrl('git@github.com:acme-co/widget-app.git')).toBe('acme-co/widget-app');
    expect(repositoryFromUrl('/tmp/x/acme-co/widget-app.git\n')).toBe('acme-co/widget-app');
  });
});

describe('readBriefSectionDeclarations — the three cases', () => {
  it('case 1: a repository whose default branch has no project file reads as none, with no warning', async () => {
    const root = tmp('b1305-none-');
    const { clone } = repoWithRemote(root, 'acme-co', 'widget-app', null);
    expect(await readBriefSectionDeclarations('clarify', ioAt(clone))).toEqual({ kind: 'none' });
  });

  it('case 1b: a project file without brief_sections for this gate reads as none', async () => {
    const root = tmp('b1305-other-gate-');
    const { clone } = repoWithRemote(root, 'acme-co', 'widget-app', DECLARED);
    expect(await readBriefSectionDeclarations('plan', ioAt(clone))).toEqual({ kind: 'none' });
    const { clone: plain } = repoWithRemote(tmp('b1305-plain-'), 'acme-co', 'plain', 'version: 1\n');
    expect(await readBriefSectionDeclarations('clarify', ioAt(plain))).toEqual({ kind: 'none' });
  });

  it('case 2: no conductor file and not inside a git repository reads as unreadable', async () => {
    const outside = tmp('b1305-nogit-');
    const r = await readBriefSectionDeclarations('clarify', ioAt(outside, { git: async () => ({ ok: false, stdout: '' }) }));
    expect(r.kind).toBe('unreadable');
    if (r.kind === 'unreadable') expect(r.detail).toMatch(/not inside a git repository/);
  });

  it('case 2b: every repository skipped (no origin) reads as unreadable', async () => {
    const d = tmp('b1305-noorigin-');
    git(d, 'init', '-q', '-b', 'main');
    const r = await readBriefSectionDeclarations('clarify', ioAt(d));
    expect(r.kind).toBe('unreadable');
    if (r.kind === 'unreadable') expect(r.detail).toMatch(/no origin remote/);
  });

  it('case 3: a malformed brief_sections block is named and not enforced', async () => {
    const root = tmp('b1305-bad-');
    const { clone } = repoWithRemote(root, 'acme-co', 'widget-app', 'version: 1\nbrief_sections:\n  clarify:\n    - id: Bad Id\n      title: T\n      instruction: I\n');
    const r = await readBriefSectionDeclarations('clarify', ioAt(clone));
    expect(r.kind).toBe('declared');
    if (r.kind !== 'declared') return;
    expect(r.repos).toEqual([]);
    expect(hasEnforcedSections(r)).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('acme-co/widget-app:.harmony/project.yml');
    expect(r.warnings[0]).toMatch(/id 'Bad Id'/);
    expect(r.warnings[0]).toMatch(/not enforced/);
  });
});

describe('readBriefSectionDeclarations — what is read', () => {
  it('reads the default branch: repository, commit, fresh and sections in order', async () => {
    const root = tmp('b1305-read-');
    const { clone } = repoWithRemote(root, 'acme-co', 'widget-app', DECLARED);
    const r = await readBriefSectionDeclarations('clarify', ioAt(clone));
    expect(r.kind).toBe('declared');
    if (r.kind !== 'declared') return;
    expect(r.warnings).toEqual([]);
    expect(r.repos).toEqual([
      {
        repository: 'acme-co/widget-app',
        commit: git(clone, 'rev-parse', 'origin/main'),
        fresh: true,
        sections: [{ id: 'ears', title: 'Requirements in EARS form', instruction: 'Restate each acceptance criterion.' }],
      },
    ]);
  });

  it('never reads a declaration present only in the working tree or on a feature branch', async () => {
    const root = tmp('b1305-branch-');
    const { clone } = repoWithRemote(root, 'acme-co', 'widget-app', null);
    git(clone, 'checkout', '-q', '-b', 'feature');
    mkdirSync(join(clone, '.harmony'));
    writeFileSync(join(clone, '.harmony', 'project.yml'), DECLARED);
    expect(await readBriefSectionDeclarations('clarify', ioAt(clone))).toEqual({ kind: 'none' });
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'declare on a branch');
    git(join(root, 'acme-co', 'widget-app.git'), 'fetch', '-q', clone, 'feature:feature');
    expect(await readBriefSectionDeclarations('clarify', ioAt(clone))).toEqual({ kind: 'none' });
  });

  it('picks up a declaration merged to the default branch after the clone (fetch)', async () => {
    const root = tmp('b1305-fetch-');
    const { clone, bare } = repoWithRemote(root, 'acme-co', 'widget-app', null);
    const other = join(root, 'other');
    git(root, 'clone', '-q', bare, other);
    mkdirSync(join(other, '.harmony'));
    writeFileSync(join(other, '.harmony', 'project.yml'), DECLARED);
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'declare');
    git(bare, 'fetch', '-q', other, 'main:main');
    const r = await readBriefSectionDeclarations('verify', ioAt(clone));
    expect(hasEnforcedSections(r)).toBe(true);
  });

  it('a broken remote reads the last-fetched copy, marked not fresh', async () => {
    const root = tmp('b1305-stale-');
    const { clone } = repoWithRemote(root, 'acme-co', 'widget-app', DECLARED);
    git(clone, 'remote', 'set-url', 'origin', join(root, 'gone', 'acme-co', 'widget-app.git'));
    const r = await readBriefSectionDeclarations('clarify', ioAt(clone));
    expect(r.kind).toBe('declared');
    if (r.kind !== 'declared') return;
    expect(r.repos[0].fresh).toBe(false);
    expect(r.repos[0].repository).toBe('acme-co/widget-app');
    expect(r.repos[0].sections[0].id).toBe('ears');
  });

  it('fetches at most once a minute per repository', async () => {
    const root = tmp('b1305-throttle-');
    const { clone } = repoWithRemote(root, 'acme-co', 'widget-app', DECLARED);
    let fetches = 0;
    let now = 1_000_000;
    const base = defaultBriefSectionsIO();
    const io = ioAt(clone, {
      now: () => now,
      git: async (args, opts) => {
        if (args[0] === 'fetch') fetches += 1;
        return base.git(args, opts);
      },
    });
    await readBriefSectionDeclarations('clarify', io);
    await readBriefSectionDeclarations('verify', io);
    expect(fetches).toBe(1);
    now += FETCH_INTERVAL_MS;
    await readBriefSectionDeclarations('clarify', io);
    expect(fetches).toBe(2);
  });

  it('two repositories from the conductor file declaring the same id are both kept', async () => {
    const root = tmp('b1305-multi-');
    const a = repoWithRemote(root, 'acme-co', 'widget-web', DECLARED);
    const b = repoWithRemote(root, 'acme-co', 'widget-api', DECLARED);
    const ws = join(root, 'ws');
    mkdirSync(join(ws, '.harmony'), { recursive: true });
    writeFileSync(
      join(ws, '.harmony', 'conductor.json'),
      JSON.stringify({ repos: [{ url: 'u', path: a.clone }, { url: 'v', path: b.clone }] }),
    );
    const r = await readBriefSectionDeclarations('clarify', ioAt(join(ws)));
    expect(r.kind).toBe('declared');
    if (r.kind !== 'declared') return;
    expect(r.repos.map((x) => [x.repository, x.sections[0].id])).toEqual([
      ['acme-co/widget-web', 'ears'],
      ['acme-co/widget-api', 'ears'],
    ]);
  });

  it('reads the repositories concurrently and keeps the conductor file order for repos and warnings', async () => {
    const root = tmp('b1305-parallel-');
    const a = repoWithRemote(root, 'acme-co', 'widget-web', DECLARED);
    const b = repoWithRemote(root, 'acme-co', 'widget-api', DECLARED);
    const ws = join(root, 'ws');
    mkdirSync(join(ws, '.harmony'), { recursive: true });
    const missing1 = join(root, 'missing-one');
    const missing2 = join(root, 'missing-two');
    writeFileSync(
      join(ws, '.harmony', 'conductor.json'),
      JSON.stringify({ repos: [{ url: 'u', path: a.clone }, { url: 'm', path: missing1 }, { url: 'v', path: b.clone }, { url: 'n', path: missing2 }] }),
    );
    // Each fetch resolves only once BOTH have started: a sequential reader would never start the second,
    // so it falls through the timeout and is recorded as not concurrent. The first repository's fetch is
    // also made to finish last, so the result order cannot come from completion order.
    const base = defaultBriefSectionsIO();
    const started: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((r) => (release = r));
    let concurrent = true;
    const io = ioAt(ws, {
      git: async (args, opts) => {
        if (args[0] === 'fetch') {
          started.push(opts.cwd);
          if (started.length === 2) release();
          const timedOut = await Promise.race([
            bothStarted.then(() => false),
            new Promise<boolean>((r) => setTimeout(() => r(true), 3000)),
          ]);
          if (timedOut) concurrent = false;
          if (opts.cwd.endsWith('widget-web')) await new Promise((r) => setTimeout(r, 50));
        }
        return base.git(args, opts);
      },
    });
    const r = await readBriefSectionDeclarations('clarify', io);
    expect(concurrent).toBe(true);
    expect(started).toHaveLength(2);
    expect(r.kind).toBe('declared');
    if (r.kind !== 'declared') return;
    expect(r.repos.map((x) => x.repository)).toEqual(['acme-co/widget-web', 'acme-co/widget-api']);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain(missing1);
    expect(r.warnings[1]).toContain(missing2);
  });

  it('maps a container-absolute repos[].path under the conductor file directory via the meta repository', async () => {
    const root = tmp('b1305-meta-');
    const meta = repoWithRemote(root, 'acme-co', 'widget-workspace', null);
    // A child repository cloned inside the meta checkout, as a worker lays it out.
    const childRoot = tmp('b1305-meta-child-');
    const child = repoWithRemote(childRoot, 'acme-co', 'widget-web', DECLARED);
    git(meta.clone, 'clone', '-q', child.bare, join(meta.clone, 'web'));
    mkdirSync(join(meta.clone, '.harmony'));
    writeFileSync(
      join(meta.clone, '.harmony', 'conductor.json'),
      JSON.stringify({
        repos: [
          { url: 'u', path: '/nonexistent-container/ws', meta_repo_role: true },
          { url: 'v', path: '/nonexistent-container/ws/web' },
        ],
      }),
    );
    const r = await readBriefSectionDeclarations('clarify', ioAt(join(meta.clone, 'web')));
    expect(r.kind).toBe('declared');
    if (r.kind !== 'declared') return;
    expect(r.repos.map((x) => x.repository)).toEqual(['acme-co/widget-web']);
    expect(r.warnings).toEqual([]);
  });

  it('a conductor repo that is not checked out here is skipped with a warning, the rest still read', async () => {
    const root = tmp('b1305-partial-');
    const a = repoWithRemote(root, 'acme-co', 'widget-web', DECLARED);
    const ws = join(root, 'ws');
    mkdirSync(join(ws, '.harmony'), { recursive: true });
    writeFileSync(
      join(ws, '.harmony', 'conductor.json'),
      JSON.stringify({ repos: [{ url: 'u', path: a.clone }, { url: 'v', path: join(root, 'missing') }] }),
    );
    const r = await readBriefSectionDeclarations('clarify', ioAt(ws));
    expect(r.kind).toBe('declared');
    if (r.kind !== 'declared') return;
    expect(r.repos).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/not a git checkout here/);
  });
});
