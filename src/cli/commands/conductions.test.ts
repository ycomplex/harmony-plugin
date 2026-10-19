// B-1164: unit coverage for the pure core of `harmony conductions active`.

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ listConductions: vi.fn(), getProject: vi.fn() }));
vi.mock('../../tools/conduction-record.js', () => ({ listConductions: mocks.listConductions }));
vi.mock('../../tools/project.js', () => ({ getProject: mocks.getProject }));

import { listActiveConductions } from './conductions.js';

const clientWithTasks = (tasks: Array<{ id: string; task_number: number }>) =>
  ({ from: () => ({ select: () => ({ in: async () => ({ data: tasks, error: null }) }) }) }) as unknown as SupabaseClient;

describe('listActiveConductions', () => {
  it('asks for active rows only and projects id, ticket key, lease holder and heartbeat', async () => {
    mocks.listConductions.mockResolvedValue([
      { id: 'c1', task_id: 't1', status: 'active', lease_holder: 'host:42:abcd', last_heartbeat_at: '2026-10-19T10:00:00Z', leg_started_at: null, clean_shutdown_at: null, retry_count: 0 },
    ]);
    mocks.getProject.mockResolvedValue({ key: 'B' });
    const rows = await listActiveConductions(clientWithTasks([{ id: 't1', task_number: 1164 }]), 'p1');
    expect(mocks.listConductions).toHaveBeenCalledWith(expect.anything(), { status: 'active' });
    expect(rows).toEqual([
      { id: 'c1', ticket: 'B-1164', status: 'active', lease_holder: 'host:42:abcd', last_heartbeat_at: '2026-10-19T10:00:00Z', leg_started_at: null, clean_shutdown_at: null },
    ]);
  });

  it('returns [] without further reads when nothing is active', async () => {
    mocks.listConductions.mockResolvedValue([]);
    mocks.getProject.mockClear();
    expect(await listActiveConductions(clientWithTasks([]), 'p1')).toEqual([]);
    expect(mocks.getProject).not.toHaveBeenCalled();
  });
});
