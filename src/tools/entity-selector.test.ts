import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { selectEntity } from './entity-selector.js';
import { queryEntities } from './knowledge.js';
const feature = { concept_id: 'feature-id', kind: 'feature', current_name: 'Knowledge', matched_alias: null };
const concept = { concept_id: 'concept-id', kind: 'concept', current_name: 'Knowledge', matched_alias: null };
function fixture(matches: unknown[] = [feature, concept], absent = false) {
  const query: any = { then: (done: any) => done({ data: [], error: null }) };
  for (const method of ['select', 'eq', 'or', 'in', 'ilike', 'order']) query[method] = vi.fn(() => query);
  query.single = vi.fn(async () => ({ data: { workspace_id: 'workspace' } }));
  const rpc = vi.fn(async () => absent ? { error: { code: 'PGRST202', message: 'read_knowledge_names absent' } } : { data: { available: true, matches, entries: [], identities: [] } });
  return { client: { rpc, from: vi.fn(() => query) } as unknown as SupabaseClient, query, rpc };
}
describe('authorized entity selector', () => {
  it('lists both candidate IDs and kinds instead of choosing a homonym', async () => {
    const { client } = fixture();
    await expect(selectEntity(client, 'workspace', 'project', { name: 'Knowledge' })).rejects.toThrow(/feature-id.*feature.*concept-id.*concept/);
  });
  it('filters kind before ambiguity and selects explicit identity', async () => {
    const { client } = fixture();
    expect(await selectEntity(client, 'workspace', 'project', { name: 'Knowledge', kind: 'concept' })).toMatchObject({ id: 'concept-id' });
    expect(await selectEntity(client, 'workspace', 'project', { entity_id: 'feature-id' })).toMatchObject({ id: 'feature-id' });
  });
  it('refuses unknown/inaccessible/retired identities and conflicting kinds', async () => {
    const { client } = fixture();
    for (const selector of [{ entity_id: 'hidden' }, { entity_id: 'feature-id', kind: 'concept' }]) {
      await expect(selectEntity(client, 'workspace', 'project', selector)).rejects.toThrow('unavailable');
    }
  });
  it('checks a supplied name against the selected ID using exact aliases', async () => {
    const { client, rpc } = fixture([feature]);
    rpc.mockResolvedValueOnce({ data: { available: true, matches: [feature], entries: [], identities: [] } })
      .mockResolvedValueOnce({ data: { available: true, matches: [], entries: [], identities: [] } });
    await expect(selectEntity(client, 'workspace', 'project', { entity_id: 'feature-id', name: 'Other' })).rejects.toThrow('conflicts');
    expect(await selectEntity(client, 'workspace', 'project', { name: 'Former name' })).toMatchObject({ id: 'feature-id' });
  });
  it('keeps old-schema fallback scoped and exact, with candidate-bearing ambiguity', async () => {
    const { client, query } = fixture([], true);
    query.then = (done: any) => done({ data: [{ id: 'one', name: ' Knowledge ', kind: 'feature', project_id: 'project' }, { id: 'two', name: 'KNOWLEDGE', kind: 'concept', project_id: 'project' }], error: null });
    await expect(selectEntity(client, 'workspace', 'project', { name: 'knowledge' })).rejects.toThrow(/one.*two/);
    expect(query.or).toHaveBeenCalledWith('project_id.is.null,project_id.eq.project');
  });
  it('does not turn a permission failure into an old-schema fallback', async () => {
    const { client, rpc } = fixture();
    rpc.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } } as any);
    await expect(selectEntity(client, 'workspace', 'project', { entity_id: 'feature-id' })).rejects.toThrow('permission denied');
    expect(client.from).not.toHaveBeenCalled();
  });
  it('query_entities selects by kind/identity and retains substring/list discovery', async () => {
    const { client, query } = fixture();
    await queryEntities(client, 'project', { name: 'Knowledge', kind: 'feature' });
    expect(query.eq).toHaveBeenCalledWith('id', 'feature-id');
    const empty = fixture([]);
    await queryEntities(empty.client, 'project', { name: 'Know' });
    expect(empty.query.ilike).toHaveBeenCalledWith('name', '%Know%');
    await queryEntities(empty.client, 'project', {});
  });
});
