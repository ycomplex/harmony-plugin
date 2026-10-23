// Original-contract fixtures keep optional name storage absent; knowledge-names tests exercise the boundary.
vi.mock('./knowledge-names.js', async importOriginal => ({ ...await importOriginal<typeof import('./knowledge-names.js')>(), readKnowledgeNames: async () => ({available:false,matches:[],entries:[],identities:[]}), withRetiredWording: async (_c:unknown,_p:unknown,entries:unknown[])=>entries }));
import { describe, it, expect, vi } from 'vitest';
import { getKnowledgeEntry, createKnowledgeEntry, recordDecision, updateKnowledgeEntry, queryKnowledge, proposeLegacyClaims } from './knowledge.js';
import { renderBrief, renderEntry, withDerivedEntryContent, type BriefDoc } from './briefs.js';
import { encodeClaim } from './knowledge-claim.js';
function mock(row: any, metadata: boolean | 'missing' = false) {
 const chain: any = {};
 for (const name of ['select','eq','neq','order','range','single','update','or','contains','in','limit']) chain[name] = vi.fn().mockReturnValue(chain);
 chain.then = (resolve: any) => Promise.resolve({ data: row, error: null }).then(resolve);
 chain.single.mockResolvedValue({ data: row, error: null });
 const ws: any = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { workspace_id: 'ws' }, error: null }) };
 const client: any = { from: vi.fn((table: string) => table === 'projects' ? ws : chain), rpc: vi.fn().mockImplementation(async (name: string) => name === 'read_knowledge_source_values' ? { data: {values: [], total_count: 0}, error: null } : name === 'knowledge_metadata_capable'
  ? { data: typeof metadata === 'boolean' ? metadata : null, error: metadata === 'missing' ? { code: 'PGRST202', message: 'older schema' } : null }
  : name === 'read_knowledge_definitions'
  ? { data: null, error: { code: 'PGRST202', message: 'Could not find function read_knowledge_definitions' } }
  : name === 'read_knowledge_invalidations'
  ? { data: null, error: { code: 'PGRST202', message: 'older schema' } } : { data: row, error: null }) };
 return { client, chain };
}
describe('claim contracts across surfaces', () => {
 it('accepts the returned id alias and rejects conflicting identifiers before any read', async () => {
  const { client, chain } = mock({ id: 'entry', content: 'Old body.' });
  expect((await getKnowledgeEntry(client, 'proj', { id: 'entry' })).claim).toBeNull();
  expect(chain.eq).toHaveBeenCalledWith('id', 'entry');
  const other = mock(null);
  await expect(getKnowledgeEntry(other.client, 'proj', { id: 'a', entry_id: 'b' })).rejects.toThrow(/same entry/);
  expect(other.client.from).not.toHaveBeenCalled();
 });
 it('refuses explicitly invalid claims before creating entries or resolving affected entities', async () => {
  const { client } = mock(null);
  await expect(createKnowledgeEntry(client, 'proj', 'user', { title: 'Teams save views.', claim: '', content: 'Body', type: 'specification' })).rejects.toThrow(/claim/);
  await expect(recordDecision(client, 'proj', 'user', { title: 'Teams save views.', claim: 'One. Two.', type: 'specification', affected_entity_names: ['Entity'] })).rejects.toThrow(/claim/);
  expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled();
 });
 it.each([false, 'missing'] as const)('keeps an old caller legacy edit compatible with metadata capability %s and marks its proposal derived', async metadata => {
  const { client } = mock({ id: 'entry', title: 'Teams save views.', content: 'Historical body.' }, metadata);
  await updateKnowledgeEntry(client, 'proj', { entry_id: 'entry', content: 'New body.' });
  expect(client.rpc).toHaveBeenCalledWith('knowledge_amend_knowledge_entry', expect.objectContaining({
    p_content: encodeClaim('New body.', 'New body.', 'derived'),
  }));
 });
 it('returns slim structured rows with claims on the old schema and retains project scoping', async () => {
  const { client, chain } = mock([{ id: 'entry', title: 'Teams save views.', content: encodeClaim('Body', 'Teams retain their filters.'), project_id: 'proj' }]);
  const rows = await queryKnowledge(client, 'proj', {});
  expect(rows[0]).toMatchObject({ claim: 'Teams retain their filters.', claim_source: 'authored' });
  expect(rows[0]).not.toHaveProperty('content');
  expect(chain.eq).toHaveBeenCalledWith('workspace_id', 'ws'); expect(chain.eq).toHaveBeenCalledWith('project_id', 'proj');
 });
 it.each([true, false, 'missing', 'denied'])('guards claimed prepends against capability %s', async capability => {
  const row = { id: 'entry', title: 'Teams save views.', content: encodeClaim('Old body.', 'Teams save views.') };
  const { client } = mock(row);
  client.rpc.mockImplementation(async (name: string) => name === 'read_knowledge_source_values' ? { data: {values: [], total_count: 0}, error: null } : name === 'knowledge_claim_amendment_capable'
    ? { data: capability === true, error: typeof capability === 'string' ? { code: capability === 'missing' ? 'PGRST202' : '42501', message: capability } : null }
    : name === 'knowledge_metadata_capable' ? { data: true, error: null } : { data: row, error: null });
  const write = updateKnowledgeEntry(client, 'proj', { entry_id: 'entry', content: 'New section.', content_mode: 'prepend_section' });
  if (capability === true) {
    await write;
    expect(client.rpc).toHaveBeenCalledWith('knowledge_amend_knowledge_entry_metadata', expect.objectContaining({ p_content: 'New section.', p_scope: null }));
  } else {
    await expect(write).rejects.toThrow(capability === 'denied' ? 'denied' : 'claim-preserving amendment migration');
    expect(client.rpc).toHaveBeenCalledTimes(1);
  }
 });
 it.each(['prepend_section','append_section'] as const)('rejects an authored claim or nested envelope in %s', async content_mode => {
  const { client } = mock({ id: 'entry', title: 'Teams save views.', content: 'Legacy.' });
  await expect(updateKnowledgeEntry(client, 'proj', { entry_id: 'entry', content_mode, content: 'New.', claim: 'Teams save views.' })).rejects.toThrow('only section text');
  await expect(updateKnowledgeEntry(client, 'proj', { entry_id: 'entry', content_mode, content: encodeClaim('New.', 'Teams save views.') })).rejects.toThrow('only section text');
  expect(client.rpc).not.toHaveBeenCalled();
 });
 it('keeps the visible brief claim identical to the derived entry and accepted payload', () => {
  const doc: BriefDoc = { decide: 'Use saved views?', claim: 'Teams retain their saved filters.', recommend: { text: 'Use saved views.' }, items: [] };
  const ctx = { reason: 'design-decision-draft', visualId: 'B-1', decisionRef: { id: 'entry', type: 'technical-design' } };
  const derived = withDerivedEntryContent(doc, ctx.reason, ctx.decisionRef, ctx);
  expect(renderBrief(derived)).toContain('**Claim:** Teams retain their saved filters.');
  expect(derived.payload?.find(p => p.write_kind === 'knowledge_entry_content')?.content).toBe(renderEntry(derived, ctx));
  expect(renderEntry(derived, ctx)).toMatch(/^\*\*Claim:\*\* Teams retain their saved filters\./);
  expect(renderEntry({ decide: 'Historical?', items: [] })).not.toContain('**Claim:**');
 });
 it('proposes without writes by default, and applying twice skips an existing claim', async () => {
  const legacy = { id: 'entry', content: 'Teams retain saved views.' };
  const first = mock([legacy]);
  expect((await proposeLegacyClaims(first.client, 'proj'))[0]).toMatchObject({ status: 'proposed', claim_source: 'derived' });
  expect(first.client.rpc).not.toHaveBeenCalled();
  const entries = [{ id: 'entry', claim: legacy.content, status: 'proposed', reviewed: true }];
  await proposeLegacyClaims(first.client, 'proj', { apply: true, entries });
  expect(first.chain.update).toHaveBeenCalledTimes(1);
  const second = mock([{ ...legacy, content: encodeClaim(legacy.content, legacy.content, 'derived') }]);
  expect((await proposeLegacyClaims(second.client, 'proj', { apply: true, entries }))[0].status).toBe('skipped-existing');
  expect(second.client.rpc).not.toHaveBeenCalled();
 });
});

// Isolate the pre-existing contract; claim-context.integration.test.ts exercises composition.
vi.mock('./claim-context.js', async original => ({
 ...await original<typeof import('./claim-context.js')>(),
 withClaimContexts: async (_client: unknown, rows: unknown[]) => rows,
}));
