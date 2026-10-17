// B-1147: runtime-scoped model catalog — tolerant read, per-adapter pinned defaults,
// getModelForGate per adapter, runtime-filtered isAllowedModelAlias, the conduction-creation
// runtime/model guard, and the conduction-defaults agent fill.

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchModelCatalog,
  getModelForGate,
  getPinnedDefaultModel,
  isAllowedModelAlias,
  isMissingCatalogColumnError,
  MODEL_CATALOG_FALLBACK,
  PINNED_DEFAULT_MODEL_BY_PROFILE,
  type ModelCatalogEntry,
} from './run-config.js';
import { assertRunConfigRuntime } from './runtime-validation.js';
import { fillRunConfigDefaults } from './conduction-defaults.js';

const PROD_ENV = { HARMONY_SUPABASE_URL: 'https://eioxsunvhakmelhanmnn.supabase.co' };
const STAGING_ENV = { HARMONY_SUPABASE_URL: 'https://meqkdgncdzromunylyxf.supabase.co' };

/** A fake client whose successive `.select(cols)` calls each resolve to the next result, recording
 *  the selected column lists. */
function sequencedClient(results: Array<{ data: unknown; error: unknown }>) {
  const selects: string[] = [];
  let i = 0;
  const client = {
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = (cols: string) => {
        selects.push(cols);
        return chain;
      };
      chain.eq = () => Promise.resolve(results[Math.min(i++, results.length - 1)]);
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, selects };
}

const oldShapeRow = {
  alias: 'claude-opus-5',
  label: 'Claude Opus 5',
  context_budget_bytes: 1,
  active: true,
  verified_at: null,
};

const codexRow: ModelCatalogEntry = {
  alias: 'codex:gpt-6.1-sol',
  label: 'GPT 6.1 Sol',
  context_budget_bytes: 1,
  active: true,
  verified_at: null,
  agent: 'codex',
  model_id: 'gpt-6.1-sol',
  underlying_model: null,
  capabilities: {},
  pinned_default_profiles: ['prod', 'staging'],
};

const claudeRow: ModelCatalogEntry = {
  ...oldShapeRow,
  agent: 'claude-code',
  model_id: 'claude-opus-5',
  underlying_model: null,
  capabilities: {},
  pinned_default_profiles: [],
};

let errSpy: MockInstance;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('B-1147 fetchModelCatalog tolerant read', () => {
  it('detects 42703 and PGRST204 as missing-column errors, but not a permission error', () => {
    expect(isMissingCatalogColumnError({ code: '42703', message: 'column model_catalog.agent does not exist' })).toBe(true);
    expect(isMissingCatalogColumnError({ code: 'PGRST204', message: "Could not find the 'agent' column" })).toBe(true);
    expect(isMissingCatalogColumnError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingCatalogColumnError(null)).toBe(false);
  });

  it.each(['42703', 'PGRST204'])(
    'falls back to the old column set on %s and labels every row claude-code with model_id = alias',
    async (code) => {
      const missing = { data: null, error: { code, message: 'column does not exist' } };
      const { client, selects } = sequencedClient([missing, missing, { data: [oldShapeRow], error: null }]);
      const rows = await fetchModelCatalog(client);
      expect(rows).toEqual([{ ...oldShapeRow, agent: 'claude-code', model_id: 'claude-opus-5' }]);
      expect(selects).toHaveLength(3);
      expect(selects[0]).toMatch(/\bagent\b/);
      expect(selects[2]).toBe('alias, label, context_budget_bytes, active, verified_at');
    },
  );

  it('reads the new shape directly when the columns exist', async () => {
    const { client, selects } = sequencedClient([{ data: [claudeRow, codexRow], error: null }]);
    const rows = await fetchModelCatalog(client);
    expect(rows).toEqual([claudeRow, codexRow]);
    expect(selects).toHaveLength(1);
  });

  it('a non-column error still degrades to null (fallback), without re-selecting', async () => {
    const { client, selects } = sequencedClient([{ data: null, error: { code: '42501', message: 'permission denied' } }]);
    await expect(fetchModelCatalog(client)).resolves.toBeNull();
    expect(selects).toHaveLength(1);
  });

  it('MODEL_CATALOG_FALLBACK carries claude-code entries only', () => {
    for (const entry of MODEL_CATALOG_FALLBACK) {
      expect(entry.agent).toBe('claude-code');
      expect(entry.model_id).toBe(entry.alias);
    }
  });
});

