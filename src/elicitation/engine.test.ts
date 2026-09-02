import { describe, it, expect } from 'vitest';
import {
  validateRound,
  warnRound,
  nextRoundNumber,
  currentRoundNumber,
  appendRound,
  echoPriorAnswers,
  MAX_QUESTIONS_PER_ROUND,
  type ElicitationQuestion,
  type ElicitationRound,
} from './engine.js';

const openQ = (over: Partial<ElicitationQuestion> = {}): ElicitationQuestion => ({
  id: 'q1', stakes: 'low', kind: 'open', text: 'What should happen on submit?', ...over,
});

const validateQ = (over: Partial<ElicitationQuestion> = {}): ElicitationQuestion => ({
  id: 'q1', stakes: 'low', kind: 'validate',
  statement: 'Submitting saves a draft, not a publish.', text: 'Is that right?', ...over,
});

describe('validateRound (the anti-rubber-stamp lints)', () => {
  it('passes 5 valid questions (the max)', () => {
    const questions = Array.from({ length: MAX_QUESTIONS_PER_ROUND }, (_, i) =>
      i % 2 === 0 ? openQ({ id: `q${i + 1}` }) : validateQ({ id: `q${i + 1}` }),
    );
    expect(validateRound(questions)).toEqual([]);
  });

  it('rejects 6 questions (> the 5-question round cap)', () => {
    const questions = Array.from({ length: 6 }, (_, i) => openQ({ id: `q${i + 1}` }));
    const errors = validateRound(questions);
    expect(errors.join(' ')).toMatch(/at most 5 questions/i);
  });

  it("rejects a load-bearing question with kind='validate' — load-bearing MUST be open text", () => {
    const errors = validateRound([validateQ({ stakes: 'load-bearing' })]);
    expect(errors.join(' ')).toMatch(/load-bearing.*kind='open'/i);
  });

  it("passes a load-bearing question with kind='open'", () => {
    expect(validateRound([openQ({ stakes: 'load-bearing' })])).toEqual([]);
  });

  it("rejects kind='validate' without a statement — nothing to confirm or correct", () => {
    const errors = validateRound([validateQ({ statement: undefined })]);
    expect(errors.join(' ')).toMatch(/no statement/i);
  });

  it("rejects a whitespace-only statement on kind='validate'", () => {
    const errors = validateRound([validateQ({ statement: '   ' })]);
    expect(errors.join(' ')).toMatch(/no statement/i);
  });

  it('lists EVERY violation, not just the first', () => {
    const errors = validateRound([
      ...Array.from({ length: 6 }, (_, i) => openQ({ id: `q${i + 1}` })),
      validateQ({ id: 'q7', stakes: 'load-bearing' }),
    ]);
    // 7 questions: over-cap + load-bearing-validate — both reported.
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.join(' ')).toMatch(/at most 5/i);
    expect(errors.join(' ')).toMatch(/load-bearing/i);
  });

  it('rejects an empty round', () => {
    expect(validateRound([]).join(' ')).toMatch(/at least one question/i);
  });

  it('rejects a duplicate question id (answers key on the id)', () => {
    const errors = validateRound([openQ({ id: 'q1' }), openQ({ id: 'q1' })]);
    expect(errors.join(' ')).toMatch(/duplicate question id/i);
  });

  it('rejects a question with no id or no text', () => {
    const errors = validateRound([openQ({ id: '' }), openQ({ id: 'q2', text: '' })]);
    expect(errors.join(' ')).toMatch(/needs an id/i);
    expect(errors.join(' ')).toMatch(/no text/i);
  });
});

