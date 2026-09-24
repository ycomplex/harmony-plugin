// B-925: `getProjectConductionDefaults` / `fillRunConfigDefaults` — the plugin-side conduction
// defaults fill, unit-tested at the module level (no CLI/MCP wiring). See conduct.test.ts /
// create-conduction.test.ts for the two entry-point wiring tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getProjectConductionDefaults, fillRunConfigDefaults } from './conduction-defaults.js';
import type { RunConfig } from './run-config.js';

// Mirrors conduction-record.test.ts's own makeClient convention: a chainable supabase mock whose
// terminal method (single) resolves the next queued response.
function makeClient(response: { data: unknown; error?: unknown }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'eq']) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(async () => response);
  return chain;
}

describe('getProjectConductionDefaults', () => {
  it('selects only conduction_defaults for the given project id, and returns it', async () => {
    const client = makeClient({ data: { conduction_defaults: { model: 'claude-sonnet-5' } } });

    const result = await getProjectConductionDefaults(client, 'proj-1');

    expect(client.from).toHaveBeenCalledWith('projects');
    expect(client.select).toHaveBeenCalledWith('conduction_defaults');
    expect(client.eq).toHaveBeenCalledWith('id', 'proj-1');
    expect(result).toEqual({ model: 'claude-sonnet-5' });
  });

  it('returns {} when the row has a null conduction_defaults', async () => {
    const client = makeClient({ data: { conduction_defaults: null } });
    expect(await getProjectConductionDefaults(client, 'proj-1')).toEqual({});
  });

  it('degrades to {} (never throws) and logs exactly one warning when the column is absent (42703)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient({ data: null, error: { code: '42703', message: 'column projects.conduction_defaults does not exist' } });

    const result = await getProjectConductionDefaults(client, 'proj-1');

    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('degrades to {} when the schema-cache miss code PGRST204 is returned', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient({ data: null, error: { code: 'PGRST204', message: "Could not find the 'conduction_defaults' column" } });

    expect(await getProjectConductionDefaults(client, 'proj-1')).toEqual({});
    warnSpy.mockRestore();
  });

  it('propagates a genuine permission-denied error (42501) rather than swallowing it', async () => {
    const client = makeClient({ data: null, error: { code: '42501', message: 'permission denied for table projects' } });

    await expect(getProjectConductionDefaults(client, 'proj-1')).rejects.toThrow(/permission denied/);
  });

  it('propagates a generic/network error rather than swallowing it', async () => {
    const client = makeClient({ data: null, error: { message: 'fetch failed' } });

    await expect(getProjectConductionDefaults(client, 'proj-1')).rejects.toThrow(/fetch failed/);
  });
});

describe('fillRunConfigDefaults', () => {
  it('an explicit session_resume: {enabled: false} is never overridden by a default of {enabled: true}', () => {
    const caller: RunConfig = { session_resume: { enabled: false } };
    const result = fillRunConfigDefaults(caller, { session_resume: { enabled: true } });
    expect(result).toBe(caller);
    expect(result).toEqual({ session_resume: { enabled: false } });
  });

  it('an explicit auto_approve_gates: [] is never overridden by a non-empty default list', () => {
    const caller: RunConfig = { auto_approve_gates: [] };
    const result = fillRunConfigDefaults(caller, { auto_approve_gates: ['clarify', 'plan'] });
    expect(result).toBe(caller);
    expect(result).toEqual({ auto_approve_gates: [] });
  });

  it('an ABSENT field DOES inherit the default', () => {
    const result = fillRunConfigDefaults({ note: 'keep this' }, { model: 'claude-opus-5' });
    expect(result).toEqual({ note: 'keep this', model: { default: 'claude-opus-5' } });
  });

  it('a caller with no run_config at all (undefined) inherits every default field', () => {
    const result = fillRunConfigDefaults(undefined, {
      model: 'claude-sonnet-5',
      session_resume: { enabled: true },
      auto_approve_gates: ['clarify'],
    });
    expect(result).toEqual({
      model: { default: 'claude-sonnet-5' },
      session_resume: { enabled: true },
      auto_approve_gates: ['clarify'],
    });
  });

  it('a project with no defaults ({}) leaves a defined caller run_config byte-for-byte unchanged', () => {
    const caller: RunConfig = { note: 'unrelated field' };
    const result = fillRunConfigDefaults(caller, {});
    expect(result).toBe(caller);
  });

  it('a project with no defaults ({}) leaves an undefined caller run_config as undefined, never {}', () => {
    const result = fillRunConfigDefaults(undefined, {});
    expect(result).toBeUndefined();
  });

  it('fills model.default alongside an existing caller model.per_gate, never touching per_gate', () => {
    const caller: RunConfig = { model: { per_gate: { build: 'claude-opus-5' } } };
    // 'model' key IS present on the caller (even though .default is absent within it), so per the
    // field-level (not sub-field-level) contract the whole model field is left alone.
    const result = fillRunConfigDefaults(caller, { model: 'claude-sonnet-5' });
    expect(result).toBe(caller);
    expect(result).toEqual({ model: { per_gate: { build: 'claude-opus-5' } } });
  });
});
