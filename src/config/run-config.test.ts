// B-846: unit coverage for the run-config plumbing seam's schema + worker-side accessor. This
// ticket adds zero operator-facing behavior — these tests exist to lock in the plumbing itself
// (absence -> {}, both delivery forms, malformed-input handling) before any dependent ticket
// starts writing a real top-level key through it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { mkdtempSync, rmSync, existsSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_RUN_CONFIG,
  resolveRunConfigFromConduction,
  MODEL_CATALOG_FALLBACK,
  PINNED_DEFAULT_MODEL_BY_PROFILE,
  RunConfigSchema,
  clearModelHandoffRequest,
  fetchModelCatalog,
  getAutoApproveGates,
  getConductionId,
  getModelContextBudgetBytes,
  getModelForGate,
  getModelHandoffPath,
  getOperatorNote,
  getRunConfig,
  isAllowedModelAlias,
  isSessionResumeEnabled,
  readModelHandoffRequest,
  resolveModelCatalog,
  writeModelHandoffRequest,
} from './run-config.js';
import type { ModelCatalogEntry } from './run-config.js';
import type { RunConfig } from './run-config.js';

describe('RunConfigSchema', () => {
  it('accepts an empty object', () => {
    expect(RunConfigSchema.parse({})).toEqual({});
  });

  it('passes through unknown keys (forward-compat with a not-yet-known dependent-ticket key)', () => {
    expect(RunConfigSchema.parse({ steering_note: 'be terse' })).toEqual({
      steering_note: 'be terse',
    });
  });

  it('rejects a non-object payload (array, string, number, null)', () => {
    expect(() => RunConfigSchema.parse([])).toThrow();
    expect(() => RunConfigSchema.parse('nope')).toThrow();
    expect(() => RunConfigSchema.parse(42)).toThrow();
    expect(() => RunConfigSchema.parse(null)).toThrow();
  });
});

describe('RunConfigSchema session_resume (B-718)', () => {
  it('accepts { session_resume: { enabled: true } }', () => {
    expect(RunConfigSchema.parse({ session_resume: { enabled: true } })).toEqual({
      session_resume: { enabled: true },
    });
  });

  it('accepts { session_resume: { enabled: false } }', () => {
    expect(RunConfigSchema.parse({ session_resume: { enabled: false } })).toEqual({
      session_resume: { enabled: false },
    });
  });

  it('rejects a session_resume object missing the required enabled boolean', () => {
    expect(() => RunConfigSchema.parse({ session_resume: {} })).toThrow();
  });

  it('rejects a non-boolean enabled value', () => {
    expect(() => RunConfigSchema.parse({ session_resume: { enabled: 'yes' } })).toThrow();
  });

  it('still passes through unrelated unknown keys alongside session_resume', () => {
    expect(
      RunConfigSchema.parse({ session_resume: { enabled: true }, steering_note: 'be terse' }),
    ).toEqual({ session_resume: { enabled: true }, steering_note: 'be terse' });
  });
});

describe('isSessionResumeEnabled', () => {
  it('defaults to false on the empty run_config ({})', () => {
    expect(isSessionResumeEnabled(EMPTY_RUN_CONFIG)).toBe(false);
  });

  it('is false when session_resume is present but enabled is false', () => {
    expect(isSessionResumeEnabled({ session_resume: { enabled: false } })).toBe(false);
  });

  it('is true only when session_resume.enabled is explicitly true', () => {
    expect(isSessionResumeEnabled({ session_resume: { enabled: true } })).toBe(true);
  });

  it('is false when session_resume is absent but other unrelated keys are present', () => {
    expect(isSessionResumeEnabled({ steering_note: 'be terse' })).toBe(false);
  });
});

