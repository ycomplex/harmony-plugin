// B-992: unit coverage for the PreToolUse gate's pure-ish, dependency-injected core — the actor
// total function, each boundary-tool matcher (including its exclusions), marker freshness, the
// verify.before_ack confirm-before-deny flow, the escape hatch, and the outer fail-open floor.

import { describe, it, expect, afterEach } from 'vitest';
import {
  decidePreToolUseGate,
  determineActor,
  matchBoundaryTool,
  parseGateOverride,
  parseOwnerRepoSlug,
  readMarkerFreshness,
  runPreToolUseGate,
  GATE_OVERRIDE_ENV,
  type GateEvidenceMarker,
  type PreToolUseGateDeps,
  type PreToolUseGateRunnerDeps,
  type PreToolUseHookInput,
} from './pretooluse-gate.js';
import { loadProjectManifest, type ManifestLoadResult } from '../config/project-manifest.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedContext } from '../cli/auth.js';

// =================================================================================================
// determineActor — a TOTAL function over three real-world states, collapsed to two outcomes.
// =================================================================================================

describe('determineActor — AC3', () => {
  it('HARMONY_CONDUCTION_ID present ⇒ worker', () => {
    expect(determineActor({ HARMONY_CONDUCTION_ID: 'cond-1' })).toBe('worker');
  });
  it('HARMONY_CONDUCTION_ID absent ⇒ human-or-ambiguous (never denied)', () => {
    expect(determineActor({})).toBe('human-or-ambiguous');
  });
  it('an EMPTY HARMONY_CONDUCTION_ID is treated the SAME as absent by getConductionId itself (envValue collapses "" to undefined) — human-or-ambiguous', () => {
    // determineActor invents no second signal — it just reflects whatever getConductionId says an
    // absent/blank value means, and getConductionId (run-config.ts's envValue) already treats a
    // blank export as "not set".
    expect(determineActor({ HARMONY_CONDUCTION_ID: '' })).toBe('human-or-ambiguous');
  });
});

// =================================================================================================
// matchBoundaryTool — the three fixed extension points' matchers.
// =================================================================================================

describe('matchBoundaryTool — build.before_pr (gh pr create)', () => {
  it('matches a plain gh pr create in this repo', () => {
    expect(matchBoundaryTool('Bash', { command: 'gh pr create --title x --body y' }, 'me/repo')).toBe(
      'build.before_pr',
    );
  });
  it('does NOT match gh pr create --help', () => {
    expect(matchBoundaryTool('Bash', { command: 'gh pr create --help' }, 'me/repo')).toBeNull();
  });
  it('does NOT match gh pr create -h', () => {
    expect(matchBoundaryTool('Bash', { command: 'gh pr create -h' }, 'me/repo')).toBeNull();
  });
  it('does NOT match when --repo names a DIFFERENT repo', () => {
    expect(
      matchBoundaryTool('Bash', { command: 'gh pr create --repo other/repo --title x' }, 'me/repo'),
    ).toBeNull();
  });
  it('DOES match when --repo names THIS SAME repo (case-insensitive)', () => {
    expect(
      matchBoundaryTool('Bash', { command: 'gh pr create --repo Me/Repo --title x' }, 'me/repo'),
    ).toBe('build.before_pr');
  });
  it('does NOT match when --repo is present but the current repo could not be resolved (fail-open toward non-match)', () => {
    expect(
      matchBoundaryTool('Bash', { command: 'gh pr create --repo other/repo --title x' }, null),
    ).toBeNull();
  });
  it('a bare git push never matches (no "gh pr create" substring at all)', () => {
    expect(matchBoundaryTool('Bash', { command: 'git push origin HEAD' }, 'me/repo')).toBeNull();
  });
  it('a non-Bash tool call never matches this matcher', () => {
    expect(matchBoundaryTool('Read', { file_path: '/tmp/x' }, 'me/repo')).toBeNull();
  });
});

describe('matchBoundaryTool — release.before_merge (gh pr merge)', () => {
  it('matches a plain gh pr merge in this repo', () => {
    expect(matchBoundaryTool('Bash', { command: 'gh pr merge 42 --squash' }, 'me/repo')).toBe(
      'release.before_merge',
    );
  });
  it('does NOT match gh pr merge --help', () => {
    expect(matchBoundaryTool('Bash', { command: 'gh pr merge --help' }, 'me/repo')).toBeNull();
  });
  it('does NOT match when -R names a different repo', () => {
    expect(
      matchBoundaryTool('Bash', { command: 'gh pr merge 42 -R other/repo --squash' }, 'me/repo'),
    ).toBeNull();
  });
});

