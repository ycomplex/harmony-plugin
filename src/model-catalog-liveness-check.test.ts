// B-881: unit coverage for scripts/model-catalog-liveness-check.mjs. Lives under src/ (not
// scripts/) so vitest's `include: ["src/**/*.test.ts"]` glob (vitest.config.ts) picks it up —
// mirrors src/resume-discovery.test.ts's own precedent for testing a scripts/*.mjs file that lives
// outside vitest's include path.
//
// Only the PURE decision/parsing helpers (decideGuard, parseVerifyResult) and the fully-injected
// orchestration (runLivenessCheck, with a fake Supabase client and a fake verifyAlias) are tested
// here — the REAL `claude` CLI invocation (runVerifyClaude's default) is deliberately never
// exercised by a test (the ticket's own explicit ask: this is a check that RUNS, not one asserted
// in a test — a mock would defeat the entire point of a liveness check).
//
// B-1053: same split applies to the pinned-default assertion added alongside the per-alias sweep —
// mapLabelToPinnedProfile and decidePinnedDefaultCheck are pure and unit-tested directly;
// checkPinnedDefaultLiveness (which does the actual Supabase read) and runLivenessCheck's wiring of
// it are exercised only with a fake service-role client, never a real one.

import { describe, it, expect } from 'vitest';
import {
  decideGuard,
  parseVerifyResult,
  runLivenessCheck,
  mapLabelToPinnedProfile,
  decidePinnedDefaultCheck,
  checkPinnedDefaultLiveness,
} from '../scripts/model-catalog-liveness-check.mjs';

describe('decideGuard (pure, table-driven — shared by both jobs)', () => {
  it('returns dormant-supabase when either Supabase credential is absent', () => {
    expect(decideGuard({ supabaseUrl: '', supabaseKey: '', anthropicKey: 'sk-ant' })).toBe(
      'dormant-supabase',
    );
    expect(decideGuard({ supabaseUrl: 'https://x.supabase.co', supabaseKey: '', anthropicKey: 'sk-ant' })).toBe(
      'dormant-supabase',
    );
    expect(decideGuard({ supabaseUrl: '', supabaseKey: 'service-role-key', anthropicKey: 'sk-ant' })).toBe(
      'dormant-supabase',
    );
    expect(decideGuard({})).toBe('dormant-supabase');
  });

  it('returns dormant-anthropic when Supabase is present but the Anthropic key is absent', () => {
    expect(
      decideGuard({ supabaseUrl: 'https://x.supabase.co', supabaseKey: 'service-role-key', anthropicKey: '' }),
    ).toBe('dormant-anthropic');
    expect(
      decideGuard({
        supabaseUrl: 'https://x.supabase.co',
        supabaseKey: 'service-role-key',
        anthropicKey: undefined,
      }),
    ).toBe('dormant-anthropic');
  });

  it('returns run when all three credentials are present', () => {
    expect(
      decideGuard({
        supabaseUrl: 'https://x.supabase.co',
        supabaseKey: 'service-role-key',
        anthropicKey: 'sk-ant',
      }),
    ).toBe('run');
  });
});

describe('parseVerifyResult', () => {
  it('treats exit 0 with non-empty stdout as a confirmed success', () => {
    expect(parseVerifyResult({ status: 0, stdout: 'OK\n' })).toBe(true);
  });

  it('treats a non-zero exit as a failure', () => {
    expect(parseVerifyResult({ status: 1, stdout: '', stderr: 'model not found' })).toBe(false);
  });

  it('treats empty stdout on exit 0 as a failure (no confirmation the model actually replied)', () => {
    expect(parseVerifyResult({ status: 0, stdout: '' })).toBe(false);
  });

  it('treats a spawn error (e.g. ENOENT — claude not on PATH) as a failure, never throws', () => {
    expect(parseVerifyResult({ status: null, error: new Error('ENOENT') })).toBe(false);
  });

  it('treats a null/undefined result as a failure', () => {
    expect(parseVerifyResult(null)).toBe(false);
    expect(parseVerifyResult(undefined)).toBe(false);
  });
});