describe('RunConfigSchema note (B-743)', () => {
  it('accepts a run_config carrying a free-text note', () => {
    expect(RunConfigSchema.parse({ note: 'be terse, and skip the design gate write-up' })).toEqual({
      note: 'be terse, and skip the design gate write-up',
    });
  });

  it('accepts a note containing a single quote — the exact shape v1 used to forbid', () => {
    expect(RunConfigSchema.parse({ note: "don't touch the migration file" })).toEqual({
      note: "don't touch the migration file",
    });
  });

  it('still passes through unrelated unknown keys alongside note', () => {
    expect(
      RunConfigSchema.parse({ note: 'be terse', session_resume: { enabled: true } }),
    ).toEqual({ note: 'be terse', session_resume: { enabled: true } });
  });

  it('rejects a non-string note', () => {
    expect(() => RunConfigSchema.parse({ note: 42 })).toThrow();
  });
});

describe('getOperatorNote', () => {
  it('returns undefined on the empty run_config ({})', () => {
    expect(getOperatorNote(EMPTY_RUN_CONFIG)).toBeUndefined();
  });

  it('returns undefined when note is an empty string', () => {
    expect(getOperatorNote({ note: '' })).toBeUndefined();
  });

  it('returns the note text when present', () => {
    expect(getOperatorNote({ note: "can't stop, won't stop" })).toBe("can't stop, won't stop");
  });

  it('returns undefined when note is absent but other unrelated keys are present', () => {
    expect(getOperatorNote({ session_resume: { enabled: true } })).toBeUndefined();
  });
});

describe('getConductionId', () => {
  it('returns the plain HARMONY_CONDUCTION_ID value when set', () => {
    expect(getConductionId({ HARMONY_CONDUCTION_ID: 'cond-123' })).toBe('cond-123');
  });

  it('returns undefined when absent — never throws for absence', () => {
    expect(getConductionId({})).toBeUndefined();
  });

  it('treats an empty-string value as absent (B-694 empty-env-value shadow class)', () => {
    expect(getConductionId({ HARMONY_CONDUCTION_ID: '' })).toBeUndefined();
  });
});

describe('getRunConfig', () => {
  it('defaults to EMPTY_RUN_CONFIG ({}) when neither delivery var is set', () => {
    expect(getRunConfig({})).toEqual(EMPTY_RUN_CONFIG);
  });

  it('reads + parses the mounted file when HARMONY_RUN_CONFIG_PATH is set', () => {
    const readFileSync = (p: string) => {
      expect(p).toBe('/home/worker/.claude/run-config.json');
      return '{"steering_note":"be terse"}';
    };
    expect(
      getRunConfig({ HARMONY_RUN_CONFIG_PATH: '/home/worker/.claude/run-config.json' }, { readFileSync }),
    ).toEqual({ steering_note: 'be terse' });
  });

  it('base64-decodes + parses HARMONY_RUN_CONFIG_JSON when no path is set', () => {
    const inline = Buffer.from(JSON.stringify({ steering_note: 'be terse' }), 'utf8').toString(
      'base64',
    );
    expect(getRunConfig({ HARMONY_RUN_CONFIG_JSON: inline })).toEqual({ steering_note: 'be terse' });
  });

  it('the file path takes precedence over the inline var when both are somehow set', () => {
    const inline = Buffer.from(JSON.stringify({ from: 'inline' }), 'utf8').toString('base64');
    const readFileSync = () => JSON.stringify({ from: 'file' });
    expect(
      getRunConfig(
        { HARMONY_RUN_CONFIG_PATH: '/some/path.json', HARMONY_RUN_CONFIG_JSON: inline },
        { readFileSync },
      ),
    ).toEqual({ from: 'file' });
  });

  it('throws on malformed JSON text read from the file (never swallowed into the empty default)', () => {
    const readFileSync = () => '{ not valid json';
    expect(() =>
      getRunConfig({ HARMONY_RUN_CONFIG_PATH: '/some/path.json' }, { readFileSync }),
    ).toThrow();
  });

  it('throws on malformed base64/JSON text from the inline var', () => {
    expect(() => getRunConfig({ HARMONY_RUN_CONFIG_JSON: 'not-valid-json-once-decoded!!' })).toThrow();
  });

  it('throws when the file-delivered payload parses to a non-object (array)', () => {
    const readFileSync = () => '[]';
    expect(() =>
      getRunConfig({ HARMONY_RUN_CONFIG_PATH: '/some/path.json' }, { readFileSync }),
    ).toThrow();
  });

  it('throws when the inline-delivered payload parses to a non-object (string)', () => {
    const inline = Buffer.from('"just a string"', 'utf8').toString('base64');
    expect(() => getRunConfig({ HARMONY_RUN_CONFIG_JSON: inline })).toThrow();
  });

  it('empty-string values for both vars are treated as absent, falling through to EMPTY_RUN_CONFIG', () => {
    expect(getRunConfig({ HARMONY_RUN_CONFIG_PATH: '', HARMONY_RUN_CONFIG_JSON: '' })).toEqual(
      EMPTY_RUN_CONFIG,
    );
  });
});

