// B-1007: the staging generation job's logic (scripts/generate-staging.sh), which CI only calls.
//
// Three properties are load-bearing and each is asserted DIRECTLY here, against a local git fixture
// (a bare "origin" plus a clone, in a temp dir — no network, no GitHub App, no npm: the build step
// is swapped for a fake via HARMONY_STAGING_BUILD_CMD):
//
//   1. MERGE, NEVER RESET — `prod` fast-forwards from `staging`, so the previous staging tip must
//      stay an ANCESTOR of the new one. A rewrite would permanently break promote-prod.sh's
//      fast-forward preflight, and would not be visible from the generated tree alone.
//   2. RE-RUN SAFE — a second run on the SAME main commit must not double-bump and must not create
//      an empty commit. Asserted on the version AND the commit count, not just the exit code.
//   3. BOOTSTRAP — with no origin/staging at all, staging is created from main with the version
//      seeded from PROD's manifest (the last really published version), not from main's inert one.
//
// Hermetic: GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM point at non-existent files and the identity is
// supplied by env, so the developer's real git config is never read and no remote is contacted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/generate-staging.sh', import.meta.url));
const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8');
/** The script's EXECUTABLE lines. Comment lines are stripped because the header deliberately NAMES
 *  the forbidden operations while explaining why they are forbidden — the ban is on doing them. */
const SCRIPT_CODE = SCRIPT_SOURCE.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

