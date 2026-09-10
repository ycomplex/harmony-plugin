// B-991: unit coverage for `harmony gates run <extension-point>` — both the pure, dependency-
// injected core (`runGatesCommand`) and a CLI-entry-level proof of the load-bearing AC4 floor (no
// manifest + no HARMONY_API_TOKEN ⇒ exit 0, one quiet line, ZERO network calls).

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { runGatesCommand, registerGatesCommands, type GatesRunDeps, type StepRunOutcome } from './gates.js';
import type { ManifestLoadResult } from '../../config/project-manifest.js';
import type { AuthenticatedContext } from '../auth.js';

// =================================================================================================
// runGatesCommand — the pure core.
// =================================================================================================

function baseDeps(overrides: Partial<GatesRunDeps> = {}): GatesRunDeps & {
  logLines: string[];
  errorLines: string[];
  authCalls: number;
  runStepCalls: { command: string; cwd: string }[];
  landEvidenceCalls: unknown[];
} {
  const logLines: string[] = [];
  const errorLines: string[] = [];
  const runStepCalls: { command: string; cwd: string }[] = [];
  const landEvidenceCalls: unknown[] = [];
  let authCalls = 0;

  const authCtx: AuthenticatedContext = {
    client: {} as AuthenticatedContext['client'],
    projectId: 'proj-1',
    userId: 'user-1',
  };

  const deps: GatesRunDeps = {
    projectRoot: '/fake/project',
    extensionPoint: 'build.before_pr',
    loadManifest: () => ({ kind: 'absent' }),
    runStep: (command, cwd) => {
      runStepCalls.push({ command, cwd });
      return { code: 0 };
    },
    getAuthenticatedContext: async () => {
      authCalls++;
      return authCtx;
    },
    getConductionId: () => 'cond-1',
    resolveTaskId: async () => 'task-1',
    landEvidence: async (...args) => {
      landEvidenceCalls.push(args);
    },
    log: (line) => logLines.push(line),
    error: (line) => errorLines.push(line),
    ...overrides,
  };

  return {
    ...deps,
    logLines,
    errorLines,
    get authCalls() {
      return authCalls;
    },
    runStepCalls,
    landEvidenceCalls,
  } as GatesRunDeps & {
    logLines: string[];
    errorLines: string[];
    authCalls: number;
    runStepCalls: { command: string; cwd: string }[];
    landEvidenceCalls: unknown[];
  };
}

describe('runGatesCommand — unrecognized extension point', () => {
  it('exits 1 and names the bad value, without ever loading a manifest', async () => {
    const loadManifest = vi.fn();
    const deps = baseDeps({ extensionPoint: 'not.a.real.point', loadManifest });
    const code = await runGatesCommand(deps);
    expect(code).toBe(1);
    expect(loadManifest).not.toHaveBeenCalled();
    expect(deps.errorLines[0]).toContain('not.a.real.point');
  });
});

describe('runGatesCommand — manifest ABSENT (AC4 floor)', () => {
  it('exits 0, prints exactly one quiet no-op line, and NEVER acquires authenticated context', async () => {
    const deps = baseDeps({ loadManifest: () => ({ kind: 'absent' }) });
    const code = await runGatesCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines).toHaveLength(1);
    expect(deps.errorLines).toHaveLength(0);
    expect(deps.authCalls).toBe(0);
    expect(deps.runStepCalls).toHaveLength(0);
  });
});

describe('runGatesCommand — manifest present but declares nothing for this extension point', () => {
  it('exits 0, one quiet no-op line, no authenticated context acquired', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1 },
      stepErrors: {},
    };
    const deps = baseDeps({ loadManifest: () => ok });
    const code = await runGatesCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines).toHaveLength(1);
    expect(deps.authCalls).toBe(0);
    expect(deps.runStepCalls).toHaveLength(0);
  });

  it('a manifest declaring only release.before_merge is still a no-op for build.before_pr', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1, release: { before_merge: [{ run: 'npm run build' }] } },
      stepErrors: {},
    };
    const deps = baseDeps({ extensionPoint: 'build.before_pr', loadManifest: () => ok });
    const code = await runGatesCommand(deps);
    expect(code).toBe(0);
    expect(deps.authCalls).toBe(0);
    expect(deps.runStepCalls).toHaveLength(0);
  });
});

