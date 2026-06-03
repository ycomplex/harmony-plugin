import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveToState, advanceWorkflow, referenceKnowledge } from './workflow.js';

// P1 seed subset (web/supabase/migrations/20260602170200_workflow_transitions.sql)
const TRANSITIONS = [
  { from_state: null,         activity: 'capturing',          to_state: 'Captured' },
  { from_state: 'Captured',   activity: 'promoting',          to_state: 'Idea' },
  { from_state: 'Idea',       activity: 'clarifying',         to_state: 'Clarified' },
  { from_state: 'Clarified',  activity: 'decomposing',        to_state: 'Decomposed' },
  { from_state: 'Decomposed', activity: 'designing',          to_state: 'Designed' },
  { from_state: 'Designed',   activity: 'planning',           to_state: 'Planned' },
  { from_state: 'Planned',    activity: 'building',           to_state: 'Built' },
  { from_state: 'Built',      activity: 'releasing',          to_state: 'Released' },
  { from_state: 'Released',   activity: 'verifying',          to_state: 'Verified' },
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
    expect(deriveToState('Idea', 'cancelling', TRANSITIONS)).toBe('Cancelled');
  });
  it('keeps researching at the same state (no advance); null stays null (F8)', () => {
    expect(deriveToState('Designed', 'researching', TRANSITIONS)).toBe('Designed');
    expect(deriveToState(null, 'researching', TRANSITIONS)).toBeNull();
  });
  it('resolves the initial capture from a null state', () => {
    expect(deriveToState(null, 'capturing', TRANSITIONS)).toBe('Captured');
  });
  it('throws on an illegal (from, activity) pair', () => {
    expect(() => deriveToState('Idea', 'building', TRANSITIONS)).toThrow(/No workflow transition/);
  });
});

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_c: unknown, _p: string, id: string) => `uuid-${id}`),
}));

function mockClientFor(currentState: string | null) {
  // Minimal chainable mock: dispatches by table name.
  return {
    from(table: string) {
      if (table === 'workflow_transitions') {
        return { select: () => Promise.resolve({ data: TRANSITIONS, error: null }) };
      }
      if (table === 'tasks') {
        return {
          select: (cols: string) => {
            if (cols.includes('workflow_state') && !cols.includes('workflow_activity')) {
              // the read
              return {
                eq: () => ({
                  eq: () => ({ single: () => Promise.resolve({ data: { workflow_state: currentState }, error: null }) }),
                }),
              };
            }
            // the update().select() tail
            return { single: () => Promise.resolve({ data: { id: 'uuid-B-1', workflow_state: 'Built', workflow_activity: 'building' }, error: null }) };
          },
          update: (payload: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => ({
                select: () => ({ single: () => Promise.resolve({ data: { id: 'uuid-B-1', ...payload }, error: null }) }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('advanceWorkflow', () => {
  beforeEach(() => vi.clearAllMocks());
  it('writes the derived target state + activity', async () => {
    const res = await advanceWorkflow(mockClientFor('Planned'), 'proj', { task_id: 'B-1', activity: 'building' });
    expect(res.from_state).toBe('Planned');
    expect(res.to_state).toBe('Built');
    expect(res.activity).toBe('building');
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