/** A minimal fake service-role Supabase client supporting exactly the call shapes runLivenessCheck
 *  (and, since B-1053, checkPinnedDefaultLiveness) make: a SELECT (`.from().select().eq()`, awaited
 *  directly), an UPDATE (`.from().update().eq()`, awaited directly), and the pinned-default
 *  array-contains SELECT (`.from().select().contains()`, awaited directly) — mirrors
 *  src/config/run-config.test.ts's own fakeCatalogClient pattern for the read half.
 *
 *  `pinnedRows`/`pinnedError` default to a "column does not exist" (42703) error — i.e. the
 *  pinned-default assertion warns-and-skips unless a test explicitly opts in — so every EXISTING
 *  test below (written before B-1053, none of which cares about the new assertion) keeps its
 *  original exit code / log assertions unaffected. */
function fakeServiceRoleClient({
  rows,
  selectError = null,
  updateErrorFor = {},
  pinnedRows = null,
  pinnedError = { message: "column model_catalog.pinned_default_profiles does not exist", code: '42703' },
}: {
  rows: Array<{ alias: string }>;
  selectError?: { message: string } | null;
  updateErrorFor?: Record<string, { message: string }>;
  pinnedRows?: Array<{ alias: string }> | null;
  pinnedError?: { message: string; code?: string } | null;
}) {
  const updates: Array<{ alias: string; patch: Record<string, unknown> }> = [];
  return {
    client: {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve(selectError ? { data: null, error: selectError } : { data: rows, error: null }),
          contains: () =>
            Promise.resolve(
              pinnedRows !== null ? { data: pinnedRows, error: null } : { data: null, error: pinnedError },
            ),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, alias: string) => {
            updates.push({ alias, patch });
            const err = updateErrorFor[alias] ?? null;
            return Promise.resolve({ data: err ? null : [{ alias }], error: err });
          },
        }),
      }),
    },
    updates,
  };
}

function silentSinks() {
  const logs: string[] = [];
  const errs: string[] = [];
  return { log: (m: string) => logs.push(m), errLog: (m: string) => errs.push(m), logs, errs };
}

describe('runLivenessCheck (AC coverage — fully injected, no real network/CLI)', () => {
  it('DORMANT (exit 1) when Supabase credentials are missing — never even attempts a read', async () => {
    const sinks = silentSinks();
    let clientCreated = false;
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: '',
      supabaseKey: '',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => {
        clientCreated = true;
        return fakeServiceRoleClient({ rows: [] }).client;
      },
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(clientCreated).toBe(false);
    expect(sinks.errs.join('\n')).toContain('::error::STAGING model-catalog liveness DORMANT');
  });

  it('DORMANT (exit 1) when ANTHROPIC_API_KEY is missing, even with valid Supabase credentials', async () => {
    const sinks = silentSinks();
    const code = await runLivenessCheck({
      label: 'production',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: '',
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(sinks.errs.join('\n')).toContain('::error::PRODUCTION model-catalog liveness DORMANT');
    expect(sinks.errs.join('\n')).toContain('ANTHROPIC_API_KEY');
  });

  it('exit 0, zero rows verified, when the catalog has no active rows', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [] });
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(0);
    expect(sinks.logs.join('\n')).toContain('zero active rows');
  });

  it('exit 1 when the catalog read itself errors', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [], selectError: { message: 'permission denied' } });
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(sinks.errs.join('\n')).toContain('FAILED to read model_catalog');
  });

  it('every alias resolving OK -> exit 0, and writes verified_at for each', async () => {
    const sinks = silentSinks();
    const { client, updates } = fakeServiceRoleClient({
      rows: [{ alias: 'claude-sonnet-5' }, { alias: 'claude-opus-5' }],
    });
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      verifyAlias: () => ({ status: 0, stdout: 'OK\n' }),
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(0);
    expect(updates).toEqual([
      { alias: 'claude-sonnet-5', patch: expect.objectContaining({ verified_at: expect.any(String) }) },
      { alias: 'claude-opus-5', patch: expect.objectContaining({ verified_at: expect.any(String) }) },
    ]);
  });

  it('a confirmed FAILURE flips active=false and drives exit 1 — never silently swallowed', async () => {
    const sinks = silentSinks();
    const { client, updates } = fakeServiceRoleClient({ rows: [{ alias: 'claude-retired-9' }] });
    const code = await runLivenessCheck({
      label: 'production',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      verifyAlias: () => ({ status: 1, stdout: '', stderr: 'model not found' }),
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(updates).toEqual([{ alias: 'claude-retired-9', patch: { active: false } }]);
    expect(sinks.errs.join('\n')).toContain("'claude-retired-9' FAILED to resolve");
  });

  it('a MIXED batch (one OK, one failed) still verifies/flips each independently and exits 1 overall', async () => {
    const sinks = silentSinks();
    const { client, updates } = fakeServiceRoleClient({
      rows: [{ alias: 'claude-sonnet-5' }, { alias: 'claude-retired-9' }],
    });
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      verifyAlias: (alias: string) =>
        alias === 'claude-sonnet-5' ? { status: 0, stdout: 'OK\n' } : { status: 1, stdout: '' },
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(updates).toContainEqual({
      alias: 'claude-sonnet-5',
      patch: expect.objectContaining({ verified_at: expect.any(String) }),
    });
    expect(updates).toContainEqual({ alias: 'claude-retired-9', patch: { active: false } });
  });

  it('a spawn error (e.g. claude not on PATH) is treated as a confirmed failure, never thrown/swallowed', async () => {
    const sinks = silentSinks();
    const { client, updates } = fakeServiceRoleClient({ rows: [{ alias: 'claude-sonnet-5' }] });
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      verifyAlias: () => ({ status: null, error: new Error('ENOENT') }),
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(updates).toEqual([{ alias: 'claude-sonnet-5', patch: { active: false } }]);
    expect(sinks.errs.join('\n')).toContain('ENOENT');
  });

  it('an UPDATE failure after a successful verify is logged loudly and still drives exit 1', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({
      rows: [{ alias: 'claude-sonnet-5' }],
      updateErrorFor: { 'claude-sonnet-5': { message: 'permission denied' } },
    });
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      verifyAlias: () => ({ status: 0, stdout: 'OK\n' }),
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(sinks.errs.join('\n')).toContain('failed to write verified_at');
  });
});