describe('B-1147 per-adapter pinned defaults', () => {
  it('keeps the Claude pins unchanged and carries null Codex pins', () => {
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE['claude-code']).toEqual({
      prod: 'claude-sonnet-5-5',
      staging: 'claude-sonnet-5-5',
    });
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.codex).toEqual({ prod: null, staging: null });
  });

  it('prefers the catalog row of that agent pinned for the profile', () => {
    expect(getPinnedDefaultModel('codex', 'prod', [claudeRow, codexRow])).toBe('gpt-6.1-sol');
    expect(getPinnedDefaultModel('codex', 'staging', [codexRow])).toBe('gpt-6.1-sol');
  });

  it('falls back to the per-adapter constant when no row is pinned', () => {
    expect(getPinnedDefaultModel('codex', 'prod', [claudeRow])).toBeNull();
    expect(getPinnedDefaultModel('codex', 'prod')).toBeNull();
    expect(getPinnedDefaultModel('claude-code', 'prod', [])).toBe('claude-sonnet-5-5');
    expect(getPinnedDefaultModel('claude-code', 'unknown-profile')).toBe('claude-sonnet-5-5');
  });
});

describe('B-1147 getModelForGate per adapter', () => {
  const codex = { agent: { adapter: 'codex' } };

  it('codex: a per-gate override wins', () => {
    expect(
      getModelForGate({ ...codex, model: { default: 'gpt-6.1', per_gate: { build: 'gpt-6.1-sol' } } }, 'build', PROD_ENV),
    ).toBe('gpt-6.1-sol');
  });

  it('codex: the run default applies when no per-gate override matches', () => {
    expect(getModelForGate({ ...codex, model: { default: 'gpt-6.1' } }, 'plan', PROD_ENV)).toBe('gpt-6.1');
  });

  it('codex: the catalog-pinned row is the pinned tier when a catalog is given', () => {
    expect(getModelForGate(codex, 'build', STAGING_ENV, [claudeRow, codexRow])).toBe('gpt-6.1-sol');
  });

  it('codex: an empty catalog (or none) resolves to empty — the leg falls back to HARMONY_CODEX_MODEL / the CLI default', () => {
    expect(getModelForGate(codex, 'build', PROD_ENV, [])).toBe('');
    expect(getModelForGate(codex, 'build', PROD_ENV)).toBe('');
  });

  it('claude regression: unchanged three-level resolution (no catalog)', () => {
    expect(getModelForGate({ model: { per_gate: { build: 'claude-opus-5' } } }, 'build', PROD_ENV)).toBe('claude-opus-5');
    expect(getModelForGate({ model: { default: 'claude-haiku-5-5' } }, 'build', PROD_ENV)).toBe('claude-haiku-5-5');
    expect(getModelForGate({}, 'build', PROD_ENV)).toBe('claude-sonnet-5-5');
    expect(getModelForGate({}, null, STAGING_ENV)).toBe('claude-sonnet-5-5');
    expect(getModelForGate({ agent: { adapter: 'claude-code' } }, 'build', PROD_ENV)).toBe('claude-sonnet-5-5');
    // a malformed agent reads as claude-code here (refused separately at launch)
    expect(getModelForGate({ agent: 'nope' }, 'build', PROD_ENV)).toBe('claude-sonnet-5-5');
  });
});

