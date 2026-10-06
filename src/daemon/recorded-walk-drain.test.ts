import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runRecordedWalk: vi.fn(),
}));
vi.mock('../tools/record-walk.js', () => ({ runRecordedWalk: mocks.runRecordedWalk }));

import {
  runRecordedWalkDrainPass,
  isMissingRecordedWalkRequestsTable,
  RECORDED_WALK_REQUESTS_TABLE,
  buildFastTrackReleaseRemarkRecordedWalkRequest,
} from './recorded-walk-drain.js';

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

/** A minimal, chainable client mock over a `recorded_walk_requests`-shaped table — the real table
 *  does not exist until B-1063 ships its migration, so this is a FAKE table shape (mock Supabase
 *  client), per the ticket's own instruction. */
function makeClient(opts: {
  selectResult?: { data: unknown; error: unknown };
  claimResult?: { data: unknown; error: unknown };
  writeBackError?: unknown;
  /** B-1073 step 9 — the `tasks.workflow_state` the from_gate-deriving read returns. Defaults to
   *  `null` (⇒ `from_gate: 'clarify'`, today's unchanged default) so every pre-existing test keeps
   *  asserting exactly what it asserted before this ticket. */
  taskWorkflowState?: string | null;
}) {
  const updates: Array<{ payload: any; eqCalls: Array<[string, unknown]> }> = [];
  const from = vi.fn((table: string) => {
    expect([RECORDED_WALK_REQUESTS_TABLE, 'tasks']).toContain(table);
    if (table === 'tasks') {
      // B-1073 step 9: the from_gate-deriving workflow_state read — a plain SELECT, never a write.
      const taskChain: any = {};
      taskChain.select = vi.fn(() => taskChain);
      taskChain.eq = vi.fn(() => taskChain);
      taskChain.maybeSingle = vi.fn(async () => ({ data: { workflow_state: opts.taskWorkflowState ?? null }, error: null }));
      return taskChain;
    }
    const chain: any = { _eqCalls: [] as Array<[string, unknown]> };
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => { chain._eqCalls.push([col, val]); return chain; });
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(async () => opts.selectResult ?? { data: [], error: null });
    chain.update = vi.fn((payload: any) => {
      const isClaim = payload.status === 'processing';
      const record = { payload, eqCalls: chain._eqCalls };
      updates.push(record);
      const result: any = {};
      result.eq = vi.fn((col: string, val: unknown) => { record.eqCalls.push([col, val]); return result; });
      result.select = vi.fn(() => result);
      result.maybeSingle = vi.fn(async () => (isClaim ? (opts.claimResult ?? { data: { id: 'req-1' }, error: null }) : { data: null, error: null }));
      result.then = (resolve: (v: unknown) => unknown) => resolve({ error: opts.writeBackError ?? null });
      return result;
    });
    return chain;
  });
  return { from, updates } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isMissingRecordedWalkRequestsTable (B-1062)', () => {
  it('matches a Postgres/PostgREST relation-absent error', () => {
    expect(isMissingRecordedWalkRequestsTable({ code: '42P01' })).toBe(true);
    expect(isMissingRecordedWalkRequestsTable({ code: 'PGRST205' })).toBe(true);
    expect(isMissingRecordedWalkRequestsTable({ message: `Could not find the table 'public.recorded_walk_requests' in the schema cache` })).toBe(true);
  });

  it('never matches a permission error or a transient network failure', () => {
    expect(isMissingRecordedWalkRequestsTable({ code: '42501', message: 'permission denied for table recorded_walk_requests' })).toBe(false);
    expect(isMissingRecordedWalkRequestsTable({ message: 'fetch failed' })).toBe(false);
    expect(isMissingRecordedWalkRequestsTable(null)).toBe(false);
  });
});