describe('RunConfigSchema model (B-772)', () => {
  it('accepts a run_config carrying only model.default', () => {
    expect(RunConfigSchema.parse({ model: { default: 'claude-opus-4-1' } })).toEqual({
      model: { default: 'claude-opus-4-1' },
    });
  });

  it('accepts a run_config carrying only model.per_gate', () => {
    expect(RunConfigSchema.parse({ model: { per_gate: { build: 'claude-opus-4-1' } } })).toEqual({
      model: { per_gate: { build: 'claude-opus-4-1' } },
    });
  });

  it('accepts a run_config carrying both model.default and model.per_gate', () => {
    expect(
      RunConfigSchema.parse({
        model: { default: 'claude-sonnet-5', per_gate: { build: 'claude-opus-4-1' } },
      }),
    ).toEqual({ model: { default: 'claude-sonnet-5', per_gate: { build: 'claude-opus-4-1' } } });
  });

  it('accepts an empty model object', () => {
    expect(RunConfigSchema.parse({ model: {} })).toEqual({ model: {} });
  });

  it('accepts a per_gate key this build does not recognize as a Gate (forward-compat parse)', () => {
    expect(
      RunConfigSchema.parse({ model: { per_gate: { 'some-future-gate': 'claude-opus-4-1' } } }),
    ).toEqual({ model: { per_gate: { 'some-future-gate': 'claude-opus-4-1' } } });
  });

  it('rejects a non-string model.default', () => {
    expect(() => RunConfigSchema.parse({ model: { default: 42 } })).toThrow();
  });

  it('rejects a non-string value inside model.per_gate', () => {
    expect(() => RunConfigSchema.parse({ model: { per_gate: { build: 42 } } })).toThrow();
  });

  it('still passes through unrelated unknown keys alongside model', () => {
    expect(
      RunConfigSchema.parse({ model: { default: 'claude-sonnet-5' }, note: 'be terse' }),
    ).toEqual({ model: { default: 'claude-sonnet-5' }, note: 'be terse' });
  });
});

