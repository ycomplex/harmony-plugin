// B-1073 step 11 (post-review wiring) — unit coverage for fasttrack-release-remark.ts's REAL
// insert call site. Mirrors src/daemon/recorded-walk-drain.test.ts's own chainable mock-client
// convention (a per-table `from` dispatch returning a minimal chainable object), since this module
// is this repo's other Supabase-mocking precedent for `recorded_walk_requests` specifically.

import { describe, it, expect, vi } from 'vitest';
import {
  buildFastTrackReleaseRemarkRecordedWalkRequest,
  fileFastTrackReleaseRemarkRecordedWalkIfEligible,
} from './fasttrack-release-remark.js';

interface ClientOpts {
  /** `conductions` table read (getActiveConduction) — defaults to no active conduction at all. */
  conductionResult?: { data: unknown; error: unknown };
  /** `tasks` table read (title + field_values.build_pr). */
  taskResult?: { data: unknown; error: unknown };
  /** `recorded_walk_requests` insert outcome. */
  insertError?: unknown;
}

function makeClient(opts: ClientOpts = {}) {
  const insertCalls: unknown[] = [];
  const from = vi.fn((table: string) => {
    if (table === 'conductions') {
      const chain: any = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => opts.conductionResult ?? { data: null, error: null });
      return chain;
    }
    if (table === 'tasks') {
      const chain: any = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => opts.taskResult ?? { data: null, error: null });
      return chain;
    }
    if (table === 'recorded_walk_requests') {
      const chain: any = {};
      chain.insert = vi.fn((row: unknown) => {
        insertCalls.push(row);
        return Promise.resolve({ error: opts.insertError ?? null });
      });
      return chain;
    }
    throw new Error(`unexpected table in test fixture: ${table}`);
  });
  return { client: { from } as any, insertCalls };
}

const FAST_TRACK_CONDUCTION = { data: { run_config: { fast_track: true } }, error: null };
const NOT_FAST_TRACK_CONDUCTION = { data: { run_config: {} }, error: null };
const TASK_WITH_BUILD_PR = {
  data: { title: 'B-2000: Fix the flaky retry timer', field_values: { build_pr: { pr_url: 'https://github.com/ycomplex/harmony-plugin/pull/42' } } },
  error: null,
};

describe('buildFastTrackReleaseRemarkRecordedWalkRequest (B-1073 step 11)', () => {
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

  it('returns null for a blank/whitespace-only remark', () => {
    expect(
      buildFastTrackReleaseRemarkRecordedWalkRequest({
        task_id: 'task-uuid-1', task_title: 'B-2000', remark_detail: '   ', build_pr_url: null, requested_by: 'human-1',
      }),
    ).toBeNull();
  });
});

describe('fileFastTrackReleaseRemarkRecordedWalkIfEligible (B-1073 step 11 — the REAL call site)', () => {
  it('inserts a recorded_walk_requests row for a fast-track ticket released with a remark', async () => {
    const { client, insertCalls } = makeClient({
      conductionResult: FAST_TRACK_CONDUCTION,
      taskResult: TASK_WITH_BUILD_PR,
    });
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'release-decision-pending',
      remark_detail: 'walked the poller locally for 8 minutes, confirmed the fix',
      requested_by: 'human-1',
    });
    expect(filed).toBe(true);
    expect(insertCalls).toEqual([
      {
        task_id: 'task-uuid-1',
        summary: 'B-2000: Fix the flaky retry timer',
        evidence_links: [{ url: 'https://github.com/ycomplex/harmony-plugin/pull/42' }],
        attest_walk: 'walked the poller locally for 8 minutes, confirmed the fix',
        requested_by: 'human-1',
      },
    ]);
  });

  it('files nothing when the brief reason is not the release gate\'s own reason', async () => {
    const { client, insertCalls } = makeClient({
      conductionResult: FAST_TRACK_CONDUCTION,
      taskResult: TASK_WITH_BUILD_PR,
    });
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'decomposition-proposal',
      remark_detail: 'a remark on a totally different gate',
      requested_by: 'human-1',
    });
    expect(filed).toBe(false);
    expect(insertCalls).toEqual([]);
  });

  it('files nothing when the ticket has no active conduction at all', async () => {
    const { client, insertCalls } = makeClient({ conductionResult: { data: null, error: null } });
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'release-decision-pending',
      remark_detail: 'walked it',
      requested_by: 'human-1',
    });
    expect(filed).toBe(false);
    expect(insertCalls).toEqual([]);
  });

  it('files nothing when the active conduction is NOT fast-track — an ordinary conducted ticket', async () => {
    const { client, insertCalls } = makeClient({
      conductionResult: NOT_FAST_TRACK_CONDUCTION,
      taskResult: TASK_WITH_BUILD_PR,
    });
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'release-decision-pending',
      remark_detail: 'walked it',
      requested_by: 'human-1',
    });
    expect(filed).toBe(false);
    expect(insertCalls).toEqual([]);
  });

  it('files nothing for a blank/whitespace-only remark — never reaches the DB at all', async () => {
    const { client, insertCalls } = makeClient({ conductionResult: FAST_TRACK_CONDUCTION });
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'release-decision-pending',
      remark_detail: '   ',
      requested_by: 'human-1',
    });
    expect(filed).toBe(false);
    expect(insertCalls).toEqual([]);
  });

  it('evidence_links is [] when the ticket has no recorded build_pr', async () => {
    const { client, insertCalls } = makeClient({
      conductionResult: FAST_TRACK_CONDUCTION,
      taskResult: { data: { title: 'B-2000', field_values: {} }, error: null },
    });
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'release-decision-pending',
      remark_detail: 'walked it',
      requested_by: 'human-1',
    });
    expect(filed).toBe(true);
    expect((insertCalls[0] as { evidence_links: unknown[] }).evidence_links).toEqual([]);
  });

  it('NEVER THROWS: degrades to false on a genuine insert error (e.g. the table not existing pre-B-1063)', async () => {
    const { client, insertCalls } = makeClient({
      conductionResult: FAST_TRACK_CONDUCTION,
      taskResult: TASK_WITH_BUILD_PR,
      insertError: { code: '42P01', message: 'relation "recorded_walk_requests" does not exist' },
    });
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'release-decision-pending',
      remark_detail: 'walked it',
      requested_by: 'human-1',
    });
    expect(filed).toBe(false);
    expect(insertCalls).toHaveLength(1); // the insert was ATTEMPTED — just failed, and that failure degraded quietly.
  });

  it('NEVER THROWS: degrades to false when the conduction read itself throws', async () => {
    const client = {
      from: vi.fn(() => {
        throw new Error('network blip');
      }),
    } as any;
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'release-decision-pending',
      remark_detail: 'walked it',
      requested_by: 'human-1',
    });
    expect(filed).toBe(false);
  });

  it('files nothing when the task read itself fails', async () => {
    const { client, insertCalls } = makeClient({
      conductionResult: FAST_TRACK_CONDUCTION,
      taskResult: { data: null, error: { message: 'boom' } },
    });
    const filed = await fileFastTrackReleaseRemarkRecordedWalkIfEligible(client, {
      task_id: 'task-uuid-1',
      reason: 'release-decision-pending',
      remark_detail: 'walked it',
      requested_by: 'human-1',
    });
    expect(filed).toBe(false);
    expect(insertCalls).toEqual([]);
  });
});