describe('matchBoundaryTool — verify.before_ack (resolve_brief accept)', () => {
  it('matches the bare MCP tool name', () => {
    expect(matchBoundaryTool('mcp__harmony__resolve_brief', { command: 'accept', task_id: 'B-1' }, null)).toBe(
      'verify.before_ack',
    );
  });
  it('matches the marketplace/installed-plugin NAMESPACED tool name (the live-captured shape — suffix match, never a hardcoded prefix)', () => {
    expect(
      matchBoundaryTool(
        'mcp__plugin_harmony-plugin_harmony__resolve_brief',
        { command: 'accept', task_id: 'B-1' },
        null,
      ),
    ).toBe('verify.before_ack');
  });
  it('does NOT match a resolve_brief DEFER', () => {
    expect(
      matchBoundaryTool('mcp__plugin_harmony-plugin_harmony__resolve_brief', { command: 'defer' }, null),
    ).toBeNull();
  });
  it('does NOT match an unrelated tool name that merely CONTAINS resolve_brief in the middle', () => {
    expect(matchBoundaryTool('resolve_brief_something_else', { command: 'accept' }, null)).toBeNull();
  });
});

// =================================================================================================
// readMarkerFreshness
// =================================================================================================

describe('readMarkerFreshness', () => {
  const marker: GateEvidenceMarker = {
    extension_point: 'build.before_pr',
    conduction_id: 'cond-1',
    head_sha: 'abc123',
    ran_at: '2026-01-01T00:00:00.000Z',
    evidence_landed: true,
  };

  it('null marker ⇒ absent', () => {
    expect(readMarkerFreshness(null, 'abc123', 'cond-1')).toBe('absent');
  });
  it('HEAD mismatch ⇒ stale', () => {
    expect(readMarkerFreshness(marker, 'def456', 'cond-1')).toBe('stale');
  });
  it('conduction mismatch ⇒ stale (a different leg cannot wave this one through)', () => {
    expect(readMarkerFreshness(marker, 'abc123', 'cond-2')).toBe('stale');
  });
  it('HEAD and conduction both match ⇒ fresh', () => {
    expect(readMarkerFreshness(marker, 'abc123', 'cond-1')).toBe('fresh');
  });
  it('marker.conduction_id "none" matches an undefined current conduction', () => {
    const noneMarker: GateEvidenceMarker = { ...marker, conduction_id: 'none' };
    expect(readMarkerFreshness(noneMarker, 'abc123', undefined)).toBe('fresh');
  });
});

// =================================================================================================
// parseGateOverride
// =================================================================================================

describe('parseGateOverride', () => {
  it('parses <point>:<reason>', () => {
    expect(parseGateOverride('build.before_pr:hotfix, ran manually')).toEqual({
      point: 'build.before_pr',
      reason: 'hotfix, ran manually',
    });
  });
  it('a reason containing colons keeps them all (splits on the FIRST colon only)', () => {
    expect(parseGateOverride('verify.before_ack:see https://example.com/x:y')).toEqual({
      point: 'verify.before_ack',
      reason: 'see https://example.com/x:y',
    });
  });
  it('undefined ⇒ null', () => {
    expect(parseGateOverride(undefined)).toBeNull();
  });
  it('no colon ⇒ null', () => {
    expect(parseGateOverride('build.before_pr')).toBeNull();
  });
  it('blank reason ⇒ null', () => {
    expect(parseGateOverride('build.before_pr:')).toBeNull();
  });
});

// =================================================================================================
// parseOwnerRepoSlug
// =================================================================================================

describe('parseOwnerRepoSlug', () => {
  it('parses an SSH URL', () => {
    expect(parseOwnerRepoSlug('git@github.com:ycomplex/harmony-plugin.git')).toBe('ycomplex/harmony-plugin');
  });
  it('parses an HTTPS URL', () => {
    expect(parseOwnerRepoSlug('https://github.com/ycomplex/harmony-plugin.git')).toBe(
      'ycomplex/harmony-plugin',
    );
  });
  it('parses an HTTPS URL with no .git suffix', () => {
    expect(parseOwnerRepoSlug('https://github.com/ycomplex/harmony-plugin')).toBe('ycomplex/harmony-plugin');
  });
  it('an unparseable string ⇒ null', () => {
    expect(parseOwnerRepoSlug('not a url')).toBeNull();
  });
});

