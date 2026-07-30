import { describe, it, expect, vi } from 'vitest';
import {
  runSchedulerPass,
  runScheduler,
  isAuthShapedError,
  PersistentAuthFailure,
  PersistentReapFailure,
  type SchedulerDeps,
  type DaemonTask,
} from './scheduler.js';
import { createHeartbeatKeeper } from './heartbeat.js';
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
    leg_started_at: null,
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
  // B-713: retryCap 0 here reproduces the pre-B-713 immediate-park behavior for every existing
  // test in this file that doesn't opt into retry via HarnessOpts.config below.
  retryCap: 0,
  retryBackoffMs: 15_000,
  workerTimeoutMs: 5_400_000,
  profile: { launch: 'launch {conduction_id} {ticket}', reap: 'reap {conduction_id}' },
};

interface HarnessOpts {
  conductions: ConductionRecord[];
  tasks: Record<string, DaemonTask | Error>;
  launchExitCode?: number | null;
  childCount?: number;
  config?: DaemonConfig;
  /** B-713: per-launch exit codes, consumed in order (falls back to launchExitCode/0 once
   *  exhausted) — lets a test script "dirty, dirty, clean" across retried attempts. */
  launchExitCodes?: Array<number | null>;
  /** B-739: hold the launch pending so a test can watch the daemon WHILE a worker blocks. */
  blockLaunch?: boolean;
  /** B-739: simulate a wedged container runtime — the reap never frees the blocked launch. */
  reapNeverFrees?: boolean;
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

  // B-739 fake timer world — no real setInterval/setTimeout anywhere; tests fire ticks by hand.
  interface FakeTimer {
    ms: number;
    fn: () => void;
    dead: boolean;
  }
  const intervals: FakeTimer[] = [];
  const timeouts: FakeTimer[] = [];

  // A launch that stays pending until the test releases it, so a test can observe what the daemon
  // does WHILE a worker blocks the pass — the entire point of this ticket.
  let releaseLaunch: ((exitCode: number | null) => void) | undefined;

  const cfg = opts.config ?? config;

