import { describe, it, expect, vi } from 'vitest';
import {
  startElicitation,
  fileElicitationRound,
  getElicitation,
  concludeElicitation,
  fetchActiveExchange,
} from './elicitation.js';

// Pass-through: the handlers delegate id resolution to resolveTaskId (like the sibling brief tools);
// the mock returns the input verbatim so the call-order assertions below stay valid for any id shape.
vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_client: unknown, _projectId: string, input: string) => input),
}));

import { resolveTaskId } from './resolve-task-id.js';
const mockResolveTaskId = vi.mocked(resolveTaskId);

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

// A chainable supabase mock whose terminal methods (single/maybeSingle) and direct `await` pop a
// queued response in call order (mirrors briefs.test.ts makeClient). `then` makes the builder
// awaitable for the trailing tasks-update; `from` is recorded per-table for the
// "wrote-nothing-else" assertions.
function makeClient(responses: Array<{ data: unknown; error?: unknown }>) {
  let i = 0;
  const next = () => responses[i++] ?? { data: null, error: null };
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'eq', 'order', 'limit']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => next());
  chain.single = vi.fn(async () => next());
  chain.then = (resolve: (v: unknown) => unknown) => resolve(next());
  return chain;
}

const exchangeRow = {
  id: 'ex-1', task_id: 'task-1', trigger: 'pre-draft-clarify', gate: 'clarifying', brief_id: null,
  status: 'active', rounds: [], answers_submitted_at: null, force_quit_requested_at: null,
  created_by: USER_ID, created_at: '2026-07-02T00:00:00Z', updated_at: '2026-07-02T00:00:00Z',
};

const openQ = (id = 'q1') => ({ id, stakes: 'low' as const, kind: 'open' as const, text: 'What drives this?' });

describe('startElicitation', () => {
  it('is idempotent-on-active: returns the existing active exchange without inserting', async () => {
    // responses: [active lookup → found]
    const client = makeClient([{ data: exchangeRow }]);
    const result = await startElicitation(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', trigger: 'pre-draft-clarify',
    });
    expect(result).toEqual(exchangeRow);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('inserts a new exchange when no active one exists', async () => {
    // responses: [active lookup → none] -> [insert row]
    const client = makeClient([{ data: null }, { data: exchangeRow }]);
    const result = await startElicitation(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', trigger: 'pre-draft-clarify', gate: 'clarifying',
    });
    expect(client.insert).toHaveBeenCalledWith({
      task_id: 'task-1', trigger: 'pre-draft-clarify', gate: 'clarifying', brief_id: null, created_by: USER_ID,
    });
    expect(result).toEqual(exchangeRow);
  });

  it('passes brief_id through for a discuss exchange', async () => {
    const client = makeClient([{ data: null }, { data: { ...exchangeRow, trigger: 'discuss', brief_id: 'brief-1' } }]);
    await startElicitation(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', trigger: 'discuss', brief_id: 'brief-1',
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'discuss', brief_id: 'brief-1' }));
  });

  it('rejects an unknown trigger', async () => {
    const client = makeClient([]);
    await expect(
      startElicitation(client, PROJECT_ID, USER_ID, { task_id: 'task-1', trigger: 'vibes' }),
    ).rejects.toThrow(/trigger must be one of/i);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('resolves a visual ID via resolveTaskId', async () => {
    const client = makeClient([{ data: exchangeRow }]);
    await startElicitation(client, PROJECT_ID, USER_ID, { task_id: 'B-42', trigger: 'pre-draft-clarify' });
    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, 'B-42');
  });
});

