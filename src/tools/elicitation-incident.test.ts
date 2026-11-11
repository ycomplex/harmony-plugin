// B-1452: a conduction worker cannot answer (or conclude unanswered) the incident round its own leg
// raised; a seat or human session can. Every round on an incident exchange carries the marker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memorySupabase, type MemoryDb } from './__fixtures__/memory-supabase.js';
import { concludeElicitation, fileElicitationRound, submitElicitationAnswers, TRIGGER_OWNERS } from './elicitation.js';

const TASK = '22222222-2222-4222-8222-222222222222';
const releaseQ = { id: 'release', stakes: 'load-bearing', kind: 'open', text: 'Only a human can do this: rotate it.' };

function board(answers: Record<string, unknown> = {}, trigger = 'incident'): MemoryDb {
  return memorySupabase({
    tasks: [{ id: TASK, awaiting_human_input: true, awaiting_human_reason: 'elicitation-round', awaiting_human_ref: { incident: 'credential-exposure' } }],
    elicitation_exchanges: [
      {
        id: 'ex-inc',
        task_id: TASK,
        trigger,
        gate: 'building',
        status: 'active',
        rounds: [{ n: 1, context_line: 'Incident — credential exposure: x was exposed at y.', questions: [releaseQ], answers }],
        answers_submitted_at: null,
        force_quit_requested_at: null,
      },
    ],
  });
}

beforeEach(() => vi.stubEnv('HARMONY_CONDUCTION_ID', ''));
afterEach(() => vi.unstubAllEnvs());

describe('incident trigger', () => {
  it("is registered as an any-gate trigger", () => {
    expect(TRIGGER_OWNERS.incident).toBe('any-gate');
  });
});

describe('(4) a conduction worker cannot answer its incident round', () => {
  it('submit_elicitation_answers refuses with HARMONY_CONDUCTION_ID set, writing nothing', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'cond-7');
    const db = board();
    await expect(
      submitElicitationAnswers(db.client, 'p', { task_id: TASK, answers: { release: { verb: 'answer', text: 'resume' } } }),
    ).rejects.toThrow(/submit_elicitation_answers refused: conduction worker 'cond-7' cannot submit answers on incident exchange ex-inc.*Nothing was written/);
    expect(db.writes).toEqual([]);
    expect(db.tables.tasks[0].awaiting_human_input).toBe(true);
  });

  it('the same call from a non-worker session (seat, human) records the answer', async () => {
    const db = board();
    await submitElicitationAnswers(db.client, 'p', { task_id: TASK, answers: { release: { verb: 'answer', text: 'resume' } } });
    expect(db.tables.tasks[0].awaiting_human_input).toBe(false);
  });

  it('a worker may still answer an ordinary (non-incident) round', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'cond-7');
    const db = board({}, 'worker-question');
    await expect(
      submitElicitationAnswers(db.client, 'p', { task_id: TASK, answers: { release: { verb: 'answer', text: 'ok' } } }),
    ).resolves.toBeTruthy();
  });

  it('conclude_elicitation from a worker is refused while the latest round is unanswered', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'cond-7');
    const db = board();
    await expect(concludeElicitation(db.client, 'p', { exchange_id: 'ex-inc', outcome: 'converged' })).rejects.toThrow(
      /conclude_elicitation refused: .*conclude an unanswered round/,
    );
    expect(db.writes).toEqual([]);
  });

  it('conclude_elicitation from a worker is allowed once a human answered (the resume path)', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'cond-7');
    const db = board({ release: { verb: 'answer', text: 'resume' } });
    await concludeElicitation(db.client, 'p', { exchange_id: 'ex-inc', outcome: 'converged' });
    expect(db.tables.elicitation_exchanges[0].status).toBe('converged');
  });

  it('a worker may not answer through a prior_answers echo either', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'cond-7');
    const db = board();
    await expect(
      fileElicitationRound(db.client, 'p', {
        exchange_id: 'ex-inc',
        context_line: 'again',
        questions: [releaseQ as never],
        prior_answers: { release: { verb: 'answer', text: 'resume' } },
      }),
    ).rejects.toThrow(/file_elicitation_round refused/);
    expect(db.writes).toEqual([]);
  });
});

describe('a round filed on an incident exchange keeps the incident marker', () => {
  it('re-filing the release question (anything-else answer) carries awaiting_human_ref.incident', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'cond-7');
    const db = board({ release: { verb: 'answer', text: 'maybe' } });
    await fileElicitationRound(db.client, 'p', { exchange_id: 'ex-inc', context_line: 'again', questions: [releaseQ as never] });
    expect(db.tables.tasks[0].awaiting_human_ref).toEqual({
      kind: 'elicitation',
      exchange_id: 'ex-inc',
      round: 2,
      gate: 'building',
      incident: 'credential-exposure',
    });
  });

  it('a round on any other exchange carries no incident marker', async () => {
    const db = board({ release: { verb: 'answer', text: 'x' } }, 'worker-question');
    await fileElicitationRound(db.client, 'p', { exchange_id: 'ex-inc', context_line: 'again', questions: [releaseQ as never] });
    expect(db.tables.tasks[0].awaiting_human_ref).not.toHaveProperty('incident');
  });
});
