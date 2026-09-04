// B-929 lever 1: container/activate-toolchain.sh's DECISION logic, executed for real.
//
// The script itself is run (bash, from disk — never a hand-retyped copy, matching this repo's
// "prose-pinned tests alone are not trusted" discipline in src/daemon/profile-contract.test.ts),
// with `fnm` and `corepack` replaced by stubs that record their argv. That makes the two things
// that actually matter assertable here, with no docker and no network:
//
//   * WHETHER it acts at all — the AC2 inertness property, which is a NEGATIVE and therefore only
//     credible if something asserts it;
//   * WHAT it asks the toolchain manager for — which declaration source won, and which version.
//
// What it deliberately does NOT prove: that fnm really installs that version and that `node
// --version` really changes. That needs the real binaries in the real image and is asserted by
// container/toolchain-contract.sh in CI. (It was also rehearsed live against the real fnm 1.39.0
// and corepack 0.34.6 during the B-929 build: .nvmrc 24.14.1 + packageManager pnpm@11.21.0 landed
// on node v24.14.1 / pnpm 11.21.0, and a fresh shell sourcing the persisted hook kept both.)

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../container/activate-toolchain.sh', import.meta.url));

interface Run {
  status: number | null;
  output: string;
  /** Every stubbed fnm/corepack invocation, in order, as "fnm <args>" / "corepack <args>". */
  calls: string[];
  home: string;
  repo: string;
}

/** Write the fnm/corepack stubs. `failResolveEngines` makes `fnm use … --resolve-engines` exit
 *  non-zero, which is how a fnm too old to carry that flag behaves. */
function makeStubs(dir: string, opts: { failResolveEngines?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'fnm'),
    [
      '#!/usr/bin/env bash',
      'echo "fnm $*" >> "$STUB_LOG"',
      'case "$1" in',
      '  env) echo "export FNM_STUB=1" ;;',
      '  current) echo "v24.14.1" ;;',
      '  use)',
      opts.failResolveEngines
        ? '    if printf "%s\\n" "$@" | grep -q -- --resolve-engines; then exit 1; fi'
        : '    :',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, 'corepack'),
    ['#!/usr/bin/env bash', 'echo "corepack $*" >> "$STUB_LOG"', 'exit 0', ''].join('\n'),
    { mode: 0o755 },
  );
}

function activate(
  files: Record<string, string>,
  opts: { failResolveEngines?: boolean; home?: string } = {},
): Run {
  const root = mkdtempSync(join(tmpdir(), 'b929-activate-'));
  const repo = join(root, 'repo');
  const home = opts.home ?? join(root, 'home');
  const stubs = join(root, 'stubs');
  const log = join(root, 'stub.log');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  makeStubs(stubs, opts);
  writeFileSync(log, '');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);

  const env = {
    ...process.env,
    HOME: home,
    STUB_LOG: log,
    FNM_DIR: join(home, '.fnm'),
    PATH: `${stubs}:${process.env.PATH}`,
  };
  let status: number | null = 0;
  let output: string;
  try {
    output = execFileSync('bash', [scriptPath, repo], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    const e = err as { status: number | null; stdout?: string; stderr?: string };
    status = e.status;
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const calls = readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '');
  return { status, output, calls, home, repo };
}

const NO_PINS = { 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }) };

describe('activate-toolchain.sh: AC2 inertness — a repo that declares nothing is untouched', () => {
  it('does nothing at all for a repo with no package.json and no version file', () => {
    const run = activate({});
    expect(run.status).toBe(0);
    expect(run.output).toContain('no toolchain pin declared');
    expect(run.calls).toEqual([]);
  });

  it('does nothing for a package.json with neither engines.node nor packageManager', () => {
    const run = activate(NO_PINS);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([]);
  });

  it('creates NO persistence file and edits NO shell rc when nothing is declared', () => {
    const run = activate(NO_PINS);
    expect(existsSync(join(run.home, '.harmony-toolchain.sh'))).toBe(false);
    expect(existsSync(join(run.home, '.bashrc'))).toBe(false);
    expect(existsSync(join(run.home, '.profile'))).toBe(false);
  });

  it('treats a MALFORMED package.json as declaring nothing, rather than failing the leg', () => {
    const run = activate({ 'package.json': '{ this is not json' });
    expect(run.status).toBe(0);
    expect(run.output).toContain('no toolchain pin declared');
    expect(run.calls).toEqual([]);
  });

  it('treats a package.json whose engines.node is not a string as declaring nothing', () => {
    const run = activate({ 'package.json': JSON.stringify({ engines: { node: { bad: true } } }) });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([]);
  });
});