describe('fileElicitationRound', () => {
  it('appends round n = last+1, clears answers_submitted_at, and flags the task awaiting', async () => {
    const withRound = { ...exchangeRow, rounds: [{ n: 1, context_line: 'c', questions: [openQ()], answers: {} }] };
    // responses: [active lookup] -> [exchange update] -> [task flag update (direct await)]
    const client = makeClient([{ data: withRound }, { data: withRound }, { data: null }]);

    const result = await fileElicitationRound(client, PROJECT_ID, {
      task_id: 'task-1', context_line: 'Settling the drivers.', questions: [openQ('q1'), openQ('q2')],
    });
    expect(result).toEqual(withRound);

    // The exchange update appends n=2 and consumes any prior answers marker.
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({
      answers_submitted_at: null,
      rounds: [
        expect.objectContaining({ n: 1 }),
        expect.objectContaining({
          n: 2, context_line: 'Settling the drivers.',
          questions: [expect.objectContaining({ id: 'q1' }), expect.objectContaining({ id: 'q2' })],
          answers: {}, filed_at: expect.any(String),
        }),
      ],
    }));

    // The ball moves to the human on the TASK row, with the typed reason + ref. The ref carries the
    // exchange's gate (B-462) so the Queue card can label the round without re-fetching the exchange.
    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(client.update).toHaveBeenCalledWith({
      awaiting_human_input: true,
      awaiting_human_reason: 'elicitation-round',
      awaiting_human_ref: { kind: 'elicitation', exchange_id: 'ex-1', round: 2, gate: 'clarifying' },
    });
  });

  it('echoes terminal-given prior_answers into the consumed round in the same write (B-462)', async () => {
    const withRound = {
      ...exchangeRow,
      rounds: [{
        n: 1, context_line: 'c',
        questions: [
          { id: 'q1', stakes: 'low', kind: 'validate', statement: 'It is per-user.', text: 'Correct?' },
          { id: 'q2', stakes: 'load-bearing', kind: 'open', text: 'What drives this?' },
        ],
        answers: {},
      }],
    };
    const client = makeClient([{ data: withRound }, { data: withRound }, { data: null }]);

    await fileElicitationRound(client, PROJECT_ID, {
      task_id: 'task-1',
      context_line: 'Following up on the driver.',
      questions: [openQ('q3')],
      prior_answers: {
        q1: { verb: 'confirm' },
        q2: { verb: 'answer', text: 'Speed of triage.' },
      },
    });

    // One exchange write: round 1 gains the echoed answers (stamped via:'terminal' + answered_at),
    // round 2 is appended, and the consumable marker clears — all in the same update payload.
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({
      answers_submitted_at: null,
      rounds: [
        expect.objectContaining({
          n: 1,
          answered_at: expect.any(String),
          answers: {
            q1: { verb: 'confirm', via: 'terminal' },
            q2: { verb: 'answer', text: 'Speed of triage.', via: 'terminal' },
          },
        }),
        expect.objectContaining({ n: 2 }),
      ],
    }));
  });

  it('rejects prior_answers that fail the echo guards, before any write', async () => {
    const withAnswered = {
      ...exchangeRow,
      rounds: [{
        n: 1, context_line: 'c',
        questions: [{ id: 'q1', stakes: 'low', kind: 'open', text: 't' }],
        answers: { q1: { verb: 'answer', text: 'already answered on the web' } },
      }],
    };
    const client = makeClient([{ data: withAnswered }]);
    await expect(
      fileElicitationRound(client, PROJECT_ID, {
        task_id: 'task-1', context_line: 'ctx', questions: [openQ('q2')],
        prior_answers: { q1: { verb: 'answer', text: 'overwrite attempt' } },
      }),
    ).rejects.toThrow(/echo guards[\s\S]*never overwritten/i);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('NEVER touches workflow_state — no update payload carries it', async () => {
    const client = makeClient([{ data: exchangeRow }, { data: exchangeRow }, { data: null }]);
    await fileElicitationRound(client, PROJECT_ID, {
      task_id: 'task-1', context_line: 'ctx', questions: [openQ()],
    });
    for (const call of client.update.mock.calls) {
      expect(call[0]).not.toHaveProperty('workflow_state');
    }
  });

  it('rejects a round that fails the engine lints, listing the violations, before any DB access', async () => {
    const client = makeClient([]);
    await expect(
      fileElicitationRound(client, PROJECT_ID, {
        task_id: 'task-1',
        context_line: 'ctx',
        questions: [
          { id: 'q1', stakes: 'load-bearing', kind: 'validate', statement: 's', text: 't' },
          { id: 'q2', stakes: 'low', kind: 'validate', text: 'no statement' },
        ] as any,
      }),
    ).rejects.toThrow(/failed the elicitation lints[\s\S]*load-bearing[\s\S]*no statement/i);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('rejects filing on a non-active exchange (by exchange_id)', async () => {
    const client = makeClient([{ data: { ...exchangeRow, status: 'converged' } }]);
    await expect(
      fileElicitationRound(client, PROJECT_ID, {
        exchange_id: 'ex-1', context_line: 'ctx', questions: [openQ()],
      }),
    ).rejects.toThrow(/'converged'.*active exchange/i);
    expect(client.update).not.toHaveBeenCalled();
  });

  it("returns the typed 'exchange-cancelled' no-op on an 'abandoned' exchange instead of throwing (B-461)", async () => {
    const abandoned = { ...exchangeRow, trigger: 'discuss', brief_id: 'brief-1', status: 'abandoned' };
    const client = makeClient([{ data: abandoned }]);
    const result = await fileElicitationRound(client, PROJECT_ID, {
      exchange_id: 'ex-1', context_line: 'ctx', questions: [openQ()],
    });
    // Never a silent success, never a generic throw: the caller sees the mechanical cancel and stands down.
    expect(result).toEqual({ noop: true, cause: 'exchange-cancelled', exchange: abandoned });
    expect(client.update).not.toHaveBeenCalled();
  });

  it("round 1 on a brief-attached exchange clears the brief's pending_resolution in the same filing (B-461)", async () => {
    const discussExchange = { ...exchangeRow, trigger: 'discuss', brief_id: 'brief-1' };
    // responses: [active lookup] -> [briefs clear (direct await)] -> [exchange update] -> [task flag update]
    const client = makeClient([{ data: discussExchange }, { data: null }, { data: discussExchange }, { data: null }]);
    await fileElicitationRound(client, PROJECT_ID, {
      task_id: 'task-1', context_line: 'Opening the discussion.', questions: [openQ()],
    });
    // Filing round 1 IS the consume of the web-captured discuss marker: the attached brief's
    // pending_resolution clears in the same logical write, so the marker is never re-consumable.
    expect(client.from).toHaveBeenCalledWith('briefs');
    expect(client.update).toHaveBeenCalledWith({ pending_resolution: null });
    // The round still lands and the ball still moves to the human.
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({
      rounds: [expect.objectContaining({ n: 1 })],
    }));
    expect(client.from).toHaveBeenCalledWith('tasks');
  });

  it('round 2 does NOT re-clear the brief marker (the consume is round-1-only)', async () => {
    const withRound = {
      ...exchangeRow, trigger: 'discuss', brief_id: 'brief-1',
      rounds: [{ n: 1, context_line: 'c', questions: [openQ()], answers: {} }],
    };
    // responses: [active lookup] -> [exchange update] -> [task flag update] — NO briefs write.
    const client = makeClient([{ data: withRound }, { data: withRound }, { data: null }]);
    await fileElicitationRound(client, PROJECT_ID, {
      task_id: 'task-1', context_line: 'Round two.', questions: [openQ('q2')],
    });
    expect(client.from).not.toHaveBeenCalledWith('briefs');
    expect(client.update).not.toHaveBeenCalledWith({ pending_resolution: null });
  });

  it('tolerates ONLY a missing pending_resolution column on the round-1 clear (B-383 schema-drift class)', async () => {
    const discussExchange = { ...exchangeRow, trigger: 'discuss', brief_id: 'brief-1' };
    const client = makeClient([
      { data: discussExchange },
      { data: null, error: { message: 'column "pending_resolution" of relation "briefs" does not exist' } },
      { data: discussExchange },
      { data: null },
    ]);
    // The marker can't exist on a schema that lacks the column — skipping the clear is a faithful
    // no-op; the round still files and the ball still moves.
    await expect(
      fileElicitationRound(client, PROJECT_ID, { task_id: 'task-1', context_line: 'ctx', questions: [openQ()] }),
    ).resolves.toEqual(discussExchange);
    expect(client.from).toHaveBeenCalledWith('tasks');
  });

  it('a permission failure on the round-1 clear is LOUD — the clear is never silently skipped', async () => {
    const discussExchange = { ...exchangeRow, trigger: 'discuss', brief_id: 'brief-1' };
    const client = makeClient([
      { data: discussExchange },
      { data: null, error: { message: 'permission denied for table briefs' } },
    ]);
    await expect(
      fileElicitationRound(client, PROJECT_ID, { task_id: 'task-1', context_line: 'ctx', questions: [openQ()] }),
    ).rejects.toThrow(/permission denied/i);
    // The clear runs BEFORE the round is appended, so the failed filing is cleanly retryable:
    // only the briefs update ran — no round write, no task-flag write.
    expect(client.update).toHaveBeenCalledTimes(1);
    expect(client.update).toHaveBeenCalledWith({ pending_resolution: null });
  });

  it('requires a context_line', async () => {
    const client = makeClient([]);
    await expect(
      fileElicitationRound(client, PROJECT_ID, { task_id: 'task-1', context_line: ' ', questions: [openQ()] }),
    ).rejects.toThrow(/context_line is required/i);
  });
});

describe('getElicitation', () => {
  it('returns the active exchange when one exists', async () => {
    const client = makeClient([{ data: exchangeRow }]);
    expect(await getElicitation(client, PROJECT_ID, { task_id: 'task-1' })).toEqual(exchangeRow);
  });

  it('falls back to the most recent exchange when none is active', async () => {
    const concluded = { ...exchangeRow, status: 'converged' };
    // responses: [active lookup → none] -> [most-recent lookup]
    const client = makeClient([{ data: null }, { data: concluded }]);
    const result = await getElicitation(client, PROJECT_ID, { task_id: 'task-1' });
    expect(result).toEqual(concluded);
    expect(client.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('returns null when the task has never had an exchange', async () => {
    const client = makeClient([{ data: null }, { data: null }]);
    expect(await getElicitation(client, PROJECT_ID, { task_id: 'task-1' })).toBeNull();
  });
});

describe('concludeElicitation', () => {
  it('sets the outcome and clears BOTH consumable markers', async () => {
    const concluded = { ...exchangeRow, status: 'converged' };
    // responses: [active lookup] -> [update]
    const client = makeClient([{ data: exchangeRow }, { data: concluded }]);
    const result = await concludeElicitation(client, PROJECT_ID, { task_id: 'task-1', outcome: 'converged' });
    expect(client.update).toHaveBeenCalledWith({
      status: 'converged', answers_submitted_at: null, force_quit_requested_at: null,
    });
    expect(result).toEqual(concluded);
  });

  it("'abandoned' writes ONLY the exchange — never tasks, never briefs", async () => {
    const abandoned = { ...exchangeRow, brief_id: 'brief-1', status: 'abandoned' };
    const client = makeClient([{ data: { ...exchangeRow, brief_id: 'brief-1' } }, { data: abandoned }]);
    await concludeElicitation(client, PROJECT_ID, { task_id: 'task-1', outcome: 'abandoned' });
    // The abandon contract: the attached brief stays active with the task flag down — gate re-entry
    // re-surfaces it. So NO tasks write and NO briefs write may happen here.
    expect(client.from).not.toHaveBeenCalledWith('tasks');
    expect(client.from).not.toHaveBeenCalledWith('briefs');
    expect(client.from).toHaveBeenCalledWith('elicitation_exchanges');
    expect(client.update).toHaveBeenCalledTimes(1);
    expect(client.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'abandoned', answers_submitted_at: null, force_quit_requested_at: null }),
    );
  });

  it('echoes terminal-given prior_answers to the final round in the concluding write (B-462)', async () => {
    const withRound = {
      ...exchangeRow,
      rounds: [{
        n: 1, context_line: 'c',
        questions: [{ id: 'q1', stakes: 'load-bearing', kind: 'open', text: 'What drives this?' }],
        answers: {},
      }],
    };
    const concluded = { ...withRound, status: 'converged' };
    const client = makeClient([{ data: withRound }, { data: concluded }]);
    await concludeElicitation(client, PROJECT_ID, {
      task_id: 'task-1', outcome: 'converged',
      prior_answers: { q1: { verb: 'answer', text: 'Faster triage.' } },
    });
    expect(client.update).toHaveBeenCalledWith({
      status: 'converged', answers_submitted_at: null, force_quit_requested_at: null,
      rounds: [expect.objectContaining({
        n: 1,
        answers: { q1: { verb: 'answer', text: 'Faster triage.', via: 'terminal' } },
        answered_at: expect.any(String),
      })],
    });
  });

  it('rejects prior_answers failing the echo guards at conclude, before any write', async () => {
    const client = makeClient([{ data: exchangeRow }]); // no rounds filed
    await expect(
      concludeElicitation(client, PROJECT_ID, {
        task_id: 'task-1', outcome: 'converged',
        prior_answers: { q1: { verb: 'answer', text: 'x' } },
      }),
    ).rejects.toThrow(/echo guards[\s\S]*no round has been filed/i);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('re-issuing the same conclusion on an already-concluded exchange is idempotent (by exchange_id)', async () => {
    const concluded = { ...exchangeRow, status: 'force-quit' };
    const client = makeClient([{ data: concluded }]);
    const result = await concludeElicitation(client, PROJECT_ID, { exchange_id: 'ex-1', outcome: 'force-quit' });
    expect(result).toEqual(concluded);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('rejects a CONFLICTING conclusion on an already-concluded exchange', async () => {
    const client = makeClient([{ data: { ...exchangeRow, status: 'converged' } }]);
    await expect(
      concludeElicitation(client, PROJECT_ID, { exchange_id: 'ex-1', outcome: 'abandoned' }),
    ).rejects.toThrow(/already 'converged'/i);
  });

  it("concluding 'converged' on an 'abandoned' exchange returns the typed no-op, not a throw (B-461)", async () => {
    // The mint→conclude window raced a mechanical cancel: the exchange is already 'abandoned'.
    const abandoned = { ...exchangeRow, trigger: 'discuss', brief_id: 'brief-1', status: 'abandoned' };
    const client = makeClient([{ data: abandoned }]);
    const result = await concludeElicitation(client, PROJECT_ID, { exchange_id: 'ex-1', outcome: 'converged' });
    expect(result).toEqual({ noop: true, cause: 'exchange-cancelled', exchange: abandoned });
    expect(client.update).not.toHaveBeenCalled();
  });

  it("re-issuing 'abandoned' on an 'abandoned' exchange stays idempotent — returns the ROW, not the no-op", async () => {
    const abandoned = { ...exchangeRow, status: 'abandoned' };
    const client = makeClient([{ data: abandoned }]);
    const result = await concludeElicitation(client, PROJECT_ID, { exchange_id: 'ex-1', outcome: 'abandoned' });
    expect(result).toEqual(abandoned);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown outcome', async () => {
    const client = makeClient([]);
    await expect(
      concludeElicitation(client, PROJECT_ID, { task_id: 'task-1', outcome: 'done' as any }),
    ).rejects.toThrow(/outcome must be one of/i);
  });

  it('errors when task_id has no active exchange', async () => {
    const client = makeClient([{ data: null }]);
    await expect(
      concludeElicitation(client, PROJECT_ID, { task_id: 'task-1', outcome: 'converged' }),
    ).rejects.toThrow(/no active elicitation exchange/i);
  });
});

describe('claims hygiene on a mechanical cancel (B-461)', () => {
  it('a claim minted before the cancel is archived by the caller path and never selected for accept-promotion', async () => {
    // Claims are minted BEFORE conclude, so the mint→conclude window can race a cancel: the agent
    // minted a coupled Asserted claim (underwriting_brief_id + claim_provenance), then the web
    // mechanically set the exchange 'abandoned' before conclude ran.
    const claims = [
      { id: 'claim-1', status: 'Asserted', claim_provenance: 'human-stated', underwriting_brief_id: 'brief-1' },
    ];
    const abandoned = { ...exchangeRow, trigger: 'discuss', brief_id: 'brief-1', status: 'abandoned' };
    const client = makeClient([{ data: abandoned }]);

    // conclude returns the typed no-op — the signal to the CALLING AGENT that the cancel won the race.
    const result = await concludeElicitation(client, PROJECT_ID, { exchange_id: 'ex-1', outcome: 'converged' });
    expect(result).toEqual({ noop: true, cause: 'exchange-cancelled', exchange: abandoned });

    // The caller-path contract (the tool descriptions): on the typed no-op, archive every claim
    // minted in that same turn — a cancelled discussion leaves NO claims behind.
    if ((result as { noop?: boolean; cause?: string }).cause === 'exchange-cancelled') {
      for (const claim of claims) claim.status = 'Archived';
    }
    expect(claims[0].status).toBe('Archived');

    // The resolve_brief accept-promotion disposal predicate (coupled to THIS brief + still Asserted)
    // must select nothing — an archived claim can never promote at the brief's accept.
    const promotable = claims.filter((c) => c.underwriting_brief_id === 'brief-1' && c.status === 'Asserted');
    expect(promotable).toEqual([]);
  });
});

describe('fetchActiveExchange (get_task guarded projection — B-383-safe)', () => {
  it('maps the active row to the compact projection, round = last filed n', async () => {
    const client = makeClient([{
      data: {
        id: 'ex-1', status: 'active',
        rounds: [{ n: 1 }, { n: 2 }],
        answers_submitted_at: '2026-07-02T10:00:00Z', force_quit_requested_at: null,
      },
    }]);
    expect(await fetchActiveExchange(client, 'task-1')).toEqual({
      exchange_id: 'ex-1', status: 'active', round: 2,
      answers_submitted_at: '2026-07-02T10:00:00Z', force_quit_requested_at: null,
    });
  });

  it('round is 0 when no rounds have been filed yet', async () => {
    const client = makeClient([{ data: { id: 'ex-1', status: 'active', rounds: [] } }]);
    expect(await fetchActiveExchange(client, 'task-1')).toEqual(
      expect.objectContaining({ round: 0, answers_submitted_at: null, force_quit_requested_at: null }),
    );
  });

  it('returns null when there is no active exchange', async () => {
    const client = makeClient([{ data: null }]);
    expect(await fetchActiveExchange(client, 'task-1')).toBeNull();
  });

  it('returns null (never throws) when the table is absent on an older DB', async () => {
    const client = makeClient([
      { data: null, error: { message: 'relation "public.elicitation_exchanges" does not exist' } },
    ]);
    expect(await fetchActiveExchange(client, 'task-1')).toBeNull();
  });
});
