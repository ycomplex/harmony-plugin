import { describe, it, expect, vi } from 'vitest';
import {
  createConduction,
  getConduction,
  getActiveConduction,
  updateConduction,
  listConductions,
  takeoverConduction,
  ActiveConductionExistsError,
  CONDUCTION_LIVE_STATUSES,
  CONDUCTION_HUMAN_OWNED_STATUSES,
  CONDUCTION_TERMINAL_STATUSES,
  CONDUCTION_STATUSES,
  CONDUCTION_PATCHABLE_FIELDS,
  isConductionLive,
  isConductionHumanOwned,
  isConductionTerminal,
  type ConductionRecord,
  type ConductionStatus,
} from './conduction-record.js';

// NOTE on the house mock pattern: this module takes the Supabase client as a plain parameter and
// depends on NOTHING else (no resolveTaskId — the daemon deals in resolved UUIDs), so there are no
// module-scope vi.mock factories to strip; the vi.restoreAllMocks gotcha (impls stripped after
// test 1 — re-arm in beforeEach) does not arise here. Each test builds a fresh makeClient.

// A chainable supabase mock whose terminal methods (single/maybeSingle) pop a queued response in
// call order (mirrors elicitation.test.ts / briefs.test.ts makeClient).
function makeClient(responses: Array<{ data: unknown; error?: unknown }>) {
  let i = 0;
  const next = () => responses[i++] ?? { data: null, error: null };
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'eq', 'is', 'or']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => next());
  chain.single = vi.fn(async () => next());
  // List queries terminate on .order(...) (the builder is awaited as a thenable in real supabase;
  // the mock returns the queued response directly).
  chain.order = vi.fn(async () => next());
  return chain;
}

const conductionRow: ConductionRecord = {
  id: 'cond-1',
  task_id: 'task-1',
  status: 'active',
  mode: 'controlled',
  lease_holder: null,
  lease_acquired_at: null,
  last_heartbeat_at: null,
  retry_count: 0,
  worker_kind: null,
  worker_ref: null,
  last_worker_exit_code: null,
  last_worker_exit_class: null,
  current_pr_ref: null,
  started_at: '2026-07-20T00:00:00Z',
  created_by: null,
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
};

