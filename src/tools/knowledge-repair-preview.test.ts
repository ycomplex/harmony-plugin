import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { previewMetadataRepair, applyMetadataRepair } from './knowledge-repair.js';
import type { RepairManifest } from './knowledge-repair.js';
vi.mock('./knowledge-metadata.js', async original => ({
  ...await original<typeof import('./knowledge-metadata.js')>(),
  metadataCapable: vi.fn().mockResolvedValue(true),
}));
function entry(id: string) {
  return { id, title: 'A reader can review a claim', content: 'Body', tags: ['known'], scope: null,
    fingerprint: 'a'.repeat(32), source_task_id: null };
}
function database(pages: Array<{ data?: ReturnType<typeof entry>[]; error?: { message: string } }>) {
  const calls: Array<Array<[string, ...unknown[]]>> = [];
  let page = 0;
  const from = vi.fn((table: string) => {
    if (table === 'ticket_references_knowledge') return { select: () => ({ eq: () => Promise.resolve({ data: [] }) }) };
    const ops: Array<[string, ...unknown[]]> = [];
    calls.push(ops);
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'neq', 'order', 'limit', 'gt', 'contains', 'gte', 'lte'])
      query[method] = (...args: unknown[]) => { ops.push([method, ...args]); return query; };
    query.then = (resolve: (value: unknown) => void) => resolve(pages[page++] ?? { data: [] });
    return query;
  });
  return { client: { from } as unknown as SupabaseClient, calls, from };
}
describe('bounded metadata preview', () => {
  it('pushes AND selectors, project isolation and limit to the query before enrichment', async () => {
    const { client, calls } = database([{ data: [entry('one')] }]);
    const result = await previewMetadataRepair(client, 'project', { tag: 'known', type: 'specification',
      created_after: '2026-10-01T00:00:00Z', created_before: '2026-10-23T23:59:59Z', limit: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining([
      ['eq', 'project_id', 'project'], ['neq', 'type', 'intent'], ['limit', 1],
      ['contains', 'tags', ['known']], ['eq', 'type', 'specification'],
      ['gte', 'created_at', '2026-10-01T00:00:00Z'], ['lte', 'created_at', '2026-10-23T23:59:59Z'],
    ]));
    expect(result.entries[0]).toMatchObject({ reviewed: false, fingerprint: 'a'.repeat(32) });
    expect(result.preview).toMatchObject({ complete: true, stopped_by: 'limit', pages: 1 });
  });
  it('uses 100-row keyset pages and shrinks the final page to the remaining entry budget', async () => {
    const first = Array.from({ length: 100 }, (_, i) => entry(`id-${String(i).padStart(3, '0')}`));
    const { client, calls } = database([{ data: first }, { data: [entry('id-100')] }]);
    const snapshots: RepairManifest[] = [];
    await previewMetadataRepair(client, 'project', { limit: 101, onCheckpoint: m => { snapshots.push(structuredClone(m)); } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContainEqual(['limit', 100]);
    expect(calls[1]).toContainEqual(['limit', 1]);
    expect(calls[1]).toContainEqual(['gt', 'id', 'id-099']);
    expect(snapshots.map(m => m.entries.length)).toEqual([0, ...Array.from({ length: 101 }, (_, i) => i + 1), 101]);
    expect(snapshots[100].preview?.complete).toBe(false);
    expect(snapshots.at(-1)?.preview?.complete).toBe(true);
  });
  it('continues an unbounded selection page-by-page until exhausted, including an empty corpus', async () => {
    const { client } = database([{ data: [] }]);
    expect(await previewMetadataRepair(client, 'project')).toMatchObject({ entries: [], counts: { entries: 0 },
      preview: { complete: true, stopped_by: 'exhausted', pages: 1 } });
    const first = Array.from({ length: 100 }, (_, i) => entry(`id-${i}`));
    const next = database([{ data: first }, { data: [entry('last')] }]);
    expect((await previewMetadataRepair(next.client, 'project')).entries).toHaveLength(101);
    expect(next.calls[1]).toContainEqual(['gt', 'id', 'id-99']);
  });
  it.each([{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: NaN }, { created_after: 'yesterday' },
    { tag: ' ' }, { created_after: '2026-10-23T00:00:00Z', created_before: '2026-10-01T00:00:00Z' }])(
    'rejects invalid selectors before querying or checkpointing: %j', async options => {
      const { client, from } = database([]); const checkpoint = vi.fn();
      await expect(previewMetadataRepair(client, 'project', { ...options, onCheckpoint: checkpoint })).rejects.toThrow();
      expect(from).not.toHaveBeenCalled(); expect(checkpoint).not.toHaveBeenCalled();
    });
  it('awaits each checkpoint and propagates failures before doing more work', async () => {
    const { client, from } = database([{ data: [entry('one'), entry('two')] }]);
    const snapshots: RepairManifest[] = [];
    await expect(previewMetadataRepair(client, 'project', { onCheckpoint: async m => {
      await Promise.resolve(); snapshots.push(structuredClone(m));
      if (m.entries.length === 1) throw new Error('disk full');
    } })).rejects.toThrow('disk full');
    expect(from.mock.calls.filter(c => c[0] === 'ticket_references_knowledge')).toHaveLength(1);
    expect(snapshots.at(-1)).toMatchObject({ counts: { entries: 1 }, preview: { complete: false } });
  });
  it('fails closed on query errors and missing server fingerprints', async () => {
    await expect(previewMetadataRepair(database([{ error: { message: 'denied' } }]).client, 'p')).rejects.toThrow('denied');
    const bad = entry('bad'); bad.fingerprint = '';
    await expect(previewMetadataRepair(database([{ data: [bad] }]).client, 'p')).rejects.toThrow('database fingerprint');
  });
  it('keeps generated version-1 output compatible with reviewed apply and stale validation', async () => {
    const m = await previewMetadataRepair(database([{ data: [entry('one')] }]).client, 'project', { limit: 1 });
    const rpc = vi.fn().mockResolvedValue({ data: { applied: true, scope: 'product' } });
    const client = { rpc } as unknown as SupabaseClient;
    expect(await applyMetadataRepair(client, 'project', m)).toMatchObject({ skipped: 1, applied: 0 });
    expect(rpc).not.toHaveBeenCalled();
    m.entries[0].reviewed = true; m.entries[0].scope = 'product';
    await applyMetadataRepair(client, 'project', m);
    expect(rpc).toHaveBeenCalledWith('knowledge_apply_metadata_repair', expect.objectContaining({
      p_project_id: 'project', p_fingerprint: 'a'.repeat(32), p_manifest_id: m.manifest_id,
    }));
    rpc.mockResolvedValue({ error: { message: 'Entry changed since review' } });
    await expect(applyMetadataRepair(client, 'project', m)).rejects.toThrow('Entry changed since review');
  });
});
