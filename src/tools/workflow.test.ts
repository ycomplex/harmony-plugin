import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveToState, advanceWorkflow, referenceKnowledge, listTicketKnowledge, listTicketKnowledgeTool, linkTicketEntities } from './workflow.js';

// P1 seed subset (web/supabase/migrations/20260602170200_workflow_transitions.sql)
const TRANSITIONS = [
  { from_state: null,         activity: 'capturing',          to_state: 'Captured' },
  { from_state: 'Captured',   activity: 'proposing',          to_state: 'Proposed' },
  { from_state: 'Proposed',   activity: 'clarifying',         to_state: 'Clarified' },
  { from_state: 'Clarified',  activity: 'decomposing',        to_state: 'Decomposed' },
  { from_state: 'Decomposed', activity: 'designing',          to_state: 'Designed' },
  { from_state: 'Designed',   activity: 'planning',           to_state: 'Planned' },
  { from_state: 'Planned',    activity: 'building',           to_state: 'Built' },
  { from_state: 'Built',      activity: 'deploying',          to_state: 'Deployed' },
  { from_state: 'Deployed',   activity: 'verifying',          to_state: 'Verified' },
  { from_state: 'Planned',    activity: 'revising-designing', to_state: 'Designed' },
  { from_state: 'Built',      activity: 'revising-building',  to_state: 'Planned' },
];

describe('deriveToState', () => {
  it('resolves a seeded forward transition', () => {
    expect(deriveToState('Planned', 'building', TRANSITIONS)).toBe('Built');
  });
  it('resolves a seeded backflow transition', () => {
    expect(deriveToState('Built', 'revising-building', TRANSITIONS)).toBe('Planned');
  });
  it('special-cases parking and cancelling to terminal/park states', () => {
    expect(deriveToState('Built', 'parking', TRANSITIONS)).toBe('Parked');
    expect(deriveToState('Proposed', 'cancelling', TRANSITIONS)).toBe('Cancelled');
  });
  it('keeps researching at the same state (no advance); null stays null (F8)', () => {
    expect(deriveToState('Designed', 'researching', TRANSITIONS)).toBe('Designed');
    expect(deriveToState(null, 'researching', TRANSITIONS)).toBeNull();
  });
  it('resolves the initial capture from a null state', () => {
    expect(deriveToState(null, 'capturing', TRANSITIONS)).toBe('Captured');
  });
  it('throws on an illegal (from, activity) pair', () => {
    expect(() => deriveToState('Proposed', 'building', TRANSITIONS)).toThrow(/No workflow transition/);
  });
});

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_c: unknown, _p: string, id: string) => `uuid-${id}`),
  resolveTaskIds: vi.fn(async (_c: unknown, _p: string, ids: string[]) => ids.map(id => `uuid-${id}`)),
}));

// B-977: linkTicketEntities calls into knowledge.js for workspace resolution + entity
// resolve-or-create — mocked here so its tests control exactly which entity ids come back,
// independent of knowledge.ts's own (separately-tested) implementation.
vi.mock('./knowledge.js', () => ({
  getWorkspaceId: vi.fn(async () => 'ws-1'),
  resolveOrCreateEntity: vi.fn(async (_c: unknown, _ws: string, _p: string, name: string) => `ent-${name}`),
}));

