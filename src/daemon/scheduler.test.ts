import { describe, it, expect, vi } from 'vitest';
import {
  runSchedulerPass,
  runScheduler,
  isAuthShapedError,
  PersistentAuthFailure,
  type SchedulerDeps,
  type DaemonTask,
} from './scheduler.js';
import type { WatchBaseline } from './watch.js';
import type { ConductionRecord } from '../tools/conduction-record.js';
import type { DaemonConfig } from './config.js';

const iso = (ms: number) => new Date(ms).toISOString();

const ME = 'this-host:1:abcd1234';
const T0 = 1_000_000_000; // fake epoch origin (nonzero so a zero-based bug is visible)

function conduction(over: Partial<ConductionRecord> = {}): ConductionRecord {
  return {
    id: 'cond-1',
    task_id: 'task-1',
    status: 'active',
    mode: 'controlled',
    lease_holder: ME,
    lease_acquired_at: iso(T0),
    last_heartbeat_at: iso(T0),
    retry_count: 0,
    worker_kind: null,
    worker_ref: null,
    last_worker_exit_code: null,
    last_worker_exit_class: null,
    current_pr_ref: null,
    started_at: iso(T0),
    created_by: null,
    created_at: iso(T0),
    updated_at: iso(T0),
    ...over,
  };
}

const config: DaemonConfig = {
  pollMs: 25_000,
  heartbeatMs: 30_000,
  staleMs: 300_000,
  profile: { launch: 'launch {conduction_id} {ticket}', reap: 'reap {conduction_id}' },
};

interface HarnessOpts {
  conductions: ConductionRecord[];
  tasks: Record<string, DaemonTask | Error>;
  launchExitCode?: number | null;
  childCount?: number;
}

// A stateful fake world: conduction rows mutate through updateConduction/takeoverConduction (the
// takeover fake applies the REAL CAS semantics — observed holder + stale-or-null heartbeat), task
// rows are mutable between passes, and every runCommand invocation is recorded in order.
function makeHarness(opts: HarnessOpts) {
  let t = T0;
  const commands: string[] = [];
  const logs: string[] = [];
  const conductions = opts.conductions.map((c) => ({ ...c }));
  const tasks = opts.tasks;
  const hooks: { onLaunch?: (cmd: string) => void } = {};

  const deps: SchedulerDeps = {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    leaseHolder: ME,
    config,
    log: (line: string) => logs.push(line),
    listConductions: vi.fn(async (args: { status?: string }) =>
      conductions.filter((c) => !args.status || c.status === args.status).map((c) => ({ ...c })),
    ) as SchedulerDeps['listConductions'],
    getTaskMeta: vi.fn(async (taskId: string) => {
      const row = tasks[taskId];
      if (row instanceof Error) throw row;
      if (!row) throw new Error(`no task ${taskId}`);
      return { ...row };
    }),
    countNonArchivedChildren: vi.fn(async () => opts.childCount ?? 0),
    updateConduction: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = conductions.find((c) => c.id === id);
      if (!row) throw new Error(`no conduction ${id}`);
      Object.assign(row, patch);
      return { ...row };
    }) as SchedulerDeps['updateConduction'],
    takeoverConduction: vi.fn(async (args) => {
      const row = conductions.find((c) => c.id === args.id);
      if (!row || row.status !== 'active') return null;
      if ((row.lease_holder ?? null) !== args.observed_lease_holder) return null;
      if (!(row.last_heartbeat_at == null || row.last_heartbeat_at < args.stale_before)) return null;
      row.lease_holder = args.new_lease_holder;
      row.lease_acquired_at = iso(t);
      row.last_heartbeat_at = iso(t);
      return { ...row };
    }),
    runCommand: vi.fn(async (cmd: string) => {
      commands.push(cmd);
      if (cmd.startsWith('launch')) {
        hooks.onLaunch?.(cmd);
        return { exitCode: opts.launchExitCode === undefined ? 0 : opts.launchExitCode };
      }
      return { exitCode: 0 };
    }),
  };

  return {
    deps,
    commands,
    logs,
    tasks,
    hooks,
    now: () => t,
    setNow: (ms: number) => {
      t = ms;
    },
    getConduction: (id: string) => conductions.find((c) => c.id === id)!,
    launches: () => commands.filter((c) => c.startsWith('launch')),
  };
}

function pausedTask(over: Partial<DaemonTask> = {}): DaemonTask {
  return {
    workflow_state: 'Built',
    awaiting_human_input: true,
    pending_resolution: null,
    active_exchange: null,
    stale: false,
    ...over,
  };
}

