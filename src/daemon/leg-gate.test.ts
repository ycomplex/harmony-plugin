// B-1073 — unit coverage for resolveLegGate: the fast-track leg-gate routing wrapper.

import { describe, it, expect } from 'vitest';
import { resolveLegGate } from './leg-gate.js';
import type { RunConfig } from '../config/run-config.js';

const FAST_TRACK: RunConfig = { fast_track: true };
const NOT_FAST_TRACK: RunConfig = { fast_track: false };
const EMPTY: RunConfig = {};

describe('resolveLegGate (B-1073)', () => {
  it("fast-track + Captured ⇒ 'build'", () => {
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Captured' })).toBe('build');
  });

  it("fast-track + Proposed ⇒ 'build'", () => {
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Proposed' })).toBe('build');
  });

  it('fast-track + any OTHER state delegates to resolveGatePhase\'s own answer, unchanged', () => {
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Clarified' })).toBe('decompose');
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Decomposed' })).toBe('design');
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Designed' })).toBe('plan');
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Planned' })).toBe('build');
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Built' })).toBe('release');
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Deployed' })).toBe('verify');
  });

  it('fast-track + a terminal state still returns null — the hard floor is untouched', () => {
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Verified' })).toBeNull();
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Parked' })).toBeNull();
    expect(resolveLegGate(FAST_TRACK, { workflow_state: 'Cancelled' })).toBeNull();
  });

  it('non-fast-track (explicit false) always delegates to resolveGatePhase, even at Captured/Proposed', () => {
    expect(resolveLegGate(NOT_FAST_TRACK, { workflow_state: 'Captured' })).toBe('clarify');
    expect(resolveLegGate(NOT_FAST_TRACK, { workflow_state: 'Proposed' })).toBe('clarify');
  });

  it('non-fast-track (absent key, {}) always delegates to resolveGatePhase, even at Captured/Proposed', () => {
    expect(resolveLegGate(EMPTY, { workflow_state: 'Captured' })).toBe('clarify');
    expect(resolveLegGate(EMPTY, { workflow_state: 'Proposed' })).toBe('clarify');
  });

  it('never throws on a null/undefined workflow_state — reads as "no gate", same as resolveGatePhase', () => {
    expect(resolveLegGate(FAST_TRACK, {})).toBeNull();
    expect(resolveLegGate(FAST_TRACK, { workflow_state: null })).toBeNull();
    expect(resolveLegGate(FAST_TRACK, { workflow_state: undefined })).toBeNull();
  });
});
