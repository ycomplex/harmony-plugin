// B-772: unit coverage for the shared workflow_state -> gate projection. Mirrors
// skills/harmony-shared/gate-routing.md's canonical table — every row there gets a case here.

import { describe, it, expect } from 'vitest';
import { resolveGatePhase, type Gate } from './gate-phase.js';

describe('resolveGatePhase', () => {
  const cases: Array<[string, Gate]> = [
    ['Captured', 'clarify'],
    ['Proposed', 'clarify'],
    ['Clarified', 'decompose'],
    ['Decomposed', 'design'],
    ['Designed', 'plan'],
    ['Planned', 'build'],
    ['Built', 'release'],
    ['Deployed', 'verify'],
  ];

  it.each(cases)('maps workflow_state %s to gate %s', (workflow_state, gate) => {
    expect(resolveGatePhase(workflow_state)).toBe(gate);
  });

  it('collapses all three design sub-track activities at Decomposed onto the single design gate', () => {
    expect(resolveGatePhase('Decomposed', 'designing')).toBe('design');
    // workflow_activity does not (currently) carry a per-sub-track distinction (see the module's
    // own doc comment) — every activity value observed at Decomposed still resolves to 'design'.
    expect(resolveGatePhase('Decomposed', 'designing-product')).toBe('design');
    expect(resolveGatePhase('Decomposed', 'designing-technical')).toBe('design');
    expect(resolveGatePhase('Decomposed', 'designing-ux-ui')).toBe('design');
  });

  it('returns null for the three terminal states', () => {
    expect(resolveGatePhase('Verified')).toBeNull();
    expect(resolveGatePhase('Parked')).toBeNull();
    expect(resolveGatePhase('Cancelled')).toBeNull();
  });

  it('returns null for a null/undefined/absent workflow_state', () => {
    expect(resolveGatePhase(null)).toBeNull();
    expect(resolveGatePhase(undefined)).toBeNull();
    expect(resolveGatePhase()).toBeNull();
  });

  it('returns null for an unrecognized workflow_state (never throws)', () => {
    expect(resolveGatePhase('SomeFutureState')).toBeNull();
  });

  it('workflow_activity alone never changes the result for a recognized workflow_state', () => {
    expect(resolveGatePhase('Planned', 'anything')).toBe('build');
    expect(resolveGatePhase('Planned', null)).toBe('build');
    expect(resolveGatePhase('Planned', undefined)).toBe('build');
  });
});