// =================================================================================================
// decidePreToolUseGate — the whole decision tree.
// =================================================================================================

interface Harness {
  deps: PreToolUseGateDeps;
  logs: string[];
  addCommentCalls: { taskId: string; content: string }[];
  queryCalls: string[];
}

function harness(over: Partial<PreToolUseGateDeps> = {}): Harness {
  const logs: string[] = [];
  const addCommentCalls: { taskId: string; content: string }[] = [];
  const queryCalls: string[] = [];

  const okManifestWithSteps = (point: string): ManifestLoadResult => ({
    kind: 'ok',
    file: '/repo/.harmony/project.yml',
    manifest: {
      version: 1,
      ...(point === 'build.before_pr' ? { build: { before_pr: [{ run: 'npm run lint' }] } } : {}),
      ...(point === 'release.before_merge'
        ? { release: { before_merge: [{ run: 'npm run build' }] } }
        : {}),
      ...(point === 'verify.before_ack' ? { verify: { before_ack: [{ run: 'npm test' }] } } : {}),
    },
    stepErrors: {},
  });

  const authCtx: AuthenticatedContext = {
    client: {} as AuthenticatedContext['client'],
    projectId: 'proj-1',
    userId: 'user-1',
  };

  const deps: PreToolUseGateDeps = {
    env: { HARMONY_CONDUCTION_ID: 'cond-1' },
    projectRoot: '/repo',
    loadManifest: () => okManifestWithSteps('build.before_pr'),
    resolveCurrentRepoSlug: () => 'me/repo',
    resolveHeadSha: () => 'headsha',
    readMarker: () => null,
    queryAwaitingReason: async (taskId) => {
      queryCalls.push(taskId);
      return null;
    },
    getAuthenticatedContext: async () => authCtx,
    resolveTaskId: async () => 'task-from-conduction',
    addComment: async (_client, _projectId, _userId, taskId, content) => {
      addCommentCalls.push({ taskId, content });
    },
    log: (line) => logs.push(line),
    ...over,
  };

  return { deps, logs, addCommentCalls, queryCalls };
}

const BASH_PR_CREATE: PreToolUseHookInput = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'gh pr create --title x' },
};

const BASH_PR_MERGE: PreToolUseHookInput = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'gh pr merge 1 --squash' },
};

const VERIFY_ACCEPT: PreToolUseHookInput = {
  hook_event_name: 'PreToolUse',
  tool_name: 'mcp__plugin_harmony-plugin_harmony__resolve_brief',
  tool_input: { task_id: 'B-1', command: 'accept', provenance: 'human-in-session' },
};

describe('decidePreToolUseGate — not a boundary-tool call', () => {
  it('allows a non-matching call regardless of actor or manifest', async () => {
    const h = harness();
    const d = await decidePreToolUseGate({ tool_name: 'Read', tool_input: {} }, h.deps);
    expect(d.action).toBe('allow');
  });
});

describe('decidePreToolUseGate — AC3: only a positively-identified worker can ever be denied', () => {
  it('a human-or-ambiguous actor is ALLOWED even though the gate would otherwise deny', async () => {
    const h = harness({ env: {}, readMarker: () => null });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
  });

  it('a worker actor with no fresh marker is DENIED', async () => {
    const h = harness({ readMarker: () => null });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('deny');
  });
});