describe('warnRound (B-785 — non-blocking why-vs-text enumerated-options lint)', () => {
  it('returns no warnings for a round with no questions carrying why', () => {
    expect(warnRound([openQ(), openQ({ id: 'q2' })])).toEqual([]);
  });

  it('returns no warnings when why has no enumerated-options pattern', () => {
    const q = openQ({ why: 'This affects the billing cycle, so getting it right matters.' });
    expect(warnRound([q])).toEqual([]);
  });

  it("returns no warnings when a SINGLE parenthetical in why is not a list (avoids false positives)", () => {
    const q = openQ({ why: 'This is the (only) viable driver we found.' });
    expect(warnRound([q])).toEqual([]);
  });

  it("skips a kind='validate' question even if its why enumerates options", () => {
    const q = validateQ({ why: 'Candidates: (1) A (2) B (3) C.' });
    expect(warnRound([q])).toEqual([]);
  });

  it("flags an OPEN question whose why enumerates options but text does not", () => {
    const q = openQ({
      text: 'How would you like to proceed?',
      why: 'Concrete redirect options: (1) retry now (2) retry later (3) drop it.',
    });
    const warnings = warnRound([q]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/why field looks like it enumerates options/i);
    expect(warnings[0]).toMatch(/question "q1"/);
  });

  it('does NOT flag when the options are embedded directly in text itself', () => {
    const q = openQ({
      id: 'q2',
      text: 'How would you like to proceed — (1) retry now, (2) retry later, or (3) drop it?',
      why: 'Concrete redirect options: (1) retry now (2) retry later (3) drop it.',
    });
    expect(warnRound([q])).toEqual([]);
  });

  it('flags numbered-list and lettered-list why patterns too, not just "(n)"', () => {
    const numbered = openQ({ id: 'qn', text: 'What next?', why: '1. Ship it. 2. Hold it.' });
    const lettered = openQ({ id: 'ql', text: 'What next?', why: 'a) Ship it. b) Hold it.' });
    expect(warnRound([numbered])[0]).toMatch(/question "qn"/);
    expect(warnRound([lettered])[0]).toMatch(/question "ql"/);
  });

  it('lists one warning per flagged question, skipping clean ones', () => {
    const bad = openQ({ id: 'q1', text: 'Proceed how?', why: 'Options: (1) X (2) Y.' });
    const clean = openQ({ id: 'q2', text: 'What is the driver here?' });
    const warnings = warnRound([bad, clean]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/question "q1"/);
  });

  it('never throws on malformed input — returns an empty array', () => {
    expect(warnRound(undefined as unknown as ElicitationQuestion[])).toEqual([]);
    expect(warnRound(null as unknown as ElicitationQuestion[])).toEqual([]);
  });

  it('sanity check: approximates B-757\'s actual incident (exchange 64efcbe3)', () => {
    // Rounds 1 and 3: why carried the concrete redirect options, text ended on a bare "how would you
    // like to proceed" with no options at all — exactly the burial this lint exists to catch.
    const round1Q = openQ({
      id: 'q1',
      text: 'The prerequisite PR is still open — how would you like to proceed?',
      why: 'Concrete redirect options: (1) wait for the prerequisite to merge, (2) proceed anyway and flag the risk, (3) split this ticket to unblock the independent part.',
    });
    const round3Q = openQ({
      id: 'q1',
      text: 'Given where things stand now, how would you like to proceed?',
      why: 'Concrete redirect options: (1) redrive once more, (2) hand off to a human, (3) close as blocked.',
    });
    // Round 2: the worker embedded the options directly in text — the desired shape — so it must NOT
    // be flagged even though its why also happens to restate them.
    const round2Q = openQ({
      id: 'q1',
      text: 'How would you like to proceed — (1) wait for the prerequisite, (2) proceed and flag the risk, or (3) split the ticket?',
      why: 'Concrete redirect options: (1) wait for the prerequisite, (2) proceed and flag the risk, (3) split the ticket.',
    });

    expect(warnRound([round1Q])).toHaveLength(1);
    expect(warnRound([round3Q])).toHaveLength(1);
    expect(warnRound([round2Q])).toEqual([]);
  });
});

describe('round lifecycle helpers', () => {
  const round = (n: number): ElicitationRound => ({
    n, context_line: 'ctx', questions: [openQ()], answers: {},
  });

  it('nextRoundNumber is 1 on a fresh exchange and last+1 thereafter', () => {
    expect(nextRoundNumber([])).toBe(1);
    expect(nextRoundNumber([round(1)])).toBe(2);
    expect(nextRoundNumber([round(1), round(2), round(3)])).toBe(4);
  });

  it('currentRoundNumber is 0 when no rounds are filed', () => {
    expect(currentRoundNumber([])).toBe(0);
    expect(currentRoundNumber([round(1), round(2)])).toBe(2);
  });

  it('falls back to the array length when the last round is malformed (still monotonic)', () => {
    const malformed = [round(1), { context_line: 'x' } as unknown as ElicitationRound];
    expect(currentRoundNumber(malformed)).toBe(2);
    expect(nextRoundNumber(malformed)).toBe(3);
  });

  it('appendRound is immutable — the input array is untouched', () => {
    const rounds = [round(1)];
    const appended = appendRound(rounds, round(2));
    expect(appended).toHaveLength(2);
    expect(rounds).toHaveLength(1);
  });
});

