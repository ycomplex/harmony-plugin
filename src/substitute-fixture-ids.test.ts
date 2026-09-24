// B-1081 — unit coverage for the fixture-id substitution the CI/worker run performs before
// `claude plugin eval` (evals/clarify-replay/scripts/substitute-fixture-ids.mjs). The pure
// function is what CI relies on; the directory walker is a thin loop over it.

import { describe, it, expect } from 'vitest';
import {
  substitutePrompt,
  PLACEHOLDER,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs helper module, deliberately dependency-free and untyped
} from '../evals/clarify-replay/scripts/substitute-fixture-ids.mjs';

describe('substitutePrompt', () => {
  it('replaces every placeholder with <KEY>-<number> for a B-<n> case', () => {
    const prompt = `Run clarify against ${PLACEHOLDER}. Do not fall back from ${PLACEHOLDER}.`;
    expect(substitutePrompt(prompt, 'B-293')).toBe('Run clarify against FX-293. Do not fall back from FX-293.');
  });

  it('honours a custom fixture project key', () => {
    expect(substitutePrompt(`ticket ${PLACEHOLDER}`, 'B-818', 'QA')).toBe('ticket QA-818');
  });

  it('is idempotent — an already-substituted prompt is left alone (null)', () => {
    expect(substitutePrompt('ticket FX-293', 'B-293')).toBeNull();
  });

  it('skips the calibration controls and anything not named <KEY>-<n>', () => {
    expect(substitutePrompt(`x ${PLACEHOLDER}`, 'ctrl-positive-known-good')).toBeNull();
    expect(substitutePrompt(`x ${PLACEHOLDER}`, 'ctrl-negative-boundary-flip')).toBeNull();
    expect(substitutePrompt(`x ${PLACEHOLDER}`, 'notes')).toBeNull();
  });
});
