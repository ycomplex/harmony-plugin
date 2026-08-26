import { describe, it, expect } from 'vitest';
import { renderQuietReapOutcome, quietLogLine } from './quiet-reap.js';

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

// B-740 REOPEN FIX: `quietLogLine` is the decision src/bin/daemon.ts's runCommand closure delegates
// to on every `close` event — pinned here (rather than only inline in daemon.ts, which cannot be
// imported directly by a test) so the exact regression this ticket fixes has EXECUTED coverage: a
// preflight-shaped quiet call (no `quietRender`) must never render as a reap outcome, no matter the
// exit code.
describe('quietLogLine (B-740 regression: a preflight-shaped quiet call renders NOTHING)', () => {
  it('quiet:true with NO quietRender ⇒ null (never "reaped a live worker") — the exact preflight.ts shape, exit 0', () => {
    expect(quietLogLine(0, { quiet: true })).toBeNull();
  });

  it('quiet:true with NO quietRender ⇒ null regardless of exit code (3, 1, null all render nothing)', () => {
    expect(quietLogLine(3, { quiet: true })).toBeNull();
    expect(quietLogLine(1, { quiet: true })).toBeNull();
    expect(quietLogLine(null, { quiet: true })).toBeNull();
  });

  it('quiet:true WITH quietRender ⇒ the renderer\'s line (today\'s ONE caller: handleWonTakeover, via renderQuietReapOutcome)', () => {
    expect(quietLogLine(0, { quiet: true, quietRender: renderQuietReapOutcome })).toBe(
      'reaped a live worker',
    );
    expect(quietLogLine(3, { quiet: true, quietRender: renderQuietReapOutcome })).toBe(
      'reap: worker already gone — ok',
    );
  });

  it('quiet:false (or opts absent) ⇒ null — that path streams raw stdout/stderr instead, never a rendered line', () => {
    expect(quietLogLine(0, { quiet: false, quietRender: renderQuietReapOutcome })).toBeNull();
    expect(quietLogLine(0)).toBeNull();
    expect(quietLogLine(0, undefined)).toBeNull();
  });

  it('quietRender supplied but quiet NOT set ⇒ null — quiet is the gate, quietRender alone is inert', () => {
    expect(quietLogLine(0, { quietRender: renderQuietReapOutcome })).toBeNull();
  });
});
