import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { updateKnowledgeEntryTool } from './knowledge.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  metadataCapable,
  metadataRpc,
  surfaceTags,
} from './knowledge-metadata.js';
const db = (rpc: unknown) => ({ rpc }) as SupabaseClient;
describe('metadata rollout contract', () => {
  it('refuses malformed capability responses rather than silently using legacy writes', async () => {
    await expect(
      metadataCapable(db(vi.fn().mockResolvedValue({ data: null }))),
    ).rejects.toThrow('legacy fallback refused');
  });
  it.each(['PGRST202', '42883'])(
    'recognizes missing capability %s without swallowing other errors',
    async (code) => {
      expect(
        await metadataCapable(
          db(vi.fn().mockResolvedValue({ error: { code } })),
        ),
      ).toBe(false);
    },
  );
  it.each(['42501', '57014', 'PGRST301'])('propagates %s', async (code) => {
    await expect(
      metadataCapable(
        db(vi.fn().mockResolvedValue({ error: { code, message: 'failure' } })),
      ),
    ).rejects.toThrow('failure');
  });
  it('requires scope for new contracts and never writes after refusal', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true });
    await expect(
      metadataRpc(db(rpc), 'knowledge_record_decision', undefined, {}),
    ).rejects.toThrow('requires');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('keeps legacy operations usable but refuses explicit metadata on the old schema', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: 'PGRST202' } })
      .mockResolvedValueOnce({ data: { id: 'entry' } });
    expect(
      await metadataRpc(db(rpc), 'knowledge_record_decision', undefined, {
        p_title: 'Legacy',
      }),
    ).toEqual({ data: { id: 'entry' } });
    expect(rpc).toHaveBeenLastCalledWith('knowledge_record_decision', {
      p_title: 'Legacy',
    });
    rpc.mockResolvedValue({ error: { code: 'PGRST202' } });
    await expect(
      metadataRpc(db(rpc), 'knowledge_record_decision', 'product', {}),
    ).rejects.toThrow('nothing was saved');
  });
  it('uses the additive transaction and carries structured tag suggestions', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({
        error: { message: 'Unknown knowledge tags', details: 'queue' },
      });
    expect(
      await metadataRpc(
        db(rpc),
        'knowledge_amend_knowledge_entry',
        'deployment',
        { p_content_mode: 'append_section' },
      ),
    ).toMatchObject({ error: { message: 'Unknown knowledge tags\nqueue' } });
    expect(rpc).toHaveBeenLastCalledWith(
      'knowledge_amend_knowledge_entry_metadata',
      { p_content_mode: 'append_section', p_scope: 'deployment' },
    );
  });
});
describe('one surface mapping for release, repair and settlement', () => {
  it('uses repository and immediate directory, deduplicates and retains removed paths supplied by PR evidence', () => {
    expect(
      surfaceTags([
        'web/src/features/queue/a.ts',
        './web/src/features/queue/deleted.ts',
        'plugin/src/tools/knowledge.ts',
        'web/src/a.ts',
        'web/../secrets',
        'customer-app/src/queue.ts',
      ]),
    ).toEqual([
      'surface:customer-app/src',
      'surface:plugin/src/tools',
      'surface:web/src',
      'surface:web/src/features/queue',
    ]);
  });
});


