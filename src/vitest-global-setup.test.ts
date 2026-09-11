// B-1007: the vitest globalSetup's OWN contract (src/vitest-global-setup.ts).
//
// The property under test is "builds when dist/index.js is absent, no-ops when it is present, and
// fails loudly rather than letting the suite die with a misleading file-not-found". It is asserted
// by driving ensureDistBuilt() directly with INJECTED deps against a temp dir — never by deleting
// the real dist/, which would be hostile to the parallel workers this very hook exists to serve
// (and would be self-defeating: the setup that repaired it is the thing being tested).
//
// The one case injection cannot prove — that vitest actually CALLS it before the workers spawn — is
// covered by a config assertion below (the hook is wired under `test.globalSetup`) plus the live
// probe recorded on the ticket: with dist/ moved aside, the six dist-dependent tests in
// src/daemon/profile-contract.test.ts fail without this hook and pass with it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureDistBuilt, defaultDeps } from './vitest-global-setup.js';

/** A temp stand-in for the repo root, with no bundle in it. */
function scratchEntry(): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), 'b1007-global-setup-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  return { dir, entry: join(dir, 'dist', 'index.js') };
}

describe('vitest globalSetup: ensureDistBuilt (B-1007)', () => {
  it('is a NO-OP when the bundle is already present — it does not rebuild on every local run', () => {
    const { dir, entry } = scratchEntry();
    writeFileSync(entry, '// an already-built bundle\n');
    let buildCalls = 0;
    const logs: string[] = [];

    const outcome = ensureDistBuilt({
      distEntry: entry,
      exists: existsSync,
      build: () => {
        buildCalls += 1;
      },
      log: (m) => logs.push(m),
    });

    expect(outcome).toBe('already-present');
    expect(buildCalls).toBe(0);
    expect(logs).toEqual([]); // silent on the common path
    rmSync(dir, { recursive: true, force: true });
  });

  it('BUILDS exactly once when the bundle is missing, and reports it', () => {
    const { dir, entry } = scratchEntry();
    let buildCalls = 0;
    const logs: string[] = [];

    const outcome = ensureDistBuilt({
      distEntry: entry,
      exists: existsSync,
      build: () => {
        buildCalls += 1;
        writeFileSync(entry, '// freshly built\n'); // what `npm run build` would do
      },
      log: (m) => logs.push(m),
    });

    expect(outcome).toBe('built');
    expect(buildCalls).toBe(1);
    expect(existsSync(entry)).toBe(true);
    expect(logs.join('\n')).toContain('is missing');
    rmSync(dir, { recursive: true, force: true });
  });

  it('FAILS LOUDLY when the build fails — naming the build, not a missing file', () => {
    const { dir, entry } = scratchEntry();

    expect(() =>
      ensureDistBuilt({
        distEntry: entry,
        exists: existsSync,
        build: () => {
          throw new Error('esbuild: Command failed with exit code 1');
        },
        log: () => {},
      }),
    ).toThrow(/`npm run build` failed: esbuild: Command failed/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('FAILS LOUDLY when the build "succeeds" but leaves the entry missing', () => {
    const { dir, entry } = scratchEntry();

    expect(() =>
      ensureDistBuilt({
        distEntry: entry,
        exists: existsSync,
        build: () => {
          /* a build that writes nothing */
        },
        log: () => {},
      }),
    ).toThrow(/reported success but .* is still missing/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('the REAL deps point at this repo\'s own dist/index.js', () => {
    const deps = defaultDeps();
    expect(deps.distEntry.endsWith(join('dist', 'index.js'))).toBe(true);
    // ...and at the repo root, not at src/.
    expect(deps.distEntry).not.toContain(`${join('src', 'dist')}`);
  });

  it('is WIRED as vitest\'s globalSetup (not merely defined) — the hook that runs before the workers spawn', () => {
    const config = readFileSync(
      fileURLToPath(new URL('../vitest.config.ts', import.meta.url)),
      'utf8',
    );
    expect(config).toMatch(/globalSetup:\s*\["\.\/src\/vitest-global-setup\.ts"\]/);
  });
});