describe('runSchedulerPass', () => {
  it('case 1: wake on the flag flip fires the launch command with the substituted conduction id + ticket', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();

    await runSchedulerPass(h.deps, state); // pass 1: captures the baseline (still awaiting) — no fire
    expect(h.commands).toEqual([]);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true; // the worker paused again
    };
    await runSchedulerPass(h.deps, state);
    expect(h.commands).toEqual(['launch cond-1 task-1']);
  });

  it('case 2 (B-611): the discussion-cancelled edge fires with NO flag transition', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: {
        'task-1': pausedTask({ active_exchange: { exchange_id: 'ex-1', status: 'active' } }),
      },
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state); // baseline: awaiting + active exchange

    // The mechanical cancel: the exchange goes away while awaiting_human_input STAYS true.
    (h.tasks['task-1'] as DaemonTask).active_exchange = null;
    await runSchedulerPass(h.deps, state);
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    // Post-exit the ticket is still awaiting (clean pause) — the conduction stays active.
    expect(h.getConduction('cond-1').status).toBe('active');
  });

  it('case 3: a clean-pause exit stores the new baseline and the conduction stays active (no status write, no re-fire)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.workflow_state = 'Designed';
      task.awaiting_human_input = true; // paused on the next gate's brief
    };
    await runSchedulerPass(h.deps, state);
    expect(h.launches()).toHaveLength(1);
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.deps.updateConduction).not.toHaveBeenCalledWith(
      'cond-1',
      expect.objectContaining({ status: expect.anything() }),
    );

    // Nothing changed since the stored post-exit baseline — a further pass must NOT fire again.
    await runSchedulerPass(h.deps, state);
    expect(h.launches()).toHaveLength(1);
  });

  it("case 4 (B-659 class): a dirty exit parks with 'dirty-exit' and there is NO second fire on the next pass", async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchExitCode: 1,
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await runSchedulerPass(h.deps, state); // fires; the worker dies dirty having changed nothing
    expect(h.launches()).toHaveLength(1);
    expect(h.deps.updateConduction).toHaveBeenCalledWith('cond-1', {
      status: 'parked',
      last_worker_exit_code: 1,
      last_worker_exit_class: 'dirty-exit',
    });
    expect(h.getConduction('cond-1').status).toBe('parked');

    // Park-immediately means park-and-STOP: no auto-retry on any later pass.
    await runSchedulerPass(h.deps, state);
    await runSchedulerPass(h.deps, state);
    expect(h.launches()).toHaveLength(1);
    expect(h.getConduction('cond-1').retry_count).toBe(0); // retry_count untouched
  });

  it("case 5: a split-umbrella exit completes the conduction ('completed'/'split-umbrella', never park)", async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      childCount: 2,
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.workflow_state = 'Decomposed';
      task.awaiting_human_input = false;
    };
    await runSchedulerPass(h.deps, state);
    expect(h.deps.countNonArchivedChildren).toHaveBeenCalledWith('task-1');
    expect(h.deps.updateConduction).toHaveBeenCalledWith('cond-1', {
      status: 'completed',
      last_worker_exit_code: 0,
      last_worker_exit_class: 'split-umbrella',
    });
    expect(h.getConduction('cond-1').status).toBe('completed');
  });

  it("case 6: a stale ticket parks the conduction with 'stale' (terminal-only stale constraint)", async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.stale = true;
      task.awaiting_human_input = false;
    };
    await runSchedulerPass(h.deps, state);
    expect(h.deps.updateConduction).toHaveBeenCalledWith('cond-1', {
      status: 'parked',
      last_worker_exit_code: 0,
      last_worker_exit_class: 'stale',
    });
  });

  it('case 7: takeover of a stale lease — CAS attempted, and on the win the REAP runs BEFORE any launch', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000), // 10 min silent ≫ 5-min stale threshold
        }),
      ],
      // The ball is already with the agent: first pickup fires on the pass AFTER the takeover.
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    const state = new Map<string, WatchBaseline>();

    await runSchedulerPass(h.deps, state); // takeover pass: CAS win → reap, fresh baseline
    expect(h.deps.takeoverConduction).toHaveBeenCalledWith({
      id: 'cond-1',
      observed_lease_holder: 'dead-host:9:zzzz9999',
      stale_before: iso(T0 - config.staleMs),
      new_lease_holder: ME,
    });
    expect(h.commands).toEqual(['reap cond-1']);
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);

    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true;
    };
    await runSchedulerPass(h.deps, state); // wake (first pickup) → fire
    // The reap-then-fire ordering: the dead holder's zombie worker is reaped BEFORE we ever launch.
    expect(h.commands).toEqual(['reap cond-1', 'launch cond-1 task-1']);
  });

  it('case 7b: a foreign lease with a FRESH heartbeat loses the CAS (null) — row untouched, nothing fired', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'other-host:2:bbbb2222', last_heartbeat_at: iso(T0 - 1_000) }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state);

    expect(h.deps.takeoverConduction).toHaveBeenCalled(); // CAS attempted…
    expect(h.commands).toEqual([]); // …but lost: no reap, no launch
    expect(h.deps.updateConduction).not.toHaveBeenCalled(); // no heartbeat on a row we do not hold
    expect(h.deps.getTaskMeta).not.toHaveBeenCalled(); // the row is skipped entirely
    expect(h.getConduction('cond-1').lease_holder).toBe('other-host:2:bbbb2222');
  });

  it('case 8: the heartbeat is stamped every pass for held rows, with the pass-time clock', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();

    await runSchedulerPass(h.deps, state);
    expect(h.deps.updateConduction).toHaveBeenCalledWith('cond-1', { last_heartbeat_at: iso(T0) });

    h.setNow(T0 + 25_000);
    await runSchedulerPass(h.deps, state);
    expect(h.deps.updateConduction).toHaveBeenCalledWith('cond-1', {
      last_heartbeat_at: iso(T0 + 25_000),
    });
  });

  it('case 9 (B-651 class): the stale window originates from deps.now() AT PASS TIME, never a construction-time stamp', async () => {
    const h = makeHarness({
      conductions: [
        // A foreign holder heartbeating happily (1s ago relative to the ADVANCED clock).
        conduction({ lease_holder: 'other-host:2:bbbb2222', last_heartbeat_at: iso(T0 + 3_600_000 - 1_000) }),
      ],
      tasks: { 'task-1': pausedTask() },
    });
    const state = new Map<string, WatchBaseline>();

    // Construct first, THEN advance the clock a full hour before the first pass.
    h.setNow(T0 + 3_600_000);
    await runSchedulerPass(h.deps, state);

    // stale_before must be measured from the advanced pass-time clock — a construction-time origin
    // would send iso(T0 - staleMs) and misjudge every row's staleness from then on.
    expect(h.deps.takeoverConduction).toHaveBeenCalledWith(
      expect.objectContaining({ stale_before: iso(T0 + 3_600_000 - config.staleMs) }),
    );
    // The fresh holder is NOT treated as instantly stale: CAS lost, row untouched, nothing fired.
    expect(h.commands).toEqual([]);
    expect(h.getConduction('cond-1').lease_holder).toBe('other-host:2:bbbb2222');
  });

  it('case 10: a throwing getTaskMeta parks NOTHING, skips that row, and the pass still handles the others', async () => {
    const h = makeHarness({
      conductions: [conduction(), conduction({ id: 'cond-2', task_id: 'task-2' })],
      tasks: {
        'task-1': new Error('read blew up'),
        'task-2': pausedTask({ awaiting_human_input: false }),
      },
    });
    const state = new Map<string, WatchBaseline>();

    await runSchedulerPass(h.deps, state); // task-2 baseline captured; task-1 errors, is skipped
    h.hooks.onLaunch = () => {
      (h.tasks['task-2'] as DaemonTask).awaiting_human_input = true;
    };
    await runSchedulerPass(h.deps, state); // task-2 first-pickup fires; task-1 errors again

    expect(h.getConduction('cond-1').status).toBe('active'); // NOT parked by the read error
    expect(h.deps.updateConduction).not.toHaveBeenCalledWith(
      'cond-1',
      expect.objectContaining({ status: expect.anything() }),
    );
    expect(h.logs.some((l) => l.includes('cond-1') && l.includes('read blew up'))).toBe(true);
    expect(h.launches()).toEqual(['launch cond-2 task-2']); // the healthy row still progressed
  });

  it('case 11 (B-696): first claim of a never-held conduction — CAS attempted, NO reap, calm claim log', async () => {
    const h = makeHarness({
      // A fresh conduction: created, never held by any daemon — no worker has ever existed for it.
      conductions: [conduction({ lease_holder: null, last_heartbeat_at: null })],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    const state = new Map<string, WatchBaseline>();

    await runSchedulerPass(h.deps, state); // claim pass: CAS still guards the claim…
    expect(h.deps.takeoverConduction).toHaveBeenCalledWith({
      id: 'cond-1',
      observed_lease_holder: null,
      stale_before: iso(T0 - config.staleMs),
      new_lease_holder: ME,
    });
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    // …but there is nothing to reap — no holder ever launched a worker for this conduction.
    expect(h.commands).toEqual([]);
    // The log reads as a first claim, not a spooky takeover from "(none)".
    expect(h.logs.some((l) => l.includes('cond-1') && /claim/i.test(l))).toBe(true);
    expect(h.logs.some((l) => /took over stale lease/i.test(l))).toBe(false);

    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true;
    };
    await runSchedulerPass(h.deps, state); // wake (first pickup) → fire, still reap-free
    expect(h.commands).toEqual(['launch cond-1 task-1']);
  });
});

