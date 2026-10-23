// Original-contract fixtures keep optional name storage absent; knowledge-names tests exercise the boundary.
vi.mock('./knowledge-names.js', async importOriginal => ({ ...await importOriginal<typeof import('./knowledge-names.js')>(), readKnowledgeNames: async () => ({available:false,matches:[],entries:[],identities:[]}), withRetiredWording: async (_c:unknown,_p:unknown,entries:unknown[])=>entries }));
import { describe, it, expect, vi } from 'vitest';
import { encodeClaim } from './knowledge-claim.js';
import { queryKnowledge } from './knowledge.js';

function clientFor(rows: Array<Record<string, unknown>>, matches: Array<Record<string, unknown>> = []) {
  const calls: Array<{ cols: string; filters: Array<[string, unknown]>; ranges: number[][]; inFilters: Array<[string, unknown[]]> }> = [];
  function queryFor(dataset: Array<Record<string, unknown>>, track = true) {
    const call = { cols: '', filters: [] as Array<[string, unknown]>, ranges: [] as number[][], inFilters: [] as Array<[string, unknown[]]> };
    if (track) calls.push(call);
    let bookkeeping: boolean | null = null;
    const filtered = () => dataset.filter(row => call.filters.every(([key, value]) => row[key] === value))
      .filter(row => call.inFilters.every(([key, values]) => values.includes(row[key])))
      .filter(row => bookkeeping === null || ((row.tags as string[] | null)?.includes('harmony:bookkeeping') ?? false) === bookkeeping);
    const q: any = {
      select: (cols: string) => { call.cols = cols; return q; },
      eq: (key: string, value: unknown) => { call.filters.push([key, value]); return q; },
      neq: () => q, order: () => q,
      in: (key: string, values: unknown[]) => { call.inFilters.push([key, values]); return q; },
      limit: async (n: number) => ({ data: filtered().slice(0, n), error: null }),
      or: () => { bookkeeping = false; return q; },
      contains: () => { bookkeeping = true; return q; },
      range: async (a: number, b: number) => {
        call.ranges.push([a, b]);
        const rows = filtered();
        return { data: rows.slice(a, b + 1), error: null, count: rows.length };
      },
    }; return q;
  }
  const client: any = { functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
    rpc: vi.fn((name: string) => (name === 'read_knowledge_source_values' || name === 'read_knowledge_invalidations' || name === 'read_knowledge_definitions')
      ? Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find function read_knowledge_definitions' } })
      : queryFor(matches, false)),
    from: (table: string) => {
      if (table === 'projects') return { select: () => ({ eq: () => ({ single: async () => ({ data: { workspace_id: 'ws' }, error: null }) }) }) };
      return queryFor(rows);
    } };
  return { client, calls };
}

const entry = (id: string, superseded_by: string | null = null, project_id = 'p') => ({ id, superseded_by, project_id, workspace_id: 'ws', status: 'Accepted', title: id, type: 'architecture', domain: [], tags: [], updated_at: '2026-10-01T00:00:00Z' });

describe('queryKnowledge supersession contract', () => {
  it('paginates on the server and derives inverse links only for returned IDs', async () => {
    const { client, calls } = clientFor([entry('old', 'new'), entry('other'), entry('new'), entry('foreign', 'new', 'other-project')]);
    const result = await queryKnowledge(client, 'p', { limit: 1, offset: 2 });
    expect(result).toMatchObject([{ id: 'new', superseded_by: null, supersedes: ['old'] }]);
    expect(calls[0].ranges).toEqual([[2, 2]]);
    expect(calls.slice(1).map(c => c.inFilters)).toEqual([[['id', ['new']]], [['superseded_by', ['new']]]]);
    expect(calls.every(c => c.filters.some(([k,v]) => k === 'project_id' && v === 'p'))).toBe(true);
    expect(calls.every(c => c.filters.some(([k,v]) => k === 'workspace_id' && v === 'ws'))).toBe(true);
  });
  it('hydrates semantic results without adding filtered-out entries or losing relevance order', async () => {
    const { client } = clientFor([entry('old', 'new'), entry('new'), entry('other')], [entry('new'), entry('other')]);
    const result = await queryKnowledge(client, 'p', { search: 'policy' });
    expect(result.map(e => e.id)).toEqual(['new', 'other']);
    expect(result[0].supersedes).toEqual(['old']);
  });
  it('keeps claims, truth state and inverse supersession together in both read paths', async () => {
    const stamp = { plugin_version: '0.16.12', web_sha: 'abc1234', at: '2026-10-22T12:00:00Z' };
    const row = { ...entry('new'), content: encodeClaim('A saved policy body.', 'Teams preserve this policy.'), verified_against: stamp, rollout_state: 'partly-live', open_steps: ['Promote remaining surface'] };
    for (const args of [{}, { search: 'policy' }]) {
      const { client } = clientFor([entry('old', 'new'), row], [row]);
      const result = await queryKnowledge(client, 'p', args);
      expect(result.find(e => e.id === 'new')).toMatchObject({ claim: 'Teams preserve this policy.', claim_source: 'authored', verified_against: stamp, rollout_state: 'partly-live', open_steps: ['Promote remaining surface'], supersedes: ['old'] });
    }
  });
  it('batches large returned pages without reading unrelated rows', async () => {
    const rows = [entry('old', 'new'), ...Array.from({ length: 500 }, (_, i) => entry(`i${i}`)), entry('new')];
    const { client, calls } = clientFor(rows);
    const result = await queryKnowledge(client, 'p', { limit: 503 });
    expect(result).toHaveLength(502);
    expect(calls.filter(c => c.inFilters.length).every(c => c.inFilters[0][1].length <= 500)).toBe(true);
    expect(result.findIndex(e => e.id === 'new')).toBeLessThan(result.findIndex(e => e.id === 'old'));
  });
  it('preserves bookkeeping filtering and uses its ranking as the baseline before precedence', async () => {
    const old = entry('old', 'new');
    const procedural = { ...entry('bookkeeping'), tags: ['harmony:bookkeeping'] };
    const { client } = clientFor([procedural, old, entry('other'), entry('new')]);
    const included = await queryKnowledge(client, 'p', { limit: 4 });
    expect(included.map(e => e.id)).toEqual(['other', 'new', 'old', 'bookkeeping']);
    const excluded = await queryKnowledge(client, 'p', { include_bookkeeping: false, offset: 2, limit: 1 });
    expect(excluded.map(e => e.id)).toEqual(['new']);
  });

  it('keeps a successor outside the requested page as a link without pulling it in', async () => {
    const { client, calls } = clientFor([entry('old', 'new'), entry('other'), entry('new')]);
    expect(await queryKnowledge(client, 'p', { limit: 1 })).toMatchObject([
      { id: 'old', superseded_by: 'new', supersedes: [] },
    ]);
    expect(calls[0].ranges).toEqual([[0, 0]]);
    expect(calls).toHaveLength(3);
  });
});

// Isolate the pre-existing contract; claim-context.integration.test.ts exercises composition.
vi.mock('./claim-context.js', async original => ({
 ...await original<typeof import('./claim-context.js')>(),
 withClaimContexts: async (_client: unknown, rows: unknown[]) => rows,
}));
