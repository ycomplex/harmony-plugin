import { describe, it, expect } from 'vitest';
import {
  validateRound,
  nextRoundNumber,
  currentRoundNumber,
  appendRound,
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
