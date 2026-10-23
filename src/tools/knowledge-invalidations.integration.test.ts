import { it, expect, vi } from 'vitest';
import { encodeClaim } from './knowledge-claim.js';
import { getKnowledgeEntry, queryKnowledge } from './knowledge.js';
it('shared list and by-id reads both attach pending invalidators', async () => {
  const entry = { id: 'entry', title: 'Old guarantee', status: 'Accepted', superseded_by: 'next', content: encodeClaim('Old body.', 'The old guarantee remains live.') };
  const link = { affected_id: 'entry', invalidator_id: 'new', invalidator_title: 'New rule', claim: 'Removed check', effective_at: null, rollout_state: null };
  const chain: any = {};
  for (const name of ['select','eq','contains','overlaps','lte','or','order','neq','in']) chain[name] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: entry, error: null });
  chain.limit = vi.fn().mockResolvedValue({ data: [entry], error: null });
  chain.range = vi.fn().mockResolvedValue({ data: [entry], error: null, count: 1 });
  const project = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { workspace_id: 'ws' }, error: null }) };
  const client: any = { from: vi.fn((table: string) => table === 'projects' ? project : chain), rpc: vi.fn(async (name: string) => name === 'read_knowledge_source_values' ? { data: {values: [], total_count: 0}, error: null } : name === 'read_knowledge_definitions' ? { data: { available: true, definitions: [], total_count: 0 }, error: null } : { data: { available: true, rollout_available: false, links: [link] }, error: null }) };
  expect(await getKnowledgeEntry(client, 'project', { entry_id: 'entry' })).toMatchObject({ invalidations: [link], invalidation_rollout_available: false });
  expect(await queryKnowledge(client, 'project', { limit: 1, include_bookkeeping: false })).toMatchObject([{ invalidations: [link], superseded_by: 'next', claim: 'The old guarantee remains live.' }]);
});

// Isolate the pre-existing contract; claim-context.integration.test.ts exercises composition.
vi.mock('./claim-context.js', async original => ({
 ...await original<typeof import('./claim-context.js')>(),
 withClaimContexts: async (_client: unknown, rows: unknown[]) => rows,
}));