function commandAvailable(cmd: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Capability probe only — never keyed on an assertion's expected outcome. */
const CAPABLE = commandAvailable('bash') && commandAvailable('git') && commandAvailable('node');
if (!CAPABLE) {
  console.warn(
    '[B-1007] SKIPPING generate-staging.sh tests: this host lacks bash, git or node on PATH.',
  );
}

// The fake build: writes the same two files a real `npm run build` would land under dist/, with no
// npm and no network. The script's contract is "run the build command, then `git add -f dist`" —
// what the build itself emits is esbuild's business, tested elsewhere.
const FAKE_BUILD =
  'mkdir -p dist/bin && echo "// generated bundle" > dist/index.js && echo "// generated bin" > dist/bin/harmony.js';

let root: string;
let originDir: string;
let seedDir: string;
let ciDir: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function manifest(version: string): string {
  return `{\n  "name": "harmony-plugin",\n  "version": "${version}"\n}\n`;
}

function versionAt(ref: string): string {
  const raw = git(ciDir, 'show', `${ref}:.claude-plugin/plugin.json`);
  return JSON.parse(raw).version as string;
}

/** Run the generation script in the "CI checkout" clone. */
function generate(extra: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [SCRIPT], {
    cwd: ciDir,
    env: { ...env, HARMONY_STAGING_BUILD_CMD: FAKE_BUILD, ...extra },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe.skipIf(!CAPABLE)('generate-staging.sh (B-1007 staging generation)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'b1007-generate-'));
    originDir = join(root, 'origin.git');
    seedDir = join(root, 'seed');
    ciDir = join(root, 'ci');
    env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: join(root, 'no-such-global-gitconfig'),
      GIT_CONFIG_SYSTEM: join(root, 'no-such-system-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'B-1007 Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@harmony.invalid',
      GIT_COMMITTER_NAME: 'B-1007 Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@harmony.invalid',
    };

    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', originDir], { env });
    mkdirSync(seedDir);
    git(seedDir, 'init', '-q', '-b', 'main');

    // `main`: source only — dist/ gitignored, version inert.
    mkdirSync(join(seedDir, '.claude-plugin'));
    writeFileSync(join(seedDir, '.claude-plugin', 'plugin.json'), manifest('0.0.0-dev'));
    writeFileSync(join(seedDir, '.gitignore'), 'node_modules/\ndist/\n');
    writeFileSync(join(seedDir, 'source.ts'), 'export const n = 1;\n');
    git(seedDir, 'add', '-A');
    git(seedDir, 'commit', '-q', '-m', 'main: source only');
    git(seedDir, 'remote', 'add', 'origin', originDir);
    git(seedDir, 'push', '-q', 'origin', 'main');

    // `prod`: what the marketplace serves today — a real version and a tracked dist/.
    git(seedDir, 'checkout', '-q', '-b', 'prod');
    writeFileSync(join(seedDir, '.claude-plugin', 'plugin.json'), manifest('0.14.187'));
    mkdirSync(join(seedDir, 'dist', 'bin'), { recursive: true });
    writeFileSync(join(seedDir, 'dist', 'index.js'), '// published bundle\n');
    writeFileSync(join(seedDir, 'dist', 'bin', 'harmony.js'), '// published bin\n');
    git(seedDir, 'add', '-f', 'dist', '.claude-plugin/plugin.json');
    git(seedDir, 'commit', '-q', '-m', 'prod: the served version');
    git(seedDir, 'push', '-q', 'origin', 'prod');
    git(seedDir, 'checkout', '-q', 'main');

    execFileSync('git', ['clone', '-q', originDir, ciDir], { env });
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Advance `main` with a new source commit, as a merged PR would. */
  function advanceMain(text: string): void {
    writeFileSync(join(seedDir, 'source.ts'), text);
    git(seedDir, 'commit', '-q', '-am', 'main: another source change');
    git(seedDir, 'push', '-q', 'origin', 'main');
  }

  function remoteStagingSha(): string {
    return git(ciDir, 'ls-remote', originDir, 'refs/heads/staging').split('\t')[0].trim();
  }

  it('bootstraps staging from main with the version seeded from PROD, not from main\'s inert 0.0.0-dev', () => {
    expect(git(ciDir, 'ls-remote', originDir, 'refs/heads/staging').trim()).toBe('');

    const output = generate();
    expect(output).toContain('bootstrapping it from main');
    expect(output).toContain('bootstrap seed version from origin/prod: 0.14.187');

    git(ciDir, 'fetch', '-q', 'origin', 'staging');
    const staging = remoteStagingSha();
    expect(staging).not.toBe('');
    expect(versionAt(staging)).toBe('0.14.188');

    // main's source is there, and the generated dist/ is TRACKED on staging despite main's ignore.
    expect(git(ciDir, 'show', `${staging}:source.ts`)).toContain('export const n = 1;');
    const tracked = git(ciDir, 'ls-tree', '-r', '--name-only', staging, '--', 'dist').trim().split('\n');
    expect(tracked.sort()).toEqual(['dist/bin/harmony.js', 'dist/index.js']);

    // main itself is untouched by generation — it stays source-only and inert.
    const main = git(ciDir, 'ls-remote', originDir, 'refs/heads/main').split('\t')[0].trim();
    expect(versionAt(main)).toBe('0.0.0-dev');
    expect(git(ciDir, 'ls-tree', '-r', '--name-only', main, '--', 'dist').trim()).toBe('');
  }, 60_000);

  it('is re-run safe: a second run on the SAME main commit neither double-bumps nor lands an empty commit', () => {
    generate();
    git(ciDir, 'fetch', '-q', 'origin', 'staging');
    const firstSha = remoteStagingSha();
    const firstCount = git(ciDir, 'rev-list', '--count', firstSha).trim();
    expect(versionAt(firstSha)).toBe('0.14.188');

    const output = generate();
    expect(output).toContain('nothing to generate');

    git(ciDir, 'fetch', '-q', 'origin', 'staging');
    const secondSha = remoteStagingSha();
    expect(secondSha).toBe(firstSha);
    expect(versionAt(secondSha)).toBe('0.14.188'); // NOT 0.14.189 — no double bump
    expect(git(ciDir, 'rev-list', '--count', secondSha).trim()).toBe(firstCount); // no empty commit
  }, 60_000);

  it('MERGES main into staging — the previous staging tip stays an ANCESTOR (this is what keeps prod fast-forwardable)', () => {
    generate();
    git(ciDir, 'fetch', '-q', 'origin', 'staging');
    const firstTip = remoteStagingSha();

    advanceMain('export const n = 2;\n');
    generate();
    git(ciDir, 'fetch', '-q', 'origin', 'staging');
    const secondTip = remoteStagingSha();

    expect(secondTip).not.toBe(firstTip);
    // Asserted directly: no history rewrite happened.
    expect(() => git(ciDir, 'merge-base', '--is-ancestor', firstTip, secondTip)).not.toThrow();
    // ...and it is a real merge commit: previous staging tip + the main tip it generated from.
    const parents = git(ciDir, 'rev-list', '--parents', '-n', '1', secondTip).trim().split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[1]).toBe(firstTip);
    expect(parents[2]).toBe(git(ciDir, 'ls-remote', originDir, 'refs/heads/main').split('\t')[0].trim());
    // The second generation bumps from STAGING's own version, and main's change came across.
    expect(versionAt(secondTip)).toBe('0.14.189');
    expect(git(ciDir, 'show', `${secondTip}:source.ts`)).toContain('export const n = 2;');
  }, 60_000);

  it('keeps the generated dist/ on staging across generations (main never carries it, the merge never deletes it)', () => {
    generate();
    advanceMain('export const n = 3;\n');
    generate();
    git(ciDir, 'fetch', '-q', 'origin', 'staging');
    const tip = remoteStagingSha();
    const tracked = git(ciDir, 'ls-tree', '-r', '--name-only', tip, '--', 'dist').trim().split('\n');
    expect(tracked.sort()).toEqual(['dist/bin/harmony.js', 'dist/index.js']);
  }, 60_000);

  it('fails closed on bootstrap when there is no prod branch and no explicit seed version', () => {
    git(seedDir, 'push', '-q', originDir, '--delete', 'prod');
    expect(() => generate()).toThrow();
    expect(git(ciDir, 'ls-remote', originDir, 'refs/heads/staging').trim()).toBe('');
  }, 60_000);

  it('never force-pushes or resets: no --force, --force-with-lease, checkout -B or reset --hard anywhere in the script', () => {
    // A prose-level guard on the ONE property the fixture tests above cannot observe after the
    // fact if it is ever added later: prod stops being an ancestor of staging the moment any of
    // these appears.
    expect(SCRIPT_CODE).not.toMatch(/--force/);
    expect(SCRIPT_CODE).not.toMatch(/\bpush\b[^\n]*\s-f\b/);
    expect(SCRIPT_CODE).not.toMatch(/checkout\s+-B\b/);
    expect(SCRIPT_CODE).not.toMatch(/reset\s+--hard/);
  });
});
