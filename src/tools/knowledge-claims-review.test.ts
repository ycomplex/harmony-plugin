import { describe, it, expect, vi } from 'vitest';
import { proposeLegacyClaims } from './knowledge.js';
import { encodeClaim } from './knowledge-claim.js';

function database(rows: Array<{ id: string; content: string }>, changed = false) {
  const filters: Record<string, unknown> = {};
  let ids: string[] | undefined;
  let bound = Infinity;
  const writes: Array<{ id: unknown; content: string }> = [];
  const query: any = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn((key: string, value: unknown) => { filters[key] = value; return query; });
  query.neq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.in = vi.fn((_key: string, value: string[]) => { ids = value; return query; });
  query.limit = vi.fn((value: number) => { bound = value; return query; });
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows.filter(row => !ids || ids.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, bound), error: null }).then(resolve);
  query.update = vi.fn((patch: { content: string }) => {
    const guard: Record<string, unknown> = {};
    const update: any = {};
    update.eq = vi.fn((key: string, value: unknown) => { guard[key] = value; return update; });
    update.select = vi.fn(async () => {
      expect(guard.workspace_id).toBe('workspace'); expect(guard.project_id).toBe('project');
      expect(guard.content).toBe(rows.find(row => row.id === guard.id)?.content);
      if (changed) return { data: [], error: null };
      writes.push({ id: guard.id, ...patch }); return { data: [{ id: guard.id }], error: null };
    });
    return update;
  });
  const workspace = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { workspace_id: 'workspace' } }) };
  const client: any = { from: vi.fn((table: string) => table === 'projects' ? workspace : query) };
  return { client, query, writes, filters };
}
const review = (id: string, claim: string, reviewed = true) => ({ id, claim, reviewed, status: 'proposed' });

describe('reviewed legacy claim proposals', () => {
  it('bounds a deterministic, project-scoped selection before proposal generation', async () => {
    const db = database([{ id: 'c', content: 'Third sentence.' }, { id: 'a', content: 'First sentence.' }, { id: 'b', content: 'Second sentence.' }]);
    const result = await proposeLegacyClaims(db.client, 'project', { entries: ['b', 'c'], limit: 1 });
    expect(result).toEqual([expect.objectContaining({ id: 'b', claim: 'Second sentence.', reviewed: false, claim_source: 'derived' })]);
    expect(db.query.in).toHaveBeenCalledWith('id', ['b', 'c']); expect(db.query.order).toHaveBeenCalledWith('id');
    expect(db.query.limit).toHaveBeenCalledWith(1); expect(db.filters).toEqual({ workspace_id: 'workspace', project_id: 'project' });
    expect(db.writes).toEqual([]);
  });
  it('writes only reviewed current proposals and preserves the body and derived label', async () => {
    const db = database([{ id: 'a', content: 'First sentence.\n\n## History\nKeep it.' }, { id: 'b', content: 'Second sentence.' }, { id: 'c', content: 'Third sentence.' }]);
    await proposeLegacyClaims(db.client, 'project', { apply: true, entries: [review('a', 'First sentence.'), review('b', 'Second sentence.', false)] });
    expect(db.writes).toEqual([{ id: 'a', content: encodeClaim('First sentence.\n\n## History\nKeep it.', 'First sentence.', 'derived') }]);
  });
  it('never writes unusable, existing, stale or falsely reviewed unusable-status rows', async () => {
    const db = database([{ id: 'a', content: 'Unterminated fragment' }, { id: 'b', content: encodeClaim('Body.', 'Existing claim.') }, { id: 'c', content: 'Changed sentence.' }, { id: 'd', content: 'Valid sentence.' }]);
    const result = await proposeLegacyClaims(db.client, 'project', { apply: true, entries: [review('a', 'Unterminated fragment'), review('b', 'Existing claim.'), review('c', 'Old sentence.'), { ...review('d', 'Valid sentence.'), status: 'no-usable-sentence' }] });
    expect(result.map(row => row.status)).toEqual(['no-usable-sentence', 'skipped-existing', 'skipped-changed', 'skipped-unreviewed']);
    expect(db.writes).toEqual([]);
  });
  it('reports a concurrent body edit instead of claiming it applied', async () => {
    const db = database([{ id: 'a', content: 'First sentence.' }], true);
    expect(await proposeLegacyClaims(db.client, 'project', { apply: true, entries: [review('a', 'First sentence.')] })).toEqual([{ id: 'a', status: 'skipped-changed' }]);
    expect(db.writes).toEqual([]);
  });
  it('refuses unbounded apply and malformed selections before any database operation', async () => {
    const db = database([]);
    for (const options of [true, { apply: true }, { apply: true, entries: ['a'] }, { limit: 0 }, { limit: 1.5 }, { entries: ['a', 'a'] }, { entries: {} }, { entries: [null] }]) {
      await expect(proposeLegacyClaims(db.client, 'project', options as any)).rejects.toThrow();
    }
    expect(db.client.from).not.toHaveBeenCalled();
    expect(await proposeLegacyClaims(db.client, 'project', { entries: [] })).toEqual([]);
  });
});
