import { describe, it, expect, vi } from 'vitest';
import {
  createConduction,
  getConduction,
  getActiveConduction,
  updateConduction,
  updateConductionIfHeld,
  listConductions,
  takeoverConduction,
  stealConduction,
  markCleanShutdown,
  assertNotExcluded,
  ActiveConductionExistsError,
  ConductorExcludedError,
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
  // B-761: markCleanShutdown awaits the builder DIRECTLY (no trailing .select()/.single() —
  // real supabase-js's PostgrestFilterBuilder is itself thenable), so the mock needs to be
  // thenable too, for that ONE caller only — every other caller here always terminates on an
  // explicit method above, so this is never reached by them.
  chain.then = (resolve: (v: unknown) => void) => resolve(next());
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
  leg_started_at: null,
  clean_shutdown_at: null,
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

describe('assertNotExcluded (B-758)', () => {
  it('resolves without throwing when conductor_excluded_at is null', async () => {
    const client = makeClient([{ data: { conductor_excluded_at: null } }]);
    await expect(assertNotExcluded(client, 'task-1')).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(client.select).toHaveBeenCalledWith('conductor_excluded_at');
    expect(client.eq).toHaveBeenCalledWith('id', 'task-1');
  });

  it('throws the typed ConductorExcludedError when conductor_excluded_at is set', async () => {
    const client = makeClient([
      { data: { conductor_excluded_at: '2026-08-01T00:00:00.000Z' } },
    ]);
    const err = await assertNotExcluded(client, 'task-1').catch((e) => e);
    expect(err).toBeInstanceOf(ConductorExcludedError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('conductor-excluded');
    expect(err.task_id).toBe('task-1');
    // Points at the existing "Return to conductor" web action, not raw internals.
    expect(err.message).toMatch(/Return it first/i);
    expect(err.message).toMatch(/Return to conductor/i);
  });

  it('throws a PLAIN error on a lookup failure (distinct from the excluded type)', async () => {
    const client = makeClient([{ data: null, error: { message: 'permission denied' } }]);
    const err = await assertNotExcluded(client, 'task-1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConductorExcludedError);
    expect(err.message).toBe('permission denied');
  });

  it('rejects a missing task_id before any DB access', async () => {
    const client = makeClient([]);
    await expect(assertNotExcluded(client, '')).rejects.toThrow(/task_id is required/);
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

  it("B-718: selects run_config (CONDUCTION_COLS now includes it — the first dependent needing a non-default value)", async () => {
    const client = makeClient([{ data: conductionRow }]);
    await getConduction(client, 'cond-1');
    const selectedCols = client.select.mock.calls[0][0] as string;
    expect(selectedCols).toContain('run_config');
  });

  it('B-718: round-trips a non-default run_config value on the returned row', async () => {
    const rowWithRunConfig = { ...conductionRow, run_config: { session_resume: { enabled: true } } };
    const client = makeClient([{ data: rowWithRunConfig }]);
    const result = await getConduction(client, 'cond-1');
    expect(result?.run_config).toEqual({ session_resume: { enabled: true } });
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
    // B-717: task_priority is additive — embedded via the tasks(priority) FK join and flattened;
    // a row with no nested `tasks` object (the fixture doesn't carry one) reads as null.
    expect(result).toEqual([{ ...conductionRow, task_priority: null }]);
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

  it('B-717: flattens the embedded tasks(priority) join into task_priority on every row', async () => {
    const client = makeClient([
      { data: [{ ...conductionRow, tasks: { priority: 'high' } }] },
    ]);
    const result = await listConductions(client, { status: 'active' });
    expect(result[0].task_priority).toBe('high');
    expect((result[0] as unknown as { tasks?: unknown }).tasks).toBeUndefined(); // not leaked raw
  });
});

describe('takeoverConduction', () => {
  const casArgs = {
    id: 'cond-1',
    observed_lease_holder: 'daemon-a',
    stale_before: '2026-07-23T00:00:00.000Z',
    new_lease_holder: 'daemon-b',
  };

  it('issues the guarded CAS UPDATE (id + active + observed holder + stale-or-clean-shutdown guard) and returns the row on win', async () => {
    const won = { ...conductionRow, lease_holder: 'daemon-b' };
    const client = makeClient([{ data: won }]);
    const result = await takeoverConduction(client, casArgs);

    expect(client.from).toHaveBeenCalledWith('conductions');
    // B-761: clean_shutdown_at is cleared on the SAME write that reassigns lease_holder — the
    // marker is single-use, so the new holder always starts clean.
    expect(client.update).toHaveBeenCalledWith({
      lease_holder: 'daemon-b',
      lease_acquired_at: expect.any(String),
      last_heartbeat_at: expect.any(String),
      clean_shutdown_at: null,
    });
    expect(client.eq).toHaveBeenCalledWith('id', 'cond-1');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    expect(client.eq).toHaveBeenCalledWith('lease_holder', 'daemon-a');
    expect(client.is).not.toHaveBeenCalled();
    // NULL last_heartbeat_at counts as stale — the guard is the or(is-null, lt stale_before,
    // clean_shutdown_at not null) form, never a bare .lt (a never-heartbeated row must be takeable,
    // and B-761's clean-shutdown marker must be takeable regardless of heartbeat recency).
    expect(client.or).toHaveBeenCalledWith(
      `last_heartbeat_at.is.null,last_heartbeat_at.lt.${casArgs.stale_before},clean_shutdown_at.not.is.null`,
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

describe('markCleanShutdown (B-761)', () => {
  it('bulk-updates every active row this lease_holder holds, stamping clean_shutdown_at, requesting an exact count', async () => {
    const client = makeClient([{ data: null, error: null, count: 3 }]);
    const result = await markCleanShutdown(client, 'this-host:1:abcd1234');

    expect(client.from).toHaveBeenCalledWith('conductions');
    expect(client.update).toHaveBeenCalledWith(
      { clean_shutdown_at: expect.any(String) },
      { count: 'exact' },
    );
    // Scoped ONLY to this exact lease_holder + status='active' — never a foreign peer's row, and
    // never a row this process already released (parked/completed/cancelled).
    expect(client.eq).toHaveBeenCalledWith('lease_holder', 'this-host:1:abcd1234');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    // B-761 reopen fix: the caller logs a success line naming the count, so the count must come
    // back through — no more silent success.
    expect(result).toBe(3);
  });

  it('returns 0 (not throw) when a null count comes back from a matched-nothing write', async () => {
    const client = makeClient([{ data: null, error: null, count: null }]);
    const result = await markCleanShutdown(client, 'this-host:1:abcd1234');
    expect(result).toBe(0);
  });

  it('requires a lease holder — an unguarded bulk write must be impossible', async () => {
    const client = makeClient([{ data: null, error: null }]);
    await expect(markCleanShutdown(client, '')).rejects.toThrow('leaseHolder is required');
    expect(client.update).not.toHaveBeenCalled();
  });

  it('throws on an operational error', async () => {
    const client = makeClient([{ data: null, error: { message: 'JWT expired' } }]);
    await expect(markCleanShutdown(client, 'this-host:1:abcd1234')).rejects.toThrow('JWT expired');
  });
});

describe('stealConduction', () => {
  const stealArgs = {
    id: 'cond-1',
    observed_lease_holder: 'daemon-a',
    new_lease_holder: 'daemon-b',
  };

  it("issues the guarded CAS UPDATE (id + active + observed holder + leg_started_at IS NULL) and returns the row on win", async () => {
    const won = { ...conductionRow, lease_holder: 'daemon-b' };
    const client = makeClient([{ data: won }]);
    const result = await stealConduction(client, stealArgs);

    expect(client.from).toHaveBeenCalledWith('conductions');
    expect(client.update).toHaveBeenCalledWith({
      lease_holder: 'daemon-b',
      lease_acquired_at: expect.any(String),
      last_heartbeat_at: expect.any(String),
    });
    expect(client.eq).toHaveBeenCalledWith('id', 'cond-1');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    expect(client.eq).toHaveBeenCalledWith('lease_holder', 'daemon-a');
    expect(client.is).toHaveBeenCalledWith('leg_started_at', null);
    expect(client.maybeSingle).toHaveBeenCalled();
    expect(result).toEqual(won);
  });

  it('returns null when no row matched — the STEAL race was LOST (or leg_started_at was not null), not an error', async () => {
    const client = makeClient([{ data: null }]);
    expect(await stealConduction(client, stealArgs)).toBeNull();
  });

  it('throws on an operational error (distinct from losing the race)', async () => {
    const client = makeClient([{ data: null, error: { message: 'permission denied' } }]);
    await expect(stealConduction(client, stealArgs)).rejects.toThrow('permission denied');
  });

  it('requires id, observed_lease_holder, and new_lease_holder — never an unguarded steal', async () => {
    const client = makeClient([{ data: conductionRow }]);
    await expect(stealConduction(client, { ...stealArgs, id: '' })).rejects.toThrow('id is required');
    await expect(
      stealConduction(client, { ...stealArgs, observed_lease_holder: '' }),
    ).rejects.toThrow('observed_lease_holder is required');
    await expect(
      stealConduction(client, { ...stealArgs, new_lease_holder: '' }),
    ).rejects.toThrow('new_lease_holder is required');
    expect(client.update).not.toHaveBeenCalled();
  });
});

describe('updateConductionIfHeld', () => {
  it('guards the UPDATE on id + lease_holder and returns the row when still held', async () => {
    const client = makeClient([{ data: conductionRow }]);
    const result = await updateConductionIfHeld(client, 'cond-1', 'daemon-a', {
      last_heartbeat_at: '2026-07-30T00:00:00.000Z',
    });

    expect(client.from).toHaveBeenCalledWith('conductions');
    expect(client.update).toHaveBeenCalledWith({
      last_heartbeat_at: '2026-07-30T00:00:00.000Z',
    });
    expect(client.eq).toHaveBeenCalledWith('id', 'cond-1');
    expect(client.eq).toHaveBeenCalledWith('lease_holder', 'daemon-a');
    expect(client.maybeSingle).toHaveBeenCalled();
    expect(result).toEqual(conductionRow);
  });

  // The null-vs-throw split is the whole point (B-739): a transient failure must NEVER read as
  // lease loss, or the heartbeat stops during exactly the blip that makes a healthy daemon look
  // dead — this ticket's own bug, re-created inside its fix.
  it('returns null when no row matched — the LEASE IS GONE, not an error', async () => {
    const client = makeClient([{ data: null }]);
    expect(
      await updateConductionIfHeld(client, 'cond-1', 'daemon-a', { retry_count: 1 }),
    ).toBeNull();
  });

  it('throws on an operational error — distinct from losing the lease', async () => {
    const client = makeClient([{ data: null, error: { message: 'JWT expired' } }]);
    await expect(
      updateConductionIfHeld(client, 'cond-1', 'daemon-a', { retry_count: 1 }),
    ).rejects.toThrow('JWT expired');
  });

  it('rejects a non-patchable field before any write (same rule as updateConduction)', async () => {
    const client = makeClient([{ data: conductionRow }]);
    await expect(
      updateConductionIfHeld(client, 'cond-1', 'daemon-a', {
        task_id: 'x',
      } as unknown as Parameters<typeof updateConductionIfHeld>[3]),
    ).rejects.toThrow('non-patchable');
    expect(client.update).not.toHaveBeenCalled();
  });

  it('rejects an empty patch before any write', async () => {
    const client = makeClient([{ data: conductionRow }]);
    await expect(updateConductionIfHeld(client, 'cond-1', 'daemon-a', {})).rejects.toThrow(
      'patch must contain at least one of',
    );
    expect(client.update).not.toHaveBeenCalled();
  });

  it('requires an expected lease holder — an unguarded write must be impossible here', async () => {
    const client = makeClient([{ data: conductionRow }]);
    await expect(
      updateConductionIfHeld(client, 'cond-1', '', { retry_count: 1 }),
    ).rejects.toThrow('expectedLeaseHolder is required');
    expect(client.update).not.toHaveBeenCalled();
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

  it('CONDUCTION_PATCHABLE_FIELDS includes leg_started_at (B-742)', () => {
    expect(CONDUCTION_PATCHABLE_FIELDS).toContain('leg_started_at');
  });

  it('CONDUCTION_PATCHABLE_FIELDS includes clean_shutdown_at (B-761)', () => {
    expect(CONDUCTION_PATCHABLE_FIELDS).toContain('clean_shutdown_at');
  });
});
