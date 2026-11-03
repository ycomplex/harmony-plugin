import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerMilestoneCommands } from './milestones.js';
import { shippingClient } from '../../test/fixtures/milestone-shipping.js';

const mocks = vi.hoisted(() => ({ getAuthenticatedContext: vi.fn() }));
vi.mock('../auth.js', () => ({ getAuthenticatedContext: mocks.getAuthenticatedContext }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-11-03T12:00:00Z'); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('milestones ship CLI report (B-1392)', () => {
  it.each([true, false])('prints human and JSON follow-up reports (undrained=%s)', async (undrained) => {
    const { client, scan } = shippingClient(undrained);
    mocks.getAuthenticatedContext.mockResolvedValue({ client, projectId: 'p1', userId: 'u1' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = async (json: boolean) => {
      const program = new Command().option('--json', 'JSON output', false);
      registerMilestoneCommands(program);
      await program.parseAsync([...(json ? ['--json'] : []), 'milestones', 'ship', 'm1'], { from: 'user' });
      return log.mock.calls.at(-1)![0] as string;
    };
    const human = await run(false);
    expect(human).toContain(`Follow-up check: 2 tickets scanned; ${undrained ? 1 : 0} undrained rollups.`);
    if (undrained) {
      expect(human).toContain('B-42 — Shipping host: 3 items');
      for (const item of scan.rollups[0].items) expect(human).toContain(`[${item.tag}] ${item.id}: ${item.text}`);
    } else expect(human).not.toContain('B-42');
    expect(human).toContain('Shipped milestone: Release');
    const json = JSON.parse(await run(true));
    expect(json.rollup_scan).toEqual(scan);
    expect(json.retained_cancelled_count).toBe(1);
    expect(json.shipped_task_count).toBe(2);
  });
});
