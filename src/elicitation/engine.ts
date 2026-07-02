// B-645 Phase 2: the pure core of the elicitation exchange engine (elicitation-first discovery,
// B-550 design verdict 5d33aba5/370c1c10/fbcdb1e0).
//
// An elicitation exchange interrogates the human's tacit intent out through rounds of questions
// BEFORE a gate drafts its artifact (or while a brief is under discussion). The substrate is
// `elicitation_exchanges` (harmony-web Phase-1 migration 20260702142754): one ACTIVE exchange per
// task, `rounds` an append-only jsonb array, `answers_submitted_at` / `force_quit_requested_at`
// consumable web→agent markers (the pending_resolution pattern).
//
// This module is deliberately pure — no I/O, no clock, no Supabase — so the round lints and the
// round-lifecycle arithmetic are unit-testable in isolation (mirrors src/conductor/poll-loop.ts).
// The I/O lives in src/tools/elicitation.ts; the trigger-agnostic behavioural contract gate skills
// follow is skills/harmony-shared/elicitation-engine.md.

/** How much a wrong answer steers the work (B-550 rule 3 — the stakes-split turn rule). */
export type QuestionStakes = 'low' | 'load-bearing';

/** 'validate' = confirm/correct an agent inference (needs a `statement`); 'open' = open text. */
export type QuestionKind = 'validate' | 'open';

export interface ElicitationQuestion {
  /** Round-unique id the answer keys on (e.g. 'q1'). */
  id: string;
  stakes: QuestionStakes;
  kind: QuestionKind;
  /** The agent's inference the human confirms or corrects. Required when kind='validate'. */
  statement?: string;
  /** The question text itself. */
  text: string;
  /** Optional "why I'm asking" expander (fbcdb1e0). */
  why?: string;
}

export interface ElicitationAnswer {
  /** confirm/correct answer a 'validate' question; answer/skip an 'open' one. */
  verb: 'confirm' | 'correct' | 'answer' | 'skip';
  text?: string;
}

/** One round of the exchange, as stored in `elicitation_exchanges.rounds` (append-only). */
export interface ElicitationRound {
  n: number;
  /** ONE plain-prose context line framing the round (fbcdb1e0 — never a wall of preamble). */
  context_line: string;
  questions: ElicitationQuestion[];
  /** Keyed by question id; written by the answering surface (web/terminal), never by the filer. */
  answers: Record<string, ElicitationAnswer>;
  filed_at?: string;
  answered_at?: string;
}

/** A round carries at most this many questions (fbcdb1e0: "at most ~5 question cards"). */
export const MAX_QUESTIONS_PER_ROUND = 5;

/**
 * Lint a round's questions before filing (B-550 rules 3 + 6). Returns the violations — an empty
 * array means the round may be filed. The load-bearing rules are the anti-rubber-stamp binding:
 *  - >5 questions      → interrogation fatigue; split across rounds instead.
 *  - load-bearing + kind='validate' → REJECTED. A load-bearing question must be kind='open'
 *    (open question FIRST, the agent's candidate withheld) so it can never render as a one-click
 *    confirm — rubber-stamping doesn't die, it moves; this lint is where it's stopped.
 *  - kind='validate' without a `statement` → there is nothing for the human to confirm/correct.
 */
export function validateRound(questions: ElicitationQuestion[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(questions) || questions.length === 0) {
    errors.push('a round needs at least one question');
    return errors;
  }
  if (questions.length > MAX_QUESTIONS_PER_ROUND) {
    errors.push(
      `a round carries at most ${MAX_QUESTIONS_PER_ROUND} questions (got ${questions.length}) — split the residual across rounds instead of interrogating in bulk`,
    );
  }
  const seen = new Set<string>();
  for (const q of questions) {
    const label = q.id?.trim() ? `question "${q.id}"` : 'a question';
    if (!q.id?.trim()) {
      errors.push('every question needs an id (the answer keys on it)');
    } else if (seen.has(q.id)) {
      errors.push(`duplicate question id "${q.id}" — answers key on the id, so ids must be round-unique`);
    } else {
      seen.add(q.id);
    }
    if (!q.text?.trim()) {
      errors.push(`${label} has no text`);
    }
    if (q.stakes === 'load-bearing' && q.kind === 'validate') {
      errors.push(
        `${label} is load-bearing but kind='validate' — load-bearing questions MUST be kind='open' (open question first, candidate withheld; a one-click confirm on a load-bearing residual is the rubber-stamp this engine exists to prevent)`,
      );
    }
    if (q.kind === 'validate' && !q.statement?.trim()) {
      errors.push(`${label} is kind='validate' but has no statement — there is nothing for the human to confirm or correct`);
    }
  }
  return errors;
}

/** The next round number: last round's n + 1 (rounds are append-only), or 1 on a fresh exchange. */
export function nextRoundNumber(rounds: ElicitationRound[]): number {
  return currentRoundNumber(rounds) + 1;
}

/** The current (= last filed) round's n, or 0 when no round has been filed yet. */
export function currentRoundNumber(rounds: ElicitationRound[]): number {
  if (!Array.isArray(rounds) || rounds.length === 0) return 0;
  const last = rounds[rounds.length - 1];
  // Defensive: a malformed last round falls back to the array length (still monotonic).
  return typeof last?.n === 'number' ? last.n : rounds.length;
}

/** Append a round immutably (the caller owns the write of the new array back to the row). */
export function appendRound(rounds: ElicitationRound[], round: ElicitationRound): ElicitationRound[] {
  return [...(Array.isArray(rounds) ? rounds : []), round];
}