describe('runRecordedWalkDrainPass — tolerant absence (B-846 precedent)', () => {
  it('logs ONE loud, clearly-named skip line and returns 0 when the table does not exist — never throws', async () => {
    const client = makeClient({ selectResult: { data: null, error: { code: '42P01', message: 'relation "recorded_walk_requests" does not exist' } } });
    const logs: string[] = [];
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: (l) => logs.push(l) });
    expect(processed).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[recorded-walk-drain]');
    expect(logs[0]).toContain('recorded_walk_requests table not found');
    expect(logs[0]).toContain('skipping this pass');
    expect(mocks.runRecordedWalk).not.toHaveBeenCalled();
  });

  it('does not crash the pass on a genuine read error (non-absence) — logs and returns 0', async () => {
    const client = makeClient({ selectResult: { data: null, error: { code: '500', message: 'internal error' } } });
    const logs: string[] = [];
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: (l) => logs.push(l) });
    expect(processed).toBe(0);
    expect(logs[0]).toContain('read failed');
  });

  it('returns 0 with no pending requests', async () => {
    const client = makeClient({ selectResult: { data: [], error: null } });
    const logs: string[] = [];
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: (l) => logs.push(l) });
    expect(processed).toBe(0);
    expect(mocks.runRecordedWalk).not.toHaveBeenCalled();
  });
});

describe('runRecordedWalkDrainPass — processing a fake pending row', () => {
  const pendingRow = {
    id: 'req-1',
    task_id: 'B-2000',
    summary: 'Fix the flaky retry timer.',
    evidence_links: [{ url: 'https://github.com/ycomplex/harmony-plugin/pull/1', repo: 'ycomplex/harmony-plugin' }],
    attest_walk: 'walked it for 8 minutes',
    requested_by: 'human-1',
    requested_at: '2026-09-20T00:00:00Z',
    status: 'pending',
    processed_at: null,
    error: null,
  };

  it('claims the row, runs the SAME gate-walk core, and writes back status=done on success', async () => {
    const fakeResult = {
      task_id: 'resolved-B-2000', eligibility: { items: [], eligible: true }, refused: false,
      gates: [{ gate: 'clarify', landed: true }, { gate: 'release', landed: true }], attestation_recorded: true,
    };
    mocks.runRecordedWalk.mockResolvedValue(fakeResult);
    const client = makeClient({ selectResult: { data: [pendingRow], error: null } });
    const logs: string[] = [];
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: (l) => logs.push(l) });

    expect(processed).toBe(1);
    expect(mocks.runRecordedWalk).toHaveBeenCalledWith(client, PROJECT_ID, USER_ID, {
      task_id: 'B-2000',
      summary: pendingRow.summary,
      evidence: pendingRow.evidence_links,
      attest_walk: pendingRow.attest_walk,
      from_gate: 'clarify',
    });
    const writeBack = client.updates.find((u: any) => u.payload.status === 'done');
    expect(writeBack).toBeDefined();
    expect(writeBack.payload.error).toBeNull();
    expect(writeBack.payload.result).toEqual(fakeResult);
    expect(logs.some((l) => l.includes('recorded — 2 gate(s) landed'))).toBe(true);
  });

  it('writes back status=error, with the refusal reason, when the walk refuses (ineligible)', async () => {
    const fakeResult = {
      task_id: 'resolved-B-2000', eligibility: { items: [], eligible: false }, refused: true,
      refusal_reason: 'harmony record refuses — 1 of 5 eligibility item(s) did not pass', gates: [], attestation_recorded: false,
    };
    mocks.runRecordedWalk.mockResolvedValue(fakeResult);
    const client = makeClient({ selectResult: { data: [pendingRow], error: null } });
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: () => {} });
    expect(processed).toBe(1);
    const writeBack = client.updates.find((u: any) => u.payload.status === 'error');
    expect(writeBack.payload.error).toContain('refuses');
    expect(writeBack.payload.result).toEqual(fakeResult);
  });

  it('writes back status=error when the gate-walk core throws — never crashes the drain', async () => {
    mocks.runRecordedWalk.mockRejectedValue(new Error('boom: unexpected failure'));
    const client = makeClient({ selectResult: { data: [pendingRow], error: null } });
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: () => {} });
    expect(processed).toBe(1);
    const writeBack = client.updates.find((u: any) => u.payload.status === 'error');
    expect(writeBack.payload.error).toContain('boom: unexpected failure');
    // The walk threw before producing a `RecordWalkResult` at all — write-back records `result: null`.
    expect(writeBack.payload.result).toBeNull();
  });

  it('loses the claim race cleanly (a peer daemon already claimed it) — no double-processing', async () => {
    const client = makeClient({ selectResult: { data: [pendingRow], error: null }, claimResult: { data: null, error: null } });
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: () => {} });
    expect(processed).toBe(0);
    expect(mocks.runRecordedWalk).not.toHaveBeenCalled();
  });

  it('B-1073 step 10: a ticket at Built derives from_gate: "deploy" — resumes without re-walking clarify..build', async () => {
    mocks.runRecordedWalk.mockResolvedValue({
      task_id: 'resolved-B-2000', eligibility: { items: [], eligible: true }, refused: false,
      gates: [{ gate: 'deploy', landed: true }, { gate: 'verify', landed: true }], attestation_recorded: false,
    });
    const client = makeClient({ selectResult: { data: [pendingRow], error: null }, taskWorkflowState: 'Built' });
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: () => {} });
    expect(processed).toBe(1);
    expect(mocks.runRecordedWalk).toHaveBeenCalledWith(client, PROJECT_ID, USER_ID, {
      task_id: 'B-2000',
      summary: pendingRow.summary,
      evidence: pendingRow.evidence_links,
      attest_walk: pendingRow.attest_walk,
      from_gate: 'deploy',
    });
  });

  it('B-1073 step 9: an unreadable workflow_state degrades to from_gate: "clarify" — never throws', async () => {
    mocks.runRecordedWalk.mockResolvedValue({
      task_id: 'resolved-B-2000', eligibility: { items: [], eligible: true }, refused: false,
      gates: [{ gate: 'clarify', landed: true }], attestation_recorded: false,
    });
    const client = makeClient({ selectResult: { data: [pendingRow], error: null } });
    // Force the tasks-table read to throw — the drain must still complete, defaulting to 'clarify'.
    const originalFrom = client.from;
    client.from = (table: string) => {
      if (table === 'tasks') throw new Error('network blip');
      return originalFrom(table);
    };
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: () => {} });
    expect(processed).toBe(1);
    expect(mocks.runRecordedWalk).toHaveBeenCalledWith(client, PROJECT_ID, USER_ID, {
      task_id: 'B-2000',
      summary: pendingRow.summary,
      evidence: pendingRow.evidence_links,
      attest_walk: pendingRow.attest_walk,
      from_gate: 'clarify',
    });
  });
});