describe('runGatesCommand — MALFORMED manifest (AC5)', () => {
  it('exits non-zero, names the file and the specific problem, never authenticates, runs no steps', async () => {
    const malformed: ManifestLoadResult = {
      kind: 'malformed',
      problem: {
        file: '/fake/project/.harmony/project.yml',
        reason: 'invalid-yaml',
        message: '/fake/project/.harmony/project.yml: invalid YAML — bad indentation',
      },
    };
    const deps = baseDeps({ loadManifest: () => malformed });
    const code = await runGatesCommand(deps);
    expect(code).not.toBe(0);
    expect(deps.errorLines[0]).toContain('/fake/project/.harmony/project.yml');
    expect(deps.errorLines[0]).toContain('invalid YAML');
    expect(deps.authCalls).toBe(0);
    expect(deps.runStepCalls).toHaveLength(0);
  });

  it('a problem scoped to ONE extension point (missing-script) fails loud for that point without ever authenticating', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1, build: { before_pr: [{ run: './scripts/missing.sh' }] } },
      stepErrors: {
        'build.before_pr': {
          file: '/fake/project/.harmony/project.yml',
          reason: 'missing-script',
          message: "missing script './scripts/missing.sh'",
        },
      },
    };
    const deps = baseDeps({ extensionPoint: 'build.before_pr', loadManifest: () => ok });
    const code = await runGatesCommand(deps);
    expect(code).not.toBe(0);
    expect(deps.errorLines[0]).toContain('missing.sh');
    expect(deps.authCalls).toBe(0);
  });

  it('an agent_task: step fails loud for its own extension point only', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1, verify: { before_ack: [{ agent_task: 'review notes' }] } },
      stepErrors: {
        'verify.before_ack': {
          file: '/fake/project/.harmony/project.yml',
          reason: 'unsupported-agent-task',
          message: "verify.before_ack declares an 'agent_task:' step",
        },
      },
    };
    const deps = baseDeps({ extensionPoint: 'verify.before_ack', loadManifest: () => ok });
    const code = await runGatesCommand(deps);
    expect(code).not.toBe(0);
    expect(deps.errorLines[0]).toContain('agent_task');
  });
});