  const deps: SchedulerDeps = {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    leaseHolder: ME,
    config: opts.config ?? config,
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
    // B-739: the lease-guarded write — applies the patch ONLY while this daemon still holds the
    // lease, returns null when it does not (row/null/throw, mirroring takeoverConduction).
    updateConductionIfHeld: vi.fn(
      async (id: string, expectedLeaseHolder: string, patch: Record<string, unknown>) => {
        const row = conductions.find((c) => c.id === id);
        if (!row || (row.lease_holder ?? null) !== expectedLeaseHolder) return null;
        Object.assign(row, patch);
        return { ...row };
      },
    ) as SchedulerDeps['updateConductionIfHeld'],
    startInterval: (ms: number, fn: () => void) => {
      const timer: FakeTimer = { ms, fn, dead: false };
      intervals.push(timer);
      return () => {
        timer.dead = true;
      };
    },
    startTimeout: (ms: number, fn: () => void) => {
      const timer: FakeTimer = { ms, fn, dead: false };
      timeouts.push(timer);
      return () => {
        timer.dead = true;
      };
    },
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
        if (opts.blockLaunch) {
          return new Promise<{ exitCode: number | null }>((resolve) => {
            releaseLaunch = (exitCode) => resolve({ exitCode });
          });
        }
        if (opts.launchExitCodes && opts.launchExitCodes.length > 0) {
          return { exitCode: opts.launchExitCodes.shift()! };
        }
        return { exitCode: opts.launchExitCode === undefined ? 0 : opts.launchExitCode };
      }
      // A reap FREES a blocked launch — the live-verified behaviour this design rests on: the
      // container's removal is what makes the attached client finally exit (137).
      if (cmd.startsWith('reap') && releaseLaunch && !opts.reapNeverFrees) {
        const free = releaseLaunch;
        releaseLaunch = undefined;
        free(137);
      }
      return { exitCode: 0 };
    }),
  };

  const keeper = createHeartbeatKeeper({
    now: () => t,
    startInterval: deps.startInterval,
    updateConductionIfHeld: (id, patch) => deps.updateConductionIfHeld(id, ME, patch),
    log: (line) => logs.push(line),
    heartbeatMs: cfg.heartbeatMs,
  });

  /** Let pending promise chains settle. Must flush MACROTASKS, not just microtasks: the pass
   *  chain awaits a dozen fakes before it even issues the launch, and the reap escalation is
   *  deliberately fire-and-forget. (Real timers are untouched here — only the DAEMON's timers are
   *  faked, so setTimeout(0) is a safe scheduler yield.) */
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    deps,
    keeper,
    commands,
    logs,
    tasks,
    hooks,
    settle,
    now: () => t,
    setNow: (ms: number) => {
      t = ms;
    },
    getConduction: (id: string) => conductions.find((c) => c.id === id)!,
    launches: () => commands.filter((c) => c.startsWith('launch')),
    reaps: () => commands.filter((c) => c.startsWith('reap')),
    /** Fire every live heartbeat interval once. */
    fireHeartbeats: async () => {
      for (const timer of intervals) if (!timer.dead) timer.fn();
      await settle();
    },
    /** Fire the per-launch deadline (the timeout armed for workerTimeoutMs). */
    fireDeadline: async () => {
      for (const timer of timeouts) {
        if (!timer.dead && timer.ms === cfg.workerTimeoutMs) {
          timer.dead = true;
          timer.fn();
        }
      }
      await settle();
    },
    /** Fire every pending reap-grace timer (REAP_GRACE_MS = 30s). */
    fireReapGrace: async () => {
      for (const timer of timeouts) {
        if (!timer.dead && timer.ms === 30_000) {
          timer.dead = true;
          timer.fn();
        }
      }
      await settle();
    },
    /** How many per-launch deadlines were armed (one per attempt, never per run). */
    armedDeadlines: () => timeouts.filter((timer) => timer.ms === cfg.workerTimeoutMs).length,
    releaseLaunch: async (exitCode: number | null) => {
      releaseLaunch?.(exitCode);
      releaseLaunch = undefined;
      await settle();
    },
    heartbeatWrites: (id: string) =>
      (deps.updateConductionIfHeld as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (c) => c[0] === id && Object.keys(c[2] as object).join() === 'last_heartbeat_at',
      ),
    /** B-742: leg_started_at writes ATTEMPTED by this daemon (set or clear), in call order. */
    legStartedWrites: (id: string) =>
      (deps.updateConductionIfHeld as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .filter((c) => c[0] === id && Object.keys(c[2] as object).join() === 'leg_started_at')
        .map((c) => (c[2] as Record<string, unknown>).leg_started_at as string | null),
    /** Status-write ATTEMPTS (the guarded call is still made when the lease is gone — it just
     *  returns null and lands nothing). Assert on the row itself to prove what actually landed. */
    statusWrites: () =>
      (deps.updateConductionIfHeld as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((c) => c[2] as Record<string, unknown>)
        .filter((p) => 'status' in p),
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

    await runSchedulerPass(h.deps, state, h.keeper); // pass 1: captures the baseline (still awaiting) — no fire
    expect(h.commands).toEqual([]);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true; // the worker paused again
    };
    await runSchedulerPass(h.deps, state, h.keeper);
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
    await runSchedulerPass(h.deps, state, h.keeper); // baseline: awaiting + active exchange

    // The mechanical cancel: the exchange goes away while awaiting_human_input STAYS true.
    (h.tasks['task-1'] as DaemonTask).active_exchange = null;
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    // Post-exit the ticket is still awaiting (clean pause) — the conduction stays active.
    expect(h.getConduction('cond-1').status).toBe('active');
  });

  it('case 3: a clean-pause exit stores the new baseline and the conduction stays active (no status write, no re-fire)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.workflow_state = 'Designed';
      task.awaiting_human_input = true; // paused on the next gate's brief
    };
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.launches()).toHaveLength(1);
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      expect.objectContaining({ status: expect.anything() }),
    );

    // Nothing changed since the stored post-exit baseline — a further pass must NOT fire again.
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.launches()).toHaveLength(1);
  });

  it("case 4 (B-659 class): a dirty exit parks with 'dirty-exit' and there is NO second fire on the next pass", async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchExitCode: 1,
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await runSchedulerPass(h.deps, state, h.keeper); // fires; the worker dies dirty having changed nothing
    expect(h.launches()).toHaveLength(1);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      status: 'parked',
      last_worker_exit_code: 1,
      last_worker_exit_class: 'dirty-exit',
    });
    expect(h.getConduction('cond-1').status).toBe('parked');

    // Park-immediately means park-and-STOP: no auto-retry on any later pass.
    await runSchedulerPass(h.deps, state, h.keeper);
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.launches()).toHaveLength(1);
    expect(h.getConduction('cond-1').retry_count).toBe(0); // retry_count untouched
  });

  const retryConfig: DaemonConfig = { ...config, retryCap: 2, retryBackoffMs: 15_000 };

  it("case 4a (B-713): dirty exit retried, cap exhausted, parks with 'dirty-exit', no further fire after parking", async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: retryConfig,
      launchExitCodes: [1, 1, 1], // every attempt (initial + 2 retries) dies dirty
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await runSchedulerPass(h.deps, state, h.keeper);

    // Initial fire + 2 retries = 3 launches; reap runs before each of the 2 retries.
    expect(h.launches()).toHaveLength(3);
    expect(h.commands.filter((c) => c.startsWith('reap'))).toHaveLength(2);
    expect(h.deps.sleep).toHaveBeenCalledWith(15_000);
    expect(h.getConduction('cond-1').retry_count).toBe(2);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      status: 'parked',
      last_worker_exit_code: 1,
      last_worker_exit_class: 'dirty-exit',
    });
    expect(h.getConduction('cond-1').status).toBe('parked');

    // Cap exhausted → parked-and-stopped, exactly like the no-retry case: no further fire.
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.launches()).toHaveLength(3);
  });

  it('case 4b (B-713): dirty exit retried, succeeds before cap, stays active, retry_count not reset', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: retryConfig,
      launchExitCodes: [1, 0], // first attempt dirty, the retry comes back clean
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      // Only the SECOND (retried) launch resolves the gate — the first dirty attempt changes
      // nothing, so the classifier still sees it as a dirty exit rather than a clean no-progress.
      if (h.launches().length === 2) task.awaiting_human_input = true;
    };
    await runSchedulerPass(h.deps, state, h.keeper);

    expect(h.launches()).toHaveLength(2); // initial dirty attempt + 1 successful retry
    expect(h.commands.filter((c) => c.startsWith('reap'))).toHaveLength(1);
    // retry_count reflects the one retry taken and is NOT reset back to 0 on success.
    expect(h.getConduction('cond-1').retry_count).toBe(1);
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      expect.objectContaining({ status: 'parked' }),
    );
  });

  it('case 4c (B-713): HARMONY_DAEMON_RETRY_CAP=0 reproduces exact pre-B-713 immediate-park behavior', async () => {
    const zeroRetryConfig: DaemonConfig = { ...config, retryCap: 0, retryBackoffMs: 15_000 };
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: zeroRetryConfig,
      launchExitCode: 1,
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await runSchedulerPass(h.deps, state, h.keeper);

    // A single launch, no reap, no sleep, no retry_count bump — identical to the no-retry-config case.
    expect(h.launches()).toHaveLength(1);
    expect(h.commands.filter((c) => c.startsWith('reap'))).toHaveLength(0);
    expect(h.deps.sleep).not.toHaveBeenCalled();
    expect(h.getConduction('cond-1').retry_count).toBe(0);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      status: 'parked',
      last_worker_exit_code: 1,
      last_worker_exit_class: 'dirty-exit',
    });
  });

  it("case 5: a split-umbrella exit completes the conduction ('completed'/'split-umbrella', never park)", async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      childCount: 2,
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.workflow_state = 'Decomposed';
      task.awaiting_human_input = false;
    };
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.deps.countNonArchivedChildren).toHaveBeenCalledWith('task-1');
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      status: 'completed',
      last_worker_exit_code: 0,
      last_worker_exit_class: 'split-umbrella',
    });
    expect(h.getConduction('cond-1').status).toBe('completed');
  });

  it("case 6: a stale ticket parks the conduction with 'stale' (terminal-only stale constraint)", async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.stale = true;
      task.awaiting_human_input = false;
    };
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
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

    await runSchedulerPass(h.deps, state, h.keeper); // takeover pass: CAS win → reap, fresh baseline
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
    await runSchedulerPass(h.deps, state, h.keeper); // wake (first pickup) → fire
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
    await runSchedulerPass(h.deps, state, h.keeper);

    expect(h.deps.takeoverConduction).toHaveBeenCalled(); // CAS attempted…
    expect(h.commands).toEqual([]); // …but lost: no reap, no launch
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalled(); // no heartbeat on a row we do not hold
    expect(h.deps.getTaskMeta).not.toHaveBeenCalled(); // the row is skipped entirely
    expect(h.getConduction('cond-1').lease_holder).toBe('other-host:2:bbbb2222');
  });

  it('case 8: the heartbeat is stamped every pass for held rows, with the pass-time clock', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();

    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, { last_heartbeat_at: iso(T0) });

    h.setNow(T0 + 25_000);
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
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
    await runSchedulerPass(h.deps, state, h.keeper);

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

    await runSchedulerPass(h.deps, state, h.keeper); // task-2 baseline captured; task-1 errors, is skipped
    h.hooks.onLaunch = () => {
      (h.tasks['task-2'] as DaemonTask).awaiting_human_input = true;
    };
    await runSchedulerPass(h.deps, state, h.keeper); // task-2 first-pickup fires; task-1 errors again

    expect(h.getConduction('cond-1').status).toBe('active'); // NOT parked by the read error
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
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

    await runSchedulerPass(h.deps, state, h.keeper); // claim pass: CAS still guards the claim…
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
    await runSchedulerPass(h.deps, state, h.keeper); // wake (first pickup) → fire, still reap-free
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
    const err = await runScheduler(h.deps, h.keeper).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersistentAuthFailure);
    expect((err as PersistentAuthFailure).consecutivePasses).toBe(3);
    expect(h.deps.listConductions).toHaveBeenCalledTimes(3); // trips at 3 — does NOT loop forever
  });

  it('throws PersistentAuthFailure when every attempted conduction handling fails auth-shaped for 3 passes', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': new Error('Invalid JWT') },
    });
    const err = await runScheduler(h.deps, h.keeper).catch((e: unknown) => e);
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
    await expect(runScheduler(h.deps, h.keeper)).rejects.toThrow('stop-the-loop');
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
    await expect(runScheduler(h.deps, h.keeper)).rejects.toThrow('stop-the-loop');
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
    await expect(runScheduler(h.deps, h.keeper)).rejects.toThrow('stop-the-loop');
    expect(h.deps.listConductions).toHaveBeenCalledTimes(3); // one pass per sleep
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-739 — liveness independent of pass progress, and a bounded per-launch deadline.
//
// The defect: the heartbeat was written ONCE per pass, immediately BEFORE a launch that blocks
// for the worker's entire lifetime. With a 5-minute stale window and multi-minute builds, a
// perfectly healthy daemon routinely aged past the takeover threshold and advertised itself as
// reapable — and winning that takeover runs REAP-THEN-FIRE against a container that is still
// running. Observed live at 32.6 minutes (conduction 095397f2, 2026-07-29).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Drive a conduction to the point where its launch is in flight and blocking the pass.
 *
 *  Returns the pending pass WRAPPED IN AN OBJECT on purpose: an async function that returns a
 *  promise has it unwrapped by the caller's `await`, so returning the still-pending pass directly
 *  would make this helper itself never resolve. */
