import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shippingClient } from '../test/fixtures/milestone-shipping.js';
import { shipMilestone } from './milestones.js';
import { projectAck } from './ack-projection.js';
import { handleToolCall } from './index.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-11-03T12:00:00Z'); });
afterEach(() => { vi.useRealTimers(); });

describe('milestone shipping replies (B-1392)', () => {
  it.each([true, false])('keeps the complete scan at the MCP serialization boundary (undrained=%s)', async (undrained) => {
    const { client, scan } = shippingClient(undrained);
    const response = await handleToolCall('ship_milestone', { milestone_id: 'm1' }, client, 'p1', 'u1');
    const text = (response as { content: { text: string }[] }).content[0].text;
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual({
      milestone: { id: 'm1', name: 'Release', status: 'shipped', shipped_at: '2026-11-03T12:00:00Z' },
      rollup_scan: scan, shipped_task_count: 2, retained_cancelled_count: 1, removed_tasks: [],
    });
    expect(client.rpc).toHaveBeenCalledWith('milestone_rollup_scan', { p_project_id: 'p1', p_milestone_id: 'm1' });
  });

  it('accounts for EVERY live handler result field, with only the milestone row compacted', async () => {
    const { client } = shippingClient();
    const result = await shipMilestone(client, 'p1', { milestone_id: 'm1' });
    const ack = projectAck('ship_milestone', result, { milestone_id: 'm1' });
    // Enumerate the real handler result, not a parallel fixture of expected keys:
    // a newly added server-computed field must be consciously projected too.
    expect(Object.keys(ack).sort()).toEqual(Object.keys(result).sort());
    for (const [key, value] of Object.entries(result)) {
      if (key !== 'milestone') expect(ack[key]).toEqual(value);
    }
    expect(ack.milestone).not.toHaveProperty('description');
  });
});