describe('runGatesCommand — real steps to run', () => {
  it('acquires authenticated context exactly once, only after confirming steps exist', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1, release: { before_merge: [{ run: 'npm run build' }] } },
      stepErrors: {},
    };
    const deps = baseDeps({ extensionPoint: 'release.before_merge', loadManifest: () => ok });
    const code = await runGatesCommand(deps);
    expect(code).toBe(0);
    expect(deps.authCalls).toBe(1);
    expect(deps.runStepCalls).toEqual([{ command: 'npm run build', cwd: '/fake/project' }]);
  });

  it('build.before_pr prints declared preconditions (data only) before running its own steps', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: {
        version: 1,
        preconditions: ['isolate worktrees inside the child repo', 'symlink gitignored env files'],
        build: { before_pr: [{ run: 'npm run lint' }] },
      },
      stepErrors: {},
    };
    const deps = baseDeps({ extensionPoint: 'build.before_pr', loadManifest: () => ok });
    const code = await runGatesCommand(deps);
    expect(code).toBe(0);
    const preconditionLines = deps.logLines.filter((l) => l.includes('isolate worktrees') || l.includes('symlink gitignored'));
    expect(preconditionLines).toHaveLength(2);
    // Preconditions are printed BEFORE the step-execution log lines.
    const preconditionIdx = deps.logLines.findIndex((l) => l.includes('isolate worktrees'));
    const stepIdx = deps.logLines.findIndex((l) => l.includes('running: npm run lint'));
    expect(preconditionIdx).toBeLessThan(stepIdx);
  });

  it('runs multiple run: steps IN ORDER, stopping at the first failure and naming it', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: {
        version: 1,
        release: {
          before_merge: [{ run: 'npm run build' }, { run: 'npm run verify:dist' }, { run: 'npm run never-reached' }],
        },
      },
      stepErrors: {},
    };
    const seen: string[] = [];
    const runStep = (command: string): StepRunOutcome => {
      seen.push(command);
      return command === 'npm run verify:dist' ? { code: 2 } : { code: 0 };
    };
    const deps = baseDeps({ extensionPoint: 'release.before_merge', loadManifest: () => ok, runStep });
    const code = await runGatesCommand(deps);
    expect(code).toBe(2);
    expect(seen).toEqual(['npm run build', 'npm run verify:dist']);
    expect(deps.errorLines.some((l) => l.includes('verify:dist') && l.includes('FAILED'))).toBe(true);
  });

  it('a spawn error (process could not even start) also fails the command loudly', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1, build: { before_pr: [{ run: './scripts/x.sh' }] } },
      stepErrors: {},
    };
    const runStep = (): StepRunOutcome => ({ code: null, error: new Error('ENOENT') });
    const deps = baseDeps({ extensionPoint: 'build.before_pr', loadManifest: () => ok, runStep });
    const code = await runGatesCommand(deps);
    expect(code).not.toBe(0);
    expect(deps.errorLines[0]).toContain('ENOENT');
  });

  it('lands exactly ONE evidence entry, typed integration, after a fully successful run', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1, release: { before_merge: [{ run: 'npm run build' }] } },
      stepErrors: {},
    };
    const deps = baseDeps({ extensionPoint: 'release.before_merge', loadManifest: () => ok });
    const code = await runGatesCommand(deps);
    expect(code).toBe(0);
    expect(deps.landEvidenceCalls).toHaveLength(1);
    const [, taskId, point, stepCount] = deps.landEvidenceCalls[0] as [unknown, string, string, number];
    expect(taskId).toBe('task-1');
    expect(point).toBe('release.before_merge');
    expect(stepCount).toBe(1);
  });

  it('never lands evidence on the no-op floor path', async () => {
    const deps = baseDeps({ loadManifest: () => ({ kind: 'absent' }) });
    await runGatesCommand(deps);
    expect(deps.landEvidenceCalls).toHaveLength(0);
  });

  it('a step that runs but cannot authenticate still completes the run, just skips evidence landing', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1, verify: { before_ack: [{ run: 'npm test' }] } },
      stepErrors: {},
    };
    const deps = baseDeps({
      extensionPoint: 'verify.before_ack',
      loadManifest: () => ok,
      getAuthenticatedContext: async () => {
        throw new Error('no login');
      },
    });
    const code = await runGatesCommand(deps);
    expect(code).toBe(0);
    expect(deps.runStepCalls).toHaveLength(1);
    expect(deps.landEvidenceCalls).toHaveLength(0);
    expect(deps.errorLines.some((l) => l.includes('no login'))).toBe(true);
  });

  it('a step that runs but resolves no task id (no conduction) still completes, skips evidence landing', async () => {
    const ok: ManifestLoadResult = {
      kind: 'ok',
      file: '/fake/project/.harmony/project.yml',
      manifest: { version: 1, verify: { before_ack: [{ run: 'npm test' }] } },
      stepErrors: {},
    };
    const deps = baseDeps({
      extensionPoint: 'verify.before_ack',
      loadManifest: () => ok,
      getConductionId: () => undefined,
    });
    const code = await runGatesCommand(deps);
    expect(code).toBe(0);
    expect(deps.landEvidenceCalls).toHaveLength(0);
  });
});

// =================================================================================================
// CLI-entry-level proof of the AC4 floor: no manifest + no HARMONY_API_TOKEN ⇒ exit 0, one quiet
// line, and getAuthenticatedContext (the real auth module, mocked here) is NEVER called.
// =================================================================================================

const authMock = vi.hoisted(() => ({ getAuthenticatedContext: vi.fn() }));
vi.mock('../auth.js', () => authMock);

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function makeProgram(): Command {
  const program = new Command();
  program.name('harmony').option('--json', 'Output results as JSON', false);
  registerGatesCommands(program);
  return program;
}

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;
let cwdSpy: MockInstance;
let emptyDir: string;

beforeEach(() => {
  emptyDir = mkdtempSync(join(tmpdir(), 'b991-cli-gates-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
  vi.stubEnv('HARMONY_API_TOKEN', '');
});

afterEach(() => {
  authMock.getAuthenticatedContext.mockReset();
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  cwdSpy.mockRestore();
  vi.unstubAllEnvs();
  rmSync(emptyDir, { recursive: true, force: true });
});

describe('harmony gates run — CLI entry, AC4 floor with no manifest and no HARMONY_API_TOKEN', () => {
  it('exits 0, prints only the quiet no-op line, and never calls getAuthenticatedContext (no network call)', async () => {
    await expect(makeProgram().parseAsync(['gates', 'run', 'build.before_pr'], { from: 'user' })).rejects.toThrow(
      ExitSentinel,
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
    expect(authMock.getAuthenticatedContext).not.toHaveBeenCalled();
  });
});
