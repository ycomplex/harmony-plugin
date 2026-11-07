import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBoardReader, parseTicketKey, ScopeError } from './board-read.js';
import { fakeSupabase, type FakeQuery } from './test-fakes.js';

const filter = (q: FakeQuery, op: string, col: string) => q.filters.find(([o, c]) => o === op && c === col)?.[2];

function board(opts: { missingLegEnd?: boolean; tasks?: Array<Record<string, unknown>>; conductions?: Array<Record<string, unknown>> } = {}) {
  const tasks = opts.tasks ?? [
    { id: 't1', task_number: 1, title: 'One', workflow_state: 'In Progress', awaiting_human_input: false, updated_at: '2026-11-07T09:00:00Z', field_values: { waiting_on: { kind: 'ci', ref: 'pr#1' } }, archived: false, milestone_id: 'm1' },
    { id: 't2', task_number: 2, title: 'Two', workflow_state: 'Planned', awaiting_human_input: true, awaiting_human_reason: 'plan-draft', awaiting_human_ref: { type: 'brief', id: 'b2' }, updated_at: '2026-11-07T09:00:00Z', field_values: null, archived: false, milestone_id: 'm1' },
  ];
  const conductions = opts.conductions ?? [
    { id: 'c1-new', task_id: 't1', status: 'active', leg_started_at: '2026-11-07T09:00:00Z', last_leg_ended_at: null, last_worker_exit_class: null, created_at: '2026-11-07T09:00:00Z' },
    { id: 'c1-old', task_id: 't1', status: 'completed', leg_started_at: null, last_leg_ended_at: null, last_worker_exit_class: 'terminal', created_at: '2026-11-01T09:00:00Z' },
  ];
  return fakeSupabase((q) => {
    if (q.table === 'projects') return { data: { key: 'B' }, error: null };
    if (q.table === 'milestones') return { data: filter(q, 'eq', 'name') === 'v1.13' ? [{ id: '00000000-0000-4000-8000-0000000000aa' }] : [], error: null };
    if (q.table === 'tasks' && q.select === 'id, task_number') {
      const nums = filter(q, 'in', 'task_number') as number[];
      return { data: tasks.filter((t) => nums.includes(t.task_number as number)), error: null };
    }
    if (q.table === 'tasks' && q.select === 'id') return { data: tasks.map((t) => ({ id: t.id })), error: null };
    if (q.table === 'tasks') return { data: tasks, error: null };
    if (q.table === 'conductions' && q.select === 'task_id') return { data: [{ task_id: 't1' }, { task_id: 't1' }], error: null };
    if (q.table === 'conductions') {
      if (opts.missingLegEnd && q.select?.includes('last_leg_ended_at')) {
        return { data: null, error: { code: '42703', message: 'column conductions.last_leg_ended_at does not exist' } };
      }
      return { data: conductions, error: null };
    }
    if (q.table === 'task_comments') return { data: [{ task_id: 't1', content: 'SEAT-START v1 seat=a milestone=m session=s', created_at: '2026-11-07T09:00:00Z' }], error: null };
    return { data: null, error: { message: `unexpected ${q.table}` } };
  });
}

describe('parseTicketKey', () => {
  it('accepts B-1422 and bare numbers, rejects others', () => {
    expect(parseTicketKey('B-1422')).toEqual({ prefix: 'B', number: 1422 });
    expect(parseTicketKey('1422')).toEqual({ prefix: null, number: 1422 });
    expect(parseTicketKey('B1422')).toBeNull();
    expect(parseTicketKey('B-x')).toBeNull();
  });
});

