// B-1478: every run-time path the plugin's workers and conductor read is real.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONDUCTOR_GENERATED, CONDUCTOR_TRACKED, RUNTIME_GENERATED_PATHS, RUNTIME_TRACKED_PATHS, WORKER_GENERATED, WORKER_TRACKED,
} from './runtime-paths.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}
const FILES = trackedFiles();
const IN_GIT = FILES.length > 0;

describe.skipIf(!IN_GIT)('B-1478 run-time paths: every tracked path exists in git ls-files', () => {
  it.each(RUNTIME_TRACKED_PATHS.map((p) => [p]))('%s', (p) => {
    const hit = p.endsWith('/') ? FILES.some((f) => f.startsWith(p)) : FILES.includes(p);
    expect(hit, `${p} is not tracked`).toBe(true);
  });

  it('no generated path is tracked on this branch (main is source-only)', () => {
    for (const p of RUNTIME_GENERATED_PATHS) expect(FILES.includes(p), p).toBe(false);
  });

  it('a mutated path is caught (positive control)', () => {
    expect(FILES.includes('container/provision.sh')).toBe(true);
    expect(FILES.includes('container/provision-renamed.sh')).toBe(false);
  });
});

describe('B-1478 run-time paths: the generated list is what `npm run build` produces', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const entries = [...pkg.scripts.build.matchAll(/src\/(\S+)\.ts/g)].map((m) => `dist/${m[1]}.js`);

  it.each(RUNTIME_GENERATED_PATHS.map((p) => [p]))('%s', (p) => {
    if (p === 'dist/THIRD_PARTY_NOTICES') {
      expect(pkg.scripts.postbuild).toContain('generate-third-party-notices.mjs');
      return;
    }
    expect(entries, `${p} is not an esbuild entry point of npm run build`).toContain(p);
  });

  it('the lists have no duplicates and use plugin-root-relative paths', () => {
    for (const list of [WORKER_TRACKED, WORKER_GENERATED, CONDUCTOR_TRACKED, CONDUCTOR_GENERATED]) {
      const paths = list.map((p) => p.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const p of paths) expect(p.startsWith('/') || p.includes('..')).toBe(false);
    }
  });

  it('the worker list carries the release marker the entrypoint checks', () => {
    expect(WORKER_TRACKED.map((p) => p.path)).toContain('container/release-runtime');
    expect(readFileSync(join(REPO, 'container/entrypoint.sh'), 'utf8')).toContain('container/release-runtime');
  });
});