describe('mapLabelToPinnedProfile (pure — B-1053)', () => {
  it("maps 'staging' to 'staging'", () => {
    expect(mapLabelToPinnedProfile('staging')).toBe('staging');
  });

  it("maps 'production' to 'prod' — the real naming mismatch this mapping exists to make explicit", () => {
    expect(mapLabelToPinnedProfile('production')).toBe('prod');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(mapLabelToPinnedProfile('  Production  ')).toBe('prod');
    expect(mapLabelToPinnedProfile('STAGING')).toBe('staging');
  });

  it("returns null for anything else (e.g. this script's own CLI default label 'env')", () => {
    expect(mapLabelToPinnedProfile('env')).toBeNull();
    expect(mapLabelToPinnedProfile('')).toBeNull();
    expect(mapLabelToPinnedProfile(undefined as unknown as string)).toBeNull();
  });
});

describe('decidePinnedDefaultCheck (pure — B-1053)', () => {
  it('column-absent: a 42703 Postgres error decides column-absent, regardless of message text', () => {
    expect(
      decidePinnedDefaultCheck({
        error: { code: '42703', message: 'column model_catalog.pinned_default_profiles does not exist' },
        rows: null,
        expectedAlias: 'claude-sonnet-5',
      }),
    ).toEqual({ kind: 'column-absent' });
  });

  it('query-error: any other error code/shape is a query-error, not tolerated', () => {
    expect(
      decidePinnedDefaultCheck({
        error: { message: 'permission denied', code: '42501' },
        rows: null,
        expectedAlias: 'claude-sonnet-5',
      }),
    ).toEqual({ kind: 'query-error', message: 'permission denied' });
  });

  it('no-row: zero rows pinned for this profile', () => {
    expect(decidePinnedDefaultCheck({ error: null, rows: [], expectedAlias: 'claude-sonnet-5' })).toEqual({
      kind: 'no-row',
    });
  });

  it('match: exactly one row, alias matches expected', () => {
    expect(
      decidePinnedDefaultCheck({
        error: null,
        rows: [{ alias: 'claude-sonnet-5' }],
        expectedAlias: 'claude-sonnet-5',
      }),
    ).toEqual({ kind: 'match', alias: 'claude-sonnet-5' });
  });

  it('mismatch: exactly one row, alias differs from expected', () => {
    expect(
      decidePinnedDefaultCheck({
        error: null,
        rows: [{ alias: 'claude-opus-5' }],
        expectedAlias: 'claude-sonnet-5',
      }),
    ).toEqual({ kind: 'mismatch', liveAlias: 'claude-opus-5', expectedAlias: 'claude-sonnet-5' });
  });

  it('multiple-rows: more than one row pinned for the same profile is a data-integrity error', () => {
    expect(
      decidePinnedDefaultCheck({
        error: null,
        rows: [{ alias: 'claude-sonnet-5' }, { alias: 'claude-opus-5' }],
        expectedAlias: 'claude-sonnet-5',
      }),
    ).toEqual({ kind: 'multiple-rows', aliases: ['claude-sonnet-5', 'claude-opus-5'] });
  });
});