describe('createBoardReader', () => {
  it('resolves visual ids through task_number (the visual id is not a column)', async () => {
    const { client, calls } = board();
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1');
    expect(await r.resolveScope({ kind: 'keys', keys: ['B-1', '2'] })).toEqual(['t1', 't2']);
    const q = calls.find((c) => c.table === 'tasks')!;
    expect(filter(q, 'in', 'task_number')).toEqual([1, 2]);
    expect(filter(q, 'eq', 'project_id')).toBe('p1');
  });

  it('refuses a key from another project with a ScopeError', async () => {
    const { client } = board();
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1');
    await expect(r.resolveScope({ kind: 'keys', keys: ['X-1'] })).rejects.toBeInstanceOf(ScopeError);
  });

  it('resolves a milestone by name to its id and selects only non-archived tickets', async () => {
    const { client, calls } = board();
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1');
    await r.resolveScope({ kind: 'milestone', id: 'v1.13' });
    const q = calls.find((c) => c.table === 'tasks' && c.select === 'id')!;
    expect(filter(q, 'eq', 'milestone_id')).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(filter(q, 'eq', 'archived')).toBe(false);
    await expect(r.resolveScope({ kind: 'milestone', id: 'nope' })).rejects.toBeInstanceOf(ScopeError);
  });

  it('conductions scope is the tasks of live conductions', async () => {
    const { client, calls } = board();
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1');
    expect(await r.resolveScope({ kind: 'conductions' })).toEqual(['t1']);
    expect(filter(calls.find((c) => c.table === 'conductions')!, 'in', 'status')).toEqual(['active']);
  });

  it('reads one tasks select + one conductions select, latest conduction per task, meta only when needed', async () => {
    const { client, calls } = board();
    const getTaskMeta = vi.fn(async (id: string) => ({ active_brief_iteration: id === 't2' ? 3 : null, active_exchange: null }));
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1', { getTaskMeta });
    const snap = await r.readSnapshot(['t1', 't2']);
    expect(calls.filter((c) => c.table === 'tasks')).toHaveLength(1);
    expect(calls.filter((c) => c.table === 'conductions')).toHaveLength(1);
    expect(snap.legEndKnown).toBe(true);
    const t1 = snap.tickets.find((t) => t.id === 't1')!;
    expect(t1.key).toBe('B-1');
    expect(t1.conduction?.id).toBe('c1-new');
    expect(t1.waiting_on).toEqual({ kind: 'ci', ref: 'pr#1' });
    expect(snap.tickets.find((t) => t.id === 't2')!.meta?.active_brief_iteration).toBe(3);
    expect(getTaskMeta).toHaveBeenCalledTimes(2); // first sight: both

    getTaskMeta.mockClear();
    await r.readSnapshot(['t1', 't2']);
    // t1 unchanged and not awaiting → no meta; t2 awaiting → meta again
    expect(getTaskMeta.mock.calls.map((c) => c[0])).toEqual(['t2']);
  });

  it('retries the conductions select without last_leg_ended_at when the column is missing', async () => {
    const { client, calls } = board({ missingLegEnd: true });
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1', { getTaskMeta: async () => ({}) });
    const snap = await r.readSnapshot(['t1']);
    expect(snap.legEndKnown).toBe(false);
    expect(snap.tickets[0].conduction?.last_leg_ended_at).toBeUndefined();
    const condSelects = calls.filter((c) => c.table === 'conductions').map((c) => c.select);
    expect(condSelects).toHaveLength(2);
    expect(condSelects[1]).not.toContain('last_leg_ended_at');
    // remembered: the next read asks once, without the column
    await r.readSnapshot(['t1']);
    expect(calls.filter((c) => c.table === 'conductions')).toHaveLength(3);
  });

  it('propagates a non-column error', async () => {
    const { client } = fakeSupabase((q) =>
      q.table === 'projects' ? { data: { key: 'B' }, error: null } : { data: null, error: { code: '', message: 'TypeError: fetch failed' } },
    );
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1');
    await expect(r.readSnapshot(['t1'])).rejects.toMatchObject({ message: 'TypeError: fetch failed' });
  });

  it('looks the project key up once', async () => {
    const { client, calls } = board();
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1', { getTaskMeta: async () => ({}) });
    await r.projectKey();
    await r.readSnapshot(['t1']);
    await r.resolveScope({ kind: 'keys', keys: ['B-1'] });
    expect(calls.filter((c) => c.table === 'projects')).toHaveLength(1);
  });

  it('lists marker comments in one select', async () => {
    const { client, calls } = board();
    const r = createBoardReader(client as unknown as SupabaseClient, 'p1');
    const c = await r.listMarkerComments(['t1', 't2']);
    expect(c).toHaveLength(1);
    expect(calls.filter((q) => q.table === 'task_comments')).toHaveLength(1);
  });
});
