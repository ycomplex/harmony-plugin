import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BriefDoc } from './briefs.js';
import { settlementWarning } from './build-settlement.js';

const doc = (report: unknown = []) => ({ frame: { kind: 'release', settled_beyond_design: report } }) as BriefDoc;
function client(rows: unknown = [], error: unknown = null) {
  const query = { select: vi.fn(), eq: vi.fn(), overlaps: vi.fn(), limit: vi.fn() };
  for (const method of ['select', 'eq', 'overlaps'] as const) query[method].mockReturnValue(query);
  query.limit.mockResolvedValue({ data: rows, error });
  const project = { select: vi.fn(), eq: vi.fn(), single: vi.fn().mockResolvedValue({ data: { workspace_id: 'workspace' } }) };
  project.select.mockReturnValue(project); project.eq.mockReturnValue(project);
  const from = vi.fn((table: string) => table === 'projects' ? project : query);
  return { db: { from } as unknown as SupabaseClient, from, query };
}
describe('build settlement advisory', () => {
  it('warns for an explicit empty report touching an Accepted exact surface entry, scoped to project and workspace', async () => {
    const c = client([{ id: 'entry', title: 'Current settings' }]);
    expect(await settlementWarning(c.db, 'project', doc(), ['./src/settings.ts', 'src/settings.ts'])).toContain('Current settings (entry)');
    expect(c.query.eq.mock.calls).toEqual([['workspace_id', 'workspace'], ['project_id', 'project'], ['status', 'Accepted']]);
    expect(c.query.overlaps).toHaveBeenCalledWith('tags', ['surface:src/settings.ts']);
  });
  it('does not warn when no current-state surface matches', async () => {
    const c = client();
    expect(await settlementWarning(c.db, 'project', doc(), ['src/unknown.ts'])).toBeUndefined();
  });
  it.each([undefined, [{ behaviour: 'Keeps stale value', ac: 'AC1', knowledge_entry_id: 'entry' }]])('skips lookups for absent or populated reports', async report => {
    const c = client(); const input = report === undefined ? { frame: { kind: 'release' } } as BriefDoc : doc(report);
    expect(await settlementWarning(c.db, 'project', input, ['src/settings.ts'])).toBeUndefined();
    expect(c.from).not.toHaveBeenCalled();
  });
  it('skips other gates and unavailable diffs', async () => {
    const c = client();
    expect(await settlementWarning(c.db, 'project', { frame: { kind: 'design' } } as BriefDoc, ['x'])).toBeUndefined();
    expect(await settlementWarning(c.db, 'project', doc())).toBeUndefined();
    expect(c.from).not.toHaveBeenCalled();
  });
  it('reports query errors without throwing or pretending no match exists', async () => {
    const c = client(null, { message: 'network error' });
    expect(await settlementWarning(c.db, 'project', doc(), ['src/settings.ts'])).toContain('Could not check');
    c.from.mockImplementation(() => { throw Error('offline'); });
    expect(await settlementWarning(c.db, 'project', doc(), ['src/settings.ts'])).toContain('Advisory only');
  });
});