describe('checkPinnedDefaultLiveness (fully injected — B-1053)', () => {
  it('an unmapped label (e.g. the CLI default \'env\') skips the assertion — no failure', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [], pinnedRows: [{ alias: 'claude-opus-5' }] });
    const failed = await checkPinnedDefaultLiveness({
      label: 'env',
      client,
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(failed).toBe(false);
    expect(sinks.logs.join('\n')).toContain('no pinned-default profile mapping');
    expect(sinks.errs).toEqual([]);
  });

  it('column-absent: warns (not ::error::) and does not fail', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [] }); // default pinnedError is 42703
    const failed = await checkPinnedDefaultLiveness({
      label: 'staging',
      client,
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(failed).toBe(false);
    expect(sinks.errs).toEqual([]);
    expect(sinks.logs.join('\n')).toContain('WARNING');
    expect(sinks.logs.join('\n')).toContain("pinned_default_profiles' does not exist");
  });

  it('no-row: ::error:: and fails', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [], pinnedRows: [] });
    const failed = await checkPinnedDefaultLiveness({
      label: 'staging',
      client,
      pinnedDefaultByProfile: { staging: 'claude-sonnet-5', prod: 'claude-sonnet-5' },
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(failed).toBe(true);
    expect(sinks.errs.join('\n')).toContain(
      "::error::STAGING model-catalog liveness: no row in model_catalog is pinned",
    );
  });

  it('mismatch: ::error:: naming both the live-pinned alias and the expected one, and fails', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [], pinnedRows: [{ alias: 'claude-opus-5' }] });
    const failed = await checkPinnedDefaultLiveness({
      label: 'production',
      client,
      pinnedDefaultByProfile: { staging: 'claude-sonnet-5', prod: 'claude-sonnet-5' },
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(failed).toBe(true);
    const msg = sinks.errs.join('\n');
    expect(msg).toContain("LIVE pinned default for profile 'prod'");
    expect(msg).toContain("'claude-opus-5'");
    expect(msg).toContain("'claude-sonnet-5'");
  });

  it('match: logs success and does not fail', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [], pinnedRows: [{ alias: 'claude-sonnet-5' }] });
    const failed = await checkPinnedDefaultLiveness({
      label: 'staging',
      client,
      pinnedDefaultByProfile: { staging: 'claude-sonnet-5', prod: 'claude-sonnet-5' },
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(failed).toBe(false);
    expect(sinks.errs).toEqual([]);
    expect(sinks.logs.join('\n')).toContain("pinned default for profile 'staging' confirmed");
  });

  it('multiple-rows: ::error:: and fails — a data-integrity problem in the catalog itself', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({
      rows: [],
      pinnedRows: [{ alias: 'claude-sonnet-5' }, { alias: 'claude-opus-5' }],
    });
    const failed = await checkPinnedDefaultLiveness({
      label: 'staging',
      client,
      pinnedDefaultByProfile: { staging: 'claude-sonnet-5', prod: 'claude-sonnet-5' },
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(failed).toBe(true);
    expect(sinks.errs.join('\n')).toContain('2 rows are pinned as the default');
  });
});

describe('runLivenessCheck wiring of the pinned-default assertion (B-1053)', () => {
  it('a pinned-default failure flips the overall exit code even when every alias verified OK', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({
      rows: [{ alias: 'claude-sonnet-5' }],
      pinnedRows: [{ alias: 'claude-opus-5' }],
    });
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      verifyAlias: () => ({ status: 0, stdout: 'OK\n' }),
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(sinks.errs.join('\n')).toContain('LIVE pinned default');
  });

  it('runs the pinned-default assertion even when there are zero active rows to verify', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [], pinnedRows: [] });
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(1);
    expect(sinks.logs.join('\n')).toContain('zero active rows');
    expect(sinks.errs.join('\n')).toContain('no row in model_catalog is pinned');
  });

  it('column-absent on the pinned check never fails the overall run', async () => {
    const sinks = silentSinks();
    const { client } = fakeServiceRoleClient({ rows: [] }); // default pinnedError is 42703
    const code = await runLivenessCheck({
      label: 'staging',
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'service-role-key',
      anthropicKey: 'sk-ant',
      createSupabaseClient: () => client,
      log: sinks.log,
      errLog: sinks.errLog,
    });
    expect(code).toBe(0);
  });
});
