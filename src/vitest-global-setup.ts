// B-1007: build `dist/` once, before the test workers spawn, when it is not on disk.
//
// WHY THIS EXISTS. After the three-branch cutover `main` is SOURCE ONLY — `dist/` is gitignored
// here and generated on `staging` (scripts/generate-staging.sh). So a fresh clone, and a fresh CI
// checkout, both start with NO `dist/` on disk. Six tests in src/daemon/profile-contract.test.ts
// shell out to the real `dist/bin/harmony.js` (the bounded model-switch loop and the context-budget
// cases run provision.sh's real block against the real CLI), and they fail with a confusing
// "file not found" when the bundle is absent. `npm ci && npm test` on a clean checkout would go
// red, and in CI the `check` job runs Test BEFORE Build.
//
// This is not a new rule: it is the cutover's own principle — anything that reads the built bundle
// needs a build step ahead of it — applied to the third place its inventory missed. (The other two:
// the `container-base` CI job, which gains `npm ci && npm run build`, and `.harmony/project.yml`'s
// `verify:dist`, dropped because it degrades to a silent no-op pass.)
//
// WHY globalSetup rather than a `beforeAll`. Vitest runs test FILES in parallel workers, so a
// beforeAll in one file cannot guarantee the bundle exists for another file's worker — that race is
// exactly the failure mode here. `globalSetup` runs ONCE, in the main process, before any worker
// spawns, so every worker sees a built `dist/`.
//
// It is a NO-OP when `dist/index.js` is already present: a normal local run does not rebuild.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** What the check did — returned so a caller (and the unit test) can assert on it. */
export type EnsureDistBuiltOutcome = 'already-present' | 'built';

export interface EnsureDistBuiltDeps {
  /** The bundle entry whose absence means "nothing is built". */
  distEntry: string;
  /** Existence probe (injected so the unit test never touches the real dist/). */
  exists: (path: string) => boolean;
  /** Runs the repo's own build. Must THROW when the build fails. */
  build: () => void;
  /** Progress/diagnostic sink. */
  log: (message: string) => void;
}

/**
 * Ensure the built bundle is on disk, building it once if it is not.
 *
 * Fails LOUDLY — a failed build, or a build that somehow leaves the entry missing, throws with a
 * message naming the cause, so the suite dies with "the build failed" rather than with six
 * unrelated "cannot find dist/bin/harmony.js" test failures.
 */
export function ensureDistBuilt(deps: EnsureDistBuiltDeps): EnsureDistBuiltOutcome {
  if (deps.exists(deps.distEntry)) return 'already-present';

  deps.log(
    `[B-1007] ${deps.distEntry} is missing — running the build once before the test workers start. ` +
      "(`main` is source-only since the three-branch cutover; `dist/` is generated on `staging`.)",
  );

  try {
    deps.build();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[B-1007] the test suite needs a built dist/, and \`npm run build\` failed: ${reason}\n` +
        'Fix the build first — several tests shell out to dist/bin/harmony.js and would otherwise ' +
        'fail with a misleading "file not found".',
      { cause: err },
    );
  }

  if (!deps.exists(deps.distEntry)) {
    throw new Error(
      `[B-1007] \`npm run build\` reported success but ${deps.distEntry} is still missing. ` +
        'The test suite cannot run against an absent bundle.',
    );
  }

  deps.log('[B-1007] build complete — dist/ is present for the test workers.');
  return 'built';
}

/** The real dependencies: this repo's own `npm run build`, run from the repo root. */
export function defaultDeps(): EnsureDistBuiltDeps {
  return {
    distEntry: join(ROOT, 'dist', 'index.js'),
    exists: existsSync,
    build: () => {
      execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    },
    log: (message: string) => console.warn(message),
  };
}

/** Vitest's globalSetup entry point — runs once, in the main process, before any worker spawns. */
export default function setup(): void {
  ensureDistBuilt(defaultDeps());
}