describe('createConduction', () => {
  it("inserts a new 'active' record with the v1 defaults and returns the inserted row", async () => {
    const client = makeClient([{ data: conductionRow }]);
    const result = await createConduction(client, { task_id: 'task-1' });

    expect(client.from).toHaveBeenCalledWith('conductions');
    // Exact payload: status forced 'active', mode defaults 'controlled', optionals null — and NO
    // lease_acquired_at stamp when no lease_holder is named.
    expect(client.insert).toHaveBeenCalledWith({
      task_id: 'task-1',
      status: 'active',
      mode: 'controlled',
      lease_holder: null,
      worker_kind: null,
      worker_ref: null,
      created_by: null,
    });
    expect(result).toEqual(conductionRow);
  });

  it('passes explicit fields through and stamps lease_acquired_at with the named lease_holder', async () => {
    const client = makeClient([{ data: { ...conductionRow, lease_holder: 'daemon-a' } }]);
    await createConduction(client, {
      task_id: 'task-1',
      mode: 'controlled',
      lease_holder: 'daemon-a',
      worker_kind: 'claude-code',
      worker_ref: 'session-9',
      created_by: 'user-1',
    });
    expect(client.insert).toHaveBeenCalledWith({
      task_id: 'task-1',
      status: 'active',
      mode: 'controlled',
      lease_holder: 'daemon-a',
      worker_kind: 'claude-code',
      worker_ref: 'session-9',
      created_by: 'user-1',
      lease_acquired_at: expect.any(String),
    });
  });

  it('surfaces the unique violation as the DISTINGUISHABLE lease-loss error (insert-or-fail IS the primitive)', async () => {
    const client = makeClient([
      {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "conductions_one_active_per_task"',
        },
      },
    ]);
    const err = await createConduction(client, { task_id: 'task-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveConductionExistsError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('active-conduction-exists');
    expect(err.task_id).toBe('task-1');
    expect(err.message).toMatch(/active conduction already exists for task task-1/i);
  });

  it('recognizes the unique violation by message when the client drops the code', async () => {
    const client = makeClient([
      { data: null, error: { message: 'duplicate key value violates unique constraint "x"' } },
    ]);
    await expect(createConduction(client, { task_id: 'task-1' })).rejects.toBeInstanceOf(
      ActiveConductionExistsError,
    );
  });

  it('throws a PLAIN error (not the lease-loss type) on any other insert failure', async () => {
    const client = makeClient([{ data: null, error: { code: '42501', message: 'permission denied' } }]);
    const err = await createConduction(client, { task_id: 'task-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ActiveConductionExistsError);
    expect(err.message).toBe('permission denied');
  });

  it('rejects a missing task_id before any DB access', async () => {
    const client = makeClient([]);
    await expect(createConduction(client, { task_id: '' })).rejects.toThrow(/task_id is required/);
    expect(client.from).not.toHaveBeenCalled();
  });
});

describe('getConduction', () => {
  it('fetches by id and returns the row', async () => {
    const client = makeClient([{ data: conductionRow }]);
    const result = await getConduction(client, 'cond-1');
    expect(client.from).toHaveBeenCalledWith('conductions');
    expect(client.eq).toHaveBeenCalledWith('id', 'cond-1');
    expect(result).toEqual(conductionRow);
  });

  it('returns null when the row does not exist', async () => {
    const client = makeClient([{ data: null }]);
    expect(await getConduction(client, 'cond-missing')).toBeNull();
  });

  it('throws on a DB error', async () => {
    const client = makeClient([{ data: null, error: { message: 'boom' } }]);
    await expect(getConduction(client, 'cond-1')).rejects.toThrow('boom');
  });
});

describe('getActiveConduction', () => {
  it("filters on task_id AND status='active'", async () => {
    const client = makeClient([{ data: conductionRow }]);
    const result = await getActiveConduction(client, 'task-1');
    expect(client.from).toHaveBeenCalledWith('conductions');
    expect(client.eq).toHaveBeenCalledWith('task_id', 'task-1');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    expect(result).toEqual(conductionRow);
  });

  it('returns null when the task has no live run', async () => {
    const client = makeClient([{ data: null }]);
    expect(await getActiveConduction(client, 'task-1')).toBeNull();
  });
});

describe('updateConduction', () => {
  it('patches exactly the allowed fields and returns the updated row', async () => {
    const patch = {
      status: 'parked' as const,
      lease_holder: null,
      lease_acquired_at: null,
      last_heartbeat_at: '2026-07-20T01:00:00Z',
      retry_count: 2,
      worker_kind: 'claude-code',
      worker_ref: 'session-9',
      last_worker_exit_code: 1,
      last_worker_exit_class: 'transient',
      current_pr_ref: 'ycomplex/harmony-web#350',
    };
    const updated = { ...conductionRow, ...patch };
    const client = makeClient([{ data: updated }]);

    const result = await updateConduction(client, 'cond-1', patch);
    expect(client.update).toHaveBeenCalledWith(patch);
    expect(client.eq).toHaveBeenCalledWith('id', 'cond-1');
    expect(result).toEqual(updated);
  });

  it.each(['id', 'task_id', 'started_at', 'created_by', 'created_at', 'updated_at'])(
    'rejects the non-patchable field %s loudly, before any write',
    async (field) => {
      const client = makeClient([]);
      await expect(
        updateConduction(client, 'cond-1', { retry_count: 1, [field]: 'x' } as any),
      ).rejects.toThrow(new RegExp(`non-patchable field\\(s\\): ${field}`));
      expect(client.update).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty patch', async () => {
    const client = makeClient([]);
    await expect(updateConduction(client, 'cond-1', {})).rejects.toThrow(/at least one of/);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('rejects a status outside the canonical vocabulary', async () => {
    const client = makeClient([]);
    await expect(
      updateConduction(client, 'cond-1', { status: 'done' as ConductionStatus }),
    ).rejects.toThrow(/status must be one of: active, parked, completed, cancelled/);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('throws on a DB error (e.g. the row does not exist)', async () => {
    const client = makeClient([{ data: null, error: { message: 'no rows returned' } }]);
    await expect(updateConduction(client, 'cond-1', { retry_count: 1 })).rejects.toThrow(
      'no rows returned',
    );
  });
});

describe('listConductions', () => {
  it("filters eq('status','active') when a status is given and orders by started_at ascending", async () => {
    const client = makeClient([{ data: [conductionRow] }]);
    const result = await listConductions(client, { status: 'active' });

    expect(client.from).toHaveBeenCalledWith('conductions');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    expect(client.order).toHaveBeenCalledWith('started_at', { ascending: true });
    expect(result).toEqual([conductionRow]);
  });

  it('applies NO status filter when none is given', async () => {
    const client = makeClient([{ data: [conductionRow, { ...conductionRow, id: 'cond-2', status: 'parked' }] }]);
    const result = await listConductions(client, {});
    expect(client.eq).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it('returns [] when there are no rows', async () => {
    const client = makeClient([{ data: null }]);
    expect(await listConductions(client, { status: 'active' })).toEqual([]);
  });

  it('throws on a DB error', async () => {
    const client = makeClient([{ data: null, error: { message: 'boom' } }]);
    await expect(listConductions(client, {})).rejects.toThrow('boom');
  });
});

describe('takeoverConduction', () => {
  const casArgs = {
    id: 'cond-1',
    observed_lease_holder: 'daemon-a',
    stale_before: '2026-07-23T00:00:00.000Z',
    new_lease_holder: 'daemon-b',
  };

  it('issues the guarded CAS UPDATE (id + active + observed holder + stale guard) and returns the row on win', async () => {
    const won = { ...conductionRow, lease_holder: 'daemon-b' };
    const client = makeClient([{ data: won }]);
    const result = await takeoverConduction(client, casArgs);

    expect(client.from).toHaveBeenCalledWith('conductions');
    expect(client.update).toHaveBeenCalledWith({
      lease_holder: 'daemon-b',
      lease_acquired_at: expect.any(String),
      last_heartbeat_at: expect.any(String),
    });
    expect(client.eq).toHaveBeenCalledWith('id', 'cond-1');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    expect(client.eq).toHaveBeenCalledWith('lease_holder', 'daemon-a');
    expect(client.is).not.toHaveBeenCalled();
    // NULL last_heartbeat_at counts as stale — the guard is the or(is-null, lt stale_before) form,
    // never a bare .lt (a never-heartbeated row must be takeable).
    expect(client.or).toHaveBeenCalledWith(
      `last_heartbeat_at.is.null,last_heartbeat_at.lt.${casArgs.stale_before}`,
    );
    expect(client.maybeSingle).toHaveBeenCalled();
    expect(result).toEqual(won);
  });

  it("guards .is('lease_holder', null) when the observed holder is null (never eq on null)", async () => {
    const client = makeClient([{ data: conductionRow }]);
    await takeoverConduction(client, { ...casArgs, observed_lease_holder: null });
    expect(client.is).toHaveBeenCalledWith('lease_holder', null);
    expect(client.eq).not.toHaveBeenCalledWith('lease_holder', expect.anything());
  });

  it('returns null when no row matched — the CAS race was LOST, not an error', async () => {
    const client = makeClient([{ data: null }]);
    expect(await takeoverConduction(client, casArgs)).toBeNull();
  });

  it('throws on an operational error (distinct from losing the race)', async () => {
    const client = makeClient([{ data: null, error: { message: 'permission denied' } }]);
    await expect(takeoverConduction(client, casArgs)).rejects.toThrow('permission denied');
  });
});

describe('the canonical status axis', () => {
  it('names the three sets exactly', () => {
    expect(CONDUCTION_LIVE_STATUSES).toEqual(['active']);
    expect(CONDUCTION_HUMAN_OWNED_STATUSES).toEqual(['parked']);
    expect(CONDUCTION_TERMINAL_STATUSES).toEqual(['completed', 'cancelled']);
    expect(CONDUCTION_STATUSES).toEqual(['active', 'parked', 'completed', 'cancelled']);
  });

  it('predicate truth table — each predicate is true exactly on its own set', () => {
    const table: Array<[ConductionStatus, boolean, boolean, boolean]> = [
      // status,     live,  human-owned, terminal
      ['active', true, false, false],
      ['parked', false, true, false],
      ['completed', false, false, true],
      ['cancelled', false, false, true],
    ];
    for (const [status, live, humanOwned, terminal] of table) {
      expect(isConductionLive(status), `${status} live`).toBe(live);
      expect(isConductionHumanOwned(status), `${status} human-owned`).toBe(humanOwned);
      expect(isConductionTerminal(status), `${status} terminal`).toBe(terminal);
    }
  });

  it('predicates are false on a non-status string', () => {
    for (const bogus of ['done', 'ACTIVE', '', 'live']) {
      expect(isConductionLive(bogus)).toBe(false);
      expect(isConductionHumanOwned(bogus)).toBe(false);
      expect(isConductionTerminal(bogus)).toBe(false);
    }
  });

  it('PARTITION: every status is a member of exactly one set (and the union is the vocabulary)', () => {
    const sets: ReadonlyArray<readonly string[]> = [
      CONDUCTION_LIVE_STATUSES,
      CONDUCTION_HUMAN_OWNED_STATUSES,
      CONDUCTION_TERMINAL_STATUSES,
    ];
    for (const status of CONDUCTION_STATUSES) {
      const memberships = sets.filter((s) => s.includes(status)).length;
      expect(memberships, `${status} must be in exactly one set`).toBe(1);
    }
    // The union covers the vocabulary with no duplicates and nothing extra.
    const union = sets.flat();
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...CONDUCTION_STATUSES].sort());
  });

  it('CONDUCTION_PATCHABLE_FIELDS excludes identity and provenance', () => {
    for (const immutable of ['id', 'task_id', 'started_at', 'created_by', 'created_at', 'updated_at']) {
      expect(CONDUCTION_PATCHABLE_FIELDS).not.toContain(immutable);
    }
  });
});
