// B-1007: the INVERTED PR gate (scripts/check-generated-artifacts.sh).
//
// Under the three-branch topology `main` is SOURCE ONLY — the version and the built `dist/` are
// generated on `staging` — so a PR into `main` must carry NEITHER. The gate that used to demand a
// version bump (B-778) now forbids one, and it keeps B-778's fail-closed property: anything it
// cannot evaluate FAILS, it never silently passes.
//
// Every case below drives the REAL script against a LOCAL git fixture repo built in a temp dir:
// no network, no GitHub, no App token, and — via GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM pointed at
// non-existent files plus an explicit author/committer identity — no read of the developer's own
// git config.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-generated-artifacts.sh', import.meta.url));

function commandAvailable(cmd: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Capability probe only — never keyed on any assertion's expected outcome, so a host missing the
 *  tools skips loudly instead of turning a real regression into a green run. */
const CAPABLE = commandAvailable('bash') && commandAvailable('git') && commandAvailable('node');
if (!CAPABLE) {
  console.warn(
    '[B-1007] SKIPPING check-generated-artifacts.sh tests: this host lacks bash, git or node on PATH.',
  );
}

let root: string;
let repo: string;
let hermeticEnv: NodeJS.ProcessEnv;

/** Run a git command inside the fixture repo with a hermetic config. */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: hermeticEnv, encoding: 'utf8' });
}

function writeManifest(version: string): void {
  writeFileSync(
    join(repo, '.claude-plugin', 'plugin.json'),
    `{\n  "name": "harmony-plugin",\n  "version": "${version}"\n}\n`,
  );
}

/** Run the gate. Returns its exit code plus the combined output, never throwing. */
function runGate(baseRef: string, headRef: string): { code: number; output: string } {
  try {
    const output = execFileSync('bash', [SCRIPT, baseRef, headRef], {
      cwd: repo,
      env: hermeticEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The PRE-cutover shape of `main`: tracked dist/ and a real published version. */
let PRE_CUTOVER = '';
/** The POST-cutover shape of `main`: no tracked dist/, version inert at 0.0.0-dev. */
let POST_CUTOVER = '';

describe.skipIf(!CAPABLE)('check-generated-artifacts.sh (B-1007 inverted PR gate)', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'b1007-gate-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    hermeticEnv = {
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

    git('init', '-q', '-b', 'main');
    mkdirSync(join(repo, '.claude-plugin'));
    mkdirSync(join(repo, 'dist', 'bin'), { recursive: true });
    writeManifest('0.14.187');
    writeFileSync(join(repo, 'dist', 'index.js'), '// generated bundle\n');
    writeFileSync(join(repo, 'dist', 'bin', 'harmony.js'), '// generated bin\n');
    writeFileSync(join(repo, 'README.md'), 'source\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'pre-cutover main: tracked dist + a real version');
    PRE_CUTOVER = git('rev-parse', 'HEAD').trim();

    // The cutover itself: untrack dist/, gitignore it, and set the inert version.
    git('checkout', '-q', '-b', 'cutover');
    git('rm', '-r', '-q', '--cached', 'dist');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
    writeManifest('0.0.0-dev');
    git('add', '-A');
    git('commit', '-q', '-m', 'B-1007 cutover: main goes source-only');
    POST_CUTOVER = git('rev-parse', 'HEAD').trim();
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Branch a head off `from`, apply `mutate`, commit, and return the head sha. */
  function headBranch(name: string, from: string, mutate: () => void): string {
    git('checkout', '-q', from);
    git('checkout', '-q', '-b', name);
    mutate();
    git('add', '-A');
    git('commit', '-q', '-m', `fixture head: ${name}`);
    return git('rev-parse', 'HEAD').trim();
  }

  it('PASSES the one allowed transition: the cutover signature (base tracks dist AND is on a real version; head has neither)', () => {
    const result = runGate(PRE_CUTOVER, POST_CUTOVER);
    expect(result.output).toContain('cutover signature');
    expect(result.code).toBe(0);
  });

  it('FORBIDS a PR that only deletes dist/ — that is not the cutover signature', () => {
    const head = headBranch('only-deletes-dist', PRE_CUTOVER, () => {
      git('rm', '-r', '-q', '--cached', 'dist');
      writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    });
    const result = runGate(PRE_CUTOVER, head);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('dist/');
  });

  it('FORBIDS a PR that only sets the inert version — that is not the cutover signature either', () => {
    const head = headBranch('only-inert-version', PRE_CUTOVER, () => writeManifest('0.0.0-dev'));
    const result = runGate(PRE_CUTOVER, head);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("version changed (0.14.187 -> 0.0.0-dev)");
  });

  it('FORBIDS an ordinary PR that bumps the version (the B-778 gate, inverted)', () => {
    const head = headBranch('bumps-version', POST_CUTOVER, () => writeManifest('0.14.188'));
    const result = runGate(POST_CUTOVER, head);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('version changed (0.0.0-dev -> 0.14.188)');
    expect(result.output).toContain('GENERATED on `staging`');
  });

  it('FORBIDS an ordinary PR that touches a path under dist/', () => {
    const head = headBranch('touches-dist', POST_CUTOVER, () => {
      mkdirSync(join(repo, 'dist'), { recursive: true });
      writeFileSync(join(repo, 'dist', 'index.js'), '// hand-edited bundle\n');
      git('add', '-f', 'dist/index.js');
    });
    const result = runGate(POST_CUTOVER, head);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('dist/index.js');
  });

  it('PASSES an ordinary source-only PR (no version change, no dist/ change)', () => {
    const head = headBranch('source-only', POST_CUTOVER, () =>
      writeFileSync(join(repo, 'README.md'), 'source\nmore source\n'),
    );
    const result = runGate(POST_CUTOVER, head);
    expect(result.output).toContain('no version change and no dist/ change');
    expect(result.code).toBe(0);
  });

  describe('fail-closed (B-778 property, deliberately preserved)', () => {
    it('FAILS on an unparseable manifest rather than passing it through', () => {
      const head = headBranch('malformed-manifest', POST_CUTOVER, () =>
        writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), '{"version":\n'),
      );
      const result = runGate(POST_CUTOVER, head);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('failing closed');
    });

    it('FAILS when the manifest is missing entirely at head', () => {
      const head = headBranch('no-manifest', POST_CUTOVER, () =>
        git('rm', '-q', '.claude-plugin/plugin.json'),
      );
      const result = runGate(POST_CUTOVER, head);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('failing closed');
    });

    it('FAILS when the version is present but not a semver', () => {
      const head = headBranch('non-semver', POST_CUTOVER, () =>
        writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), '{"version": "latest"}\n'),
      );
      const result = runGate(POST_CUTOVER, head);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('failing closed');
    });

    it('FAILS when the base ref is unreadable', () => {
      const result = runGate('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', POST_CUTOVER);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('failing closed');
    });

    it('FAILS when no base ref is given at all', () => {
      const result = runGate('', POST_CUTOVER);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('failing closed');
    });
  });
});
