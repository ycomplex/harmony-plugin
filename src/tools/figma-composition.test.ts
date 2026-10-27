import { describe, it, expect, vi } from 'vitest';
import { planComposition, CallBudget, limited, waitForVersionAfter, MCP_CALL_CAP } from './figma-composition.js';

// SYNTHETIC fixtures. The real recorded use_figma fixture from the 2026-10-27 live proof is in
// __fixtures__/figma-composition.live-2026-10-27.json, exercised by figma-composition.recorded.test.ts.
const componentMap = { Button: 'key-button', Card: 'key-card', Table: 'key-table' };

describe('planComposition (synthetic fixture)', () => {
  const options = [
    { name: 'Inline', components: ['Card', 'Button'], provenance: [{ element: 'Card copy', provenance: 'illustrative' as const }] },
    { name: 'Table', recommended: true, components: ['Table', 'Ghost'], provenance: [{ element: 'Columns', provenance: 'real' as const }, { element: '5th column', provenance: 'invented' as const, note: 'not decided' }] },
  ];
  it('orders frames, names them, marks exactly one recommendation, carries provenance notes', () => {
    const plan = planComposition({ ticket: 'B-9', options, componentMap });
    expect(plan.frames.map((f) => f.name)).toEqual(['B-9 · Inline', 'B-9 · Table']);
    expect(plan.frames.filter((f) => f.recommended)).toHaveLength(1);
    expect(plan.frames[1].notes).toContain('invented: 5th column — not decided');
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0].tool).toBe('use_figma');
  });
  it('resolves library instances and reports unmapped components rather than importing layers', () => {
    const plan = planComposition({ ticket: 'B-9', options, componentMap });
    expect(plan.frames[0].instances).toEqual([{ component: 'Card', componentKey: 'key-card' }, { component: 'Button', componentKey: 'key-button' }]);
    expect(plan.unmapped).toEqual(['Ghost']);
  });
  it('refuses zero or several recommendations', () => {
    expect(() => planComposition({ ticket: 'B-9', options: options.map((o) => ({ ...o, recommended: false })), componentMap })).toThrow(/exactly one/);
  });
  it('plans a flow as N ordered frames with a caption each', () => {
    const plan = planComposition({ ticket: 'B-9', componentMap, flow: [
      { name: 'Start', caption: 'Pick a team', components: ['Card'] },
      { name: 'Done', caption: 'Confirm', components: ['Button'] },
    ] });
    expect(plan.kind).toBe('flow');
    expect(plan.frames.map((f) => [f.order, f.caption])).toEqual([[1, 'Pick a team'], [2, 'Confirm']]);
  });
});

describe('CallBudget', () => {
  it('hard-caps at 6 and reports the stop message', () => {
    const b = new CallBudget();
    expect(b.cap).toBe(MCP_CALL_CAP);
    expect(MCP_CALL_CAP).toBe(6);
    for (let i = 0; i < 6; i++) expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
    expect(b.record()).toBe(6);
    expect(b.stopMessage()).toMatch(/6-call MCP cap/);
  });
  it('has no stop message while under the cap', () => {
    const b = new CallBudget();
    b.tryConsume();
    expect(b.stopMessage()).toBeNull();
  });
});

describe('limited', () => {
  it('passes through the limiter when present and runs directly when absent', async () => {
    const acquire = vi.fn(async () => {});
    expect(await limited({ acquire }, async () => 7)).toBe(7);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(await limited(undefined, async () => 8)).toBe(8);
  });
});

describe('waitForVersionAfter', () => {
  const sleep = async () => {};
  it('returns the first version created after the timestamp, polling boundedly', async () => {
    const lists = [[{ id: 'v1', created_at: '2026-01-01T00:00:00Z' }], [{ id: 'v1', created_at: '2026-01-01T00:00:00Z' }, { id: 'v2', created_at: '2026-01-01T00:05:00Z' }]];
    let n = 0;
    const r = await waitForVersionAfter({ listVersions: async () => lists[Math.min(n++, 1)], afterIso: '2026-01-01T00:01:00Z', maxAttempts: 3, intervalMs: 1, sleep });
    expect(r).toEqual({ ok: true, version: { id: 'v2', created_at: '2026-01-01T00:05:00Z' } });
    expect(n).toBe(2);
  });
  it('fails clearly after the bounded attempts', async () => {
    const listVersions = vi.fn(async () => [{ id: 'v1', created_at: '2026-01-01T00:00:00Z' }]);
    const r = await waitForVersionAfter({ listVersions, afterIso: '2026-01-01T00:01:00Z', maxAttempts: 3, intervalMs: 1, sleep });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/3 attempts/);
    expect(listVersions).toHaveBeenCalledTimes(3);
  });
});
