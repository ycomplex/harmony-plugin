import { describe, it, expect, vi } from 'vitest';
import { getKnowledgeEntry, createKnowledgeEntry, recordDecision, updateKnowledgeEntry, queryKnowledge, proposeLegacyClaims } from './knowledge.js';
import { renderBrief, renderEntry, withDerivedEntryContent, type BriefDoc } from './briefs.js';
import { encodeClaim } from './knowledge-claim.js';
function mock(row: any) {
 const chain: any = {};
 for (const name of ['select','eq','neq','order','range','single','update']) chain[name] = vi.fn().mockReturnValue(chain);
 chain.then = (resolve: any) => Promise.resolve({ data: row, error: null }).then(resolve);
 chain.single.mockResolvedValue({ data: row, error: null });
 const ws: any = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { workspace_id: 'ws' }, error: null }) };
 const client: any = { from: vi.fn((table: string) => table === 'projects' ? ws : chain), rpc: vi.fn().mockResolvedValue({ data: row, error: null }) };
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
 it('refuses missing/invalid claims before creating entries or resolving affected entities', async () => {
  const { client } = mock(null);
  await expect(createKnowledgeEntry(client, 'proj', 'user', { title: 'Teams save views.', content: 'Body', type: 'specification' })).rejects.toThrow(/claim/);
  await expect(recordDecision(client, 'proj', 'user', { title: 'Teams save views.', claim: 'One. Two.', type: 'specification', affected_entity_names: ['Entity'] })).rejects.toThrow(/claim/);
  expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled();
 });
 it('refuses a legacy edit without an explicit claim, with no mutation', async () => {
  const { client } = mock({ id: 'entry', title: 'Teams save views.', content: 'Historical body.' });
  await expect(updateKnowledgeEntry(client, 'proj', { entry_id: 'entry', content: 'New body.' })).rejects.toThrow(/claim/);
  expect(client.rpc).not.toHaveBeenCalled();
 });
 it('returns slim structured rows with claims on the old schema and retains project scoping', async () => {
  const { client, chain } = mock([{ id: 'entry', title: 'Teams save views.', content: encodeClaim('Body', 'Teams retain their filters.'), project_id: 'proj' }]);
  const rows = await queryKnowledge(client, 'proj', {});
  expect(rows[0]).toMatchObject({ claim: 'Teams retain their filters.', claim_source: 'authored' });
  expect(rows[0]).not.toHaveProperty('content');
  expect(chain.eq).toHaveBeenCalledWith('workspace_id', 'ws'); expect(chain.eq).toHaveBeenCalledWith('project_id', 'proj');
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
  await proposeLegacyClaims(first.client, 'proj', true);
  expect(first.chain.update).toHaveBeenCalledTimes(1);
  const second = mock([{ ...legacy, content: encodeClaim(legacy.content, legacy.content, 'derived') }]);
  expect((await proposeLegacyClaims(second.client, 'proj', true))[0].status).toBe('skipped-existing');
  expect(second.client.rpc).not.toHaveBeenCalled();
 });
});