describe('activate-toolchain.sh: which declaration source wins', () => {
  it('activates Node from .nvmrc', () => {
    const run = activate({ '.nvmrc': '24.14.1\n' });
    expect(run.status).toBe(0);
    expect(run.output).toContain(".nvmrc declares Node '24.14.1'");
    expect(run.calls).toContain('fnm use --install-if-missing --resolve-engines');
  });

  it('activates Node from .node-version when there is no .nvmrc', () => {
    const run = activate({ '.node-version': '24.14.1\n' });
    expect(run.output).toContain(".node-version declares Node '24.14.1'");
    expect(run.calls.some((c) => c.startsWith('fnm use'))).toBe(true);
  });

  it('activates Node from package.json engines.node when neither version file exists', () => {
    const run = activate({ 'package.json': JSON.stringify({ engines: { node: '24.14.1' } }) });
    expect(run.output).toContain("package.json engines.node declares Node '24.14.1'");
    expect(run.calls.some((c) => c.startsWith('fnm use'))).toBe(true);
  });

  it('prefers .nvmrc over engines.node when both are present', () => {
    const run = activate({
      '.nvmrc': '24.14.1\n',
      'package.json': JSON.stringify({ engines: { node: '18.0.0' } }),
    });
    expect(run.output).toContain('.nvmrc declares');
    expect(run.output).not.toContain('engines.node declares');
    expect(run.output).toContain('floor 24.14.1 as fallback');
  });

  it('ignores comment and blank lines in a .nvmrc', () => {
    const run = activate({ '.nvmrc': '# the version our CI uses\n\n24.14.1\n' });
    expect(run.output).toContain("declares Node '24.14.1'");
  });

  it('sets the ACTIVATED version as fnm\'s default alias, so later shells inherit it', () => {
    const run = activate({ '.nvmrc': '24.14.1\n' });
    // Keyed on `fnm current` (the concrete resolved version), never on the declared token.
    expect(run.calls).toContain('fnm alias v24.14.1 default');
  });
});

describe('activate-toolchain.sh: the engines.node fallback that does not need --resolve-engines', () => {
  it('falls back to an explicitly resolved version when fnm\'s own resolution fails', () => {
    const run = activate({ 'package.json': JSON.stringify({ engines: { node: '24.14.1' } }) }, {
      failResolveEngines: true,
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("fnm's own resolution did not settle");
    expect(run.calls).toContain('fnm use --install-if-missing 24.14.1');
  });

  it('resolves a semver RANGE at its floor on the fallback path (">=20.11.0" -> 20.11.0)', () => {
    const run = activate({ 'package.json': JSON.stringify({ engines: { node: '>=20.11.0' } }) }, {
      failResolveEngines: true,
    });
    expect(run.calls).toContain('fnm use --install-if-missing 20.11.0');
  });

  it('strips a leading "v" on the fallback path ("v22.11.0" -> 22.11.0)', () => {
    const run = activate({ '.nvmrc': 'v22.11.0\n' }, { failResolveEngines: true });
    expect(run.calls).toContain('fnm use --install-if-missing 22.11.0');
  });

  it('warns and skips the Node half when the declaration carries no version at all', () => {
    const run = activate({ 'package.json': JSON.stringify({ engines: { node: '*' } }) });
    expect(run.status).toBe(0);
    expect(run.output).toContain('carries no version-shaped token');
    expect(run.calls.some((c) => c.startsWith('fnm use'))).toBe(false);
  });
});

describe('activate-toolchain.sh: the package manager half', () => {
  it('enables ONLY the declared package manager, into $HOME/bin, and prepares the pinned version', () => {
    const run = activate({ 'package.json': JSON.stringify({ packageManager: 'pnpm@11.21.0' }) });
    expect(run.status).toBe(0);
    expect(run.calls).toContain(`corepack enable --install-directory ${run.home}/bin pnpm`);
    expect(run.calls).toContain('corepack prepare pnpm@11.21.0 --activate');
    // Never a bare `corepack enable`, which would also shim npm ahead of the image's own.
    expect(run.calls.some((c) => c === 'corepack enable')).toBe(false);
  });

  it('touches Node not at all when ONLY packageManager is declared', () => {
    const run = activate({ 'package.json': JSON.stringify({ packageManager: 'pnpm@11.21.0' }) });
    expect(run.calls.some((c) => c.startsWith('fnm'))).toBe(false);
  });

  it('activates BOTH halves when both are declared', () => {
    const run = activate({
      '.nvmrc': '24.14.1\n',
      'package.json': JSON.stringify({ packageManager: 'pnpm@11.21.0' }),
    });
    expect(run.calls.some((c) => c.startsWith('fnm use'))).toBe(true);
    expect(run.calls).toContain('corepack prepare pnpm@11.21.0 --activate');
  });
});

describe('activate-toolchain.sh: persistence for later shells', () => {
  it('writes the hook file and sources it from BOTH ~/.bashrc and ~/.profile', () => {
    const run = activate({ '.nvmrc': '24.14.1\n' });
    const hook = join(run.home, '.harmony-toolchain.sh');
    expect(existsSync(hook)).toBe(true);
    const body = readFileSync(hook, 'utf8');
    expect(body).toContain('fnm env --use-on-cd --shell bash'); // per-repo switching on cd
    expect(body).toContain('$HOME/bin'); // where the corepack shims live
    for (const rc of ['.bashrc', '.profile']) {
      expect(readFileSync(join(run.home, rc), 'utf8')).toContain('.harmony-toolchain.sh');
    }
  });

  it('is idempotent: a second activation does not duplicate the rc source line', () => {
    const first = activate({ '.nvmrc': '24.14.1\n' });
    const second = activate({ '.nvmrc': '24.14.1\n' }, { home: first.home });
    expect(second.status).toBe(0);
    const bashrc = readFileSync(join(first.home, '.bashrc'), 'utf8');
    expect(bashrc.split('.harmony-toolchain.sh').length - 1).toBe(2); // the guard + the source line, once
  });
});

describe('activate-toolchain.sh: argument handling', () => {
  it('skips a path that does not exist rather than failing', () => {
    const root = mkdtempSync(join(tmpdir(), 'b929-missing-'));
    const out = execFileSync('bash', [scriptPath, join(root, 'nope')], {
      env: { ...process.env, HOME: root },
      encoding: 'utf8',
    });
    expect(out).toBe(''); // the skip notice goes to stderr; the point is it exits 0
  });
});
