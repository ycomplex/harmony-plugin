import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runRecordedWalk: vi.fn(),
}));
vi.mock('../tools/record-walk.js', () => ({ runRecordedWalk: mocks.runRecordedWalk }));

import {
  runRecordedWalkDrainPass,
  isMissingRecordedWalkRequestsTable,
  RECORDED_WALK_REQUESTS_TABLE,
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
}) {
  const updates: Array<{ payload: any; eqCalls: Array<[string, unknown]> }> = [];
  const from = vi.fn((table: string) => {
    expect(table).toBe(RECORDED_WALK_REQUESTS_TABLE);
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
    mocks.runRecordedWalk.mockResolvedValue({
      task_id: 'resolved-B-2000', eligibility: { items: [], eligible: true }, refused: false,
      gates: [{ gate: 'clarify', landed: true }, { gate: 'release', landed: true }], attestation_recorded: true,
    });
    const client = makeClient({ selectResult: { data: [pendingRow], error: null } });
    const logs: string[] = [];
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: (l) => logs.push(l) });

    expect(processed).toBe(1);
    expect(mocks.runRecordedWalk).toHaveBeenCalledWith(client, PROJECT_ID, USER_ID, {
      task_id: 'B-2000',
      summary: pendingRow.summary,
      evidence: pendingRow.evidence_links,
      attest_walk: pendingRow.attest_walk,
    });
    const writeBack = client.updates.find((u: any) => u.payload.status === 'done');
    expect(writeBack).toBeDefined();
    expect(writeBack.payload.error).toBeNull();
    expect(logs.some((l) => l.includes('recorded — 2 gate(s) landed'))).toBe(true);
  });

  it('writes back status=error, with the refusal reason, when the walk refuses (ineligible)', async () => {
    mocks.runRecordedWalk.mockResolvedValue({
      task_id: 'resolved-B-2000', eligibility: { items: [], eligible: false }, refused: true,
      refusal_reason: 'harmony record refuses — 1 of 5 eligibility item(s) did not pass', gates: [], attestation_recorded: false,
    });
    const client = makeClient({ selectResult: { data: [pendingRow], error: null } });
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: () => {} });
    expect(processed).toBe(1);
    const writeBack = client.updates.find((u: any) => u.payload.status === 'error');
    expect(writeBack.payload.error).toContain('refuses');
  });

  it('writes back status=error when the gate-walk core throws — never crashes the drain', async () => {
    mocks.runRecordedWalk.mockRejectedValue(new Error('boom: unexpected failure'));
    const client = makeClient({ selectResult: { data: [pendingRow], error: null } });
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: () => {} });
    expect(processed).toBe(1);
    const writeBack = client.updates.find((u: any) => u.payload.status === 'error');
    expect(writeBack.payload.error).toContain('boom: unexpected failure');
  });

  it('loses the claim race cleanly (a peer daemon already claimed it) — no double-processing', async () => {
    const client = makeClient({ selectResult: { data: [pendingRow], error: null }, claimResult: { data: null, error: null } });
    const processed = await runRecordedWalkDrainPass({ client, projectId: PROJECT_ID, userId: USER_ID, log: () => {} });
    expect(processed).toBe(0);
    expect(mocks.runRecordedWalk).not.toHaveBeenCalled();
  });
});