describe('decidePreToolUseGate — the no-op floor (AC2/AC4)', () => {
  it('an ABSENT manifest allows a worker through', async () => {
    const h = harness({ loadManifest: () => ({ kind: 'absent' }) });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
  });

  it('a MALFORMED manifest allows a worker through (fail open)', async () => {
    const h = harness({
      loadManifest: () => ({
        kind: 'malformed',
        problem: { file: '/repo/.harmony/project.yml', reason: 'invalid-yaml', message: 'bad' },
      }),
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
  });

  it('a manifest declaring NOTHING for this extension point allows a worker through', async () => {
    const h = harness({
      loadManifest: () => ({
        kind: 'ok',
        file: '/repo/.harmony/project.yml',
        manifest: { version: 1 },
        stepErrors: {},
      }),
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
  });

  it('an extension point BLOCKED by a scoped manifest problem allows a worker through (fail open)', async () => {
    const h = harness({
      loadManifest: () => ({
        kind: 'ok',
        file: '/repo/.harmony/project.yml',
        manifest: { version: 1, build: { before_pr: [{ run: './missing.sh' }] } },
        stepErrors: {
          'build.before_pr': {
            file: '/repo/.harmony/project.yml',
            reason: 'missing-script',
            message: 'missing',
          },
        },
      }),
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
  });
});

describe('decidePreToolUseGate — build.before_pr / release.before_merge marker gating', () => {
  it('a FRESH marker allows through', async () => {
    const h = harness({
      readMarker: (point) => ({
        extension_point: point,
        conduction_id: 'cond-1',
        head_sha: 'headsha',
        ran_at: 'now',
        evidence_landed: true,
      }),
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
  });

  it('an ABSENT marker denies', async () => {
    const h = harness({ readMarker: () => null });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('deny');
  });

  it('a STALE marker (wrong HEAD) denies', async () => {
    const h = harness({
      readMarker: (point) => ({
        extension_point: point,
        conduction_id: 'cond-1',
        head_sha: 'some-other-sha',
        ran_at: 'now',
        evidence_landed: true,
      }),
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('deny');
  });

  it('a readMarker that THROWS is treated as absent, and still denies (never crashes)', async () => {
    const h = harness({
      readMarker: () => {
        throw new Error('ENOENT');
      },
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('deny');
  });

  it('release.before_merge is gated the same way', async () => {
    const h = harness({
      loadManifest: () => ({
        kind: 'ok',
        file: '/repo/.harmony/project.yml',
        manifest: { version: 1, release: { before_merge: [{ run: 'npm run build' }] } },
        stepErrors: {},
      }),
      readMarker: () => null,
    });
    const d = await decidePreToolUseGate(BASH_PR_MERGE, h.deps);
    expect(d.action).toBe('deny');
  });
});

describe('decidePreToolUseGate — verify.before_ack confirm-before-deny flow', () => {
  const verifyManifest = (): ManifestLoadResult => ({
    kind: 'ok',
    file: '/repo/.harmony/project.yml',
    manifest: { version: 1, verify: { before_ack: [{ run: 'npm test' }] } },
    stepErrors: {},
  });

  it('a FRESH marker allows, with ZERO network reads (queryAwaitingReason never called)', async () => {
    const h = harness({
      loadManifest: verifyManifest,
      readMarker: (point) => ({
        extension_point: point,
        conduction_id: 'cond-1',
        head_sha: 'headsha',
        ran_at: 'now',
        evidence_landed: true,
      }),
    });
    const d = await decidePreToolUseGate(VERIFY_ACCEPT, h.deps);
    expect(d.action).toBe('allow');
    expect(h.queryCalls).toHaveLength(0);
  });

  it('marker stale + confirm says NOT verification-ack-pending ⇒ allow', async () => {
    const h = harness({
      loadManifest: verifyManifest,
      readMarker: () => null,
      queryAwaitingReason: async (taskId) => {
        h.queryCalls.push(taskId);
        return 'release-decision-pending';
      },
    });
    const d = await decidePreToolUseGate(VERIFY_ACCEPT, h.deps);
    expect(d.action).toBe('allow');
    expect(h.queryCalls).toEqual(['B-1']);
  });

  it('marker stale + confirm says verification-ack-pending ⇒ deny', async () => {
    const h = harness({
      loadManifest: verifyManifest,
      readMarker: () => null,
      queryAwaitingReason: async () => 'verification-ack-pending',
    });
    const d = await decidePreToolUseGate(VERIFY_ACCEPT, h.deps);
    expect(d.action).toBe('deny');
  });

  it('the confirm read THROWING ⇒ allow (fail open, never a wrongful deny or wedge)', async () => {
    const h = harness({
      loadManifest: verifyManifest,
      readMarker: () => null,
      queryAwaitingReason: async () => {
        throw new Error('ETIMEDOUT');
      },
    });
    const d = await decidePreToolUseGate(VERIFY_ACCEPT, h.deps);
    expect(d.action).toBe('allow');
  });

  it('no task_id on the call at all ⇒ allow (nothing to confirm against)', async () => {
    const h = harness({ loadManifest: verifyManifest, readMarker: () => null });
    const d = await decidePreToolUseGate(
      { ...VERIFY_ACCEPT, tool_input: { command: 'accept' } },
      h.deps,
    );
    expect(d.action).toBe('allow');
  });
});

describe('decidePreToolUseGate — the escape hatch (AC5)', () => {
  it('a matching override allows through AND posts a visible ticket comment', async () => {
    const h = harness({
      readMarker: () => null,
      env: { HARMONY_CONDUCTION_ID: 'cond-1', [GATE_OVERRIDE_ENV]: 'build.before_pr:hotfix, deploy is down' },
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
    expect(h.addCommentCalls).toHaveLength(1);
    expect(h.addCommentCalls[0].taskId).toBe('task-from-conduction');
    expect(h.addCommentCalls[0].content).toContain('build.before_pr');
    expect(h.addCommentCalls[0].content).toContain('hotfix, deploy is down');
  });

  it('a NON-matching override falls through to ordinary evaluation (still denies)', async () => {
    const h = harness({
      readMarker: () => null,
      env: { HARMONY_CONDUCTION_ID: 'cond-1', [GATE_OVERRIDE_ENV]: 'release.before_merge:unrelated' },
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('deny');
    expect(h.addCommentCalls).toHaveLength(0);
  });

  it('the verify matcher resolves its task id directly from tool_input, never via conduction', async () => {
    const h = harness({
      loadManifest: () => ({
        kind: 'ok',
        file: '/repo/.harmony/project.yml',
        manifest: { version: 1, verify: { before_ack: [{ run: 'npm test' }] } },
        stepErrors: {},
      }),
      readMarker: () => null,
      env: { HARMONY_CONDUCTION_ID: 'cond-1', [GATE_OVERRIDE_ENV]: 'verify.before_ack:manual ack' },
      resolveTaskId: async () => {
        throw new Error('should never be called for the verify matcher');
      },
    });
    const d = await decidePreToolUseGate(VERIFY_ACCEPT, h.deps);
    expect(d.action).toBe('allow');
    expect(h.addCommentCalls[0].taskId).toBe('B-1');
  });

  it('task id UNRESOLVABLE because getAuthenticatedContext throws ⇒ stderr fallback, never silent, never a crash', async () => {
    const h = harness({
      readMarker: () => null,
      env: { HARMONY_CONDUCTION_ID: 'cond-1', [GATE_OVERRIDE_ENV]: 'build.before_pr:db is down' },
      getAuthenticatedContext: async () => {
        throw new Error('no auth');
      },
    });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
    expect(h.addCommentCalls).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('Gate override used') && l.includes('db is down'))).toBe(true);
  });

  it('task id UNRESOLVABLE because resolveTaskId itself resolves to null ⇒ stderr fallback', async () => {
    const h = harness({
      readMarker: () => null,
      env: { HARMONY_CONDUCTION_ID: 'cond-1', [GATE_OVERRIDE_ENV]: 'release.before_merge:no task on this conduction' },
      loadManifest: () => ({
        kind: 'ok',
        file: '/repo/.harmony/project.yml',
        manifest: { version: 1, release: { before_merge: [{ run: 'npm run build' }] } },
        stepErrors: {},
      }),
      resolveTaskId: async () => null,
    });
    const d = await decidePreToolUseGate(BASH_PR_MERGE, h.deps);
    expect(d.action).toBe('allow');
    expect(h.addCommentCalls).toHaveLength(0);
    expect(
      h.logs.some((l) => l.includes('Gate override used') && l.includes('no task on this conduction')),
    ).toBe(true);
  });
});

// =================================================================================================
// runPreToolUseGate — the exit code and the outer fail-open floor.
// =================================================================================================

function runnerDeps(over: Partial<PreToolUseGateRunnerDeps> = {}): PreToolUseGateRunnerDeps {
  const { deps } = harness();
  return {
    ...deps,
    input: JSON.stringify(BASH_PR_CREATE),
    readMarker: () => null,
    ...over,
  };
}

describe('runPreToolUseGate — exit codes', () => {
  it('denies with exit 2 and logs the reason', async () => {
    const logs: string[] = [];
    const code = await runPreToolUseGate(runnerDeps({ log: (l) => logs.push(l) }));
    expect(code).toBe(2);
    expect(logs.join('\n')).toContain('[harmony pretooluse-gate]');
  });

  it('allows with exit 0 on a fresh marker', async () => {
    const code = await runPreToolUseGate(
      runnerDeps({
        readMarker: (point) => ({
          extension_point: point,
          conduction_id: 'cond-1',
          head_sha: 'headsha',
          ran_at: 'now',
          evidence_landed: true,
        }),
      }),
    );
    expect(code).toBe(0);
  });

  it.each([
    ['malformed stdin JSON', { input: 'not json at all' }],
    ['a loadManifest that throws', { loadManifest: () => { throw new Error('boom'); } }],
  ] as const)('%s fails OPEN (exit 0), never denies', async (_label, over) => {
    const code = await runPreToolUseGate(runnerDeps(over as Partial<PreToolUseGateRunnerDeps>));
    expect(code).toBe(0);
  });

  it('a resolveCurrentRepoSlug that throws degrades to null internally — the matcher/decision still runs (this is NOT an outer-catch case)', async () => {
    // Distinguishing case: an unresolvable repo slug is caught INSIDE decidePreToolUseGate (a
    // command with no --repo flag still matches), so this legitimately reaches a real decision
    // (deny, here, since the marker is absent) rather than falling through to the outer try/catch.
    const code = await runPreToolUseGate(
      runnerDeps({ resolveCurrentRepoSlug: () => { throw new Error('not a git repo'); } }),
    );
    expect(code).toBe(2);
  });
});

// =================================================================================================
// B-973 — the enforcement REVERSAL a notify-declaring manifest undergoes.
//
// Before B-973, `notify` was an unrecognized top-level key, so a project that declared it had a
// WHOLE-FILE malformed manifest. decidePreToolUseGate's `manifestResult.kind !== 'ok'` branch then
// failed OPEN and the hook enforced NOTHING — not even the build/release/verify steps that same
// manifest still declared. After B-973 the manifest parses, so the hook resumes enforcing. Both
// halves are asserted here against the REAL loader (not the harness's stub) so the reversal is
// proven end-to-end rather than asserted about a hand-built ManifestLoadResult.
// =================================================================================================

describe('decidePreToolUseGate — B-973 notify enforcement reversal', () => {
  const roots: string[] = [];

  function projectRootWith(manifestBody: string): string {
    const root = mkdtempSync(join(tmpdir(), 'b973-pretooluse-'));
    roots.push(root);
    mkdirSync(join(root, '.harmony'), { recursive: true });
    writeFileSync(join(root, '.harmony', 'project.yml'), manifestBody, 'utf8');
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const DECLARED_BUILD_STEPS = ['build:', '  before_pr:', '    - run: npm run lint'];

  it('a notify-declaring manifest now PARSES, so the gate ENFORCES (denies a worker with no marker) instead of failing open', async () => {
    const root = projectRootWith(
      [
        'version: 1',
        ...DECLARED_BUILD_STEPS,
        'notify:',
        '  - on: "reaching Built"',
        '    endpoint: "https://hooks.example.com/harmony/built"',
      ].join('\n'),
    );

    // Sanity: the real loader accepts it now.
    expect(loadProjectManifest(root).kind).toBe('ok');

    const h = harness({ projectRoot: root, loadManifest: loadProjectManifest, readMarker: () => null });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('deny');
  });

  it('the pre-B-973 shape — an UNRECOGNIZED top-level key — still takes the kind!=="ok" fail-open branch, which is exactly what a notify declaration used to hit', async () => {
    const root = projectRootWith(
      [
        'version: 1',
        ...DECLARED_BUILD_STEPS,
        'notifications:',
        '  - on: "reaching Built"',
        '    endpoint: "https://hooks.example.com/harmony/built"',
      ].join('\n'),
    );

    const loaded = loadProjectManifest(root);
    expect(loaded.kind).toBe('malformed');

    const h = harness({ projectRoot: root, loadManifest: loadProjectManifest, readMarker: () => null });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('no usable');
  });

  it('a notify entry naming an UNRECOGNIZED transition is whole-file malformed, so the gate fails open again — the loud error is the CLI runner\'s job, never a wrongful deny', async () => {
    const root = projectRootWith(
      [
        'version: 1',
        ...DECLARED_BUILD_STEPS,
        'notify:',
        '  - on: "reaching Shipped"',
        '    endpoint: "https://hooks.example.com/harmony/built"',
      ].join('\n'),
    );

    const loaded = loadProjectManifest(root);
    expect(loaded.kind).toBe('malformed');
    if (loaded.kind !== 'malformed') return;
    expect(loaded.problem.reason).toBe('unknown-transition');

    const h = harness({ projectRoot: root, loadManifest: loadProjectManifest, readMarker: () => null });
    const d = await decidePreToolUseGate(BASH_PR_CREATE, h.deps);
    expect(d.action).toBe('allow');
  });
});
