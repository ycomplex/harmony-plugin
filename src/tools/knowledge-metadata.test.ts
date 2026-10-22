import { describe, it, expect, vi } from 'vitest';
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
