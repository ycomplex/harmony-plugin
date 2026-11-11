// B-1452: raise_incident / `harmony incident raise` — the handler, the launch-path guard, the MCP ack
// and the CLI, over an in-memory board that logs every write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { memorySupabase, type MemoryDb } from './__fixtures__/memory-supabase.js';
import { assertNoOpenIncident, IncidentOpenError, raiseIncident, raiseIncidentTool } from './incident.js';
import { projectAck } from './ack-projection.js';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../cli/auth.js', () => ({ getAuthenticatedContext: mocks.auth }));

const TASK = '11111111-1111-4111-8111-111111111111';
const PROJECT = 'proj-1';
const USER = 'user-1';

// Built at runtime so this source file never carries a literal token shape.
const FAKE_GITHUB = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const FAKE_JWT = ['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'sig_abcDEF123'].join('');

function board(over: { task?: Record<string, unknown>; exchanges?: Record<string, unknown>[] } = {}): MemoryDb {
  return memorySupabase({
    tasks: [
      {
        id: TASK,
        workflow_state: 'Planned',
        awaiting_human_input: false,
        awaiting_human_reason: null,
        awaiting_human_ref: null,
        field_values: { gate_slots: { plan: 'x' } },
        ...(over.task ?? {}),
      },
    ],
    elicitation_exchanges: over.exchanges ?? [],
    task_comments: [],
  });
}

const args = (over: Record<string, unknown> = {}) => ({
  task_id: TASK,
  kind: 'credential-exposure',
  what: `the GitHub token ${FAKE_GITHUB} of the build app`,
  where: `commit 1a2b3c4 on feat/x, and the bearer ${FAKE_JWT} in a PR comment`,
  human_steps: `revoke ${FAKE_GITHUB} and rotate it, then rewrite feat/x`,
  ...over,
});

/** Everything the handler wrote or returned, as one string. */
function everything(db: MemoryDb, result: unknown): string {
  return JSON.stringify({ writes: db.writes, tables: db.tables, result });
}

beforeEach(() => {
  vi.stubEnv('HARMONY_CONDUCTION_ID', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('raiseIncident', () => {
  it('(1) never writes or returns a token-shaped argument — round, ref, comment, return', async () => {
    const db = board();
    const result = await raiseIncident(db.client, PROJECT, USER, args());
    const all = everything(db, result);
    expect(all).not.toContain(FAKE_GITHUB);
    expect(all).not.toContain(FAKE_JWT);
    expect(all).not.toContain('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    expect(result.what).toBe('the GitHub token [redacted] of the build app');
    expect(result.human_steps).toBe('revoke [redacted] and rotate it, then rewrite feat/x');
    expect(result.scrubbed).toBe(true);
    // The comment carries the scrubbed text and the marker line first.
    const comment = db.tables.task_comments[0];
    expect(String(comment.content).split('\n')[0]).toBe(`INCIDENT-RAISED kind=credential-exposure exchange_id=${result.exchange_id}`);
    expect(String(comment.content)).toContain('[redacted]');
  });

  it('(2) sets awaiting_human_input, reason elicitation-round and awaiting_human_ref.incident in one task write', async () => {
    const db = board();
    const result = await raiseIncident(db.client, PROJECT, USER, args());
    const task = db.tables.tasks[0];
    expect(task.awaiting_human_input).toBe(true);
    expect(task.awaiting_human_reason).toBe('elicitation-round');
    expect(task.awaiting_human_ref).toEqual({
      kind: 'elicitation',
      exchange_id: result.exchange_id,
      round: 1,
      gate: 'building',
      incident: 'credential-exposure',
    });
    // Flag and marker landed together: ONE task write carries both.
    const flagWrites = db.writes.filter((w) => w.table === 'tasks' && 'awaiting_human_input' in w.payload);
    expect(flagWrites).toHaveLength(1);
    expect((flagWrites[0].payload.awaiting_human_ref as Record<string, unknown>).incident).toBe('credential-exposure');
    // The exchange and its one round.
    const ex = db.tables.elicitation_exchanges[0];
    expect(ex.trigger).toBe('incident');
    expect(ex.gate).toBe('building');
    const rounds = ex.rounds as Array<Record<string, unknown>>;
    expect(rounds).toHaveLength(1);
    expect(rounds[0].context_line).toBe(
      'Incident — credential exposure: the GitHub token [redacted] of the build app was exposed at commit 1a2b3c4 on feat/x, and the bearer [redacted] in a PR comment.',
    );
    expect(rounds[0].questions).toEqual([
      {
        id: 'release',
        stakes: 'load-bearing',
        kind: 'open',
        text: 'Only a human can do this: revoke [redacted] and rotate it, then rewrite feat/x. When it is done, answer "resume" to let the ticket continue, or "stop" to park it with this incident as the reason.',
      },
    ]);
    expect(result).toMatchObject({ round: 1, superseded_exchange_id: null, cleared_model_handoff: false });
    // Never touches workflow_state.
    for (const w of db.writes) expect(w.payload).not.toHaveProperty('workflow_state');
  });

  it('concludes an active non-incident exchange as abandoned and says so in the comment', async () => {
    const db = board({ exchanges: [{ id: 'ex-old', task_id: TASK, trigger: 'pre-draft-clarify', status: 'active', rounds: [] }] });
    const result = await raiseIncident(db.client, PROJECT, USER, args());
    expect(db.tables.elicitation_exchanges.find((e) => e.id === 'ex-old')?.status).toBe('abandoned');
    expect(result.superseded_exchange_id).toBe('ex-old');
    expect(result.exchange_id).not.toBe('ex-old');
    expect(String(db.tables.task_comments[0].content)).toContain("ex-old was concluded 'abandoned'");
  });

  it('files a new round on an already-active incident exchange instead of opening another', async () => {
    const db = board({
      exchanges: [
        {
          id: 'ex-inc',
          task_id: TASK,
          trigger: 'incident',
          status: 'active',
          gate: 'building',
          rounds: [{ n: 1, context_line: 'c', questions: [{ id: 'release', stakes: 'load-bearing', kind: 'open', text: 't' }], answers: {} }],
        },
      ],
    });
    const result = await raiseIncident(db.client, PROJECT, USER, args());
    expect(result.exchange_id).toBe('ex-inc');
    expect(result.round).toBe(2);
    expect(db.writes.filter((w) => w.table === 'elicitation_exchanges' && w.op === 'insert')).toHaveLength(0);
  });

  it('rejects any other kind by name and writes nothing (a token-shaped kind is scrubbed in the error)', async () => {
    const db = board();
    await expect(raiseIncident(db.client, PROJECT, USER, args({ kind: 'data-leak' }))).rejects.toThrow(
      /incident kind 'data-leak' is not accepted.*'credential-exposure'/,
    );
    const err = await raiseIncident(db.client, PROJECT, USER, args({ kind: FAKE_GITHUB })).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(FAKE_GITHUB);
    expect(db.writes).toEqual([]);
  });

  it('refuses empty fields after scrubbing, writing nothing', async () => {
    const db = board();
    await expect(raiseIncident(db.client, PROJECT, USER, args({ where: '   ' }))).rejects.toThrow(/where is required/);
    expect(db.writes).toEqual([]);
  });

  it('clears a live model-handoff wait so the conductor cannot relaunch past the incident', async () => {
    const db = board({
      task: { field_values: { gate_slots: { plan: 'x' }, waiting_on: { kind: 'model-handoff', ref: 'opus', since: 'x', first_since: 'x' } } },
    });
    const result = await raiseIncident(db.client, PROJECT, USER, args());
    expect(result.cleared_model_handoff).toBe(true);
    expect(db.tables.tasks[0].field_values).toEqual({ gate_slots: { plan: 'x' }, waiting_on: null });
  });

  it('leaves any other wait kind alone', async () => {
    const fv = { waiting_on: { kind: 'ci', ref: 'pr#1', since: 'x', first_since: 'x' } };
    const db = board({ task: { field_values: fv } });
    const result = await raiseIncident(db.client, PROJECT, USER, args());
    expect(result.cleared_model_handoff).toBe(false);
    expect(db.tables.tasks[0].field_values).toEqual(fv);
  });

  it('works from a conduction worker (raising is allowed; answering is not)', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', 'cond-1');
    const db = board();
    await expect(raiseIncident(db.client, PROJECT, USER, args())).resolves.toMatchObject({ round: 1 });
  });
});

describe('raise_incident MCP ack', () => {
  it('drops the caller text and keeps the server-computed identity', async () => {
    const db = board();
    const result = await raiseIncident(db.client, PROJECT, USER, args());
    const ack = projectAck('raise_incident', result, args()) as Record<string, unknown>;
    expect(ack).toMatchObject({ exchange_id: result.exchange_id, round: 1, kind: 'credential-exposure', scrubbed: true });
    expect(ack).not.toHaveProperty('what');
    expect(ack).not.toHaveProperty('where');
    expect(ack).not.toHaveProperty('human_steps');
  });

  it('tells the caller to stop, end the turn and never pass the secret', () => {
    expect(raiseIncidentTool.description).toMatch(/ONLY when you discovered that you exposed a credential outside the worker/);
    expect(raiseIncidentTool.description).toMatch(/make NO further change/);
    expect(raiseIncidentTool.description).toMatch(/END YOUR TURN/);
    expect(raiseIncidentTool.description).toMatch(/NEVER put the secret in any argument/);
  });
});

describe('assertNoOpenIncident (create_conduction / harmony conduct guard)', () => {
  const inc = (answers: Record<string, unknown>) => ({
    id: 'ex-inc',
    task_id: TASK,
    trigger: 'incident',
    status: 'active',
    rounds: [{ n: 1, context_line: 'c', questions: [], answers }],
  });

  it('refuses while the incident round is unanswered', async () => {
    const db = board({ exchanges: [inc({})] });
    await expect(assertNoOpenIncident(db.client, TASK, 'B-9')).rejects.toBeInstanceOf(IncidentOpenError);
    await expect(assertNoOpenIncident(db.client, TASK, 'B-9')).rejects.toThrow(/B-9 has an open incident.*answer its incident round/);
  });

  it('allows once a human answered it, with no incident, or on a read error (fails open)', async () => {
    await expect(assertNoOpenIncident(board({ exchanges: [inc({ release: { verb: 'answer', text: 'resume' } })] }).client, TASK)).resolves.toBeUndefined();
    await expect(assertNoOpenIncident(board().client, TASK)).resolves.toBeUndefined();
    const failing = board({ exchanges: [inc({})] });
    failing.failReads.set('elicitation_exchanges', 'relation does not exist');
    await expect(assertNoOpenIncident(failing.client, TASK)).resolves.toBeUndefined();
  });
});

describe('harmony incident raise (CLI)', () => {
  it('passes every flag to the handler, prints JSON and never prints or writes the token', async () => {
    const db = board();
    mocks.auth.mockResolvedValue({ client: db.client, projectId: PROJECT, userId: USER });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { registerIncidentCommands } = await import('../cli/commands/incident.js');
      const program = new Command().option('--json');
      registerIncidentCommands(program);
      const a = args();
      await program.parseAsync(
        ['--json', 'incident', 'raise', '--task', TASK, '--kind', 'credential-exposure', '--what', a.what as string, '--where', a.where as string, '--human-steps', a.human_steps as string],
        { from: 'user' },
      );
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed).toMatchObject({ kind: 'credential-exposure', round: 1, what: 'the GitHub token [redacted] of the build app' });
      expect(out).not.toContain(FAKE_GITHUB);
      expect(out).not.toContain(FAKE_JWT);
      expect(everything(db, null)).not.toContain(FAKE_GITHUB);
      expect(db.tables.tasks[0].awaiting_human_ref).toMatchObject({ incident: 'credential-exposure' });
    } finally {
      log.mockRestore();
    }
  });

  it('prints a plain summary without --json', async () => {
    const db = board();
    mocks.auth.mockResolvedValue({ client: db.client, projectId: PROJECT, userId: USER });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { registerIncidentCommands } = await import('../cli/commands/incident.js');
      const program = new Command().option('--json');
      registerIncidentCommands(program);
      const a = args();
      await program.parseAsync(
        ['incident', 'raise', '--task', TASK, '--kind', 'credential-exposure', '--what', a.what as string, '--where', a.where as string, '--human-steps', a.human_steps as string],
        { from: 'user' },
      );
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toMatch(/^Incident raised \(credential-exposure\)/);
      expect(out).toMatch(/Make no further change and end your turn\./);
      expect(out).not.toContain(FAKE_GITHUB);
    } finally {
      log.mockRestore();
    }
  });
});