// Returns the client AND the update spy, so tests can assert the PERSISTED patch
// (not just the derived return value) — the read goes through tasks.select(); the
// write goes through tasks.update(), whose payload we capture.
//
// B-964: a 4th optional arg carries `parked_from` — the advanceWorkflow read now also selects it
// (needed for the 'unparking' activity's dynamic target fallback); every pre-B-964 test omits it
// and gets `null`, matching a task that has never been Parked.
function mockClientFor(currentState: string | null, stale = false, parkedFrom: string | null = null) {
  const updateSpy = vi.fn((payload: Record<string, unknown>) => ({
    eq: () => ({
      eq: () => ({
        select: () => ({ single: () => Promise.resolve({ data: { id: 'uuid-B-1', ...payload }, error: null }) }),
      }),
    }),
  }));
  const client = {
    from(table: string) {
      if (table === 'workflow_transitions') {
        return { select: () => Promise.resolve({ data: TRANSITIONS, error: null }) };
      }
      if (table === 'tasks') {
        return {
          // advanceWorkflow's read: select('workflow_state, stale, parked_from').eq().eq().single()
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: { workflow_state: currentState, stale, parked_from: parkedFrom },
                    error: null,
                  }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
  return { client, updateSpy };
}

describe('advanceWorkflow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the derived target state + activity for a forward transition', async () => {
    const { client, updateSpy } = mockClientFor('Planned');
    const res = await advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'building' });
    expect(res.from_state).toBe('Planned');
    expect(res.to_state).toBe('Built');
    expect(res.activity).toBe('building');
    // Assert the PERSISTED payload, not just the returned value: a regression that wrote
    // the wrong column (or nothing) would slip past a return-value-only assertion.
    expect(updateSpy).toHaveBeenCalledWith({ workflow_state: 'Built', workflow_activity: 'building' });
  });

  it('records researching as activity-only — never writes workflow_state (F8)', async () => {
    const { client, updateSpy } = mockClientFor('Designed');
    const res = await advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'researching' });
    expect(res.to_state).toBe('Designed'); // researching never advances state
    expect(updateSpy).toHaveBeenCalledWith({ workflow_activity: 'researching' });
    // The whole point of F8: the patch must omit workflow_state (else a no-op edge for a
    // stated task, or a NULL→FK violation for an un-stated one). Drop the special-case in
    // workflow.ts and this goes red.
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('workflow_state');
  });

  it('refuses a forward activity when the task is stale', async () => {
    const { client } = mockClientFor('Planned', true);
    await expect(
      advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'building' }),
    ).rejects.toThrow(/stale/i);
  });

  it('allows a revising-* backflow on a stale task', async () => {
    const { client } = mockClientFor('Built', true);
    const res = await advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'revising-building' });
    expect(res.to_state).toBe('Planned');
  });

  it('allows parking/cancelling a stale task', async () => {
    const { client } = mockClientFor('Planned', true);
    const res = await advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'parking' });
    expect(res.to_state).toBe('Parked');
  });

  it('allows researching on a stale task (no state change)', async () => {
    const { client } = mockClientFor('Designed', true);
    await expect(
      advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'researching' }),
    ).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // B-964 — 'unparking': the dynamic target resolution (3 cases) + stale non-exemption
  // ---------------------------------------------------------------------------

  it('B-964: unparking resolves to an explicit resume_to override when given', async () => {
    const { client, updateSpy } = mockClientFor('Parked', false, 'Designed');
    const res = await advanceWorkflow(client, 'proj', {
      task_id: 'B-1',
      activity: 'unparking',
      resume_to: 'Built',
    });
    expect(res.to_state).toBe('Built'); // override wins even though parked_from is 'Designed'
    expect(res.from_state).toBe('Parked');
    // Writes workflow_activity: NULL — mirrors the web's own live "Resume" action exactly.
    expect(updateSpy).toHaveBeenCalledWith({ workflow_state: 'Built', workflow_activity: null });
  });

  it("B-964: unparking falls back to the task's own parked_from when no override is given", async () => {
    const { client, updateSpy } = mockClientFor('Parked', false, 'Designed');
    const res = await advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'unparking' });
    expect(res.to_state).toBe('Designed');
    expect(updateSpy).toHaveBeenCalledWith({ workflow_state: 'Designed', workflow_activity: null });
  });

  it("B-964: unparking falls back to 'Proposed' when parked_from is itself null and no override is given", async () => {
    const { client, updateSpy } = mockClientFor('Parked', false, null);
    const res = await advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'unparking' });
    expect(res.to_state).toBe('Proposed');
    expect(updateSpy).toHaveBeenCalledWith({ workflow_state: 'Proposed', workflow_activity: null });
  });

  it('B-964: unparking is NOT stale-exempt — a stale Parked ticket refuses exactly like any other forward activity', async () => {
    const { client } = mockClientFor('Parked', true, 'Designed');
    await expect(
      advanceWorkflow(client, 'proj', { task_id: 'B-1', activity: 'unparking' }),
    ).rejects.toThrow(/stale/i);
  });
});