async function blockedOnWorker(h: ReturnType<typeof makeHarness>, state: Map<string, WatchBaseline>) {
  await runSchedulerPass(h.deps, state, h.keeper); // baseline
  (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved → wake
  const pass = runSchedulerPass(h.deps, state, h.keeper);
  await h.settle();
  return { pass };
}

describe('B-739: the heartbeat keeps advancing while a worker blocks the pass', () => {
  it('THE DEFECT REPRO: a blocked launch no longer silences the lease', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    const state = new Map<string, WatchBaseline>();
    const { pass } = await blockedOnWorker(h, state);
    expect(h.launches()).toEqual(['launch cond-1 task-1']); // in flight, pass is blocked
    const before = h.heartbeatWrites('cond-1').length;

    // Time passes well beyond the 5-minute stale window while the worker runs.
    h.setNow(T0 + 600_000);
    await h.fireHeartbeats();
    h.setNow(T0 + 900_000);
    await h.fireHeartbeats();

    // Before this ticket the count would be frozen at `before` for the worker's whole lifetime.
    expect(h.heartbeatWrites('cond-1').length).toBe(before + 2);
    expect(h.getConduction('cond-1').last_heartbeat_at).toBe(iso(T0 + 900_000));

    await h.releaseLaunch(0);
    await pass;
  });

  it('a SECOND held lease keeps stamping while the first is blocked (the serial-pass starvation)', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction(), conduction({ id: 'cond-2', task_id: 'task-2' })],
      tasks: { 'task-1': pausedTask(), 'task-2': pausedTask() },
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper); // both baselines; both leases now kept
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    const pass = runSchedulerPass(h.deps, state, h.keeper);
    await h.settle();

    const before = h.heartbeatWrites('cond-2').length;
    h.setNow(T0 + 600_000);
    await h.fireHeartbeats();

    // cond-2's worker is not even running; the serial pass used to starve it anyway.
    expect(h.heartbeatWrites('cond-2').length).toBe(before + 1);

    await h.releaseLaunch(0);
    await pass;
  });

  it('stops stamping a lease that left the active set (prune mirrors the watch baselines)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.keeper.running()).toEqual(['cond-1']);

    h.getConduction('cond-1').status = 'completed'; // closed elsewhere
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.keeper.running()).toEqual([]);
  });
});

