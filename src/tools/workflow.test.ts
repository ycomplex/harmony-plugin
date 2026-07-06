import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveToState, advanceWorkflow, referenceKnowledge, listTicketKnowledge } from './workflow.js';

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
}));

// Returns the client AND the update spy, so tests can assert the PERSISTED patch
// (not just the derived return value) — the read goes through tasks.select(); the
// write goes through tasks.update(), whose payload we capture.
function mockClientFor(currentState: string | null) {
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
          // advanceWorkflow's read: select('workflow_state').eq().eq().single()
          select: () => ({
            eq: () => ({
              eq: () => ({ single: () => Promise.resolve({ data: { workflow_state: currentState }, error: null }) }),
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

describe('listTicketKnowledge', () => {
  it('returns this ticket\'s referenced decisions flattened with type + status', async () => {
    const rows = [
      { decision_id: 'd1', knowledge_decisions: { id: 'd1', type: 'product-design', status: 'Accepted', title: 'PD' } },
      { decision_id: 'd2', knowledge_decisions: { id: 'd2', type: 'technical-design', status: 'Asserted', title: 'TD' } },
    ];
    const eq = vi.fn(() => Promise.resolve({ data: rows, error: null }));
    const client = { from: vi.fn(() => ({ select: () => ({ eq }) })) } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const res = await listTicketKnowledge(client, 'proj', { task_id: 'B-1' });
    expect(res).toEqual([
      { decision_id: 'd1', id: 'd1', type: 'product-design', status: 'Accepted', title: 'PD' },
      { decision_id: 'd2', id: 'd2', type: 'technical-design', status: 'Asserted', title: 'TD' },
    ]);
  });
});
