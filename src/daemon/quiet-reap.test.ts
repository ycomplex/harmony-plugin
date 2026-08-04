import { describe, it, expect } from 'vitest';
import { renderQuietReapOutcome } from './quiet-reap.js';

describe('renderQuietReapOutcome (B-761 quiet reap-miss rendering)', () => {
  it('exit 0 — a live container really was reaped', () => {
    expect(renderQuietReapOutcome(0)).toBe('reaped a live container');
  });

  it('a nonzero exit — the routine "already gone" case reads calmly, not as an error', () => {
    expect(renderQuietReapOutcome(1)).toBe('reap: container already gone — ok');
  });

  it('a null exit code (spawn/signal ambiguity) also reads calmly, not as an error', () => {
    expect(renderQuietReapOutcome(null)).toBe('reap: container already gone — ok');
  });
});
