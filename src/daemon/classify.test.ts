import { describe, it, expect } from 'vitest';
import {
  classifyWorkerExit,
  classifyCleanRowShape,
  isCleanRowShape,
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
    operatorReaped: false,
    repoProgressed: false,
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

  it("6. exitCode=0, flag still false, progressed=false, repoProgressed=false ⇒ park / 'no-progress'", () => {
    const a = args({ progressed: false, repoProgressed: false });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'park', reason: 'no-progress' });
    expect(exitClass(outcome, a)).toBe('no-progress');
  });

  // B-792: the clean-exit contract's distinguishable park reason — repo work landed (a commit/
  // push/PR head moved) but no state-advancing board write happened yet.
  it("6b. B-792: exitCode=0, flag false, progressed=false, repoProgressed=true ⇒ park / 'repo-active-board-silent' (NOT 'no-progress')", () => {
    const a = args({ progressed: false, repoProgressed: true });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'park', reason: 'repo-active-board-silent' });
    expect(exitClass(outcome, a)).toBe('repo-active-board-silent');
  });

  it('B-792: repoProgressed is irrelevant once progressed=true — still a plain wait, never a park', () => {
    const a = args({ progressed: true, repoProgressed: true });
    expect(classifyWorkerExit(a)).toEqual({ action: 'wait' });
  });

  it('B-792: repoProgressed alone does not change branch ORDER — a terminal state still completes (branch 2 precedes branch 7)', () => {
    const a = args({
      row: { workflow_state: 'Verified', awaiting_human_input: false, stale: false },
      progressed: false,
      repoProgressed: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'complete' });
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

  // B-792: the WIDENED `progressed` formula (active_brief_iteration / knowledge_reference_count /
  // a consumed marker) is computed by the SCHEDULER (settleTrackedLaunch, scheduler.test.ts owns
  // that coverage) — classify.ts only ever sees the already-computed boolean. These pin classify.ts's
  // OWN half of the contract: once the scheduler has decided `progressed: true` off any ONE of those
  // board signals alone, classify.ts must resolve 'wait', never a park — regardless of repoProgressed.
  it.each([
    ['active_brief_iteration changed alone', false],
    ['knowledge_reference_count changed alone', false],
    ['a consumed marker (pending_resolution/active_exchange) alone', true],
  ])('B-792: %s ⇒ progressed=true reaches classify.ts as a plain wait, never a park', (_label, repoProgressed) => {
    const a = args({ progressed: true, repoProgressed });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'wait' });
  });

  // B-745 AC2b: the release-approval pause (B-732) has TWO clearing paths now — a founder GitHub
  // approval landing (mechanism 2) or the re-composed release-decision brief being accepted
  // (mechanism 1) — plus the pre-existing release-decision-pending / verification-ack-pending
  // gates. Whichever mechanism cleared awaiting_human_input, the ROW this module reads afterward is
  // the same shape: Built, not awaiting, not stale. This pins that this exact row — independent of
  // WHICH tool did the clearing — resumes the conduction (the 'wait' outcome at this fallthrough
  // branch IS the daemon's wake signal: this file's own header names it "the next pass's wake
  // detection re-fires") rather than getting the ticket wrongly stuck in 'park' or falsely
  // 'complete'.
  it('B-745 AC2b: Built + awaiting_human_input=false + stale=false + clean progressed exit resumes — never park, never complete, regardless of what cleared the flag', () => {
    const a = args({ row: { workflow_state: 'Built', awaiting_human_input: false, stale: false } });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'wait' });
    expect(outcome.action).not.toBe('park');
    expect(outcome.action).not.toBe('complete');
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

// B-740. The early-reap lever: an operator (web "Reap now" or the request_conduction_reap MCP tool)
// requested a reap of a hung leg, and this daemon's own reap-escalation actually freed it. Same
// structural position as the worker-timeout branch (5) — deliberately BEFORE dirty-exit — so it too
// bypasses B-713's retry ladder by construction.
describe("the operator-reap class (B-740) — 'an operator's early-reap request actually freed the launch'", () => {
  it("5b. an otherwise-dirty operator-reaped worker ⇒ park / 'operator-reap', NOT 'dirty-exit'", () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: false },
      exitCode: 137,
      progressed: false,
      operatorReaped: true,
    });
    const outcome = classifyWorkerExit(a);
    expect(outcome).toEqual({ action: 'park', reason: 'operator-reap' });
    // The distinct class is what keeps it out of B-713's retry ladder (guarded on 'dirty-exit').
    expect(exitClass(outcome, a)).toBe('operator-reap');
  });

  it('1 still beats 5b: an operator-reaped worker that had already filed a brief is a CLEAN PAUSE', () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: true, stale: false },
      exitCode: 137,
      operatorReaped: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'wait' });
    expect(exitClass(classifyWorkerExit(a), a)).toBe('clean-pause');
  });

  it('2 still beats 5b: an operator-reaped worker that had already driven the ticket terminal COMPLETES', () => {
    const a = args({
      row: { workflow_state: 'Verified', awaiting_human_input: false, stale: false },
      exitCode: 137,
      operatorReaped: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'complete' });
  });

  it("4 still beats 5b: a stale ticket parks as 'stale', not 'operator-reap'", () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: true },
      exitCode: 137,
      operatorReaped: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'park', reason: 'stale' });
  });

  it('5 (worker-timeout) and 5b (operator-reap) can never collide in practice, but 5 still wins if BOTH flags are somehow true — worker-timeout is checked first', () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: false },
      exitCode: 137,
      timedOut: true,
      operatorReaped: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'park', reason: 'worker-timeout' });
  });

  it("a non-operator-reaped non-zero exit is still 'dirty-exit' — the retry ladder is untouched", () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: false },
      exitCode: 1,
      progressed: false,
      operatorReaped: false,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'park', reason: 'dirty-exit' });
  });

  it('an operator-reaped worker with a CLEAN exit code still parks — the flag decides, not the code', () => {
    const a = args({
      row: { workflow_state: 'Planned', awaiting_human_input: false, stale: false },
      exitCode: 0,
      progressed: false,
      operatorReaped: true,
    });
    expect(classifyWorkerExit(a)).toEqual({ action: 'park', reason: 'operator-reap' });
  });
});