describe('B-739: lease-guarded writes — a daemon that lost its lease goes quiet', () => {
  it('SUPPRESSES the outcome write when the lease was taken over mid-launch (no clobber)', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    const state = new Map<string, WatchBaseline>();
    const { pass } = await blockedOnWorker(h, state);

    // A peer wins the CAS takeover while we are blocked, and reaps our container.
    h.getConduction('cond-1').lease_holder = 'other-daemon:9:zzzz';
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.releaseLaunch(1); // dirty exit, as a reaped worker would look
    await pass;

    // The guarded write IS attempted — and returns null, so nothing lands. What matters is that
    // the new holder's record is untouched: no status, no exit code, no exit class from us.
    const row = h.getConduction('cond-1');
    expect(row.status).toBe('active');
    expect(row.lease_holder).toBe('other-daemon:9:zzzz');
    expect(row.last_worker_exit_code).toBeNull();
    expect(row.last_worker_exit_class).toBeNull();
    expect(h.logs.join(' ')).toMatch(/lease lost/);
  });

  it('stops the heartbeat for a lease it no longer holds', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);
    expect(h.keeper.running()).toEqual(['cond-1']);

    h.getConduction('cond-1').lease_holder = 'other-daemon:9:zzzz';
    await h.fireHeartbeats(); // the guarded write returns null → the keeper discovers the loss

    expect(h.keeper.running()).toEqual([]);
    expect(h.logs.join(' ')).toMatch(/lease no longer held/);
  });
});

