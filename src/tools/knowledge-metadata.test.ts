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


describe('unknown authored tag recovery', () => {
  const refused = () => ({ code: '22023', message: 'Unknown knowledge tags: surfce:plugin/src/tools. Register explicitly.',
    details: JSON.stringify({ unknown: ['surfce:plugin/src/tools'], suggestions: { 'surfce:plugin/src/tools': ['unrelated'] } }) });
  it('ranks registered generated spellings first, caps five, and never retries the failed write', async () => {
    const error = refused();
    const names = ['queue', 'surface:web/src/tools', 'surface:plugin/src/tool', 'unrelated',
      'surface:plugin/src/tools', 'surface:plugin/src/hooks', 'surface:plugin/src/cli', 'surface:plugin/src/tools'];
    const rpc = vi.fn().mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: null, error })
      .mockResolvedValueOnce({ data: names.map(name => ({ name })) });
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
    else rpc.mockResolvedValueOnce(mode === 'error' ? { error: { message: 'permission denied' } } : { data: {} });
    const result = await metadataRpc(db(rpc), 'knowledge_record_decision', 'product', { p_project_id: 'p' });
    expect(result.error).toBe(error);
    expect(result.error!.message).toBe(`Unknown knowledge tags: surfce:plugin/src/tools. Register explicitly.\n${error.details}`);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('reports an empty vocabulary without inventing suggestions', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: true }).mockResolvedValueOnce({ error: refused() })
      .mockResolvedValueOnce({ data: [] });
    const result = await metadataRpc(db(rpc), 'knowledge_record_decision', 'product', { p_project_id: 'p' });
    expect(result.error!.message).toContain('(none registered)');
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
