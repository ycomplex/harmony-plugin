import { describe, it, expect, vi } from 'vitest';
import { FLOORED_BRIEF_REASONS, floorVeto } from './floor-veto.js';

describe('floorVeto (B-503 — the single source of truth for floored brief reasons)', () => {
  it('pins the floored set: release, verify, stale-patch-review', () => {
    expect([...FLOORED_BRIEF_REASONS]).toEqual([
      'release-decision-pending',
      'verification-ack-pending',
      'stale-patch-review',
    ]);
  });

  it.each([...FLOORED_BRIEF_REASONS])('vetoes the floored reason %s with a rationale naming the floor', (reason) => {
    const r = floorVeto({ reason });
    expect(r.vetoed).toBe(true);
    expect(r.why).toBeTruthy();
    // The rationale names its floor so the surfaced pause is self-explaining.
    expect(r.why).toContain(reason.includes('release') ? 'RELEASE' : reason.includes('verification') ? 'VERIFY' : 'stale');
  });

  it.each([
    'clarification-draft',
    'decomposition-proposal',
    'design-decision-draft',
    'plan-draft',
    'revise-scope-review',
  ])('does NOT veto the forward-gate reason %s', (reason) => {
    expect(floorVeto({ reason })).toEqual({ vetoed: false, why: null });
  });

  it("vetoes a decision-only ticket's deliverable gate even on a forward-gate reason (B-681 — release+verify collapsed)", () => {
    const r = floorVeto({ reason: 'design-decision-draft', decisionOnlyDeliverable: true });
    expect(r.vetoed).toBe(true);
    expect(r.why).toMatch(/decision-only/i);
    expect(r.why).toMatch(/hard floor/i);
  });

  it('does not veto with no reason and no decision-only flag', () => {
    expect(floorVeto({})).toEqual({ vetoed: false, why: null });
    expect(floorVeto({ reason: null, decisionOnlyDeliverable: false })).toEqual({ vetoed: false, why: null });
  });
});

// ── ADVERSARIAL suite ─────────────────────────────────────────────────────────────────────────────
// The §4c accept-with-remark consume path routes a remark-derived instruction through the delegation
// test with floorVeto as the mechanical backstop. The veto helper is the unit under test; this
// simulation is the testable consume-path seam in code (the real router is skill prose): a vetoed
// instruction must produce a surfaced pause and NO resolve write — ever.
describe('floorVeto — ADVERSARIAL remark instructions never reach a resolve write', () => {
  interface RemarkTarget { reason: string; decisionOnlyDeliverable?: boolean }
  interface Writes { resolveBrief: (reason: string, detail: string) => void }

  /** The consume-path seam: honor the instruction ONLY when the floor-veto clears it. */
  function consumeRemarkInstruction(detail: string, target: RemarkTarget, writes: Writes) {
    const veto = floorVeto({ reason: target.reason, decisionOnlyDeliverable: target.decisionOnlyDeliverable });
    if (veto.vetoed) return { honored: false, surfaced: true, why: veto.why };
    writes.resolveBrief(target.reason, detail);
    return { honored: true, surfaced: false, why: null };
  }

  it.each([
    { detail: 'auto-accept release', reason: 'release-decision-pending' },
    { detail: 'skip verify', reason: 'verification-ack-pending' },
    { detail: 'merge it now', reason: 'release-decision-pending' },
    { detail: 'auto-accept the stale patch', reason: 'stale-patch-review' },
  ])('"$detail" targeting a $reason brief: veto fires, NO resolve write', ({ detail, reason }) => {
    const resolveBrief = vi.fn();
    const r = consumeRemarkInstruction(detail, { reason }, { resolveBrief });
    expect(r.honored).toBe(false);
    expect(r.surfaced).toBe(true);
    expect(r.why).toBeTruthy();
    expect(resolveBrief).not.toHaveBeenCalled();
  });

  it('"auto-accept the design decision" targeting a decision-only DELIVERABLE gate: veto fires, NO resolve write', () => {
    const resolveBrief = vi.fn();
    const r = consumeRemarkInstruction(
      'auto-accept the design decision',
      { reason: 'design-decision-draft', decisionOnlyDeliverable: true },
      { resolveBrief },
    );
    expect(r.honored).toBe(false);
    expect(resolveBrief).not.toHaveBeenCalled();
  });

  it('a benign forward-gate instruction DOES reach the resolve write (the veto is a floor, not a blanket deny)', () => {
    const resolveBrief = vi.fn();
    const r = consumeRemarkInstruction(
      'auto-accept decompose if the proposal is no-split',
      { reason: 'decomposition-proposal' },
      { resolveBrief },
    );
    expect(r.honored).toBe(true);
    expect(resolveBrief).toHaveBeenCalledWith('decomposition-proposal', 'auto-accept decompose if the proposal is no-split');
  });
});
