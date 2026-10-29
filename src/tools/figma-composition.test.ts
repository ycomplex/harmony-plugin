import { describe, it, expect, vi } from 'vitest';
import { planComposition, CallBudget, limited, waitForVersionAfter, nextThrottleDelay, THROTTLE_BACKOFF, MCP_CALL_CAP, checkPreviewSet, NO_PREVIEW_NOTE } from './figma-composition.js';

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

describe('nextThrottleDelay (429 backoff)', () => {
  it('honours Retry-After without shortening the server cooldown', () => {
    expect(nextThrottleDelay({ attempt: 1, retryAfterSeconds: 7 })).toEqual({ retry: true, delayMs: 7000 });
    expect(nextThrottleDelay({ attempt: 1, retryAfterSeconds: 9999 })).toEqual({ retry: true, delayMs: 9999000 });
  });
  it('grows exponentially without Retry-After, bounded by maxMs', () => {
    const d = (attempt: number) => (nextThrottleDelay({ attempt, maxAttempts: 50 }) as { delayMs: number }).delayMs;
    expect([d(1), d(2), d(3)]).toEqual([2000, 4000, 8000]);
    expect(d(20)).toBe(THROTTLE_BACKOFF.maxMs);
  });
  it('never returns an immediate retry, even for Retry-After 0 or a zero base', () => {
    for (const retryAfterSeconds of [undefined, 0, -3, NaN]) {
      const r = nextThrottleDelay({ attempt: 1, retryAfterSeconds, baseMs: 0 });
      expect(r.retry && r.delayMs).toBeGreaterThan(0);
    }
  });
  it('is exhausted at maxAttempts', () => {
    expect(nextThrottleDelay({ attempt: THROTTLE_BACKOFF.maxAttempts })).toEqual({ retry: false, reason: 'backoff-exhausted' });
    expect(nextThrottleDelay({ attempt: 2, maxAttempts: 2, retryAfterSeconds: 1 })).toEqual({ retry: false, reason: 'backoff-exhausted' });
  });
});

describe('composition cost (B-1203)', () => {
  const componentMap = { Card: 'k' };
  const options = [{ name: 'A', recommended: true, components: ['Card'], provenance: [] }];
  it('adds no MCP call and no save tail: the plan is still one compose call', () => {
    const plan = planComposition({ ticket: 'B-9', options, componentMap });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls.filter((c) => c.purpose === 'compose')).toHaveLength(1);
    expect(MCP_CALL_CAP).toBe(6);
  });
});

describe('checkPreviewSet', () => {
  it('complete when every frame was composed and every image non-null', () => {
    const r = checkPreviewSet({ plannedFrameIds: ['1:1', '1:2'], composedFrameIds: ['1:1', '1:2'], images: { '1:1': 'u1', '1:2': 'u2' } });
    expect(r).toEqual({ complete: true, missingFrames: [], nullImages: [] });
  });
  it('reports a frame not returned by the compose call with the honest note', () => {
    const r = checkPreviewSet({ plannedFrameIds: ['1:1', '1:2'], composedFrameIds: ['1:1'], images: { '1:1': 'u1' } });
    expect(r.complete).toBe(false);
    expect(r.missingFrames).toEqual(['1:2']);
    expect(r.note).toBe(NO_PREVIEW_NOTE);
  });
  it('reports null or absent images', () => {
    const r = checkPreviewSet({ plannedFrameIds: ['1:1', '1:2'], composedFrameIds: ['1:1', '1:2'], images: { '1:1': null } });
    expect(r.complete).toBe(false);
    expect(r.nullImages).toEqual(['1:1', '1:2']);
  });
  it('an empty plan is never complete', () => {
    expect(checkPreviewSet({ plannedFrameIds: [], composedFrameIds: [], images: {} }).complete).toBe(false);
  });
});
