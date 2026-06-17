import { describe, it, expect } from 'vitest';
import {
  TRUST_MATRIX,
  DEFAULT_TRUST_LEVEL,
  resolveTrustLevel,
  dialForbidsAllDelegation,
  type TrustLevel,
} from './trust-model.js';

describe('trust-model mirror', () => {
  it('mirrors the web TRUST_MATRIX shape + values (drift guard)', () => {
    // These MUST match web/src/features/agent-trust/lib/trustModel.ts. A diff here is a real drift.
    expect(TRUST_MATRIX.cautious.autoAdvances).toEqual([]);
    expect(TRUST_MATRIX.balanced.autoAdvances).toEqual(['reversible-rerun']);
    expect(TRUST_MATRIX.autonomous.autoAdvances).toEqual([
      'reversible-rerun',
      'forward-gate',
      'release',
      'verify',
    ]);
  });

  it('defaults to balanced (mirrors web DEFAULT_TRUST.level)', () => {
    expect(DEFAULT_TRUST_LEVEL).toBe('balanced');
  });

  describe('resolveTrustLevel', () => {
    it('resolves a known level', () => {
      expect(resolveTrustLevel({ level: 'cautious' })).toBe('cautious');
      expect(resolveTrustLevel({ level: 'balanced' })).toBe('balanced');
      expect(resolveTrustLevel({ level: 'autonomous' })).toBe('autonomous');
    });

    it('falls back to balanced on empty {}, null, undefined, or unknown level', () => {
      expect(resolveTrustLevel({})).toBe('balanced');
      expect(resolveTrustLevel(null)).toBe('balanced');
      expect(resolveTrustLevel(undefined)).toBe('balanced');
      expect(resolveTrustLevel({ level: 'banana' })).toBe('balanced');
      expect(resolveTrustLevel('garbage')).toBe('balanced');
    });
  });

  describe('dialForbidsAllDelegation (kill-switch)', () => {
    it('is TRUE only for cautious (autoAdvances === [])', () => {
      expect(dialForbidsAllDelegation('cautious')).toBe(true);
      expect(dialForbidsAllDelegation('balanced')).toBe(false);
      expect(dialForbidsAllDelegation('autonomous')).toBe(false);
    });

    it('agrees with the matrix for every level', () => {
      (['cautious', 'balanced', 'autonomous'] as TrustLevel[]).forEach((level) => {
        expect(dialForbidsAllDelegation(level)).toBe(TRUST_MATRIX[level].autoAdvances.length === 0);
      });
    });
  });
});