describe('echoPriorAnswers (B-462 — terminal answering echo)', () => {
  const round = (n: number, questions: ElicitationQuestion[], answers: ElicitationRound['answers'] = {}): ElicitationRound => ({
    n, context_line: 'ctx', questions, answers,
  });
  const validateQ = (id: string): ElicitationQuestion => ({
    id, stakes: 'low', kind: 'validate', statement: 'It is per-user.', text: 'Correct?',
  });

  it('merges echoed answers into the LAST round, stamped via:terminal + answered_at', () => {
    const rounds = [round(1, [openQ({ id: 'old' })]), round(2, [validateQ('q1'), openQ({ id: 'q2' })])];
    const { rounds: out, errors } = echoPriorAnswers(rounds, {
      q1: { verb: 'confirm' },
      q2: { verb: 'answer', text: 'Speed of triage.' },
    }, '2026-07-02T16:00:00Z');
    expect(errors).toEqual([]);
    expect(out![1].answers).toEqual({
      q1: { verb: 'confirm', via: 'terminal' },
      q2: { verb: 'answer', text: 'Speed of triage.', via: 'terminal' },
    });
    expect(out![1].answered_at).toBe('2026-07-02T16:00:00Z');
    // Immutable: the input rounds are untouched.
    expect(rounds[1].answers).toEqual({});
  });

  it('a partial echo is legitimate — unanswered questions stay unanswered', () => {
    const rounds = [round(1, [validateQ('q1'), openQ({ id: 'q2' })])];
    const { rounds: out, errors } = echoPriorAnswers(rounds, { q1: { verb: 'confirm' } });
    expect(errors).toEqual([]);
    expect(Object.keys(out![0].answers)).toEqual(['q1']);
  });

  it('rejects an echo when no round has been filed', () => {
    const { rounds: out, errors } = echoPriorAnswers([], { q1: { verb: 'confirm' } });
    expect(out).toBeNull();
    expect(errors[0]).toMatch(/no round has been filed/i);
  });

  it('rejects an empty prior_answers object', () => {
    const { errors } = echoPriorAnswers([round(1, [openQ()])], {});
    expect(errors[0]).toMatch(/empty/i);
  });

  it('rejects a question id not in the LAST round (earlier rounds are history)', () => {
    const rounds = [round(1, [openQ({ id: 'old' })]), round(2, [openQ({ id: 'q2' })])];
    const { errors } = echoPriorAnswers(rounds, { old: { verb: 'answer', text: 'late' } });
    expect(errors[0]).toMatch(/not in the last filed round/i);
  });

  it('NEVER overwrites a submitted answer — the human\'s own words win', () => {
    const rounds = [round(1, [openQ({ id: 'q1' })], { q1: { verb: 'answer', text: 'web answer' } })];
    const { errors } = echoPriorAnswers(rounds, { q1: { verb: 'answer', text: 'echo attempt' } });
    expect(errors[0]).toMatch(/never overwritten/i);
  });

  it('enforces verb/kind fit and text presence', () => {
    const rounds = [round(1, [validateQ('q1'), openQ({ id: 'q2' })])];
    expect(echoPriorAnswers(rounds, { q1: { verb: 'answer', text: 'x' } }).errors[0]).toMatch(/confirm, correct, or skip/);
    expect(echoPriorAnswers(rounds, { q2: { verb: 'confirm' } }).errors[0]).toMatch(/answer or skip/);
    expect(echoPriorAnswers(rounds, { q2: { verb: 'answer' } }).errors[0]).toMatch(/no text/);
  });

  it('preserves an existing answered_at (first stamp wins)', () => {
    const r = { ...round(1, [validateQ('q1'), openQ({ id: 'q2' })], { q2: { verb: 'answer', text: 'web' } }), answered_at: '2026-07-01T00:00:00Z' };
    const { rounds: out } = echoPriorAnswers([r], { q1: { verb: 'confirm' } }, '2026-07-02T00:00:00Z');
    expect(out![0].answered_at).toBe('2026-07-01T00:00:00Z');
  });
});
