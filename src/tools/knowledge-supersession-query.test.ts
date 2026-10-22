import { describe, it, expect, vi } from 'vitest';
import { queryKnowledge } from './knowledge.js';

function clientFor(rows: Array<Record<string, unknown>>, matches: Array<Record<string, unknown>> = []) {
  const calls: Array<{ cols: string; filters: Array<[string, unknown]> }> = [];
  function queryFor(dataset: Array<Record<string, unknown>>, track = true) {
    const call = { cols: '', filters: [] as Array<[string, unknown]> };
    if (track) calls.push(call);
    let bookkeeping: boolean | null = null;
    const q: any = {
      select: (cols: string) => { call.cols = cols; return q; },
      eq: (key: string, value: unknown) => { call.filters.push([key, value]); return q; },
      neq: () => q, order: () => q,
      or: () => { bookkeeping = false; return q; },
      contains: () => { bookkeeping = true; return q; },
      range: async (a: number, b: number) => {
        const filtered = dataset.filter(row => call.filters.every(([key, value]) => row[key] === value))
          .filter(row => bookkeeping === null || ((row.tags as string[] | null)?.includes('harmony:bookkeeping') ?? false) === bookkeeping);
        return { data: filtered.slice(a, b + 1), error: null, count: filtered.length };
      },
    }; return q;
  }
  const client: any = { functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
    rpc: vi.fn(() => queryFor(matches, false)),
    from: (table: string) => {
      if (table === 'projects') return { select: () => ({ eq: () => ({ single: async () => ({ data: { workspace_id: 'ws' }, error: null }) }) }) };
      return queryFor(rows);
    } };
  return { client, calls };
}

const entry = (id: string, superseded_by: string | null = null, project_id = 'p') => ({ id, superseded_by, project_id, workspace_id: 'ws', status: 'Accepted', title: id, type: 'architecture', domain: [], tags: [], updated_at: '2026-10-01T00:00:00Z' });

describe('queryKnowledge supersession contract', () => {
  it('orders before pagination and derives inverse links outside the requested page', async () => {
    const { client, calls } = clientFor([entry('old', 'new'), entry('other'), entry('new'), entry('foreign', 'new', 'other-project')]);
    const result = await queryKnowledge(client, 'p', { limit: 1, offset: 1 });
    expect(result).toMatchObject([{ id: 'new', superseded_by: null, supersedes: ['old'] }]);
    expect(calls.every(c => c.filters.some(([k,v]) => k === 'project_id' && v === 'p'))).toBe(true);
    expect(calls.every(c => c.filters.some(([k,v]) => k === 'workspace_id' && v === 'ws'))).toBe(true);
  });
  it('hydrates semantic results without adding filtered-out entries or losing relevance order', async () => {
    const { client } = clientFor([entry('old', 'new'), entry('new'), entry('other')], [entry('new'), entry('other')]);
    const result = await queryKnowledge(client, 'p', { search: 'policy' });
    expect(result.map(e => e.id)).toEqual(['new', 'other']);
    expect(result[0].supersedes).toEqual(['old']);
  });
  it('continues across database pages before applying successor precedence', async () => {
    const rows = [entry('old', 'new'), ...Array.from({ length: 500 }, (_, i) => entry(`i${i}`)), entry('new')];
    const { client } = clientFor(rows);
    const result = await queryKnowledge(client, 'p', { limit: 503 });
    expect(result).toHaveLength(502);
    expect(result.findIndex(e => e.id === 'new')).toBeLessThan(result.findIndex(e => e.id === 'old'));
  });
  it('preserves bookkeeping filtering and uses its ranking as the baseline before precedence', async () => {
    const old = entry('old', 'new');
    const procedural = { ...entry('bookkeeping'), tags: ['harmony:bookkeeping'] };
    const { client } = clientFor([procedural, old, entry('other'), entry('new')]);
    const included = await queryKnowledge(client, 'p', { limit: 4 });
    expect(included.map(e => e.id)).toEqual(['other', 'new', 'old', 'bookkeeping']);
    const excluded = await queryKnowledge(client, 'p', { include_bookkeeping: false, offset: 2, limit: 1 });
    expect(excluded.map(e => e.id)).toEqual(['old']);
  });

});
