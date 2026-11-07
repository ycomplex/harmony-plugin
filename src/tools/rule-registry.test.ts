import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readRuleRegistry, readRuleRegistryTool, ruleFingerprint, RULE_REGISTRY_UNAVAILABLE } from './rule-registry.js';
import { registerTools } from './index.js';

type Result = { data: unknown; error: unknown };

/** A chainable PostgREST builder stub: records every filter call, resolves to `result` when awaited. */
function builder(result: Result) {
  const calls: Array<[string, unknown[]]> = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'overlaps', 'ilike', 'order', 'limit']) {
    b[m] = vi.fn((...args: unknown[]) => { calls.push([m, args]); return b; });
  }
  b.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return { b, calls };
}

function client(tables: Record<string, Result>) {
  const built: Record<string, ReturnType<typeof builder>> = {};
  const from = vi.fn((table: string) => {
    const r = tables[table];
    if (!r) throw new Error(`unexpected table ${table}`);
    built[table] = builder(r);
    return built[table].b;
  });
  return { client: { from } as any, built, from };
}

const ROW = {
  entry_id: 'entry-1', fingerprint: 'a'.repeat(64), normalized_claim: 'buttons use the primary token',
  scope: 'product', reach: 'this_product', domains: ['ui'], surfaces: ['Board'],
};

const CONTENT = 'Buttons use the primary token.';
const LIVE = createHash('sha256').update(CONTENT, 'utf8').digest('hex');

describe('ruleFingerprint (B-1421)', () => {
  it('matches the pinned cross-repo vector', () => {
    // PINNED VECTOR: the web DB suite (supabase/tests/b1421_rule_registry_in_step.test.sql in
    // harmony-web) asserts the same input hashes to the same value through b1047_rule_fingerprint,
    // so the plugin's live fingerprint and the database's stale check cannot diverge silently.
    expect(ruleFingerprint('Règle — fingerprint fixture ✓ 規則 (B-1421)'))
      .toBe('1751bb42d8fc90230bf5ec2fc8094b8205ca7621050fde9b98cd18dacacbec6a');
  });
});

describe('readRuleRegistry live fingerprint and drift (B-1421)', () => {
  it('an in-step row reports drift false and the matching fingerprint', async () => {
    const { client: c } = client({
      knowledge_rule_registry: { data: [{ ...ROW, fingerprint: LIVE }], error: null },
      knowledge_decisions: { data: [{ id: 'entry-1', title: 'Primary buttons', status: 'Accepted', content: CONTENT }], error: null },
    });
    const result = await readRuleRegistry(c, 'project-1');
    expect(result.rules[0]).toMatchObject({ fingerprint: LIVE, stored_fingerprint: LIVE, drift: false });
  });

  it('a drifted row (content edited outside a rule_bundle) returns the live hash and drift true', async () => {
    const stale = ruleFingerprint('Buttons used the old token.');
    const { client: c } = client({
      knowledge_rule_registry: { data: [{ ...ROW, fingerprint: stale }], error: null },
      knowledge_decisions: { data: [{ id: 'entry-1', title: 'Primary buttons', status: 'Accepted', content: CONTENT }], error: null },
    });
    const result = await readRuleRegistry(c, 'project-1');
    expect(result.rules[0]).toMatchObject({ fingerprint: LIVE, stored_fingerprint: stale, drift: true });
  });

  it('a missing entry or unreadable content falls back to the stored fingerprint with drift null', async () => {
    const { client: c } = client({
      knowledge_rule_registry: { data: [ROW, { ...ROW, entry_id: 'entry-2' }], error: null },
      knowledge_decisions: { data: [{ id: 'entry-2', title: 'Hidden', status: 'Accepted', content: null }], error: null },
    });
    const result = await readRuleRegistry(c, 'project-1');
    for (const rule of result.rules) {
      expect(rule).toMatchObject({ fingerprint: ROW.fingerprint, stored_fingerprint: ROW.fingerprint, drift: null });
    }
  });

  it('hashes an empty string content rather than treating it as unreadable', async () => {
    const { client: c } = client({
      knowledge_rule_registry: { data: [ROW], error: null },
      knowledge_decisions: { data: [{ id: 'entry-1', title: 'Empty', status: 'Accepted', content: '' }], error: null },
    });
    const result = await readRuleRegistry(c, 'project-1');
    expect(result.rules[0]).toMatchObject({ fingerprint: ruleFingerprint(''), drift: true });
  });
});

