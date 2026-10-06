// B-1073 — unit coverage for resolveLegGate: the fast-track leg-gate routing wrapper.

import { describe, it, expect } from 'vitest';
import { resolveLegGate, isFastTrackBuildLeg, evaluateFastTrackAdmission } from './leg-gate.js';
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

describe('isFastTrackBuildLeg (B-1073 post-review wiring)', () => {
  it('true for fast-track + Captured/Proposed — the exact condition resolveLegGate special-cases', () => {
    expect(isFastTrackBuildLeg(FAST_TRACK, { workflow_state: 'Captured' })).toBe(true);
    expect(isFastTrackBuildLeg(FAST_TRACK, { workflow_state: 'Proposed' })).toBe(true);
  });

  it('false for fast-track at any other state', () => {
    expect(isFastTrackBuildLeg(FAST_TRACK, { workflow_state: 'Planned' })).toBe(false);
    expect(isFastTrackBuildLeg(FAST_TRACK, { workflow_state: 'Built' })).toBe(false);
  });

  it('false for a non-fast-track run, even at Captured/Proposed', () => {
    expect(isFastTrackBuildLeg(NOT_FAST_TRACK, { workflow_state: 'Captured' })).toBe(false);
    expect(isFastTrackBuildLeg(EMPTY, { workflow_state: 'Proposed' })).toBe(false);
  });
});

describe('evaluateFastTrackAdmission (B-1073 post-review wiring)', () => {
  const CLEAN_SUMMARY = 'Fix the flaky retry timer in the poller.';

  it('admissible with zero declared repos — the feature-detect default', () => {
    const { admissible, report } = evaluateFastTrackAdmission(CLEAN_SUMMARY, []);
    expect(admissible).toBe(true);
    expect(report.items.find((i) => i.item === 'multi_repo')!.value).toContain('repos: 0');
  });

  it('admissible with exactly one declared repo', () => {
    const { admissible } = evaluateFastTrackAdmission(CLEAN_SUMMARY, ['ycomplex/harmony-plugin']);
    expect(admissible).toBe(true);
  });

  it('inadmissible when the deployment declares more than one repo (the conservative pre-build floor)', () => {
    const { admissible, report } = evaluateFastTrackAdmission(CLEAN_SUMMARY, [
      'ycomplex/harmony-web',
      'ycomplex/harmony-plugin',
    ]);
    expect(admissible).toBe(false);
    expect(report.items.find((i) => i.item === 'multi_repo')!.verdict).toBe('fail');
  });

  it('inadmissible when the summary is not single-sentence-statable, even with one declared repo', () => {
    const { admissible } = evaluateFastTrackAdmission(
      'Fix the timer. Also touch up the retry logic while we are in there.',
      ['ycomplex/harmony-plugin'],
    );
    expect(admissible).toBe(false);
  });
});
