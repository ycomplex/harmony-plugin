// B-1274: unpark inherits the previous conduction's run_config.

import { getModelForGate } from '../config/run-config.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeRunConfig, resolveUnparkRunConfig, INHERITED_FROM_KEY } from './unpark-inheritance.js';

const mocks = vi.hoisted(() => ({ listConductions: vi.fn() }));
vi.mock('./conduction-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conduction-record.js')>();
  return { ...actual, listConductions: mocks.listConductions };
});

const clientFor = (workflow_state: string | null) =>
  ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { workflow_state }, error: null }) }) }),
    }),
  }) as never;

const previous = {
  id: 'cond-old',
  run_config: {
    agent: { adapter: 'codex' },
    model: { default: 'codex:gpt-6.1-sol' },
    auto_approve_gates: ['clarify', 'decompose', 'design', 'plan', 'build'],
    release_delegate: 'orchestrator',
    fast_track: false,
    note: 'v1.10 follow-on',
    session_resume: { enabled: true },
    inherited_from: 'cond-older',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConductions.mockResolvedValue([previous]);
});

describe('resolveUnparkRunConfig', () => {
  it('inherits the full previous run_config when no run_config is passed, stamping inherited_from', async () => {
    const result = await resolveUnparkRunConfig(clientFor('Parked'), 't1', { unpark: true });

    expect(result).toEqual({ ...previous.run_config, [INHERITED_FROM_KEY]: 'cond-old' });
    expect(mocks.listConductions).toHaveBeenCalledWith(expect.anything(), { task_id: 't1', order: 'desc' });
  });

  it('merges an explicit run_config over the inherited one, key by key', async () => {
    const result = await resolveUnparkRunConfig(clientFor('Parked'), 't1', {
      unpark: true,
      explicit: { agent: { adapter: 'claude-code' }, auto_approve_gates: ['clarify'] },
    });

    expect(result).toMatchObject({
      agent: { adapter: 'claude-code' },
      auto_approve_gates: ['clarify'],
      model: { default: 'codex:gpt-6.1-sol' },
      release_delegate: 'orchestrator',
      note: 'v1.10 follow-on',
      [INHERITED_FROM_KEY]: 'cond-old',
    });
  });

  it('returns the explicit run_config untouched when the ticket has no previous conduction', async () => {
    mocks.listConductions.mockResolvedValue([]);
    const explicit = { note: 'fresh' };
    expect(await resolveUnparkRunConfig(clientFor('Parked'), 't1', { unpark: true, explicit })).toBe(explicit);
    expect(await resolveUnparkRunConfig(clientFor('Parked'), 't1', { unpark: true })).toBeUndefined();
  });

  it('inherits nothing when the ticket is not Parked, or unpark is not requested', async () => {
    expect(await resolveUnparkRunConfig(clientFor('Built'), 't1', { unpark: true })).toBeUndefined();
    expect(await resolveUnparkRunConfig(clientFor('Parked'), 't1', {})).toBeUndefined();
    expect(mocks.listConductions).not.toHaveBeenCalled();
  });

  it('inherits the stub run_config of a previous conduction that only had one', async () => {
    mocks.listConductions.mockResolvedValue([{ id: 'cond-stub', run_config: null }]);
    expect(await resolveUnparkRunConfig(clientFor('Parked'), 't1', { unpark: true })).toEqual({
      [INHERITED_FROM_KEY]: 'cond-stub',
    });
  });
});

describe('mergeRunConfig', () => {
  it('replaces model selection, arrays and scalars, and ignores undefined overrides', () => {
    const merged = mergeRunConfig(
      { model: { default: 'a', per_gate: { plan: 'b' } }, auto_approve_gates: ['plan', 'build'], note: 'x' } as never,
      { model: { per_gate: { build: 'c' } }, auto_approve_gates: [], note: undefined } as never,
    );
    expect(merged).toEqual({
      model: { per_gate: { build: 'c' } },
      auto_approve_gates: [],
      note: 'x',
    });
  });
});


describe('B-1352 model selection boundary', () => {
  const base = {
    model: { default: 'old', per_gate: { plan: 'old-plan', build: 'old-build' } },
    session_resume: { enabled: true },
    extension: { model: { first: 1 } },
    inherited_from: 'cond-old',
  };

  it.each([
    { default: 'new' },
    { per_gate: { build: 'new-build' } },
    { default: 'new', per_gate: { build: 'new-build' } },
    {},
  ])('replaces the complete top-level selection with %j without mutating inputs', model => {
    const snapshot = structuredClone(base);
    const override = { model, session_resume: { enabled: false }, extension: { model: { second: 2 } } };
    const overrideSnapshot = structuredClone(override);
    expect(mergeRunConfig(base, override)).toEqual({
      ...base, model, session_resume: { enabled: false },
      extension: { model: { first: 1, second: 2 } },
    });
    expect(base).toEqual(snapshot);
    expect(override).toEqual(overrideSnapshot);
  });

  it.each([undefined, {}, { model: undefined }, { note: 'changed' }])('inherits omitted model with override %j', override => {
    expect(mergeRunConfig(base, override).model).toEqual(base.model);
  });

  it('retains schema validation for invalid explicit model settings', () => {
    expect(() => mergeRunConfig(base, { model: null } as never)).toThrow();
  });

  it('replaces saved per-gate settings and stamps the immediate source conduction', async () => {
    mocks.listConductions.mockResolvedValue([{ ...previous, run_config: { ...previous.run_config, model: base.model } }]);
    const result = await resolveUnparkRunConfig(clientFor('Parked'), 't1', {
      unpark: true, explicit: { model: { default: 'new' } },
    });
    expect(result).toEqual({ ...previous.run_config, model: { default: 'new' }, inherited_from: 'cond-old' });
  });
});


describe('B-1352 effective gate choices', () => {
  const base = { model: { default: 'old', per_gate: { plan: 'old-plan' } } };
  it('uses a new default for both previously overridden and other gates', () => {
    const merged = mergeRunConfig(base, { model: { default: 'new' } });
    expect(getModelForGate(merged, 'plan', {})).toBe('new');
    expect(getModelForGate(merged, 'build', {})).toBe('new');
  });
  it('uses only supplied per-gate choices and normal fallback for omitted gates', () => {
    const merged = mergeRunConfig(base, { model: { per_gate: { build: 'new-build' } } });
    expect(getModelForGate(merged, 'build', {})).toBe('new-build');
    expect(getModelForGate(merged, 'plan', {})).toBe(getModelForGate({}, 'plan', {}));
  });
});