const paged = (result: unknown) => Object.assign(Promise.resolve(result), { range: () => Promise.resolve(result) });
describe('unknown authored tag recovery', () => {
  const refused = () => ({ code: '22023', message: 'Unknown knowledge tags: surfce:plugin/src/tools. Register explicitly.',
    details: JSON.stringify({ unknown: ['surfce:plugin/src/tools'], suggestions: { 'surfce:plugin/src/tools': ['unrelated'] } }) });
  it('ranks registered generated spellings first, caps five, and never retries the failed write', async () => {
    const error = refused();
    const names = ['queue', 'surface:web/src/tools', 'surface:plugin/src/tool', 'unrelated',
      'surface:plugin/src/tools', 'surface:plugin/src/hooks', 'surface:plugin/src/cli', 'surface:plugin/src/tools'];
    const rpc = vi.fn().mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: null, error })
      .mockReturnValueOnce(paged({ data: names.map(name => ({ name })) }));
    const result = await metadataRpc(db(rpc), 'knowledge_record_decision', 'product', {
      p_project_id: 'project-a', p_tags: ['surfce:plugin/src/tools'],
    });
    expect(result.data).toBeNull();
    expect(result.error).toBe(error);
    const line = result.error!.message.split('\n')[1];
    expect(line).toMatch(/^Known tags for "surfce:plugin\/src\/tools": surface:plugin\/src\/tools, /);
    expect(line.split(': ').at(-1)!.split(', ')).toHaveLength(5);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'knowledge_metadata_capable', 'knowledge_record_decision_metadata', 'knowledge_list_tags',
    ]);
    expect(rpc).toHaveBeenLastCalledWith('knowledge_list_tags', { p_project_id: 'project-a' });
    expect(result.error!.message).toContain(error.details);
  });
  it.each(['error', 'throw', 'malformed'])('preserves the refusal when vocabulary lookup is %s', async mode => {
    const error = refused();
    const rpc = vi.fn().mockResolvedValueOnce({ data: true }).mockResolvedValueOnce({ error });
    if (mode === 'throw') rpc.mockRejectedValueOnce(new Error('offline'));
    else rpc.mockReturnValueOnce(paged(mode === 'error' ? { error: { message: 'permission denied' } } : { data: {} }));
    const result = await metadataRpc(db(rpc), 'knowledge_record_decision', 'product', { p_project_id: 'p' });
    expect(result.error).toBe(error);
    expect(result.error!.message).toBe(`Unknown knowledge tags: surfce:plugin/src/tools. Register explicitly.\n${error.details}`);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('reports an empty vocabulary without inventing suggestions', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: true }).mockResolvedValueOnce({ error: refused() })
      .mockReturnValueOnce(paged({ data: [] }));
    const result = await metadataRpc(db(rpc), 'knowledge_record_decision', 'product', { p_project_id: 'p' });
    expect(result.error!.message).toContain('(none registered)');
  });
  it.each([undefined, null, ''])('derives hints from the deployed message alone when details is %j', async details => {
    // Verbatim shape of the production refusal (b1141/b1223 RAISE EXCEPTION): no structured details.
    const error = { code: 'P0001', details,
      message: 'Unknown knowledge tags: surfce:plugin/src/tools, queue-typo. Register a project tag explicitly or choose a known tag.' };
    const rpc = vi.fn().mockResolvedValueOnce({ data: true }).mockResolvedValueOnce({ error })
      .mockReturnValueOnce(paged({ data: [{ name: 'surface:plugin/src/tools' }, { name: 'queue' }] }));
    const result = await metadataRpc(db(rpc), 'knowledge_record_decision', 'product', { p_project_id: 'p' });
    const lines = result.error!.message.split('\n');
    expect(lines[1]).toMatch(/^Known tags for "surfce:plugin\/src\/tools": surface:plugin\/src\/tools, queue$/);
    expect(lines[2]).toMatch(/^Known tags for "queue-typo": queue, /);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'knowledge_metadata_capable', 'knowledge_record_decision_metadata', 'knowledge_list_tags',
    ]);
  });
  it('reads the whole vocabulary past the 1000-row API cap so later-sorting tags can be suggested', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({ name: `a-tag-${i}` }));
    const ranges: Array<[number, number]> = [];
    const list = (_n: string, _a: unknown) => ({ range: (from: number, to: number) => {
      ranges.push([from, to]);
      return Promise.resolve({ data: from === 0 ? first : [{ name: 'surface:plugin/src/tools' }] });
    } });
    const rpc = vi.fn().mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ error: { message: 'Unknown knowledge tags: surfce:plugin/src/tools. Register.', details: '' } })
      .mockImplementation(list);
    const result = await metadataRpc(db(rpc), 'knowledge_record_decision', 'product', { p_project_id: 'p' });
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(result.error!.message).toMatch(/Known tags for "surfce:plugin\/src\/tools": surface:plugin\/src\/tools, /);
  });
  it('does not look up hints for successful writes, unrelated failures or malformed refusal details', async () => {
    for (const response of [{ data: { id: 'saved' } }, { error: { message: 'permission denied' } },
      { error: { message: 'Unknown knowledge tags', details: '{bad json' } }]) {
      const rpc = vi.fn().mockResolvedValueOnce({ data: true }).mockResolvedValueOnce(response);
      await metadataRpc(db(rpc), 'knowledge_record_decision', 'product', { p_project_id: 'p' });
      expect(rpc).toHaveBeenCalledTimes(2);
    }
  });
});

describe('protected amendment guidance', () => {
  it('names exact dated marker words on both authoring surfaces', () => {
    const discipline = readFileSync(new URL('../../skills/harmony-shared/knowledge-discipline.md', import.meta.url), 'utf8');
    for (const guidance of [updateKnowledgeEntryTool.description, discipline]) {
      expect(guidance).toMatch(/amended/i);
      expect(guidance).toMatch(/revised/i);
      expect(guidance).toContain('YYYY-MM-DD');
      expect(guidance).toMatch(/amendment.*alone is not protected/i);
      expect(guidance).toContain('allow_shrink');
    }
  });
});
