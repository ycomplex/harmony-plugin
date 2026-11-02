import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveBrief, reshapeBrief } from './briefs.js';
import { handleToolCall } from './index.js';

vi.mock('./resolve-task-id.js', () => ({ resolveTaskId: vi.fn(async () => 'task-uuid') }));

// Stateful decision substrate: any mutation RPC changes this sentinel. Refusals may only insert
// a comment, so this also detects an accidental resolution, reshape audit, or umbrella fallback.
function board(auditFailure?: string, umbrella = false) {
  const state = { brief: 'active', gate: 'Designed', payload: { steps: ['approved scope'] }, marker: null };
  const original = structuredClone(state);
  const comments: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (_name: string, _args: unknown) => {
    state.brief = 'mutated';
    return { data: { ok: true }, error: null };
  });
  const from = vi.fn((table: string) => {
    const q = {
      select: vi.fn(() => q), eq: vi.fn(() => q),
      insert: vi.fn((row: Record<string, unknown>) => { if (!auditFailure) comments.push(row); return q; }),
      single: vi.fn(async () => ({ data: { id: 'comment' }, error: auditFailure ? { message: auditFailure } : null })),
      maybeSingle: vi.fn(async () => ({ data: table === 'briefs'
        ? umbrella ? null : { id: 'brief', doc: {}, reason: 'plan-draft' }
        : { workflow_state: 'Deployed', awaiting_human_reason: 'verification-ack-pending', awaiting_human_ref: { kind: 'umbrella-auto-verify' } }, error: null })),
    };
    return q;
  });
  return { client: { from, rpc } as unknown as SupabaseClient, state, original, comments, from, rpc };
}
const operations = ['accept', 'defer', 'iterate', 'edited-in-tool'] as const;
function call(b: ReturnType<typeof board>, op: typeof operations[number], provenance: string, userId: string | undefined = 'caller') {
  return op === 'accept' || op === 'defer'
    ? resolveBrief(b.client, 'project', { task_id: 'B-1364', command: op, provenance }, userId)
    : reshapeBrief(b.client, 'project', { task_id: 'B-1364', kind: op, feedback: 'Change this', provenance }, userId);
}
afterEach(() => vi.unstubAllEnvs());

describe('B-1364 worker brief authority', () => {
  for (const op of operations) {
    it.each(['agent-synthesized:orchestrator', 'human-in-session', 'human-in-browser', '  human-in-session  ', ' agent-synthesized: orchestrator  '])(`${op} refuses %s before any decision write and comments once`, async (provenance) => {
      vi.stubEnv('HARMONY_CONDUCTION_ID', 'conduction');
      const b = board();
      await expect(call(b, op, provenance)).rejects.toThrow(/file a brief, iterate on feedback, or elicit/);
      expect(b.state).toEqual(b.original);
      expect(b.rpc).not.toHaveBeenCalled();
      expect(b.from.mock.calls.map(([table]) => table)).toEqual(['task_comments']);
      expect(b.comments).toHaveLength(1);
      expect(b.comments[0]).toMatchObject({ task_id: 'task-uuid', user_id: 'caller' });
      expect(b.comments[0].content).toContain(`operation=${op === 'accept' || op === 'defer' ? 'resolve_brief' : 'reshape_brief'}`);
      expect(b.comments[0].content).toContain('conduction_id=conduction');
      expect(b.comments[0].content).toContain(provenance.trim().replace(': ', ':'));
    });
    it.each(['permission denied (RLS)', 'network unavailable'])(`${op} still refuses if the audit fails: %s`, async (failure) => {
      vi.stubEnv('HARMONY_CONDUCTION_ID', 'conduction');
      const b = board(failure);
      await expect(call(b, op, 'human-in-session')).rejects.toThrow(`Refusal audit comment failed: ${failure}`);
      expect(b.state).toEqual(b.original);
      expect(b.rpc).not.toHaveBeenCalled();
      expect(b.comments).toHaveLength(0);
    });
    it.each(['agent-synthesized:unattended', 'agent-synthesized:pause-at', 'agent-synthesized:escalate', 'agent-synthesized:override'])(`${op} preserves delegated worker %s`, async (provenance) => {
      vi.stubEnv('HARMONY_CONDUCTION_ID', 'conduction');
      const b = board();
      await call(b, op, provenance);
      expect(b.rpc).toHaveBeenCalled();
      expect(b.rpc.mock.calls[0]).toEqual(expect.arrayContaining([expect.any(String), expect.objectContaining({ p_provenance: provenance })]));
      expect(b.comments).toHaveLength(0);
    });
    it.each(['human-in-session', 'agent-synthesized:orchestrator'])(`${op} preserves interactive %s with no worker context`, async (provenance) => {
      vi.stubEnv('HARMONY_CONDUCTION_ID', '');
      const b = board();
      await call(b, op, provenance);
      expect(b.rpc).toHaveBeenCalled();
      expect(b.comments).toHaveLength(0);
    });
  }
  it('checks context on each call and never reaches the brief-less umbrella fallback on refusal', async () => {
    const b = board(undefined, true);
    vi.stubEnv('HARMONY_CONDUCTION_ID', '');
    await call(b, 'accept', 'human-in-session');
    expect(b.rpc).toHaveBeenCalledWith('ack_umbrella_verify', { _task_id: 'task-uuid' });
    b.rpc.mockClear(); b.from.mockClear();
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'new-conduction');
    await expect(call(b, 'accept', 'human-in-session')).rejects.toThrow('new-conduction');
    expect(b.rpc).not.toHaveBeenCalled();
    expect(b.from.mock.calls.map(([table]) => table)).toEqual(['task_comments']);
  });
  it('preserves plugin-wide browser provenance rejection outside a worker', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', '');
    const b = board();
    await expect(call(b, 'accept', 'human-in-browser')).rejects.toThrow("web client's alone");
    expect(b.from).not.toHaveBeenCalled();
  });
  it('refuses even when a direct caller supplies no audit identity', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'conduction');
    const b = board();
    await expect(resolveBrief(b.client, 'project', { task_id: 'B-1364', command: 'accept', provenance: 'human-in-session' })).rejects.toThrow('authenticated caller user id unavailable');
    expect(b.rpc).not.toHaveBeenCalled();
  });
  it.each(['resolve_brief', 'reshape_brief'])('MCP %s dispatch retains actionable refusal and audit failure', async (name) => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'conduction');
    for (const failure of [undefined, 'permission denied (RLS)', 'task not found']) {
      const b = board(failure);
      const result = await handleToolCall(name, { task_id: 'B-1364', command: 'accept', feedback: 'Revise', provenance: 'human-in-session' }, b.client, 'project', 'caller');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('file a brief, iterate on feedback, or elicit');
      if (failure) expect(result.content[0].text).toContain(failure);
      else expect(b.comments[0].user_id).toBe('caller');
      expect(b.rpc).not.toHaveBeenCalled();
      expect(b.state).toEqual(b.original);
    }
  });
});