describe('isAuthShapedError', () => {
  it('matches the auth-failure shapes and nothing else', () => {
    expect(isAuthShapedError(new Error('JWT expired'))).toBe(true);
    expect(isAuthShapedError(new Error('jwt expired'))).toBe(true);
    expect(isAuthShapedError(new Error('401 Unauthorized'))).toBe(true);
    expect(isAuthShapedError(new Error('Invalid JWT'))).toBe(true);
    expect(isAuthShapedError(new Error('invalid token'))).toBe(true);
    expect(isAuthShapedError(new Error('token abc123 expired'))).toBe(true);
    expect(isAuthShapedError(new Error('network flake'))).toBe(false);
    expect(isAuthShapedError(new Error('read blew up'))).toBe(false);
    expect(isAuthShapedError(new Error('HTTP 4011'))).toBe(false); // \b401\b — not a substring hit
  });
});

// B-696 backstop: the accessToken callback (src/supabase.ts) is the FIX for the JWT zombie; this
// exit is the safety net if auth still fails persistently — exit non-zero so launchd restarts the
// daemon with fresh auth, instead of zombie-looping forever.
describe('runScheduler — persistent auth-failure exit', () => {
  it('throws PersistentAuthFailure after 3 consecutive passes whose listConductions rejects auth-shaped', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    (h.deps as { listConductions: () => Promise<never> }).listConductions = vi.fn(async () => {
      throw new Error('JWT expired');
    });
    const err = await runScheduler(h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersistentAuthFailure);
    expect((err as PersistentAuthFailure).consecutivePasses).toBe(3);
    expect(h.deps.listConductions).toHaveBeenCalledTimes(3); // trips at 3 — does NOT loop forever
  });

  it('throws PersistentAuthFailure when every attempted conduction handling fails auth-shaped for 3 passes', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': new Error('Invalid JWT') },
    });
    const err = await runScheduler(h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersistentAuthFailure);
    expect(h.deps.getTaskMeta).toHaveBeenCalledTimes(3);
  });

  it('a successful pass between failures resets the counter (fail, fail, ok, fail, fail → still running)', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    let pass = 0;
    (h.deps as { listConductions: () => Promise<unknown[]> }).listConductions = vi.fn(async () => {
      pass += 1;
      if (pass === 3) return []; // the OK pass
      throw new Error('JWT expired');
    });
    let sleeps = 0;
    (h.deps as { sleep: () => Promise<void> }).sleep = async () => {
      sleeps += 1;
      if (sleeps >= 5) throw new Error('stop-the-loop');
    };
    // Counter runs 1, 2, reset-to-0, 1, 2 — never 3: the loop is still alive at the 5th sleep.
    await expect(runScheduler(h.deps)).rejects.toThrow('stop-the-loop');
    expect(pass).toBe(5);
  });

  it('non-auth pass errors never trip it (per-conduction isolation unchanged)', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    (h.deps as { listConductions: () => Promise<never> }).listConductions = vi.fn(async () => {
      throw new Error('network flake');
    });
    let sleeps = 0;
    (h.deps as { sleep: () => Promise<void> }).sleep = async () => {
      sleeps += 1;
      if (sleeps >= 5) throw new Error('stop-the-loop');
    };
    await expect(runScheduler(h.deps)).rejects.toThrow('stop-the-loop');
    expect(h.deps.listConductions).toHaveBeenCalledTimes(5); // survived well past 3
  });
});

describe('runScheduler', () => {
  it('loops pass → sleep(pollMs) forever (deterministically broken by a throwing sleep)', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    let sleeps = 0;
    (h.deps as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
      expect(ms).toBe(config.pollMs);
      sleeps += 1;
      if (sleeps >= 3) throw new Error('stop-the-loop');
    };
    await expect(runScheduler(h.deps)).rejects.toThrow('stop-the-loop');
    expect(h.deps.listConductions).toHaveBeenCalledTimes(3); // one pass per sleep
  });
});