// B-870. The clean row shapes (branches 1-3) are now ONE exported predicate, shared with the
// interactive Stop gate. These pin the predicate DIRECTLY — its three true shapes, everything that
// is not one of them, and the fact that pulling it out changed neither behaviour nor branch order.
describe('isCleanRowShape / classifyCleanRowShape (B-870) — the shared clean-row predicate', () => {
  it("1. awaiting_human_input=true ⇒ 'clean-pause' (whatever the state, including no state at all)", () => {
    for (const state of ['Built', 'Planned', 'Decomposed', null]) {
      expect(classifyCleanRowShape({ workflow_state: state, awaiting_human_input: true }, 0)).toBe(
        'clean-pause',
      );
      expect(isCleanRowShape({ workflow_state: state, awaiting_human_input: true }, 0)).toBe(true);
    }
  });

  it.each(['Verified', 'Cancelled', 'Parked'])("2. terminal state %s ⇒ 'terminal'", (state) => {
    expect(classifyCleanRowShape({ workflow_state: state, awaiting_human_input: false }, 0)).toBe(
      'terminal',
    );
  });

  it('2b. exact allowlist membership — a state merely CONTAINING a terminal name is not clean', () => {
    for (const impostor of ['Unverified', 'Verified-ish', 'Parked lot', 'revising-Cancelled']) {
      expect(
        classifyCleanRowShape({ workflow_state: impostor, awaiting_human_input: false }, 0),
      ).toBeNull();
    }
  });

  it("3. Decomposed + ≥1 non-archived child + flag false ⇒ 'split-umbrella'", () => {
    expect(
      classifyCleanRowShape({ workflow_state: 'Decomposed', awaiting_human_input: false }, 3),
    ).toBe('split-umbrella');
  });

  it('3b. Decomposed with ZERO non-archived children is NOT clean (the umbrella has nothing carrying it)', () => {
    expect(
      classifyCleanRowShape({ workflow_state: 'Decomposed', awaiting_human_input: false }, 0),
    ).toBeNull();
    expect(isCleanRowShape({ workflow_state: 'Decomposed', awaiting_human_input: false }, 0)).toBe(
      false,
    );
  });

  it('an ordinary mid-flight row (Built, flag down) is NOT clean — this is the shape the stop gate exists to catch', () => {
    expect(classifyCleanRowShape({ workflow_state: 'Built', awaiting_human_input: false }, 0)).toBeNull();
    expect(isCleanRowShape({ workflow_state: 'Built', awaiting_human_input: false }, 0)).toBe(false);
  });

  it('a MISSING awaiting flag (undefined/null) is not the same as false — it is still not clean', () => {
    expect(classifyCleanRowShape({ workflow_state: 'Built' }, 0)).toBeNull();
    expect(classifyCleanRowShape({ workflow_state: 'Built', awaiting_human_input: null }, 0)).toBeNull();
  });

  it('branch ORDER survives the extraction: awaiting=true on a Decomposed umbrella is a clean-pause, never a split-umbrella', () => {
    expect(
      classifyCleanRowShape({ workflow_state: 'Decomposed', awaiting_human_input: true }, 5),
    ).toBe('clean-pause');
  });

  it('branch ORDER survives the extraction: awaiting=true on a Verified ticket is a clean-pause, never terminal', () => {
    expect(
      classifyCleanRowShape({ workflow_state: 'Verified', awaiting_human_input: true }, 0),
    ).toBe('clean-pause');
  });

  it('the split-umbrella branch requires the flag to be exactly false — branch 3 is order-dependent on branch 1', () => {
    // Not a boolean at all: neither branch 1 (=== true) nor branch 3 (=== false) fires.
    expect(classifyCleanRowShape({ workflow_state: 'Decomposed' }, 4)).toBeNull();
  });

  it("classifyWorkerExit still CALLS the predicate — its clean kinds map to the same actions and exitClass labels as before", () => {
    const cases: Array<[ClassifyArgs, 'wait' | 'complete', string]> = [
      [args({ row: { workflow_state: 'Built', awaiting_human_input: true, stale: false } }), 'wait', 'clean-pause'],
      [args({ row: { workflow_state: 'Verified', awaiting_human_input: false, stale: false } }), 'complete', 'terminal'],
      [
        args({
          row: { workflow_state: 'Decomposed', awaiting_human_input: false, stale: false },
          nonArchivedChildCount: 2,
        }),
        'complete',
        'split-umbrella',
      ],
    ];
    for (const [a, action, cls] of cases) {
      const outcome = classifyWorkerExit(a);
      expect(outcome.action).toBe(action);
      expect(exitClass(outcome, a)).toBe(cls);
      expect(isCleanRowShape(a.row, a.nonArchivedChildCount)).toBe(true);
    }
  });
});
