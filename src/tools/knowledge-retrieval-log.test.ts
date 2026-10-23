import { describe, it, expect, vi, afterEach } from 'vitest';
import { logKnowledgeRetrieval, RETRIEVAL_LOG_CAP, RETRIEVAL_EVENT_TYPE } from './knowledge-retrieval-log.js';

const TASK = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakeClient(opts: { insertError?: boolean; insertThrows?: boolean; conductionTask?: string | null } = {}) {
  const inserted: any[][] = [];
  const client: any = {
    from(table: string) {
      if (table === 'projects') return { select: () => ({ eq: () => ({ single: async () => ({ data: { workspace_id: WS } }) }) }) };
      if (table === 'conductions') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.conductionTask ? { task_id: opts.conductionTask } : null }) }) }) };
      if (table === 'knowledge_events') {
        return { insert: async (rows: any[]) => {
          if (opts.insertThrows) throw new Error('boom');
          inserted.push(rows);
          return { error: opts.insertError ? { message: 'denied' } : null };
        } };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, inserted };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('logKnowledgeRetrieval (B-678)', () => {
  it('writes one knowledge-retrieved row per returned decision with ticket, gate, rank and score', async () => {
    const { client, inserted } = fakeClient();
    const result = { matches: [{ id: id(1), score: 0.03, source_kind: 'knowledge' }, { id: id(2), score: 0.02, source_kind: 'knowledge' }] };
    await logKnowledgeRetrieval(client, 'p1', { task_id: TASK, gate: 'design', search: ' reuse telemetry ' }, result);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(2);
    expect(inserted[0][0]).toMatchObject({
      workspace_id: WS, event_type: RETRIEVAL_EVENT_TYPE, decision_id: id(1),
      metadata: { task_id: TASK, gate: 'design', query: 'reuse telemetry', rank: 1, score: 0.03 },
      source: 'rpc-typed', aggregate_type: 'knowledge_decision', aggregate_id: id(1), contract_version: 1,
    });
    expect(inserted[0][1].metadata.rank).toBe(2);
  });

  it('caps the rows logged per query', async () => {
    const { client, inserted } = fakeClient();
    const list = Array.from({ length: 25 }, (_, i) => ({ id: id(i + 1) }));
    await logKnowledgeRetrieval(client, 'p1', { task_id: TASK }, list);
    expect(inserted[0]).toHaveLength(RETRIEVAL_LOG_CAP);
  });

  it('skips definitions, concepts and generated values; writes nothing when no decision remains', async () => {
    const { client, inserted } = fakeClient();
    const result = [
      { id: id(1), type: 'definition' }, { id: id(2), kind: 'concept' }, { id: id(3), source_type: 'generated' },
      { id: id(4), source_kind: 'prose' }, { id: 'not-a-uuid' },
    ];
    await logKnowledgeRetrieval(client, 'p1', { task_id: TASK }, result);
    expect(inserted).toHaveLength(0);
  });

  it('writes nothing when no ticket can be resolved', async () => {
    const { client, inserted } = fakeClient();
    await logKnowledgeRetrieval(client, 'p1', {}, [{ id: id(1) }]);
    expect(inserted).toHaveLength(0);
  });

  it('falls back to the current conduction\'s ticket and records the conduction id', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', '33333333-3333-4333-8333-333333333333');
    const { client, inserted } = fakeClient({ conductionTask: TASK });
    await logKnowledgeRetrieval(client, 'p1', {}, [{ id: id(1) }]);
    expect(inserted[0][0].metadata.task_id).toBe(TASK);
    expect(inserted[0][0].causation_conduction_id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('never throws when the insert errors or throws', async () => {
    for (const opts of [{ insertError: true }, { insertThrows: true }]) {
      const { client } = fakeClient(opts);
      await expect(logKnowledgeRetrieval(client, 'p1', { task_id: TASK }, [{ id: id(1) }])).resolves.toBeUndefined();
    }
  });
});
