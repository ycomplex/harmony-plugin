// B-1346: the workspace model-policy guard (assertRunConfigPolicy), and an explicitly named
// INACTIVE offer passing both the runtime guard and the policy guard.

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertRunConfigPolicy, assertRunConfigRuntime } from './runtime-validation.js';

const row = (alias: string, model_id: string, agent: string, active = true) => ({
  alias,
  label: alias,
  context_budget_bytes: 1,
  active,
  verified_at: null,
  agent,
  model_id,
  underlying_model: null,
  capabilities: {},
  pinned_default_profiles: null,
  provider: null,
  context_window_tokens: null,
});

const opus = row('claude-opus-5', 'claude-opus-5', 'claude-code');
const sonnet = row('claude-sonnet-5', 'claude-sonnet-5', 'claude-code');
const haiku = row('claude-haiku-5-5', 'claude-haiku-5-5', 'claude-code');
const sol = row('codex:gpt-6.1-sol', 'gpt-6.1-sol', 'codex');
const luna = row('codex:gpt-6-luna', 'gpt-6-luna', 'codex');
const inactiveOffer = row('codex:or-offer', 'vendor/or-offer', 'codex', false);
const CATALOG = [opus, sonnet, haiku, sol, luna, inactiveOffer];

/** A fake client: `projects` answers the policy embed read; `model_catalog` answers every catalog
 *  read with `catalog` (an `.eq('active', true)` read is filtered to active rows). */
function fakeClient(policy: unknown, catalog = CATALOG) {
  return {
    from(table: string) {
      if (table === 'projects') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: { workspace: { model_policy: policy } }, error: null }),
          single: async () => ({ data: { workspace: { model_policy: policy } }, error: null }),
        };
        return chain;
      }
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => Promise.resolve({ data: catalog.filter((r) => r.active), error: null });
      chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: catalog, error: null }).then(ok, bad);
      return chain;
    },
  } as unknown as SupabaseClient;
}

const TWO = { allowed_aliases: ['claude-opus-5', 'claude-sonnet-5'] };

let errSpy: MockInstance;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('B-1346 assertRunConfigPolicy', () => {
  it('a two-offer policy accepts each of the two and refuses a third, naming the allowed set', async () => {
    const client = fakeClient(TWO);
    await expect(assertRunConfigPolicy(client, 'p', { model: { default: 'claude-opus-5' } })).resolves.toBeUndefined();
    await expect(assertRunConfigPolicy(client, 'p', { model: { default: 'claude-sonnet-5' } })).resolves.toBeUndefined();
    await expect(assertRunConfigPolicy(client, 'p', { model: { default: 'claude-haiku-5-5' } })).rejects.toThrow(
      "Model 'claude-haiku-5-5' is not allowed by this workspace's model policy — allowed: claude-opus-5, claude-sonnet-5",
    );
  });

  it('uses the plural form for several refused models', async () => {
    const client = fakeClient({ allowed_aliases: ['claude-opus-5'] });
    await expect(
      assertRunConfigPolicy(client, 'p', { model: { default: 'claude-haiku-5-5', per_gate: { build: 'claude-sonnet-5' } } }),
    ).rejects.toThrow(
      "Models 'claude-haiku-5-5', 'claude-sonnet-5' are not allowed by this workspace's model policy — allowed: claude-opus-5",
    );
  });

  it.each([null, {}, { allowed_aliases: [] }, { allowed_aliases: 'claude-opus-5' }])(
    'an empty policy (%j) accepts anything the runtime check accepts',
    async (policy) => {
      const client = fakeClient(policy);
      const config = { model: { default: 'claude-haiku-5-5', per_gate: { build: 'claude-opus-5' } } };
      await expect(assertRunConfigRuntime(client, config)).resolves.toBeUndefined();
      await expect(assertRunConfigPolicy(client, 'p', config)).resolves.toBeUndefined();
    },
  );

  it('passes without reading the policy when no run_config or no model is given', async () => {
    const client = fakeClient({ allowed_aliases: ['claude-opus-5'] });
    await expect(assertRunConfigPolicy(client, 'p', undefined)).resolves.toBeUndefined();
    await expect(assertRunConfigPolicy(client, 'p', { note: 'x' })).resolves.toBeUndefined();
  });

  it.each([
    ['policy alias, run model_id', ['codex:gpt-6.1-sol'], 'gpt-6.1-sol'],
    ['policy model_id, run alias', ['gpt-6.1-sol'], 'codex:gpt-6.1-sol'],
    ['both alias', ['codex:gpt-6.1-sol'], 'codex:gpt-6.1-sol'],
  ])('the alias and codex:<model_id> spellings both match (%s)', async (_label, allowed, model) => {
    const client = fakeClient({ allowed_aliases: allowed });
    await expect(
      assertRunConfigPolicy(client, 'p', { agent: { adapter: 'codex' }, model: { default: model } }),
    ).resolves.toBeUndefined();
    await expect(
      assertRunConfigPolicy(client, 'p', { agent: { adapter: 'codex' }, model: { default: 'gpt-6-luna' } }),
    ).rejects.toThrow(/'gpt-6-luna' is not allowed/);
  });

  it('falls back to a prefix-stripped string match when the catalog has no row for either', async () => {
    const client = fakeClient({ allowed_aliases: ['codex:gpt-9-uncatalogued'] });
    await expect(
      assertRunConfigPolicy(client, 'p', { agent: { adapter: 'codex' }, model: { default: 'gpt-9-uncatalogued' } }),
    ).resolves.toBeUndefined();
  });

  it('refuses a per-gate model outside the policy even when the default is inside', async () => {
    const client = fakeClient(TWO);
    await expect(
      assertRunConfigPolicy(client, 'p', { model: { default: 'claude-opus-5', per_gate: { build: 'claude-haiku-5-5' } } }),
    ).rejects.toThrow("Model 'claude-haiku-5-5' is not allowed by this workspace's model policy — allowed: claude-opus-5, claude-sonnet-5");
  });

  it('an explicitly named INACTIVE offer in the policy passes both the runtime and the policy guard', async () => {
    const client = fakeClient({ allowed_aliases: ['codex:or-offer', 'codex:gpt-6.1-sol'] });
    for (const model of ['codex:or-offer', 'vendor/or-offer']) {
      const config = { agent: { adapter: 'codex' }, model: { default: model } };
      await expect(assertRunConfigRuntime(client, config)).resolves.toBeUndefined();
      await expect(assertRunConfigPolicy(client, 'p', config)).resolves.toBeUndefined();
    }
  });
});
