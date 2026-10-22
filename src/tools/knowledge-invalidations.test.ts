import { describe, it, expect, vi } from 'vitest';
import { validateRemovals, requireRemovalCapability, readInvalidations, withInvalidations } from './knowledge-invalidations.js';
import { renderBrief, renderEntry, resolveBrief } from './briefs.js';
const id = '12310000-0000-0000-0000-000000000040';
const declaration = { removes: [{ claim: 'Remove old check', invalidates: [id] }] };
const client = (data: unknown, error: unknown = null) => ({ rpc: vi.fn().mockResolvedValue({ data, error }) }) as any;
describe('removal declarations', () => {
  it.each([undefined, []])('keeps legacy declarations valid (%s)', removes => expect(() => validateRemovals({ removes })).not.toThrow());
  it.each([null, {}, [{ claim: '', invalidates: [id] }], [{ claim: 'x', invalidates: [] }], [{ claim: 'x', invalidates: ['bad'] }]])('refuses malformed declarations %j', removes => expect(() => validateRemovals({ removes })).toThrow());
  it('rejects malformed policy flags and empty effectivity promises', () => {
    expect(() => validateRemovals({ ...declaration, removal_effective_on_accept: 'true' })).toThrow('boolean');
    expect(() => validateRemovals({ removes: [], removal_policy_only: true, removal_effective_on_accept: true })).toThrow('requires');
  });
  it('restricts nonempty declarations to design', () => expect(() => validateRemovals(declaration, 'plan-draft')).toThrow('design'));
  it('renders the same affected ids and timing in brief and derived entry', () => {
    const doc = { decide: 'Remove?', items: [], ...declaration };
    for (const content of [renderBrief(doc), renderEntry(doc)]) {
      expect(content).toContain(id); expect(content).toContain('not yet effective');
    }
  });
  it('makes old-schema reads explicit and refuses promised removal writes', async () => {
    const c = client(null, { code: 'PGRST202', message: 'function absent' });
    expect(await readInvalidations(c, [id])).toMatchObject({ available: false });
    await expect(requireRemovalCapability(c, declaration)).rejects.toThrow('enforcement capability unavailable');
    c.rpc.mockClear(); await requireRemovalCapability(c, {}); expect(c.rpc).not.toHaveBeenCalled();
  });
  it('never masks permission or network failures as missing schema', async () => {
    await expect(readInvalidations(client(null, { code: '42501', message: 'denied' }), [id])).rejects.toThrow('denied');
    await expect(readInvalidations(client(null), [id])).rejects.toThrow('Invalid removal');
  });
  it('attaches invalidator identity and capability state in batched reads', async () => {
    const link = { affected_id: id, invalidator_id: 'successor', invalidator_title: 'New rule', claim: 'Remove check', effective_at: null, rollout_state: null };
    const c = client({ available: true, rollout_available: false, links: [link] });
    const rows = await withInvalidations(c, [{ id }, { id: 'other' }]);
    expect(rows[0]).toMatchObject({ invalidations: [link], invalidation_rollout_available: false });
    expect(rows[1].invalidations).toEqual([]);
    expect(c.rpc).toHaveBeenCalledWith('read_knowledge_invalidations', { p_entry_ids: [id, 'other'] });
  });
  it('refuses an agent policy cutover before calling the acceptance RPC', async () => {
    const c = client({ available: true, rollout_available: true, links: [] });
    const chain: any = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'brief', doc: { ...declaration, removal_policy_only: true, removal_effective_on_accept: true } }, error: null }) };
    c.from = vi.fn().mockReturnValue(chain);
    await expect(resolveBrief(c, 'project', { task_id: id, command: 'accept', provenance: 'agent-synthesized:override' })).rejects.toThrow('explicit human');
    expect(c.rpc).not.toHaveBeenCalledWith('resolve_brief', expect.anything());
  });
});
