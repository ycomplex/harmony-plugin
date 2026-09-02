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

import { describe, it, expect } from 'vitest';
import {
  decideGuard,
  parseVerifyResult,
  runLivenessCheck,
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

/** A minimal fake service-role Supabase client supporting exactly the two call shapes
 *  runLivenessCheck makes: a SELECT (`.from().select().eq()`, awaited directly) and an UPDATE
 *  (`.from().update().eq()`, awaited directly) — mirrors src/config/run-config.test.ts's own
 *  fakeCatalogClient pattern for the read half. */
function fakeServiceRoleClient({
  rows,
  selectError = null,
  updateErrorFor = {},
}: {
  rows: Array<{ alias: string }>;
  selectError?: { message: string } | null;
  updateErrorFor?: Record<string, { message: string }>;
}) {
  const updates: Array<{ alias: string; patch: Record<string, unknown> }> = [];
  return {
    client: {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve(selectError ? { data: null, error: selectError } : { data: rows, error: null }),
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
