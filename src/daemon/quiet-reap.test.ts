import { describe, it, expect } from 'vitest';
import { renderQuietReapOutcome } from './quiet-reap.js';

describe('renderQuietReapOutcome (B-761 quiet reap-miss rendering)', () => {
  it('exit 0 — a live worker really was reaped', () => {
    expect(renderQuietReapOutcome(0)).toBe('reaped a live worker');
  });

  it('exit 3 — the routine "already gone" miss reads calmly, not as an error', () => {
    expect(renderQuietReapOutcome(3)).toBe('reap: worker already gone — ok');
  });

  // B-761 reopen fix: exit 3 is the ONLY routine-miss code. Any OTHER nonzero exit is a genuine,
  // unexpected reap failure (the exact inversion bug this reopen fixes — the old renderer collapsed
  // BOTH into the same calm "already gone" line) and must render distinctly so it doesn't get
  // mistaken for the routine case.
  it('some OTHER nonzero exit (e.g. 1) is NOT the routine miss — it renders as an unexpected, investigatable outcome', () => {
    expect(renderQuietReapOutcome(1)).toBe('reap: unexpected exit code 1 — investigate');
  });

  it('a null exit code (spawn/signal ambiguity) is also treated as unexpected, not the routine miss', () => {
    expect(renderQuietReapOutcome(null)).toBe('reap: unexpected exit code null — investigate');
  });
});