describe('buildFastTrackReleaseRemarkRecordedWalkRequest (B-1073 step 11 — pure stub, no caller yet)', () => {
  it('shapes the row from a non-blank remark + a known build_pr url', () => {
    const row = buildFastTrackReleaseRemarkRecordedWalkRequest({
      task_id: 'task-uuid-1',
      task_title: 'B-2000: Fix the flaky retry timer',
      remark_detail: 'walked the poller locally for 8 minutes, confirmed the fix',
      build_pr_url: 'https://github.com/ycomplex/harmony-plugin/pull/42',
      requested_by: 'human-1',
    });
    expect(row).toEqual({
      task_id: 'task-uuid-1',
      summary: 'B-2000: Fix the flaky retry timer',
      evidence_links: [{ url: 'https://github.com/ycomplex/harmony-plugin/pull/42' }],
      attest_walk: 'walked the poller locally for 8 minutes, confirmed the fix',
      requested_by: 'human-1',
    });
  });

  it('returns null for a blank/whitespace-only remark — an attestation cannot be empty', () => {
    expect(buildFastTrackReleaseRemarkRecordedWalkRequest({
      task_id: 'task-uuid-1', task_title: 'B-2000', remark_detail: '   ', build_pr_url: null, requested_by: 'human-1',
    })).toBeNull();
  });

  it('evidence_links is [] when no build_pr url is known', () => {
    const row = buildFastTrackReleaseRemarkRecordedWalkRequest({
      task_id: 'task-uuid-1', task_title: 'B-2000', remark_detail: 'walked it', build_pr_url: null, requested_by: 'human-1',
    });
    expect(row?.evidence_links).toEqual([]);
  });
});
