import { describe, it, expect } from 'vitest';
import {
  classifyWorkerExit,
  exitClass,
  TICKET_TERMINAL_STATES,
  type ClassifyArgs,
} from './classify.js';

// Baseline args: clean exit, progressed, nothing awaiting — individual tests override one axis.
function args(overrides: Partial<ClassifyArgs> = {}): ClassifyArgs {
  return {
    row: { workflow_state: 'Built', awaiting_human_input: false, stale: false },
    nonArchivedChildCount: 0,
    exitCode: 0,
    progressed: true,
    timedOut: false,
    ...overrides,
  };
}

describe('classifyWorkerExit — the B-693 worker exit contract, in order', () => {
  it("1. awaiting_human_input=true (worker paused on a brief/exchange) ⇒ wait / 'clean-pause'", () => {
    const a = args({ row: { workflow_state: 'Built', awaiting_human_input: true, stale: false } });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'wait' });
    expect(exitClass(outcome, a)).toBe('clean-pause');
  });

  it.each(['Verified', 'Cancelled', 'Parked'])(
    "2. terminal ticket state %s ⇒ complete / 'terminal'",
    (state) => {
      const a = args({ row: { workflow_state: state, awaiting_human_input: false, stale: false } });
      const outcome = classifyWorkerExit(a);
      expect(outcome).toEqual({ action: 'complete' });
      expect(exitClass(outcome, a)).toBe('terminal');
    },
  );

  it('2b. the terminal check is an explicit allowlist CONSTANT — exactly the three terminal states', () => {
    expect(TICKET_TERMINAL_STATES).toEqual(['Verified', 'Cancelled', 'Parked']);
  });

  it('2c. the terminal check is exact membership, never string includes (a state merely CONTAINING a terminal name must not complete)', () => {
    for (const impostor of ['Unverified', 'Verified-ish', 'Parked lot', 'revising-Cancelled']) {
      const a = args({
        row: { workflow_state: impostor, awaiting_human_input: false, stale: false },
        exitCode: 1,
      });
      expect(classifyWorkerExit(a)).not.toEqual({ action: 'complete' });
    }
  });

  it("3. Decomposed + nonArchivedChildCount ≥ 1 + flag false ⇒ complete / 'split-umbrella' (NEVER park — the legitimate clean exit)", () => {
    const a = args({
      row: { workflow_state: 'Decomposed', awaiting_human_input: false, stale: false },
      nonArchivedChildCount: 3,
    });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'complete' });
    expect(exitClass(outcome, a)).toBe('split-umbrella');
  });

  it('3b. Decomposed with ZERO non-archived children is NOT a split-umbrella completion', () => {
    const a = args({
      row: { workflow_state: 'Decomposed', awaiting_human_input: false, stale: false },
      nonArchivedChildCount: 0,
      progressed: false,
    });
    expect(classifyWorkerExit(a)).not.toEqual({ action: 'complete' });
  });

  it("4. stale=true ⇒ park / 'stale' (terminal-only stale constraint — a stale ticket's conduction is parked)", () => {
    const a = args({ row: { workflow_state: 'Built', awaiting_human_input: false, stale: true } });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'park', reason: 'stale' });
    expect(exitClass(outcome, a)).toBe('stale');
  });

  it("5. non-zero exitCode, nothing else matched ⇒ park / 'dirty-exit'", () => {
    const a = args({ exitCode: 1 });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'park', reason: 'dirty-exit' });
    expect(exitClass(outcome, a)).toBe('dirty-exit');
  });

  it("5b. a NULL exitCode (reaped/unknown) is dirty, never clean", () => {
    const a = args({ exitCode: null });
    expect(classifyWorkerExit(a)).toEqual({ action: 'park', reason: 'dirty-exit' });
  });

  it("6. exitCode=0, flag still false, progressed=false ⇒ park / 'no-progress'", () => {
    const a = args({ progressed: false });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'park', reason: 'no-progress' });
    expect(exitClass(outcome, a)).toBe('no-progress');
  });

  it('order is the contract: a paused worker on a STALE ticket waits (branch 1 precedes branch 4)', () => {
    const a = args({ row: { workflow_state: 'Built', awaiting_human_input: true, stale: true } });
    expect(classifyWorkerExit(a)).toEqual({ action: 'wait' });
  });

  it('order is the contract: a terminal state completes even on a dirty exit code (branch 2 precedes branch 5)', () => {
    const a = args({
      row: { workflow_state: 'Verified', awaiting_human_input: false, stale: false },
      exitCode: 1,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'complete' });
  });

  it('fallthrough: a clean, progressed exit with the ball still agent-side ⇒ wait (the next pass re-fires)', () => {
    const a = args();
    expect(classifyWorkerExit(a)).toEqual({ action: 'wait' });
  });
});

// B-739. The deadline's job is to stop a STUCK worker, never to discard an outcome the ticket row
// already proves. That is why the branch sits at the dirty-exit position rather than the top: the
// placement IS the guarantee, so these tests pin the ordering, not just the happy case.
describe("the worker-timeout class (B-739) — 'this daemon ruled the launch overrun'", () => {
  it("5. an otherwise-dirty timed-out worker ⇒ park / 'worker-timeout', NOT 'dirty-exit'", () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: false },
      exitCode: 137,
      progressed: false,
      timedOut: true,
    });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'park', reason: 'worker-timeout' });
    // The distinct class is what keeps it out of B-713's retry ladder (guarded on 'dirty-exit').
    expect(exitClass(outcome, a)).toBe('worker-timeout');
  });

  it('1 still beats 5: a timed-out worker that had already filed a brief is a CLEAN PAUSE', () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: true, stale: false },
      exitCode: 137,
      timedOut: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'wait' });
    expect(exitClass(classifyWorkerExit(a), a)).toBe('clean-pause');
  });

  it('2 still beats 5: a timed-out worker that had already driven the ticket terminal COMPLETES', () => {
    const a = args({
      row: { workflow_state: 'Verified', awaiting_human_input: false, stale: false },
      exitCode: 137,
      timedOut: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'complete' });
  });

  it('3 still beats 5: a timed-out worker that produced a live split umbrella COMPLETES', () => {
    const a = args({
      row: { workflow_state: 'Decomposed', awaiting_human_input: false, stale: false },
      nonArchivedChildCount: 2,
      exitCode: 137,
      timedOut: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'complete' });
  });

  it("4 still beats 5: a stale ticket parks as 'stale', not 'worker-timeout'", () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: true },
      exitCode: 137,
      timedOut: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'park', reason: 'stale' });
  });

  it("a NON-timed-out non-zero exit is still 'dirty-exit' — the retry ladder is untouched", () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: false },
      exitCode: 1,
      progressed: false,
      timedOut: false,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'park', reason: 'dirty-exit' });
  });

  it('a timed-out worker with a CLEAN exit code still parks — the flag decides, not the code', () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: false },
      exitCode: 0,
      progressed: false,
      timedOut: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'park', reason: 'worker-timeout' });
  });
});