describe('getModelForGate (B-772 three-level fallback)', () => {
  const PROD_ENV = { HARMONY_SUPABASE_URL: 'https://eioxsunvhakmelhanmnn.supabase.co' };
  const STAGING_ENV = { HARMONY_SUPABASE_URL: 'https://meqkdgncdzromunylyxf.supabase.co' };

  it('level 1: an explicit per_gate override for the resolved gate wins over everything else', () => {
    const runConfig: RunConfig = {
      model: { default: 'run-default-model', per_gate: { build: 'per-gate-build-model' } },
    };
    expect(getModelForGate(runConfig, 'build', PROD_ENV)).toBe('per-gate-build-model');
  });

  it('level 1 only applies to the gate it names — a different gate falls through to level 2', () => {
    const runConfig: RunConfig = {
      model: { default: 'run-default-model', per_gate: { build: 'per-gate-build-model' } },
    };
    expect(getModelForGate(runConfig, 'release', PROD_ENV)).toBe('run-default-model');
  });

  it('level 1 is skipped entirely when gate is null (e.g. a terminal-state ticket)', () => {
    const runConfig: RunConfig = {
      model: { default: 'run-default-model', per_gate: { build: 'per-gate-build-model' } },
    };
    expect(getModelForGate(runConfig, null, PROD_ENV)).toBe('run-default-model');
  });

  it('level 2: model.default applies when no per_gate override matches', () => {
    const runConfig: RunConfig = { model: { default: 'run-default-model' } };
    expect(getModelForGate(runConfig, 'clarify', PROD_ENV)).toBe('run-default-model');
  });

  it('level 3: an empty run_config falls through to the pinned per-deployment-profile default (prod)', () => {
    expect(getModelForGate(EMPTY_RUN_CONFIG, 'build', PROD_ENV)).toBe(
      PINNED_DEFAULT_MODEL_BY_PROFILE.prod,
    );
  });

  it('level 3: resolves the STAGING pin when HARMONY_SUPABASE_URL points at the staging project', () => {
    expect(getModelForGate(EMPTY_RUN_CONFIG, 'build', STAGING_ENV)).toBe(
      PINNED_DEFAULT_MODEL_BY_PROFILE.staging,
    );
  });

  it('level 3: an empty run_config with a null gate still falls through to the pinned default', () => {
    expect(getModelForGate(EMPTY_RUN_CONFIG, null, PROD_ENV)).toBe(
      PINNED_DEFAULT_MODEL_BY_PROFILE.prod,
    );
  });

  it('level 3: an unrecognized/custom Supabase URL falls back to the prod pin, never undefined', () => {
    expect(
      getModelForGate(EMPTY_RUN_CONFIG, 'build', { HARMONY_SUPABASE_URL: 'https://example.com' }),
    ).toBe(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
  });

  it('level 3: a malformed Supabase URL degrades to the prod pin rather than throwing', () => {
    expect(
      getModelForGate(EMPTY_RUN_CONFIG, 'build', { HARMONY_SUPABASE_URL: 'not a url' }),
    ).toBe(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
  });

  it('defaults env to process.env when no third argument is given (never throws)', () => {
    expect(() => getModelForGate(EMPTY_RUN_CONFIG, 'build')).not.toThrow();
    expect(typeof getModelForGate(EMPTY_RUN_CONFIG, 'build')).toBe('string');
  });
});

describe('RunConfigSchema auto_approve_gates (B-773)', () => {
  it('accepts a run_config carrying a single forward gate', () => {
    expect(RunConfigSchema.parse({ auto_approve_gates: ['build'] })).toEqual({
      auto_approve_gates: ['build'],
    });
  });

  it('accepts a run_config carrying all five eligible forward gates', () => {
    const gates = ['clarify', 'decompose', 'design', 'plan', 'build'];
    expect(RunConfigSchema.parse({ auto_approve_gates: gates })).toEqual({
      auto_approve_gates: gates,
    });
  });

  it('accepts an empty auto_approve_gates array', () => {
    expect(RunConfigSchema.parse({ auto_approve_gates: [] })).toEqual({ auto_approve_gates: [] });
  });

  it('rejects release in auto_approve_gates — the hard floor is never delegable', () => {
    expect(() => RunConfigSchema.parse({ auto_approve_gates: ['release'] })).toThrow();
  });

  it('rejects verify in auto_approve_gates — the hard floor is never delegable', () => {
    expect(() => RunConfigSchema.parse({ auto_approve_gates: ['verify'] })).toThrow();
  });

  it('rejects a gate name this build does not recognize (unlike model.per_gate, this is an enum, not forward-compat)', () => {
    expect(() => RunConfigSchema.parse({ auto_approve_gates: ['some-future-gate'] })).toThrow();
  });

  it('rejects a non-array auto_approve_gates', () => {
    expect(() => RunConfigSchema.parse({ auto_approve_gates: 'build' })).toThrow();
  });

  it('still passes through unrelated unknown keys alongside auto_approve_gates', () => {
    expect(
      RunConfigSchema.parse({ auto_approve_gates: ['build'], note: 'be terse' }),
    ).toEqual({ auto_approve_gates: ['build'], note: 'be terse' });
  });
});

describe('getAutoApproveGates', () => {
  it('returns an empty Set on the empty run_config ({})', () => {
    expect(getAutoApproveGates(EMPTY_RUN_CONFIG)).toEqual(new Set());
  });

  it('returns an empty Set when auto_approve_gates is an empty array', () => {
    expect(getAutoApproveGates({ auto_approve_gates: [] })).toEqual(new Set());
  });

  it('returns a Set of the named gates when present', () => {
    expect(getAutoApproveGates({ auto_approve_gates: ['clarify', 'build'] })).toEqual(
      new Set(['clarify', 'build']),
    );
  });

  it('returns an empty Set when auto_approve_gates is absent but other unrelated keys are present', () => {
    expect(getAutoApproveGates({ note: 'be terse' })).toEqual(new Set());
  });
});

describe('PINNED_DEFAULT_MODEL_BY_PROFILE', () => {
  it('carries an explicit, non-empty pin for both known deployment profiles', () => {
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.prod).toEqual(expect.any(String));
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.prod.length).toBeGreaterThan(0);
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.staging).toEqual(expect.any(String));
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.staging.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// B-881: the LIVE model catalog. Every check below runs with NO client (client omitted/null) unless
// a describe block says otherwise — that exercises isAllowedModelAlias/getModelContextBudgetBytes's
// documented "no client -> silent degrade to MODEL_CATALOG_FALLBACK" contract, mirroring the OLD
// MODEL_ALIAS_ALLOWLIST/MODEL_CONTEXT_BUDGET_BYTES tests' offline shape one-for-one.
// =================================================================================================

describe('B-881: isAllowedModelAlias (no client — degrade-only fallback)', () => {
  it('accepts every value PINNED_DEFAULT_MODEL_BY_PROFILE can produce (the pinned tier must always be a valid switch target, even with no client)', async () => {
    for (const pinned of Object.values(PINNED_DEFAULT_MODEL_BY_PROFILE)) {
      await expect(isAllowedModelAlias(pinned)).resolves.toBe(true);
    }
  });

  it('accepts every alias in MODEL_CATALOG_FALLBACK itself', async () => {
    for (const entry of MODEL_CATALOG_FALLBACK) {
      await expect(isAllowedModelAlias(entry.alias)).resolves.toBe(true);
    }
  });

  it('rejects an arbitrary/unrecognized string', async () => {
    await expect(isAllowedModelAlias('not-a-real-model')).resolves.toBe(false);
  });

  it('rejects an empty string', async () => {
    await expect(isAllowedModelAlias('')).resolves.toBe(false);
  });

  it('rejects a shell-metacharacter-laden string (the argv-injection surface this check exists to close)', async () => {
    await expect(isAllowedModelAlias('claude-sonnet-5"; rm -rf / #')).resolves.toBe(false);
  });

  it('never contains claude-haiku-5 — a model that has never existed (the defect this ticket purges)', () => {
    expect(MODEL_CATALOG_FALLBACK.some((entry) => entry.alias === 'claude-haiku-5')).toBe(false);
  });
});

describe('B-881: getModelContextBudgetBytes (no client — degrade-only fallback)', () => {
  it('returns a positive byte budget for every fallback-tabled alias', async () => {
    for (const entry of MODEL_CATALOG_FALLBACK) {
      await expect(getModelContextBudgetBytes(entry.alias)).resolves.toBeGreaterThan(0);
    }
  });

  it('returns a positive conservative default for an alias absent from the fallback table', async () => {
    const fallback = await getModelContextBudgetBytes('some-future-alias');
    expect(fallback).toBeGreaterThan(0);
    // The fallback is the SMALLEST tabled budget (biases toward cold-starting, never toward
    // assuming the largest window on file) — never larger than every fallback entry.
    for (const entry of MODEL_CATALOG_FALLBACK) {
      expect(fallback).toBeLessThanOrEqual(entry.context_budget_bytes);
    }
  });

  it('never throws (resolves to a number) on an empty-string alias', async () => {
    await expect(getModelContextBudgetBytes('')).resolves.toEqual(expect.any(Number));
  });
});

/** Stands in for the one call shape fetchModelCatalog makes:
 *  `client.from('model_catalog').select(cols).eq('active', true)` — awaited directly (no
 *  `.maybeSingle()`/`.single()` terminator, since this is a multi-row select). */
function fakeCatalogClient(result: { data: unknown; error: unknown } | 'throws'): SupabaseClient {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => {
    if (result === 'throws') throw new Error('transport exploded');
    return Promise.resolve(result);
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const liveCatalogRow = (overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  alias: 'claude-opus-5',
  label: 'Claude Opus 5 (live)',
  context_budget_bytes: 999,
  active: true,
  verified_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

describe('B-881 fetchModelCatalog / resolveModelCatalog — live reachability, including the TABLE-ABSENT tolerance', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('returns the live rows when the catalog is reachable and non-empty, and resolveModelCatalog reports source "live"', async () => {
    const client = fakeCatalogClient({ data: [liveCatalogRow()], error: null });
    await expect(fetchModelCatalog(client)).resolves.toEqual([liveCatalogRow()]);
    const { entries, source } = await resolveModelCatalog(client);
    expect(source).toBe('live');
    expect(entries).toEqual([liveCatalogRow()]);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns null (no client) — silent, no warning logged (an unauthenticated caller is an ordinary, expected shape)', async () => {
    await expect(fetchModelCatalog(null)).resolves.toBeNull();
    await expect(fetchModelCatalog(undefined)).resolves.toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("B-881 TABLE-ABSENT TOLERANCE (B-383 prod-before-promote, load-bearing): a 'relation does not exist' error degrades to MODEL_CATALOG_FALLBACK, logs a WARNING to stderr, and NEVER throws", async () => {
    const client = fakeCatalogClient({
      data: null,
      error: { message: 'relation "public.model_catalog" does not exist', code: '42P01' },
    });
    await expect(fetchModelCatalog(client)).resolves.toBeNull();
    const { entries, source } = await resolveModelCatalog(client);
    expect(source).toBe('fallback');
    expect(entries).toEqual(MODEL_CATALOG_FALLBACK);
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toMatch(/model_catalog/i);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/unreachable/i);
  });

  it('degrades to MODEL_CATALOG_FALLBACK (never throws) when the transport blows up', async () => {
    const client = fakeCatalogClient('throws');
    await expect(fetchModelCatalog(client)).resolves.toBeNull();
    const { entries, source } = await resolveModelCatalog(client);
    expect(source).toBe('fallback');
    expect(entries).toEqual(MODEL_CATALOG_FALLBACK);
    expect(errSpy).toHaveBeenCalled();
  });

  it('degrades to MODEL_CATALOG_FALLBACK and logs a warning when the catalog is reachable but has zero active rows', async () => {
    const client = fakeCatalogClient({ data: [], error: null });
    const { entries, source } = await resolveModelCatalog(client);
    expect(source).toBe('fallback');
    expect(entries).toEqual(MODEL_CATALOG_FALLBACK);
    expect(errSpy).toHaveBeenCalled();
  });

  it('isAllowedModelAlias / getModelContextBudgetBytes both consult the LIVE catalog (never the fallback) once a client is reachable', async () => {
    const client = fakeCatalogClient({
      data: [liveCatalogRow({ alias: 'live-only-alias', context_budget_bytes: 42 })],
      error: null,
    });
    await expect(isAllowedModelAlias('live-only-alias', client)).resolves.toBe(true);
    // Not in THIS live catalog, even though it IS in the fallback — once reachable, the catalog is
    // ALWAYS authoritative and the fallback is never consulted (this ticket's own drift-only-during-
    // outage contract).
    await expect(isAllowedModelAlias('claude-sonnet-5', client)).resolves.toBe(false);
    await expect(getModelContextBudgetBytes('live-only-alias', client)).resolves.toBe(42);
  });
});

describe('B-772 round 2: model handoff-file contract', () => {
  let dir: string;
  let handoffPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'b772-handoff-'));
    handoffPath = join(dir, 'model-handoff-request.json');
    env = { HARMONY_MODEL_HANDOFF_PATH: handoffPath };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('getModelHandoffPath honors the HARMONY_MODEL_HANDOFF_PATH override', () => {
    expect(getModelHandoffPath(env)).toBe(handoffPath);
  });

  it('getModelHandoffPath falls back to $HOME/.harmony/model-handoff-request.json when no override is set', () => {
    const resolved = getModelHandoffPath({ HOME: '/fake/home' });
    expect(resolved).toBe(join('/fake/home', '.harmony', 'model-handoff-request.json'));
  });

  it('readModelHandoffRequest returns null when no file exists yet', () => {
    expect(readModelHandoffRequest(env)).toBeNull();
  });

  it('writeModelHandoffRequest then readModelHandoffRequest round-trips the alias', () => {
    writeModelHandoffRequest('claude-opus-5', env);
    expect(existsSync(handoffPath)).toBe(true);
    expect(readModelHandoffRequest(env)).toEqual({ requested_model: 'claude-opus-5' });
  });

  it('writeModelHandoffRequest creates the parent directory when it does not exist yet', () => {
    const nestedPath = join(dir, 'nested', 'sub', 'model-handoff-request.json');
    writeModelHandoffRequest('claude-sonnet-5', { HARMONY_MODEL_HANDOFF_PATH: nestedPath });
    expect(existsSync(nestedPath)).toBe(true);
  });

  it('writeModelHandoffRequest overwrites a prior pending request — only the latest matters', () => {
    writeModelHandoffRequest('claude-sonnet-5', env);
    writeModelHandoffRequest('claude-haiku-4-5-20251001', env);
    expect(readModelHandoffRequest(env)).toEqual({ requested_model: 'claude-haiku-4-5-20251001' });
  });

  it('readModelHandoffRequest returns null on malformed JSON (best-effort, never throws)', () => {
    fsWriteFileSync(handoffPath, 'not valid json');
    expect(readModelHandoffRequest(env)).toBeNull();
  });

  it('readModelHandoffRequest returns null when requested_model is missing/non-string', () => {
    fsWriteFileSync(handoffPath, JSON.stringify({ requested_model: 42 }));
    expect(readModelHandoffRequest(env)).toBeNull();
  });

  it('readModelHandoffRequest returns null when requested_model is an empty string', () => {
    fsWriteFileSync(handoffPath, JSON.stringify({ requested_model: '' }));
    expect(readModelHandoffRequest(env)).toBeNull();
  });

  it('clearModelHandoffRequest deletes a pending request', () => {
    writeModelHandoffRequest('claude-sonnet-5', env);
    clearModelHandoffRequest(env);
    expect(existsSync(handoffPath)).toBe(false);
    expect(readModelHandoffRequest(env)).toBeNull();
  });

  it('clearModelHandoffRequest is idempotent — a second clear on an already-absent file does not throw', () => {
    expect(() => clearModelHandoffRequest(env)).not.toThrow();
    expect(() => clearModelHandoffRequest(env)).not.toThrow();
  });
});

// =================================================================================================
// B-892: resolveRunConfigFromConduction — the gate-boundary re-read of conductions.run_config.
// Contract under test: returns the row's parsed run_config, or NULL on ANY failure, and NEVER
// throws (callers read null as "fall back to the launch env").
// =================================================================================================

/** Stands in for the one call shape getConduction makes:
 *  `client.from('conductions').select(COLS).eq('id', id).maybeSingle()`. */
function fakeConductionClient(
  result: { data: unknown; error: unknown } | 'throws',
): { client: SupabaseClient; fromSpy: ReturnType<typeof vi.fn> } {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => {
    if (result === 'throws') throw new Error('transport exploded');
    return result;
  };
  const fromSpy = vi.fn(() => chain);
  return { client: { from: fromSpy } as unknown as SupabaseClient, fromSpy };
}

const conductionRow = (run_config: unknown) => ({
  data: { id: 'cond-892', task_id: 't-1', status: 'active', run_config },
  error: null,
});

describe('B-892 resolveRunConfigFromConduction', () => {
  it("returns the row's run_config, parsed", async () => {
    const { client } = fakeConductionClient(
      conductionRow({ note: 'edited mid-run', auto_approve_gates: ['design'] }),
    );
    await expect(resolveRunConfigFromConduction(client, 'cond-892')).resolves.toEqual({
      note: 'edited mid-run',
      auto_approve_gates: ['design'],
    });
  });

  it("returns an EMPTY config (not null) for a row whose run_config is `{}` — a cleared payload is an ANSWER, not a failure", async () => {
    const { client } = fakeConductionClient(conductionRow({}));
    await expect(resolveRunConfigFromConduction(client, 'cond-892')).resolves.toEqual({});
  });

  it('preserves forward compatibility — an unrecognized top-level key passes through, never rejects', async () => {
    const { client } = fakeConductionClient(conductionRow({ some_future_axis: { on: true } }));
    const parsed = await resolveRunConfigFromConduction(client, 'cond-892');
    expect(parsed).toEqual({ some_future_axis: { on: true } });
  });

  it('returns null (no DB call at all) when the conduction id is absent', async () => {
    const { client, fromSpy } = fakeConductionClient(conductionRow({ note: 'x' }));
    await expect(resolveRunConfigFromConduction(client, null)).resolves.toBeNull();
    await expect(resolveRunConfigFromConduction(client, undefined)).resolves.toBeNull();
    await expect(resolveRunConfigFromConduction(client, '')).resolves.toBeNull();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('returns null when there is no client', async () => {
    await expect(resolveRunConfigFromConduction(null, 'cond-892')).resolves.toBeNull();
    await expect(resolveRunConfigFromConduction(undefined, 'cond-892')).resolves.toBeNull();
  });

  it('returns null when the row does not exist', async () => {
    const { client } = fakeConductionClient({ data: null, error: null });
    await expect(resolveRunConfigFromConduction(client, 'cond-892')).resolves.toBeNull();
  });

  it('returns null (never throws) when the query errors', async () => {
    const { client } = fakeConductionClient({ data: null, error: { message: 'permission denied' } });
    await expect(resolveRunConfigFromConduction(client, 'cond-892')).resolves.toBeNull();
  });

  it('returns null (never throws) when the transport blows up', async () => {
    const { client } = fakeConductionClient('throws');
    await expect(resolveRunConfigFromConduction(client, 'cond-892')).resolves.toBeNull();
  });

  it('returns null for a MALFORMED run_config payload rather than throwing', async () => {
    for (const malformed of [
      { auto_approve_gates: 'not-an-array' },
      { note: 42 },
      { auto_approve_gates: ['release'] }, // structurally excluded from the auto-approve enum
      'a bare string',
      [1, 2, 3],
      7,
    ]) {
      const { client } = fakeConductionClient(conductionRow(malformed));
      await expect(resolveRunConfigFromConduction(client, 'cond-892')).resolves.toBeNull();
    }
  });

  it('returns null when the row carries a null run_config (a pre-migration/absent column)', async () => {
    const { client } = fakeConductionClient(conductionRow(null));
    await expect(resolveRunConfigFromConduction(client, 'cond-892')).resolves.toBeNull();
  });
});