describe('referenceKnowledge', () => {
  it('upserts the link idempotently', async () => {
    const upsert = vi.fn(() => Promise.resolve({ error: null }));
    const client = { from: () => ({ upsert }) } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const res = await referenceKnowledge(client, 'proj', { task_id: 'B-1', decision_id: 'dec-1' });
    expect(res.linked).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      { task_id: 'uuid-B-1', decision_id: 'dec-1' },
      { onConflict: 'task_id,decision_id', ignoreDuplicates: true },
    );
  });
});

// B-977: listTicketKnowledge now ALSO reads decision_affects_entity per decision (the
// "affecting decision" half of the entity-edges read surface) — a second, table-routed
// query. This helper builds a client whose `ticket_references_knowledge` branch returns the
// caller-supplied rows and whose `decision_affects_entity` branch returns `affectedRows`
// (default: none — most listTicketKnowledge tests don't care about entity edges).
function mockTicketKnowledgeClient(
  rows: unknown[],
  affectedRows: unknown[] = [],
): { client: import('@supabase/supabase-js').SupabaseClient; selectSpy: ReturnType<typeof vi.fn> } {
  const eq = vi.fn(() => Promise.resolve({ data: rows, error: null }));
  const selectSpy = vi.fn(() => ({ eq }));
  const inSpy = vi.fn(() => Promise.resolve({ data: affectedRows, error: null }));
  const client = {
    from: vi.fn((table: string) => {
      if (table === 'tasks') return { select: () => ({ eq: () => ({ in: (_key: string, ids: string[]) => Promise.resolve({ data: ids.map(id => ({ id })), error: null }) }) }) };
      if (table === 'decision_affects_entity') return { select: () => ({ in: inSpy }) };
      return { select: selectSpy };
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
  return { client, selectSpy };
}

describe('listTicketKnowledge', () => {
  it('returns this ticket\'s referenced decisions flattened with type + status + affected_entities', async () => {
    const rows = [
      { decision_id: 'd1', knowledge_decisions: { id: 'd1', type: 'product-design', status: 'Accepted', title: 'PD' } },
      { decision_id: 'd2', knowledge_decisions: { id: 'd2', type: 'technical-design', status: 'Asserted', title: 'TD' } },
    ];
    const { client } = mockTicketKnowledgeClient(rows);
    const res = await listTicketKnowledge(client, 'proj', { task_id: 'B-1' });
    expect(res).toEqual([
      { decision_id: 'd1', id: 'd1', type: 'product-design', status: 'Accepted', title: 'PD', claim: null, claim_source: null, affected_entities: [] },
      { decision_id: 'd2', id: 'd2', type: 'technical-design', status: 'Asserted', title: 'TD', claim: null, claim_source: null, affected_entities: [] },
    ]);
  });

  // B-744 (reopened round 2): a ticket can carry more than one Accepted `specification` decision
  // (clarify's clarified-intent record AND decompose's no-split record). Callers need
  // `source_activity` projected so they can discriminate which gate authored the decision, rather
  // than falling back to an ordering-dependent `.find()` on type + status alone.
  it('projects source_activity in the select so callers can discriminate same-type decisions', async () => {
    const rows = [
      {
        decision_id: 'd1',
        knowledge_decisions: {
          id: 'd1',
          type: 'specification',
          status: 'Accepted',
          title: 'clarified intent',
          source_activity: 'clarify',
        },
      },
    ];
    const { client, selectSpy } = mockTicketKnowledgeClient(rows);
    const res = await listTicketKnowledge(client, 'proj', { task_id: 'B-1' });
    // The projection string itself must ask for source_activity — this is what makes the column
    // available to downstream `.find()` predicates at all.
    expect(selectSpy).toHaveBeenCalledWith(expect.stringContaining('source_activity'));
    // And it must flow through into the flattened row, not get dropped on the way out.
    expect(res).toEqual([
      { decision_id: 'd1', id: 'd1', type: 'specification', status: 'Accepted', title: 'clarified intent', source_activity: 'clarify', claim: null, claim_source: null, affected_entities: [] },
    ]);
  });

  // B-977 (AC1): the "affecting decision" half of the entity-edges read surface —
  // decision_affects_entity rows are joined in and grouped by decision_id.
  it('B-977: surfaces affected_entities per decision from decision_affects_entity', async () => {
    const rows = [
      { decision_id: 'd1', knowledge_decisions: { id: 'd1', type: 'technical-design', status: 'Accepted', title: 'TD' } },
    ];
    const affected = [
      { decision_id: 'd1', entity_id: 'ent-1', knowledge_entities: { name: 'Cloud library management', kind: 'feature' } },
    ];
    const { client } = mockTicketKnowledgeClient(rows, affected);
    const res = await listTicketKnowledge(client, 'proj', { task_id: 'B-1' });
    expect(res[0].affected_entities).toEqual([{ entity_id: 'ent-1', name: 'Cloud library management', kind: 'feature' }]);
  });

  it('B-977: no decisions -> no decision_affects_entity query at all', async () => {
    const { client } = mockTicketKnowledgeClient([]);
    const res = await listTicketKnowledge(client, 'proj', { task_id: 'B-1' });
    expect(res).toEqual([]);
    expect((client.from as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('decision_affects_entity');
  });
});


describe('listTicketKnowledge batch contract', () => {
  type Ref = { task_id: string; decision_id: string; knowledge_decisions: Record<string, unknown> | null };
  type Edge = { decision_id: string; entity_id: string; knowledge_entities: { name: string; kind: string } | null };
  function fixture(options: { refs?: Ref[]; edges?: Edge[]; missing?: string; pageCap?: number; fail?: string; failOffset?: number } = {}) {
    const queries: { table: string; filters: Record<string, unknown>; offset: number; order: string[] }[] = [];
    const client = {
      from: vi.fn((table: string) => {
        const query = { table, filters: {} as Record<string, unknown>, offset: 0, order: [] as string[] };
        queries.push(query);
        let end = Infinity;
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn((key: string, value: unknown) => { query.filters[key] = value; return builder; }),
          in: vi.fn((key: string, value: unknown) => { query.filters[key] = value; return builder; }),
          order: vi.fn((key: string) => { query.order.push(key); return builder; }),
          range: vi.fn((start: number, last: number) => { query.offset = start; end = last + 1; return builder; }),
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
            if (options.fail === table && query.offset >= (options.failOffset ?? 0)) {
              return Promise.resolve({ data: null, error: new Error(`${table} unavailable`) }).then(resolve, reject);
            }
            let data: unknown[];
            if (table === 'tasks') {
              data = (query.filters.id as string[]).filter(id => id !== options.missing).map(id => ({ id }));
            } else if (table === 'ticket_references_knowledge') {
              data = (options.refs ?? []).filter(row => (query.filters.task_id as string[]).includes(row.task_id));
            } else {
              data = (options.edges ?? []).filter(row => (query.filters.decision_id as string[]).includes(row.decision_id));
            }
            const last = Math.min(end, query.offset + (options.pageCap ?? Infinity));
            return Promise.resolve({ data: table === 'tasks' ? data : data.slice(query.offset, last), error: null }).then(resolve, reject);
          },
        };
        return builder;
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    return { client, queries };
  }

  it('advertises mutually exclusive single and bounded batch inputs to MCP clients', () => {
    expect(listTicketKnowledgeTool.inputSchema.oneOf).toEqual([
      { required: ['task_id'], not: { required: ['task_ids'] } },
      { required: ['task_ids'], not: { required: ['task_id'] } },
    ]);
    expect(listTicketKnowledgeTool.inputSchema.properties.task_ids).toMatchObject({ minItems: 1, maxItems: 20 });
    const nonBlank = new RegExp(listTicketKnowledgeTool.inputSchema.properties.task_ids.items.pattern);
    expect(nonBlank.test('B-1')).toBe(true);
    expect(nonBlank.test('  ')).toBe(false);
  });

  it('keeps ticket order, metadata, shared entries and empty groups without adding ownership fields to entries', async () => {
    const decision = { id: 'shared', type: 'specification', status: 'Accepted', title: 'Shared', domain: ['engineering'], source_activity: 'clarify', content: 'Full body' };
    const { client, queries } = fixture({ refs: [
      { task_id: 'uuid-b-1', decision_id: 'shared', knowledge_decisions: decision },
      { task_id: 'uuid-b-2', decision_id: 'shared', knowledge_decisions: decision },
      { task_id: 'uuid-b-2', decision_id: 'hidden', knowledge_decisions: null },
    ], edges: [{ decision_id: 'shared', entity_id: 'e', knowledge_entities: { name: 'Feature', kind: 'feature' } }] });
    const result = await listTicketKnowledge(client, 'proj', { task_ids: ['B-2', 'B-1', 'B-3', 'B-2'] });
    const entry = { decision_id: 'shared', ...decision, claim: null, claim_source: null, affected_entities: [{ entity_id: 'e', name: 'Feature', kind: 'feature' }] };
    expect(result).toEqual({ tickets: [
      { task_id: 'uuid-b-2', entries: [entry, { decision_id: 'hidden', affected_entities: [], claim: null, claim_source: null }] },
      { task_id: 'uuid-b-1', entries: [entry] },
      { task_id: 'uuid-b-3', entries: [] },
    ] });
    expect(queries[0]).toMatchObject({ table: 'tasks', filters: { project_id: 'proj', id: ['uuid-b-2', 'uuid-b-1', 'uuid-b-3'] } });
    expect(queries.find(query => query.table === 'decision_affects_entity')?.filters.decision_id).toEqual(['shared', 'hidden']);
  });

  it('collapses aliases and UUID case after resolution', async () => {
    const { resolveTaskIds } = await import('./resolve-task-id.js');
    const id = 'a1b2c3d4-0000-4000-8000-000000000001';
    vi.mocked(resolveTaskIds).mockResolvedValueOnce([id, id.toUpperCase(), id]);
    const { client } = fixture();
    expect(await listTicketKnowledge(client, 'proj', { task_ids: ['1', 'B-1', id.toUpperCase()] })).toEqual({ tickets: [{ task_id: id, entries: [] }] });
  });

  it.each([
    {}, { task_id: 'B-1', task_ids: ['B-2'] }, { task_id: null }, { task_id: '' },
    { task_id: '  ' }, { task_ids: [] }, { task_ids: null }, { task_ids: 'B-1' },
    { task_ids: ['B-1', ' '] }, { task_ids: [2] }, { task_ids: Array(21).fill('B-1') },
  ])('rejects malformed or mixed input before querying: %j', async args => {
    const { client, queries } = fixture();
    await expect(listTicketKnowledge(client, 'proj', args as never)).rejects.toThrow(/exactly one|non-blank/);
    expect(queries).toEqual([]);
  });

  it('accepts the 20-identifier boundary', async () => {
    const { client } = fixture();
    expect((await listTicketKnowledge(client, 'proj', { task_ids: Array.from({ length: 20 }, (_, i) => String(i + 1)) })).tickets).toHaveLength(20);
  });

  it.each([false, true])('rejects a missing or foreign UUID before knowledge reads (single=%s)', async single => {
    const { client, queries } = fixture({ missing: 'uuid-00000000-0000-4000-8000-000000000000' });
    const id = '00000000-0000-4000-8000-000000000000';
    await expect(listTicketKnowledge(client, 'proj', single ? { task_id: id } : { task_ids: ['B-1', id] })).rejects.toThrow('not found in this project');
    expect(queries.map(query => query.table)).toEqual(['tasks']);
  });

  it.each(['tasks', 'ticket_references_knowledge', 'decision_affects_entity'])('propagates %s errors without returning partial data', async fail => {
    const { client } = fixture({ fail, refs: [{ task_id: 'uuid-b-1', decision_id: 'd', knowledge_decisions: {} }] });
    await expect(listTicketKnowledge(client, 'proj', { task_ids: ['B-1'] })).rejects.toThrow(`${fail} unavailable`);
  });

  it('reads every reference and entity page even when the server caps pages below the requested size', async () => {
    const refs = Array.from({ length: 102 }, (_, i) => ({ task_id: 'uuid-b-1', decision_id: `d${i}`, knowledge_decisions: { status: 'Accepted' } }));
    const edges = refs.flatMap(row => Array.from({ length: 3 }, (_, i) => ({ decision_id: row.decision_id, entity_id: `e${i}`, knowledge_entities: { name: `Entity ${i}`, kind: 'feature' } })));
    const { client, queries } = fixture({ refs, edges, pageCap: 2 });
    const result = await listTicketKnowledge(client, 'proj', { task_ids: ['B-1'] });
    expect(result.tickets[0].entries).toHaveLength(102);
    expect(result.tickets[0].entries.every(entry => entry.affected_entities.length === 3)).toBe(true);
    const entityQueries = queries.filter(query => query.table === 'decision_affects_entity');
    expect(entityQueries.every(query => (query.filters.decision_id as string[]).length <= 100)).toBe(true);
    expect(entityQueries.some(query => (query.filters.decision_id as string[]).length === 2)).toBe(true);
    expect(queries.filter(query => query.table === 'ticket_references_knowledge').every(query => query.order.join(',') === 'task_id,decision_id')).toBe(true);
  });

  it.each(['ticket_references_knowledge', 'decision_affects_entity'])('fails the whole request when a later %s page fails', async fail => {
    const { client } = fixture({ pageCap: 1, fail, failOffset: 1,
      refs: [{ task_id: 'uuid-b-1', decision_id: 'd', knowledge_decisions: {} }, { task_id: 'uuid-b-1', decision_id: 'd2', knowledge_decisions: {} }],
      edges: [{ decision_id: 'd', entity_id: 'e', knowledge_entities: { name: 'E', kind: 'feature' } }, { decision_id: 'd', entity_id: 'e2', knowledge_entities: { name: 'E2', kind: 'feature' } }],
    });
    await expect(listTicketKnowledge(client, 'proj', { task_ids: ['B-1'] })).rejects.toThrow(`${fail} unavailable`);
  });
});


// ---------------------------------------------------------------------------
// linkTicketEntities (B-977)
// ---------------------------------------------------------------------------

describe('linkTicketEntities', () => {
  beforeEach(async () => {
    const { resolveOrCreateEntity } = (await import('./knowledge.js')) as any;
    (resolveOrCreateEntity as ReturnType<typeof vi.fn>).mockClear();
    (resolveOrCreateEntity as ReturnType<typeof vi.fn>).mockImplementation(
      async (_c: unknown, _ws: string, _p: string, name: string) => `ent-${name}`,
    );
  });

  function mockLinkClient() {
    const implementsUpsert = vi.fn(() => Promise.resolve({ error: null }));
    const affectsUpsert = vi.fn(() => Promise.resolve({ error: null }));
    const client = {
      from: vi.fn((table: string) => {
        if (table === 'ticket_implements_entity') return { upsert: implementsUpsert };
        if (table === 'decision_affects_entity') return { upsert: affectsUpsert };
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    return { client, implementsUpsert, affectsUpsert };
  }

  it('resolves each entity name and writes BOTH edge tables for each one', async () => {
    const { client, implementsUpsert, affectsUpsert } = mockLinkClient();
    const res = await linkTicketEntities(client, 'proj', {
      task_id: 'B-1', decision_id: 'dec-1', entity_names: ['Cloud library management', 'Book metadata'],
    });
    expect(res).toEqual({
      task_id: 'uuid-B-1', decision_id: 'dec-1',
      entity_ids: ['ent-Cloud library management', 'ent-Book metadata'],
      linked: true,
    });
    expect(implementsUpsert).toHaveBeenCalledWith(
      { task_id: 'uuid-B-1', entity_id: 'ent-Cloud library management' },
      { onConflict: 'task_id,entity_id', ignoreDuplicates: true },
    );
    expect(implementsUpsert).toHaveBeenCalledWith(
      { task_id: 'uuid-B-1', entity_id: 'ent-Book metadata' },
      { onConflict: 'task_id,entity_id', ignoreDuplicates: true },
    );
    expect(affectsUpsert).toHaveBeenCalledWith(
      { decision_id: 'dec-1', entity_id: 'ent-Cloud library management' },
      { onConflict: 'decision_id,entity_id', ignoreDuplicates: true },
    );
    expect(affectsUpsert).toHaveBeenCalledWith(
      { decision_id: 'dec-1', entity_id: 'ent-Book metadata' },
      { onConflict: 'decision_id,entity_id', ignoreDuplicates: true },
    );
  });

  it('defaults the resolve-or-create kind to "feature"', async () => {
    const { resolveOrCreateEntity } = (await import('./knowledge.js')) as any;
    const { client } = mockLinkClient();
    await linkTicketEntities(client, 'proj', { task_id: 'B-1', decision_id: 'dec-1', entity_names: ['Native mobile client'] });
    expect(resolveOrCreateEntity).toHaveBeenCalledWith(client, 'ws-1', 'proj', 'Native mobile client', 'feature');
  });

  it('honors an explicit entity_kind override', async () => {
    const { resolveOrCreateEntity } = (await import('./knowledge.js')) as any;
    const { client } = mockLinkClient();
    await linkTicketEntities(client, 'proj', {
      task_id: 'B-1', decision_id: 'dec-1', entity_names: ['OIDC'], entity_kind: 'integration',
    });
    expect(resolveOrCreateEntity).toHaveBeenCalledWith(client, 'ws-1', 'proj', 'OIDC', 'integration');
  });

  it('throws when decision_id is missing', async () => {
    const { client } = mockLinkClient();
    await expect(
      linkTicketEntities(client, 'proj', { task_id: 'B-1', decision_id: '', entity_names: ['x'] }),
    ).rejects.toThrow(/decision_id is required/);
  });

  it('throws when entity_names is empty (or all-blank)', async () => {
    const { client } = mockLinkClient();
    await expect(
      linkTicketEntities(client, 'proj', { task_id: 'B-1', decision_id: 'dec-1', entity_names: [] }),
    ).rejects.toThrow(/entity_names must contain at least one/);
    await expect(
      linkTicketEntities(client, 'proj', { task_id: 'B-1', decision_id: 'dec-1', entity_names: ['   '] }),
    ).rejects.toThrow(/entity_names must contain at least one/);
  });

  // A genuine RLS/permission denial is a real defect — let it throw, never degrade
  // (both tables' policies are confirmed live; see B-977 plan notes).
  it('propagates a genuine permission/RLS denial from either edge table rather than swallowing it', async () => {
    const implementsUpsert = vi.fn(() => Promise.resolve({ error: { message: 'permission denied for table ticket_implements_entity' } }));
    const client = {
      from: vi.fn((table: string) => {
        if (table === 'ticket_implements_entity') return { upsert: implementsUpsert };
        return { upsert: vi.fn(() => Promise.resolve({ error: null })) };
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    await expect(
      linkTicketEntities(client, 'proj', { task_id: 'B-1', decision_id: 'dec-1', entity_names: ['x'] }),
    ).rejects.toMatchObject({ message: expect.stringContaining('permission denied') });
  });
});