describe('B-1147 isAllowedModelAlias runtime filter', () => {
  it('defaults to claude-code — Claude behavior unchanged on the fallback list', async () => {
    await expect(isAllowedModelAlias('claude-opus-5')).resolves.toBe(true);
    await expect(isAllowedModelAlias('gpt-6.1-sol')).resolves.toBe(false);
  });

  it('matches on model_id within the requested agent', async () => {
    const { client } = sequencedClient([{ data: [claudeRow, codexRow], error: null }]);
    await expect(isAllowedModelAlias('gpt-6.1-sol', client, 'codex')).resolves.toBe(true);
    await expect(isAllowedModelAlias('claude-opus-5', client, 'codex')).resolves.toBe(false);
    await expect(isAllowedModelAlias('gpt-6.1-sol', client, 'claude-code')).resolves.toBe(false);
    await expect(isAllowedModelAlias('claude-opus-5', client)).resolves.toBe(true);
  });

  it('a codex check against the fallback list (catalog unreachable) is always false', async () => {
    await expect(isAllowedModelAlias('gpt-6.1-sol', null, 'codex')).resolves.toBe(false);
  });
});

describe('B-1147 assertRunConfigRuntime', () => {
  it('passes an absent run_config and one naming no model', async () => {
    await expect(assertRunConfigRuntime(null, undefined)).resolves.toBeUndefined();
    await expect(assertRunConfigRuntime(null, { agent: { adapter: 'codex' } })).resolves.toBeUndefined();
  });

  it('refuses an unknown adapter, listing the available runtimes', async () => {
    await expect(assertRunConfigRuntime(null, { agent: { adapter: 'gemini' } })).rejects.toThrow(
      /Unknown agent runtime 'gemini' — available runtimes: claude-code, codex/,
    );
  });

  it('refuses a model default not in the catalog for the run adapter, naming runtime and its models', async () => {
    const { client } = sequencedClient([{ data: [claudeRow, codexRow], error: null }]);
    await expect(
      assertRunConfigRuntime(client, { agent: { adapter: 'codex' }, model: { default: 'claude-opus-5' } }),
    ).rejects.toThrow(/'claude-opus-5' not available on runtime 'codex' — available models for 'codex': gpt-6.1-sol/);
  });

  it('refuses a per-gate model not in the catalog for the run adapter', async () => {
    const { client } = sequencedClient([{ data: [claudeRow, codexRow], error: null }]);
    await expect(
      assertRunConfigRuntime(client, { model: { per_gate: { build: 'gpt-6.1-sol' } } }),
    ).rejects.toThrow(/runtime 'claude-code'/);
  });

  it('accepts matching models', async () => {
    const { client } = sequencedClient([{ data: [claudeRow, codexRow], error: null }]);
    await expect(
      assertRunConfigRuntime(client, { agent: { adapter: 'codex' }, model: { default: 'gpt-6.1-sol' } }),
    ).resolves.toBeUndefined();
    await expect(assertRunConfigRuntime(null, { model: { default: 'claude-opus-5' } })).resolves.toBeUndefined();
  });
});

describe('B-1147 conduction-defaults agent fill', () => {
  it('copies agent when the caller left it unset', () => {
    expect(fillRunConfigDefaults(undefined, { agent: { adapter: 'codex' } })).toEqual({ agent: { adapter: 'codex' } });
    expect(fillRunConfigDefaults({ note: 'x' }, { agent: { adapter: 'codex' } })).toEqual({
      note: 'x',
      agent: { adapter: 'codex' },
    });
  });

  it('never overrides an explicit caller agent', () => {
    const caller = { agent: { adapter: 'claude-code' } };
    expect(fillRunConfigDefaults(caller, { agent: { adapter: 'codex' } })).toBe(caller);
  });

  it('ignores a malformed agent default', () => {
    expect(fillRunConfigDefaults(undefined, { agent: { adapter: '' } })).toBeUndefined();
    expect(fillRunConfigDefaults(undefined, { agent: {} })).toBeUndefined();
  });
});
