import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createKnowledgeEntry } from './knowledge.js';

// B-1262: `knowledge create` inserts into the base table, so the vocabulary trigger's refusal never
// passed through metadataRpc and carried no suggestions. This pins the direct-insert path.
describe('createKnowledgeEntry unknown tag refusal', () => {
  it('appends registered near-matches to the real refusal and writes nothing', async () => {
    const refusal = { code: 'P0001', details: '', hint: '',
      message: 'Unknown knowledge tags: surfce:plugin/src/tools. Register a project tag explicitly or choose a known tag.' };
    const insert = vi.fn();
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq']) chain[method] = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn()
      .mockResolvedValueOnce({ data: { workspace_id: 'ws' }, error: null })
      .mockResolvedValueOnce({ data: null, error: refusal });
    chain.insert = insert.mockReturnValue(chain);
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: true })
      .mockReturnValueOnce(Object.assign(Promise.resolve({ data: [{ name: 'surface:plugin/src/tools' }, { name: 'queue' }] }), {
        range: () => Promise.resolve({ data: [{ name: 'surface:plugin/src/tools' }, { name: 'queue' }] }) }));
    const client = { from: vi.fn().mockReturnValue(chain), rpc } as unknown as SupabaseClient;

    await expect(createKnowledgeEntry(client, 'project', 'user', {
      title: 'Typo tag', claim: 'A refused tag is corrected.', content: 'Body', type: 'convention',
      scope: 'product', tags: ['surfce:plugin/src/tools'],
    })).rejects.toMatchObject({
      message: expect.stringMatching(/\nKnown tags for "surfce:plugin\/src\/tools": surface:plugin\/src\/tools, queue$/),
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['knowledge_metadata_capable', 'knowledge_list_tags']);
  });
});