describe('B-739: the per-launch deadline is enforced by firing the REAP template', () => {
  it('fires the reap on expiry, and the reap is what frees the launch → worker-timeout park', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: { ...config, retryCap: 2 }, // retry is ENABLED, and must still not engage
    });
    const state = new Map<string, WatchBaseline>();
    const { pass } = await blockedOnWorker(h, state);

    await h.fireDeadline();
    await pass;

    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: 137, last_worker_exit_class: 'worker-timeout' },
    ]);
    // Park on the FIRST timeout: the class is not 'dirty-exit', so B-713's ladder never engages.
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
  });

  it('cancels the deadline on a normal exit — a healthy worker is never reaped', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true;
    };
    await runSchedulerPass(h.deps, state, h.keeper);

    expect(h.reaps()).toEqual([]);
  });

  it('gives each RETRIED attempt its own full deadline (per launch, never per run)', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchExitCodes: [1, 0], // dirty, then clean
      config: { ...config, retryCap: 1 },
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper);
    // No onLaunch hook: launch 1 exits dirty with nothing moved, so B-713's ladder retries it.
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await runSchedulerPass(h.deps, state, h.keeper);

    expect(h.launches()).toHaveLength(2);
    expect(h.armedDeadlines()).toBe(2); // a fresh full deadline per attempt
  });

  it('escalates to PersistentReapFailure when the reap cannot free the daemon', async () => {
    const h = makeHarness({
      blockLaunch: true,
      reapNeverFrees: true, // a wedged container runtime
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    const state = new Map<string, WatchBaseline>();
    const { pass } = await blockedOnWorker(h, state);
    const settled = pass.catch((err: unknown) => err);

    await h.fireDeadline();
    for (let i = 0; i < 4; i += 1) await h.fireReapGrace();

    const err = await settled;
    expect(err).toBeInstanceOf(PersistentReapFailure);
    // Bounded: it does not re-fire forever.
    expect(h.reaps()).toHaveLength(3);
  });

  it('PersistentReapFailure ESCAPES the per-conduction isolation — it must kill the process', async () => {
    // A daemon that cannot free itself must die loudly, not skip the row and keep heartbeating
    // from inside a state it cannot leave. The per-row catch exists for transients; this is not one.
    const h = makeHarness({
      blockLaunch: true,
      reapNeverFrees: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    const state = new Map<string, WatchBaseline>();
    const { pass } = await blockedOnWorker(h, state);
    const settled = pass.then(
      () => 'RESOLVED — the error was swallowed by the pass isolation',
      (err: unknown) => err,
    );

    await h.fireDeadline();
    for (let i = 0; i < 4; i += 1) await h.fireReapGrace();

    expect(await settled).toBeInstanceOf(PersistentReapFailure);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-742 — leg_started_at: stamped fresh immediately before every launch attempt (retries
// included), cleared the instant the launch call returns for ANY reason, both lease-guarded via
// the same writeIfHeld/updateConductionIfHeld path as every other post-claim write.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-742: leg_started_at', () => {
  it('a clean launch sets leg_started_at to the pass-time clock immediately before firing, and clears it once the launch returns', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const state = new Map<string, WatchBaseline>();

    await runSchedulerPass(h.deps, state, h.keeper); // baseline pass — still awaiting, no wake

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true; // the worker paused again
    };
    await runSchedulerPass(h.deps, state, h.keeper);

    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    // The pre-launch set, stamped from the pass-time clock…
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      leg_started_at: iso(T0),
    });
    // …and the post-return clear, both lease-guarded.
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      leg_started_at: null,
    });
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
  });

  const retryConfig: DaemonConfig = { ...config, retryCap: 2, retryBackoffMs: 15_000 };

  it('a B-713 dirty-exit retry sets leg_started_at FRESH on each attempt — no attempt inherits a previous stamp', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: retryConfig,
      launchExitCodes: [1, 0], // initial attempt dies dirty, the retry comes back clean
    });
    const state = new Map<string, WatchBaseline>();
    await runSchedulerPass(h.deps, state, h.keeper); // baseline

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      // Only the SECOND (retried) launch resolves the gate, mirroring case 4b.
      if (h.launches().length === 2) task.awaiting_human_input = true;
    };
    await runSchedulerPass(h.deps, state, h.keeper);

    expect(h.launches()).toHaveLength(2);
    // Set → clear for the initial attempt, then a FRESH set (at the post-backoff clock, never the
    // stale first-attempt stamp) → clear for the retry. Every attempt gets its own set+clear pair.
    expect(h.legStartedWrites('cond-1')).toEqual([
      iso(T0),
      null,
      iso(T0 + retryConfig.retryBackoffMs),
      null,
    ]);
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
  });

  it('a takeover of a stale lease clears leg_started_at right after the reap, as part of the takeover pass itself', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000), // 10 min silent ≫ 5-min stale threshold
          leg_started_at: iso(T0 - 600_000), // the dead holder's leg — never cleared when it died
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    const state = new Map<string, WatchBaseline>();

    await runSchedulerPass(h.deps, state, h.keeper); // takeover pass: CAS win → reap → clear

    // The reap-then-clear ordering: only ONE command ran (the reap) this pass — no launch fired
    // yet — so the clear observed below can only have come from the takeover path, not the
    // launch-return clear (B2/B3), which fires on a LATER pass.
    expect(h.commands).toEqual(['reap cond-1']);
    expect(h.launches()).toEqual([]);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      leg_started_at: null,
    });
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
  });

  it('a lease lost mid-launch: the pre-launch set was lease-guarded, and no leg_started_at write from this daemon lands after the steal', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    const state = new Map<string, WatchBaseline>();
    const { pass } = await blockedOnWorker(h, state);

    // The pre-launch set landed while this daemon still held the lease.
    expect(h.getConduction('cond-1').leg_started_at).toBe(iso(T0));

    // A peer wins the CAS takeover while we are blocked, and reaps our container.
    h.getConduction('cond-1').lease_holder = 'other-daemon:9:zzzz';
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.releaseLaunch(1); // dirty exit, as a reaped worker would look
    await pass;

    // The guarded clear IS attempted (through updateConductionIfHeld) — it just lands nothing,
    // because this daemon no longer holds the lease.
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      leg_started_at: null,
    });
    expect(h.getConduction('cond-1').lease_holder).toBe('other-daemon:9:zzzz');
    // Untouched by us: still the pre-steal value, not cleared.
    expect(h.getConduction('cond-1').leg_started_at).toBe(iso(T0));
  });
});
