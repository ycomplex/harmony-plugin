import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RollupScan } from '../../tools/milestone-rollup-scan.js';

/** Database boundary only: both callers still execute the real shipping handler. */
export function shippingClient(undrained = true): { client: SupabaseClient; scan: RollupScan } {
  const scan: RollupScan = {
    schema_version: 1, scanned_host_count: 2, open_rollup_count: undrained ? 1 : 0,
    members: [
      { id: 't1', title: 'Shipping host', status: 'Done', workflow_state: 'Verified' },
      { id: 't2', title: 'Cancelled host', status: 'Backlog', workflow_state: 'Cancelled' },
    ],
    rollups: undrained ? [{
      task_id: 't1', visual_id: 'B-42', title: 'Shipping host', comment_id: 'c1',
      rollup_key: 'follow-ups', item_count: 3, needs_review: false,
      items: [
        { id: 'fix', tag: 'do-now', text: 'Fix inline' },
        { id: 'later', tag: 'defer-with-trigger', text: 'Revisit on release' },
        { id: 'omit', tag: 'drop', text: 'Duplicate' },
      ],
    }] : [],
    needs_review: [],
  };
  const client = {
    rpc: vi.fn().mockResolvedValue({ data: scan, error: null }),
    from: vi.fn((table: string) => {
      const chain = {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: table === 'projects'
          ? { mode: 'opinionated', custom_statuses: ['Backlog', 'Done'] }
          : { id: 'm1', name: 'Release', status: 'shipped', shipped_at: '2026-11-03T12:00:00Z', description: 'Not echoed' }, error: null }),
      };
      if (!['projects', 'milestones'].includes(table)) throw new Error(`Unexpected table ${table}`);
      return chain;
    }),
  } as unknown as SupabaseClient;
  return { client, scan };
}