describe('readRuleRegistry (B-1047)', () => {
  it('returns available rows joined with their entry title, status and content', async () => {
    const { client: c, built } = client({
      knowledge_rule_registry: { data: [ROW, { ...ROW, entry_id: 'entry-2', domains: null, surfaces: null }], error: null },
      knowledge_decisions: { data: [{ id: 'entry-1', title: 'Primary buttons', status: 'Accepted', content: 'Buttons use the primary token.' }], error: null },
    });
    const result = await readRuleRegistry(c, 'project-1');
    expect(result).toEqual({
      availability: 'available',
      rules: [
        {
          ...ROW, fingerprint: LIVE, stored_fingerprint: ROW.fingerprint, drift: true,
          title: 'Primary buttons', status: 'Accepted', content: 'Buttons use the primary token.',
        },
        {
          ...ROW, entry_id: 'entry-2', stored_fingerprint: ROW.fingerprint, drift: null,
          domains: [], surfaces: [], title: null, status: null, content: null,
        },
      ],
    });
    expect(built.knowledge_rule_registry.calls).toContainEqual(['eq', ['project_id', 'project-1']]);
    expect(built.knowledge_rule_registry.calls).toContainEqual(['limit', [50]]);
    expect(built.knowledge_decisions.calls).toContainEqual(['in', ['id', ['entry-1', 'entry-2']]]);
  });

  it('filters by entry_id, domains, surfaces and an escaped search', async () => {
    const { client: c, built } = client({
      knowledge_rule_registry: { data: [ROW], error: null },
      knowledge_decisions: { data: [], error: null },
    });
    await readRuleRegistry(c, 'project-1', { entry_id: 'entry-1', domains: ['ui'], surfaces: ['Board'], search: '50%_off', limit: 5 });
    const calls = built.knowledge_rule_registry.calls;
    expect(calls).toContainEqual(['eq', ['entry_id', 'entry-1']]);
    expect(calls).toContainEqual(['overlaps', ['domains', ['ui']]]);
    expect(calls).toContainEqual(['overlaps', ['surfaces', ['Board']]]);
    expect(calls).toContainEqual(['ilike', ['normalized_claim', '%50\\%\\_off%']]);
    expect(calls).toContainEqual(['limit', [5]]);
  });

  it('an empty registry is available with no rules and skips the entry read', async () => {
    const { client: c, from } = client({ knowledge_rule_registry: { data: [], error: null } });
    expect(await readRuleRegistry(c, 'project-1')).toEqual({ availability: 'available', rules: [] });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it.each(['PGRST205', '42P01'])('degrades to unavailable when the table is missing (%s)', async (code) => {
    const { client: c } = client({
      knowledge_rule_registry: { data: null, error: { code, message: 'relation "public.knowledge_rule_registry" does not exist' } },
    });
    expect(await readRuleRegistry(c, 'project-1')).toEqual({ availability: 'unavailable', reason: RULE_REGISTRY_UNAVAILABLE, rules: [] });
  });

  it.each(['42501', 'PGRST301'])('propagates any other error (%s)', async (code) => {
    const { client: c } = client({ knowledge_rule_registry: { data: null, error: { code, message: `denied ${code}` } } });
    await expect(readRuleRegistry(c, 'project-1')).rejects.toThrow(`denied ${code}`);
  });

  it('propagates an entry-read error rather than returning rules without their content', async () => {
    const { client: c } = client({
      knowledge_rule_registry: { data: [ROW], error: null },
      knowledge_decisions: { data: null, error: { code: '42501', message: 'permission denied' } },
    });
    await expect(readRuleRegistry(c, 'project-1')).rejects.toThrow('permission denied');
  });

  it('refuses unknown arguments and is registered as an MCP tool', async () => {
    const { client: c } = client({ knowledge_rule_registry: { data: [], error: null } });
    await expect(readRuleRegistry(c, 'project-1', { fingerprint: 'x' })).rejects.toThrow();
    expect(registerTools().map((t: { name: string }) => t.name)).toContain(readRuleRegistryTool.name);
    expect(readRuleRegistryTool.name).toBe('read_rule_registry');
  });
});
