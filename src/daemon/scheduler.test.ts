import { describe, it, expect, vi } from 'vitest';
import {
  runSchedulerPass,
  runScheduler,
  createSchedulerRuntime,
  isAuthShapedError,
  PersistentAuthFailure,
  PersistentReapFailure,
  type SchedulerDeps,
  type SchedulerRuntime,
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
    clean_shutdown_at: null,
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
    task_priority: 'medium',
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
  // B-717: 3 concurrent workers / 10-minute aging, matching config.ts's own defaults, so a test
  // that doesn't care about concurrency at all still exercises the real default ceiling.
  maxConcurrentWorkers: 3,
  readyAgeMs: 600_000,
  profile: { launch: 'launch {conduction_id} {ticket}', reap: 'reap {conduction_id}' },
};

/** B-717 restart reconciliation: a profile that also carries the optional `probe` template. */
const reconcilableConfig: DaemonConfig = {
  ...config,
  profile: { ...config.profile, probe: 'probe {conduction_id}' },
};

interface HarnessOpts {
  conductions: ConductionRecord[];
  /** B-723: the deployment's project key the daemon pinned at launch (defaults to this board's). */
  projectKey?: string;
  tasks: Record<string, DaemonTask | Error>;
  launchExitCode?: number | null;
  childCount?: number;
  config?: DaemonConfig;
  /** B-713: per-launch exit codes, consumed in order (falls back to launchExitCode/0 once
   *  exhausted) — lets a test script "dirty, dirty, clean" across retried attempts. Applies to
   *  EVERY conduction's launches, in the GLOBAL order they fire — fine for the single-conduction
   *  retry-ladder tests that use it. */
  launchExitCodes?: Array<number | null>;
  /** B-739: hold EVERY launch pending so a test can watch the daemon WHILE a worker blocks. */
  blockLaunch?: boolean;
  /** Hold only specific conduction ids' launches pending — for multi-conduction concurrency tests
   *  that need SOME workers blocked and others not. */
  blockLaunchIds?: string[];
  /** B-739: simulate a wedged container runtime — the reap never frees the blocked launch. */
  reapNeverFrees?: boolean;
  /** B-761 reopen fix: the exit code a reap call that does NOT free a pending launch returns
   *  (defaults to 0). Lets a test prove the REAP_ATTEMPT_LIMIT escalation loop's attempt-counting /
   *  settlement decisions are driven ENTIRELY by `tracked.settled`, never by whatever exit code a
   *  reap happens to return — irrelevant of the miss-vs-kill exit-code contract change (0/3/other)
   *  the reap scripts themselves now use. */
  reapExitCode?: number | null;
  /** B-717: default probe exit code (0 = found/still running, non-zero = not found) for any
   *  conduction id not given an explicit override via `h.setProbe`. */
  probeDefaultExitCode?: number;
  /** B-792: default return for `deps.probeRef` when no per-ref override was set via
   *  `h.setProbeRefSha` — mirrors probeDefaultExitCode's shape. Defaults to null (no repo
   *  configured / ref not found), matching the real implementation's feature-detect fallback. */
  probeRefDefault?: string | null;
}

// A stateful fake world: conduction rows mutate through updateConduction/takeoverConduction/
// stealConduction (the fakes apply the REAL CAS semantics), task rows are mutable between passes,
// and every runCommand invocation is recorded in order. `pass()` bundles a scheduler pass with a
// full macrotask flush, so a fired-but-not-yet-settled launch is guaranteed genuinely settled (or
// still genuinely pending, for a blocked one) by the time the NEXT `pass()` call inspects it — the
// B-717 two-call rhythm every test below uses: one pass fires (wake → ready → running), the next
// observes settlement and classifies.
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

  // Pending BLOCKED launches, keyed by the conduction id parsed out of the rendered command (the
  // fixture templates always render "launch <conduction_id> <ticket>").
  const pendingLaunches = new Map<string, (result: { exitCode: number | null }) => void>();
  const probeExitCodes = new Map<string, number>();
  const launchExitCodesQueue = opts.launchExitCodes ? [...opts.launchExitCodes] : undefined;
  // B-792: per-ref SHA overrides for deps.probeRef + every call recorded in order (ref, result).
  const probeRefShas = new Map<string, string | null>();
  const probeRefCalls: Array<{ ref: string; result: string | null }> = [];

  const cfg = opts.config ?? config;
  const condId = (cmd: string): string => cmd.split(' ')[1] ?? '';

  const state = new Map<string, WatchBaseline>();
  const runtime: SchedulerRuntime = createSchedulerRuntime();

  const deps: SchedulerDeps = {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    leaseHolder: ME,
    projectKey: opts.projectKey ?? 'B',
    config: cfg,
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
      // B-761: the real CAS's widened guard — stale heartbeat OR a non-null clean_shutdown_at
      // marker (a same-host successor of a DELIBERATE exit adopts immediately).
      const staleByHeartbeat = row.last_heartbeat_at == null || row.last_heartbeat_at < args.stale_before;
      const cleanlyShutDown = row.clean_shutdown_at != null;
      if (!(staleByHeartbeat || cleanlyShutDown)) return null;
      row.lease_holder = args.new_lease_holder;
      row.lease_acquired_at = iso(t);
      row.last_heartbeat_at = iso(t);
      row.clean_shutdown_at = null; // single-use: cleared on the same write that reassigns the lease
      return { ...row };
    }),
    // B-717 item 3: mirrors takeoverConduction's CAS shape, guarded on leg_started_at IS NULL
    // instead of staleness.
    stealConduction: vi.fn(async (args) => {
      const row = conductions.find((c) => c.id === args.id);
      if (!row || row.status !== 'active') return null;
      if (row.lease_holder !== args.observed_lease_holder) return null;
      if (row.leg_started_at !== null) return null;
      row.lease_holder = args.new_lease_holder;
      row.lease_acquired_at = iso(t);
      row.last_heartbeat_at = iso(t);
      return { ...row };
    }),
    runCommand: vi.fn(async (cmd: string, _opts?: { quiet?: boolean }) => {
      commands.push(cmd);
      const id = condId(cmd);
      if (cmd.startsWith('launch')) {
        hooks.onLaunch?.(cmd);
        if (opts.blockLaunch || opts.blockLaunchIds?.includes(id)) {
          return new Promise<{ exitCode: number | null }>((resolve) => {
            pendingLaunches.set(id, resolve);
          });
        }
        if (launchExitCodesQueue && launchExitCodesQueue.length > 0) {
          return { exitCode: launchExitCodesQueue.shift()! };
        }
        return { exitCode: opts.launchExitCode === undefined ? 0 : opts.launchExitCode };
      }
      if (cmd.startsWith('probe')) {
        const code = probeExitCodes.has(id) ? probeExitCodes.get(id)! : (opts.probeDefaultExitCode ?? 1);
        return { exitCode: code };
      }
      // A reap FREES a blocked launch for that SAME conduction — the live-verified behaviour this
      // design rests on: the container's removal is what makes the attached client finally exit.
      if (cmd.startsWith('reap')) {
        const resolve = pendingLaunches.get(id);
        if (resolve && !opts.reapNeverFrees) {
          pendingLaunches.delete(id);
          resolve({ exitCode: 137 });
        }
        // B-761 reopen fix: the reap COMMAND's own return value (as distinct from what it does to
        // the pending launch above) is configurable per-test — the REAP_ATTEMPT_LIMIT loop must
        // never care what this is.
        return { exitCode: opts.reapExitCode === undefined ? 0 : opts.reapExitCode };
      }
      return { exitCode: 0 };
    }),
    // B-792: a LIVE head-SHA probe of a ref — per-ref override via setProbeRefSha, else
    // probeRefDefault (defaults to null, matching the real "no repo configured" fallback). Every
    // call is recorded in order so a test can assert it fired at fire AND settle with the expected
    // resolved ref.
    probeRef: vi.fn(async (ref: string) => {
      const result = probeRefShas.has(ref) ? (probeRefShas.get(ref) ?? null) : (opts.probeRefDefault ?? null);
      probeRefCalls.push({ ref, result });
      return result;
    }),
  };

  const keeper = createHeartbeatKeeper({
    now: () => t,
    startInterval: deps.startInterval,
    updateConductionIfHeld: (id, patch) => deps.updateConductionIfHeld(id, ME, patch),
    log: (line) => logs.push(line),
    heartbeatMs: cfg.heartbeatMs,
  });

  /** Let pending promise chains settle. Must flush MACROTASKS, not just microtasks. (Real timers
   *  are untouched here — only the DAEMON's timers are faked, so setTimeout(0) is a safe yield.) */
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    deps,
    keeper,
    state,
    runtime,
    commands,
    logs,
    tasks,
    hooks,
    settle,
    now: () => t,
    setNow: (ms: number) => {
      t = ms;
    },
    /** ONE scheduler pass, followed by a full flush — see the function-header rhythm note. */
    pass: async () => {
      const result = await runSchedulerPass(deps, state, keeper, runtime);
      await settle();
      return result;
    },
    getConduction: (id: string) => conductions.find((c) => c.id === id)!,
    launches: () => commands.filter((c) => c.startsWith('launch')),
    reaps: () => commands.filter((c) => c.startsWith('reap')),
    probes: () => commands.filter((c) => c.startsWith('probe')),
    /** B-761: every runCommand call's (cmd, opts) pair, in call order — lets a test assert quiet
     *  mode was requested at EXACTLY one call site and nowhere else. */
    runCommandCalls: () =>
      (deps.runCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls as Array<
        [string, { quiet?: boolean } | undefined]
      >,
    ready: () => [...runtime.ready.keys()],
    running: () => [...runtime.running.keys()],
    setProbe: (conductionId: string, exitCode: number) => probeExitCodes.set(conductionId, exitCode),
    // B-792: pre-arm what deps.probeRef(ref) resolves to for a specific ref, plus a read-only view
    // of every call made (in order) — see the deps.probeRef fake above.
    setProbeRefSha: (ref: string, sha: string | null) => probeRefShas.set(ref, sha),
    probeRefCalls: () => [...probeRefCalls],
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
    releaseLaunch: async (exitCode: number | null, conductionId = 'cond-1') => {
      const resolve = pendingLaunches.get(conductionId);
      pendingLaunches.delete(conductionId);
      resolve?.({ exitCode });
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

/** Baseline pass, then the human resolves and the pending wake fires (queued → fired, since a
 *  fresh harness always has a free slot). Returns after the SECOND pass, i.e. the launch is
 *  in flight/settled but NOT yet classified — a THIRD pass (or an explicit releaseLaunch + pass)
 *  observes settlement. Mirrors the B-717 two-call rhythm the harness header documents. */
async function wakeAndFire(h: ReturnType<typeof makeHarness>): Promise<void> {
  await h.pass(); // baseline (still awaiting) — no wake
  (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved
  await h.pass(); // wake detected → queued → fired this same pass (a slot is free)
}

describe('runSchedulerPass — wake, fire, and settle (fire-and-track)', () => {
  it('case 1: wake on the flag flip queues then fires the launch command with the substituted conduction id + ticket', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });

    await h.pass(); // pass 1: captures the baseline (still awaiting) — no fire
    expect(h.commands).toEqual([]);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved
    await h.pass();
    expect(h.commands).toEqual(['launch cond-1 task-1']);
    expect(h.running()).toEqual(['cond-1']); // fired, tracked, not yet classified
    expect(h.ready()).toEqual([]);
  });

  it('B-743: the launch template\'s {run_config_json} placeholder is rendered from the CONDUCTION ROW\'S OWN run_config, base64-encoded JSON.stringify\'d', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { session_resume: { enabled: true } } })],
      tasks: { 'task-1': pausedTask() },
      config: {
        ...config,
        profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --run-config '{run_config_json}'" },
      },
    });
    await wakeAndFire(h);
    const encoded = Buffer.from(JSON.stringify({ session_resume: { enabled: true } }), 'utf8').toString(
      'base64',
    );
    expect(h.launches()).toEqual([`launch cond-1 task-1 --run-config '${encoded}'`]);
  });

  it('B-718: a conduction row with NO run_config renders {run_config_json} as the base64 of the empty object, matching the pre-B-718 hardcoded default', async () => {
    const h = makeHarness({
      conductions: [conduction()], // run_config left undefined, same as every pre-B-718 row
      tasks: { 'task-1': pausedTask() },
      config: {
        ...config,
        profile: { ...config.profile, launch: "launch {conduction_id} --run-config '{run_config_json}'" },
      },
    });
    await wakeAndFire(h);
    const encoded = Buffer.from('{}', 'utf8').toString('base64');
    expect(h.launches()).toEqual([`launch cond-1 --run-config '${encoded}'`]);
  });

  it('B-743: a run_config.note containing a single quote round-trips through {run_config_json} WITHOUT throwing — the blocker this ticket removes', async () => {
    const noteWithApostrophe = "don't touch the migration file, it's already reviewed";
    const h = makeHarness({
      conductions: [conduction({ run_config: { note: noteWithApostrophe } })],
      tasks: { 'task-1': pausedTask() },
      config: {
        ...config,
        profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --run-config '{run_config_json}'" },
      },
    });
    await wakeAndFire(h);
    const encoded = Buffer.from(JSON.stringify({ note: noteWithApostrophe }), 'utf8').toString('base64');
    // The shell-facing launch command never carries a raw single quote from the note — only the
    // base64 alphabet, safe unescaped inside the template's own single-quoted literal.
    expect(h.launches()).toEqual([`launch cond-1 task-1 --run-config '${encoded}'`]);
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(decoded).toEqual({ note: noteWithApostrophe });
  });

  it('B-718 reopen: warns loudly (but still fires the launch) when the conduction has a non-empty run_config and the ACTIVE launch template has no {run_config_json} placeholder', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { session_resume: { enabled: true } } })],
      tasks: { 'task-1': pausedTask() },
      // Deliberately no {run_config_json} in this template — the shape that shipped B-718 as a
      // silent no-op on the one live deployment profile.
      config: { ...config, profile: { ...config.profile, launch: 'launch {conduction_id} {ticket}' } },
    });
    await wakeAndFire(h);
    // The launch still fires — this is a WARN, never a block.
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    const warning = h.logs.find(
      (line) => line.includes('run_config') && /will NOT reach the worker/i.test(line),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain('cond-1');
  });

  it('B-718 reopen: does NOT warn when run_config is empty/absent, even with a template lacking {run_config_json}', async () => {
    const h = makeHarness({
      conductions: [conduction()], // run_config left undefined
      tasks: { 'task-1': pausedTask() },
      config: { ...config, profile: { ...config.profile, launch: 'launch {conduction_id} {ticket}' } },
    });
    await wakeAndFire(h);
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(h.logs.some((line) => /will NOT reach the worker/i.test(line))).toBe(false);
  });

  it('B-718 reopen: does NOT warn when the template DOES carry {run_config_json}, even with a non-empty run_config', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { session_resume: { enabled: true } } })],
      tasks: { 'task-1': pausedTask() },
      config: {
        ...config,
        profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --run-config '{run_config_json}'" },
      },
    });
    await wakeAndFire(h);
    expect(h.logs.some((line) => /will NOT reach the worker/i.test(line))).toBe(false);
  });

  describe('B-772: {model} template substitution — the daemon-resolved per-gate model', () => {
    it('level 1: a per_gate override for the resolved gate is substituted into {model}', async () => {
      const h = makeHarness({
        conductions: [
          conduction({ run_config: { model: { per_gate: { release: 'per-gate-release-model' } } } }),
        ],
        // pausedTask() defaults workflow_state to 'Built' — gate 'release'.
        tasks: { 'task-1': pausedTask() },
        config: {
          ...config,
          profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --model '{model}'" },
        },
      });
      await wakeAndFire(h);
      expect(h.launches()).toEqual([`launch cond-1 task-1 --model 'per-gate-release-model'`]);
    });

    it('level 1 does not apply to a DIFFERENT gate — falls through to level 2 (model.default)', async () => {
      const h = makeHarness({
        conductions: [
          conduction({
            run_config: {
              model: { default: 'run-default-model', per_gate: { build: 'per-gate-build-model' } },
            },
          }),
        ],
        // 'Built' -> gate 'release', which has no per_gate entry above.
        tasks: { 'task-1': pausedTask() },
        config: {
          ...config,
          profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --model '{model}'" },
        },
      });
      await wakeAndFire(h);
      expect(h.launches()).toEqual([`launch cond-1 task-1 --model 'run-default-model'`]);
    });

    it('level 2: model.default is substituted when the conduction row carries no per_gate at all', async () => {
      const h = makeHarness({
        conductions: [conduction({ run_config: { model: { default: 'run-default-model' } } })],
        tasks: { 'task-1': pausedTask() },
        config: {
          ...config,
          profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --model '{model}'" },
        },
      });
      await wakeAndFire(h);
      expect(h.launches()).toEqual([`launch cond-1 task-1 --model 'run-default-model'`]);
    });

    it('level 3: an empty/absent run_config substitutes the pinned per-deployment-profile default', async () => {
      const originalUrl = process.env.HARMONY_SUPABASE_URL;
      process.env.HARMONY_SUPABASE_URL = 'https://eioxsunvhakmelhanmnn.supabase.co'; // the prod ref
      try {
        const h = makeHarness({
          conductions: [conduction()], // run_config left undefined entirely
          tasks: { 'task-1': pausedTask() },
          config: {
            ...config,
            profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --model '{model}'" },
          },
        });
        await wakeAndFire(h);
        expect(h.launches()).toEqual([`launch cond-1 task-1 --model 'claude-sonnet-5'`]);
      } finally {
        if (originalUrl === undefined) delete process.env.HARMONY_SUPABASE_URL;
        else process.env.HARMONY_SUPABASE_URL = originalUrl;
      }
    });

    it('{model} is harmless (never throws) when the active launch template does not reference it at all', async () => {
      const h = makeHarness({
        conductions: [conduction({ run_config: { model: { default: 'run-default-model' } } })],
        tasks: { 'task-1': pausedTask() },
        // No {model} placeholder in this template — same "always computed upstream, only
        // substituted where referenced" convention {run_config_json} already relies on.
        config,
      });
      await wakeAndFire(h);
      expect(h.launches()).toEqual(['launch cond-1 task-1']);
    });

    it('resolves the gate from the CURRENT task read at fire time (Planned -> build gate)', async () => {
      const h = makeHarness({
        conductions: [
          conduction({ run_config: { model: { per_gate: { build: 'per-gate-build-model' } } } }),
        ],
        tasks: { 'task-1': pausedTask({ workflow_state: 'Planned' }) },
        config: {
          ...config,
          profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --model '{model}'" },
        },
      });
      await wakeAndFire(h);
      expect(h.launches()).toEqual([`launch cond-1 task-1 --model 'per-gate-build-model'`]);
    });
  });

  it('a clean-pause exit is classified and the baseline stored ONLY once the launch settles, on a LATER pass', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await wakeAndFire(h);
    expect(h.launches()).toHaveLength(1);
    // The worker exits 0 immediately (default fake) and pauses again — but classification needs
    // ANOTHER pass to observe the settlement.
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true;
    expect(h.getConduction('cond-1').status).toBe('active');

    await h.pass(); // observes settlement, classifies 'wait', stores the post-exit baseline
    expect(h.running()).toEqual([]);
    expect(h.getConduction('cond-1').status).toBe('active');
  });

  it('case 2 (B-611): the discussion-cancelled edge fires with NO flag transition', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: {
        'task-1': pausedTask({ active_exchange: { exchange_id: 'ex-1', status: 'active' } }),
      },
    });
    await h.pass(); // baseline: awaiting + active exchange

    // The mechanical cancel: the exchange goes away while awaiting_human_input STAYS true.
    (h.tasks['task-1'] as DaemonTask).active_exchange = null;
    await h.pass(); // wake → fire
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    await h.pass(); // settle → classify
    // Post-exit the ticket is still awaiting (clean pause) — the conduction stays active.
    expect(h.getConduction('cond-1').status).toBe('active');
  });

  it('case 3: a clean-pause exit stores the new baseline and the conduction stays active (no status write, no re-fire)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    hooksOnLaunchPausesAgain(h);
    await h.pass(); // fire
    await h.pass(); // settle → classify 'wait'
    expect(h.launches()).toHaveLength(1);
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
      expect.objectContaining({ status: expect.anything() }),
    );

    // Nothing changed since the stored post-exit baseline — a further pass must NOT fire again.
    await h.pass();
    expect(h.launches()).toHaveLength(1);
  });

  it("case 4 (B-659 class): a dirty exit parks with 'dirty-exit' and there is NO second fire on the next pass", async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchExitCode: 1,
    });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // fires; the worker dies dirty having changed nothing
    await h.pass(); // settle → classify 'park'/'dirty-exit'
    expect(h.launches()).toHaveLength(1);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      status: 'parked',
      last_worker_exit_code: 1,
      last_worker_exit_class: 'dirty-exit',
    });
    expect(h.getConduction('cond-1').status).toBe('parked');

    // Park-immediately means park-and-STOP: no auto-retry on any later pass.
    await h.pass();
    await h.pass();
    expect(h.launches()).toHaveLength(1);
    expect(h.getConduction('cond-1').retry_count).toBe(0); // retry_count untouched
  });

  const retryConfig: DaemonConfig = { ...config, retryCap: 2, retryBackoffMs: 15_000 };

  it("case 4a (B-713/B-717): dirty exit retried with EXPONENTIAL backoff, cap exhausted, parks with 'dirty-exit'", async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: retryConfig,
      launchExitCodes: [1, 1, 1], // every attempt (initial + 2 retries) dies dirty
    });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // fire 1
    await h.pass(); // settle 1 (dirty) → reap → QUEUE retry gated by notBefore = t + 15_000

    expect(h.launches()).toHaveLength(1);
    expect(h.reaps()).toHaveLength(1);
    expect(h.getConduction('cond-1').retry_count).toBe(1);
    expect(h.deps.sleep).not.toHaveBeenCalled(); // B-717: no blocking sleep — a ready gate instead
    expect(h.ready()).toEqual(['cond-1']);

    // Not yet due — a pass before the backoff elapses must not re-fire.
    await h.pass();
    expect(h.launches()).toHaveLength(1);

    h.setNow(h.now() + 15_000); // first backoff: base * 2**0 = 15_000ms
    await h.pass(); // fire 2 (now due)
    await h.pass(); // settle 2 (dirty) → reap → QUEUE retry gated by notBefore = t + 30_000
    expect(h.launches()).toHaveLength(2);
    expect(h.getConduction('cond-1').retry_count).toBe(2);

    h.setNow(h.now() + 30_000); // second backoff: base * 2**1 = 30_000ms — EXPONENTIAL, not flat
    await h.pass(); // fire 3
    await h.pass(); // settle 3 (dirty, cap exhausted) → park
    expect(h.launches()).toHaveLength(3);
    expect(h.reaps()).toHaveLength(2);
    expect(h.getConduction('cond-1').retry_count).toBe(2);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      status: 'parked',
      last_worker_exit_code: 1,
      last_worker_exit_class: 'dirty-exit',
    });
    expect(h.getConduction('cond-1').status).toBe('parked');

    // Cap exhausted → parked-and-stopped: no further fire.
    await h.pass();
    expect(h.launches()).toHaveLength(3);
  });

  it('case 4b (B-713): dirty exit retried, succeeds before cap, stays active, retry_count not reset', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: retryConfig,
      launchExitCodes: [1, 0], // first attempt dirty, the retry comes back clean
    });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      // Only the SECOND (retried) launch resolves the gate — the first dirty attempt changes
      // nothing, so the classifier still sees it as a dirty exit rather than a clean no-progress.
      if (h.launches().length === 2) (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true;
    };
    await h.pass(); // fire 1
    await h.pass(); // settle 1 (dirty) → queue retry

    h.setNow(h.now() + 15_000);
    await h.pass(); // fire 2 (retry)
    await h.pass(); // settle 2 (clean, progressed) → 'wait'

    expect(h.launches()).toHaveLength(2); // initial dirty attempt + 1 successful retry
    expect(h.reaps()).toHaveLength(1);
    // retry_count reflects the one retry taken and is NOT reset back to 0 on success.
    expect(h.getConduction('cond-1').retry_count).toBe(1);
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
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
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();

    // A single launch, no reap, no re-queue, no retry_count bump — identical to the no-retry-config case.
    expect(h.launches()).toHaveLength(1);
    expect(h.reaps()).toHaveLength(0);
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
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.workflow_state = 'Decomposed';
      task.awaiting_human_input = false;
    };
    await h.pass(); // fire
    await h.pass(); // settle → classify
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
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.stale = true;
      task.awaiting_human_input = false;
    };
    await h.pass();
    await h.pass();
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

    await h.pass(); // takeover pass: CAS win → reap, fresh baseline
    expect(h.deps.takeoverConduction).toHaveBeenCalledWith({
      id: 'cond-1',
      observed_lease_holder: 'dead-host:9:zzzz9999',
      stale_before: iso(T0 - config.staleMs),
      new_lease_holder: ME,
    });
    expect(h.commands).toEqual(['reap cond-1']);
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);

    await h.pass(); // wake (first pickup) → fire
    // The reap-then-fire ordering: the dead holder's zombie worker is reaped BEFORE we ever launch.
    expect(h.commands).toEqual(['reap cond-1', 'launch cond-1 task-1']);
  });

  it('case 7b: a foreign lease with a FRESH heartbeat loses the CAS (null) — no takeover, and no steal without a wake', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'other-host:2:bbbb2222', last_heartbeat_at: iso(T0 - 1_000) }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    await h.pass(); // first sight of a foreign row: no baseline yet ⇒ no steal-eligible wake either

    expect(h.deps.takeoverConduction).toHaveBeenCalled(); // CAS attempted…
    expect(h.commands).toEqual([]); // …but lost: no reap, no launch, no steal win
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalled(); // no heartbeat on a row we do not hold
    expect(h.getConduction('cond-1').lease_holder).toBe('other-host:2:bbbb2222');
  });

  it('case 8: the heartbeat is stamped every pass for held rows, with the pass-time clock', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });

    await h.pass();
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, { last_heartbeat_at: iso(T0) });

    h.setNow(T0 + 25_000);
    await h.pass();
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

    // Construct first, THEN advance the clock a full hour before the first pass.
    h.setNow(T0 + 3_600_000);
    await h.pass();

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

    await h.pass(); // task-2 baseline captured; task-1 errors, is skipped
    await h.pass(); // task-2 first-pickup fires; task-1 errors again

    expect(h.getConduction('cond-1').status).toBe('active'); // NOT parked by the read error
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
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

    await h.pass(); // claim pass: CAS still guards the claim…
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

    await h.pass(); // wake (first pickup) → fire, still reap-free
    expect(h.commands).toEqual(['launch cond-1 task-1']);
  });

  it('case 12 (B-691 class): a pause that appears AFTER the baseline still wakes — the stored baseline ROLLS on a no-wake pass', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: {
        'task-1': pausedTask({
          awaiting_human_input: false,
          active_exchange: { exchange_id: 'ex-1', status: 'active', round: 0 },
        }),
      },
    });

    await h.pass(); // FIRST SIGHT: captures the baseline, no wake detection yet.
    expect(h.commands).toEqual([]);

    await h.pass(); // the ball is the agent's — a leg must fire.
    expect(h.commands).toEqual(['launch cond-1 task-1']);
  });

  it('case 12b (B-691 class): a no-wake pass ROLLS the stored baseline instead of leaving it pinned to first sight', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ workflow_state: 'Proposed' }) },
    });

    await h.pass(); // first sight — baseline captured
    expect(h.state.get('cond-1')?.activeExchange ?? null).toBeNull();

    (h.tasks['task-1'] as DaemonTask).active_exchange = { exchange_id: 'ex-1', status: 'active', round: 1 };
    await h.pass();

    expect(h.commands).toEqual([]); // no wake — the human still holds the ball
    expect(h.state.get('cond-1')?.activeExchange).toEqual({
      exchange_id: 'ex-1',
      status: 'active',
      round: 1,
    });
  });

  it('case 13 (B-756): a non-null conductor_excluded_at skips the fire on a pass that would otherwise wake', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true, conductor_excluded_at: null }) },
    });

    await h.pass(); // first sight: baseline captured, no wake detection yet.
    expect(h.commands).toEqual([]);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).conductor_excluded_at = '2026-08-01T00:00:00.000Z';

    await h.pass();
    expect(h.commands).toEqual([]); // no launch — the exclusion guard skipped the fire
    expect(h.ready()).toEqual([]);
  });

  it('case 13b (B-756): clearing conductor_excluded_at back to null lets the pending wake fire normally', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true, conductor_excluded_at: null }) },
    });

    await h.pass(); // first sight — baseline captured

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).conductor_excluded_at = '2026-08-01T00:00:00.000Z';
    await h.pass();
    expect(h.commands).toEqual([]);

    (h.tasks['task-1'] as DaemonTask).conductor_excluded_at = null;
    await h.pass();
    expect(h.commands).toEqual(['launch cond-1 task-1']);
  });

  it('case 13c (B-771): the take-away line logs exactly once across 3+ consecutive excluded passes, not on every pass', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true, conductor_excluded_at: null }) },
    });
    const takeAwayLines = () =>
      h.logs.filter((l) => l.includes('taken away from conductor (conductor_excluded_at set)'));

    await h.pass(); // pass 1: first sight

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).conductor_excluded_at = '2026-08-01T00:00:00.000Z';
    await h.pass();
    expect(takeAwayLines()).toHaveLength(1);

    await h.pass();
    await h.pass();
    await h.pass();
    expect(takeAwayLines()).toHaveLength(1); // still exactly once, total
    expect(h.commands).toEqual([]); // never fired
  });

  it('case 13d (B-771): the return-to-conductor line logs exactly once when conductor_excluded_at clears', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true, conductor_excluded_at: null }) },
    });
    const returnLines = () =>
      h.logs.filter((l) => l.includes('returned to conductor (conductor_excluded_at cleared)'));

    await h.pass(); // pass 1: first sight

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).conductor_excluded_at = '2026-08-01T00:00:00.000Z';
    await h.pass();
    expect(returnLines()).toHaveLength(0);

    (h.tasks['task-1'] as DaemonTask).conductor_excluded_at = null;
    await h.pass(); // the return line logs AND the pending wake fires, same pass
    expect(returnLines()).toHaveLength(1);
    expect(h.commands).toEqual(['launch cond-1 task-1']);

    await h.pass(); // settle → 'wait' (worker exits 0 clean by default, nothing progressed though)
    h.hooks.onLaunch = undefined;
    expect(returnLines()).toHaveLength(1); // still exactly once, total
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-792: the clean-exit contract — the repo-progress probe (bracketing fire and settle) and the
// widened board-progress `progressed` formula (active_brief_iteration / knowledge_reference_count /
// a consumed marker), plus the distinguishable 'repo-active-board-silent' park reason that follows
// when repo work landed but the board stayed silent.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-792: the repo-progress probe (deps.probeRef, bracketing fire and settle)', () => {
  it('resolves build_pr.branch over work_branch.branch when both are present, probes it at fire, stores preFireHeadSha, and probes the SAME ref again at settle', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: {
        'task-1': pausedTask({
          field_values: {
            build_pr: { branch: 'feat/pr-branch', head_sha: 'stale-recorded-sha' },
            work_branch: { branch: 'feat/wip-branch' },
          },
        }),
      },
    });
    h.setProbeRefSha('feat/pr-branch', 'sha-A');
    await h.pass(); // baseline

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // wake
    await h.pass(); // fire
    expect(h.probeRefCalls()).toEqual([{ ref: 'feat/pr-branch', result: 'sha-A' }]);
    expect(h.runtime.running.get('cond-1')?.preFireHeadSha).toBe('sha-A');

    // The worker pushes a commit mid-leg — the branch head moves — with no board write at all
    // (field_values.build_pr.head_sha is untouched — the exact B-758 rebase-push blind spot).
    h.setProbeRefSha('feat/pr-branch', 'sha-B');
    await h.pass(); // settle → classify

    expect(h.probeRefCalls()).toEqual([
      { ref: 'feat/pr-branch', result: 'sha-A' },
      { ref: 'feat/pr-branch', result: 'sha-B' },
    ]);
    // repoProgressed=true, progressed=false (nothing else moved) ⇒ the DISTINGUISHABLE park reason.
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('repo-active-board-silent');
  });

  it('an UNCHANGED SHA at settle ⇒ repoProgressed=false — still the plain no-progress park', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ field_values: { work_branch: { branch: 'feat/foo' } } }) },
    });
    h.setProbeRefSha('feat/foo', 'sha-same');
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // fire
    await h.pass(); // settle — the branch never moved

    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
  });

  it('no build_pr/work_branch on the ticket ⇒ probeRef is never called, preFireHeadSha is null, repoProgressed=false', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // fire
    expect(h.runtime.running.get('cond-1')?.preFireHeadSha).toBeNull();
    expect(h.probeRefCalls()).toEqual([]);

    await h.pass(); // settle
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress'); // never repo-active-board-silent
    expect(h.probeRefCalls()).toEqual([]); // still never called — nothing to probe at settle either
  });

  it('a probe that finds NOTHING (null) at settle ⇒ repoProgressed=false, never treated as progress', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ field_values: { work_branch: { branch: 'feat/foo' } } }) },
    });
    h.setProbeRefSha('feat/foo', 'sha-A'); // found at fire
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // fire — preFireHeadSha = 'sha-A'

    h.setProbeRefSha('feat/foo', null); // the settle-time probe finds nothing (e.g. a transient error)
    await h.pass(); // settle

    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
  });

  it('repoProgressed never overrides genuine board progress — a workflow_state advance still classifies on its own terms, not as a park at all', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ field_values: { work_branch: { branch: 'feat/foo' } } }) },
    });
    h.setProbeRefSha('feat/foo', 'sha-A');
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).workflow_state = 'Verified'; // genuine board progress too
    };
    await h.pass(); // fire
    h.setProbeRefSha('feat/foo', 'sha-B'); // the branch ALSO moved
    await h.pass(); // settle

    expect(h.getConduction('cond-1').status).toBe('completed'); // terminal wins outright — not a park
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('terminal');
  });
});

describe('B-792: the widened `progressed` formula — a board signal alone is enough, never misread as no-progress', () => {
  it('active_brief_iteration bumped alone (no workflow_state/awaiting_human_input delta) ⇒ progressed=true, stays active', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ active_brief_iteration: 1 }) },
    });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).active_brief_iteration = 2; // an in-place brief iterate
    };
    await h.pass(); // fire
    await h.pass(); // settle

    expect(h.getConduction('cond-1').status).toBe('active'); // never parked as no-progress
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
      expect.objectContaining({ status: 'parked' }),
    );
  });

  it('knowledge_reference_count bumped alone ⇒ progressed=true, stays active', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ knowledge_reference_count: 0 }) },
    });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).knowledge_reference_count = 1; // recorded + referenced knowledge
    };
    await h.pass(); // fire
    await h.pass(); // settle

    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
      expect.objectContaining({ status: 'parked' }),
    );
  });

  it('a pending_resolution marker present at fire, CONSUMED by settle (nulled, no flag flip) ⇒ progressed=true, stays active', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ pending_resolution: { command: 'iterate', detail: 'narrow scope' } }) },
    });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).pending_resolution = null; // consumed
    };
    await h.pass(); // fire
    await h.pass(); // settle

    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
      expect.objectContaining({ status: 'parked' }),
    );
  });

  it('an active exchange marker present at fire, gone by settle (exchangeWentInactive, no flag flip) ⇒ progressed=true, stays active', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ active_exchange: { exchange_id: 'ex-1', status: 'active' } }) },
    });
    await h.pass(); // baseline: awaiting + active exchange

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // wake
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).active_exchange = null; // consumed, no flag flip
    };
    await h.pass(); // fire
    await h.pass(); // settle

    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
      expect.objectContaining({ status: 'parked' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-761 — a same-host successor adopts a DELIBERATELY shut-down lease immediately (no staleness
// wait), an unclean death still waits the full window unchanged, a foreign live peer is never
// adopted, the wait is announced once per transition, and the routine reap-miss renders quietly.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-761: clean-shutdown adoption + the dead-lease wait announcement', () => {
  it('a same-host clean-shutdown marker is adopted IMMEDIATELY — no staleness wait, even with a FRESH heartbeat', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'this-host:1:dead0000', // a prior instance of THIS same host
          last_heartbeat_at: iso(T0 - 1_000), // fresh — nowhere near the 5-minute stale window
          clean_shutdown_at: iso(T0 - 1_000), // ...but it shut down deliberately right before dying
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });

    await h.pass(); // takeover pass: CAS wins on the clean-shutdown marker alone
    expect(h.deps.takeoverConduction).toHaveBeenCalledWith({
      id: 'cond-1',
      observed_lease_holder: 'this-host:1:dead0000',
      stale_before: iso(T0 - config.staleMs),
      new_lease_holder: ME,
    });
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    // The marker is single-use — cleared on the SAME write that reassigns the lease.
    expect(h.getConduction('cond-1').clean_shutdown_at).toBeNull();

    await h.pass(); // wake (first pickup) → fire
    expect(h.commands).toEqual(['reap cond-1', 'launch cond-1 task-1']);
    // B-761 reopen fix (legibility): the marker-driven adoption gets its OWN distinct log line —
    // no timestamp arithmetic required to tell it apart from a genuine staleness-window adoption.
    expect(h.logs.some((l) => l === 'conduction cond-1: adopted cleanly-released lease from this-host:1:dead0000')).toBe(true);
    expect(h.logs.some((l) => /took over stale lease/.test(l))).toBe(false);
  });

  it('an unclean death (no clean_shutdown_at) still waits out the FULL staleness window, unchanged', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'this-host:1:dead0000',
          last_heartbeat_at: iso(T0 - 1_000), // fresh heartbeat, no marker — indistinguishable from alive
          clean_shutdown_at: null,
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });

    await h.pass(); // CAS loses: neither stale nor marked
    expect(h.getConduction('cond-1').lease_holder).toBe('this-host:1:dead0000'); // untouched
    expect(h.commands).toEqual([]);

    // Only once the FULL stale window has genuinely elapsed does the takeover win.
    h.setNow(T0 + config.staleMs + 1_000);
    await h.pass();
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    // B-761 reopen fix: the ORDINARY staleness-window adoption keeps its OLD wording, unchanged —
    // the two cases must stay distinguishable in the suite too, not just in the implementation.
    expect(h.logs.some((l) => l === 'conduction cond-1: took over stale lease from this-host:1:dead0000 — reaped')).toBe(true);
    expect(h.logs.some((l) => /adopted cleanly-released lease/.test(l))).toBe(false);
  });

  it('a genuinely foreign, ALIVE peer is never adopted, marker or not — the identity check still guards it', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'other-host:2:alive111',
          last_heartbeat_at: iso(T0 - 1_000), // alive and fresh
          clean_shutdown_at: null,
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });

    await h.pass();
    expect(h.getConduction('cond-1').lease_holder).toBe('other-host:2:alive111'); // never taken over
    expect(h.commands).toEqual([]);
  });

  it('the wait-announcement log fires ONCE on the empty→non-empty transition, not again while the set is unchanged', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'other-host:2:midleg11',
          last_heartbeat_at: iso(T0 - 1_000), // not yet stale, no clean-shutdown marker
          leg_started_at: iso(T0 - 30_000), // mid-leg: not steal-eligible either
        }),
      ],
      tasks: { 'task-1': pausedTask() },
    });
    const waitLines = () => h.logs.filter((l) => /waiting out a dead lease/.test(l));

    await h.pass(); // first sight — the set transitions empty → non-empty
    expect(waitLines()).toHaveLength(1);
    expect(waitLines()[0]).toMatch(/1 conduction/);
    expect(waitLines()[0]).toMatch(new RegExp(iso(T0 - 1_000 + config.staleMs).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    await h.pass(); // same row, same mid-leg state — membership unchanged, no new line
    await h.pass();
    expect(waitLines()).toHaveLength(1); // still exactly once
  });

  it('an IDLE foreign row (ball-with-human, no leg in flight) ALSO triggers the wait announcement — REOPEN FIX (AC-3)', async () => {
    // Live production dead windows over rows exactly shaped like this one (leg_started_at null,
    // nothing running, the task awaiting human input so there is no wake) announced NOTHING for
    // 4+ minutes each — this used to be gated on leg_started_at !== null (mid-leg only). The fix
    // (see handleForeignConduction) tracks EVERY row whose takeover CAS just lost, not just the
    // mid-leg ones, so this idle row must show up in the wait summary too.
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'other-host:2:idle1111',
          last_heartbeat_at: iso(T0 - 1_000), // not yet stale, no clean-shutdown marker
          leg_started_at: null, // idle — nothing running, mirrors conduction()'s own default
        }),
      ],
      tasks: { 'task-1': pausedTask() }, // awaiting_human_input: true by default — no wake, ball-with-human
    });
    const waitLines = () => h.logs.filter((l) => /waiting out a dead lease/.test(l));

    await h.pass(); // first sight — the set transitions empty → non-empty, even with no leg in flight
    expect(waitLines()).toHaveLength(1);
    expect(waitLines()[0]).toMatch(/1 conduction/);
    expect(waitLines()[0]).toMatch(new RegExp(iso(T0 - 1_000 + config.staleMs).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('the wait-announcement log fires again when the waiting set CLEARS (e.g. the row finally goes stale and is adopted)', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'other-host:2:midleg11',
          last_heartbeat_at: iso(T0 - 1_000),
          leg_started_at: iso(T0 - 30_000),
        }),
      ],
      tasks: { 'task-1': pausedTask() },
    });

    await h.pass();
    expect(h.logs.filter((l) => /waiting out a dead lease/.test(l))).toHaveLength(1);

    // Advance well past staleness — the row is genuinely taken over, leaving the waiting set empty.
    h.setNow(T0 + config.staleMs + 1_000);
    await h.pass();
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    expect(h.logs.filter((l) => /no conductions waiting/.test(l))).toHaveLength(1);
  });

  it('the reap-before-adopt call (handleWonTakeover) requests quiet mode (with its OWN renderQuietReapOutcome quietRender, B-740); the dirty-exit retry reap and the deadline reap do not', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000), // genuinely stale
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });

    await h.pass(); // takeover pass: CAS win → reap (this is the ONE quiet call site)
    const reapCalls = h.runCommandCalls().filter(([cmd]) => cmd.startsWith('reap'));
    expect(reapCalls).toHaveLength(1);
    expect(reapCalls[0][1]?.quiet).toBe(true);
    // B-740: the reap-before-adopt call site now supplies its OWN renderer explicitly, rather than
    // relying on a bare `{ quiet: true }` to unconditionally render a reap outcome (the exact
    // regression that made every preflight tool-check log "reaped a live worker" on every boot).
    expect(reapCalls[0][1]?.quietRender?.(0)).toBe('reaped a live worker');
  });

  it('the deadline-escalation reap does NOT request quiet mode (that call site stays verbose)', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);
    await h.fireDeadline(); // arms the deadline escalation's reap

    const reapCalls = h.runCommandCalls().filter(([cmd]) => cmd.startsWith('reap'));
    expect(reapCalls.length).toBeGreaterThan(0);
    for (const [, opts] of reapCalls) expect(opts).toBeUndefined();
  });
});

/** Small shared onLaunch fixture: the worker pauses again immediately on exit (a clean no-op leg). */
function hooksOnLaunchPausesAgain(h: ReturnType<typeof makeHarness>): void {
  h.hooks.onLaunch = () => {
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true;
  };
}

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

  it('B-844: matches a plain-object PostgREST error shape (not instanceof Error) — the shape ' +
    'src/tools/conduction-record.ts now throws on a Supabase failure since 7ff203c', () => {
    // Real PostgREST/Supabase auth failure: a plain object, never an Error instance. Coercing the
    // whole object through String() (the old bug) produces "[object Object]", which can never
    // match the auth-shape regex — this asserts the fix reads .message off the object instead.
    const pgrstExpiredJwt = {
      message: 'JWT expired',
      details: null,
      hint: null,
      code: 'PGRST301',
    };
    expect(pgrstExpiredJwt instanceof Error).toBe(false);
    expect(isAuthShapedError(pgrstExpiredJwt)).toBe(true);
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
// B-717 items 1 & 2 — concurrency cap, non-blocking passes, and the priority/aging queue.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-717 item 1: fire-and-track concurrency', () => {
  it('AC1/AC2: with more ready rows than free slots, the daemon runs up to the cap concurrently — a long-running leg never blocks the others', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ id: 'cond-1', task_id: 'task-1' }),
        conduction({ id: 'cond-2', task_id: 'task-2' }),
        conduction({ id: 'cond-3', task_id: 'task-3' }),
        conduction({ id: 'cond-4', task_id: 'task-4' }),
      ],
      tasks: {
        'task-1': pausedTask(),
        'task-2': pausedTask(),
        'task-3': pausedTask(),
        'task-4': pausedTask(),
      },
      config: { ...config, maxConcurrentWorkers: 2 },
      blockLaunch: true, // every launch blocks — nothing settles on its own
    });

    await h.pass(); // 4 baselines captured, no wake yet
    for (const t of ['task-1', 'task-2', 'task-3', 'task-4']) {
      (h.tasks[t] as DaemonTask).awaiting_human_input = false;
    }
    await h.pass(); // all 4 wake — only 2 free slots

    // AC1: exactly maxConcurrentWorkers fired, the rest stayed queued.
    expect(h.launches()).toHaveLength(2);
    expect(h.running()).toHaveLength(2);
    expect(h.ready()).toHaveLength(2);

    // AC2: cond-1's blocked leg (still running) does not stop cond-3/cond-4 from EVENTUALLY firing
    // once a slot frees — release ONE of the two in-flight legs.
    const firstRunning = h.running()[0];
    await h.releaseLaunch(0, firstRunning);
    await h.pass(); // observes the settlement, classifies 'wait', frees the slot
    await h.pass(); // the freed slot picks up a THIRD ready row this same pass

    expect(h.launches()).toHaveLength(3);
    expect(h.running()).toHaveLength(2); // cap held throughout — never exceeded
  });

  it('a pass never blocks: it returns immediately even while every slot is occupied by an unsettled launch (AC5 evidence)', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      blockLaunch: true,
    });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // fires, tracked as running, unsettled
    expect(h.running()).toEqual(['cond-1']);

    // A pass with an unsettled launch in `running` must still complete PROMPTLY — this IS the
    // property PersistentAuthFailure's counter (AC5, B-696) needs restored: a pass completes on
    // roughly the poll cadence, not the runtime of the slowest in-flight leg. Demonstrated here by
    // simply completing several more passes with the launch still blocked the whole time.
    for (let i = 0; i < 5; i += 1) {
      const summary = await h.pass();
      expect(summary.attempted).toBe(1);
    }
    expect(h.running()).toEqual(['cond-1']); // still unsettled — the pass never awaited it
  });

  it('item 2: ready candidates fire in PRIORITY order (high before medium before low) when slots are scarce', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ id: 'cond-low', task_id: 'task-low', task_priority: 'low' }),
        conduction({ id: 'cond-high', task_id: 'task-high', task_priority: 'high' }),
        conduction({ id: 'cond-med', task_id: 'task-med', task_priority: 'medium' }),
      ],
      tasks: {
        'task-low': pausedTask(),
        'task-high': pausedTask(),
        'task-med': pausedTask(),
      },
      config: { ...config, maxConcurrentWorkers: 1 },
      blockLaunch: true,
    });

    await h.pass(); // baselines
    for (const t of ['task-low', 'task-high', 'task-med']) {
      (h.tasks[t] as DaemonTask).awaiting_human_input = false;
    }
    await h.pass(); // all 3 become ready in the SAME pass — only 1 slot

    expect(h.running()).toEqual(['cond-high']); // highest priority fires first
    expect(h.ready().sort()).toEqual(['cond-low', 'cond-med']);

    await h.releaseLaunch(0, 'cond-high');
    await h.pass(); // settle cond-high, frees the slot
    await h.pass(); // the freed slot goes to the next-highest-priority ready row

    expect(h.running()).toEqual(['cond-med']);
  });

  it('item 2: aging escalation promotes a long-waiting LOW-priority row one tier, so it beats a fresh MEDIUM arrival by FIFO within the promoted tier', async () => {
    // 0 free slots at first — the low-priority row queues but cannot fire, so it ages in `ready`.
    const h = makeHarness({
      conductions: [conduction({ id: 'cond-aged-low', task_id: 'task-aged-low', task_priority: 'low' })],
      tasks: { 'task-aged-low': pausedTask() },
      config: { ...config, maxConcurrentWorkers: 0, readyAgeMs: 600_000 },
    });
    await h.pass();
    (h.tasks['task-aged-low'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // becomes ready, but 0 slots ⇒ never fires
    expect(h.ready()).toEqual(['cond-aged-low']);

    // Advance the clock past readyAgeMs (still sitting in `ready`, unfired) and introduce a FRESH
    // medium-priority row NOT YET awake (its baseline is only just being captured this pass — it
    // must not compete yet).
    h.setNow(h.now() + 600_000);
    h.tasks['task-fresh-med'] = pausedTask({ awaiting_human_input: true });
    (h.deps as { listConductions: SchedulerDeps['listConductions'] }).listConductions = vi.fn(async () => [
      h.getConduction('cond-aged-low'),
      conduction({ id: 'cond-fresh-med', task_id: 'task-fresh-med', task_priority: 'medium' }),
    ]) as SchedulerDeps['listConductions'];
    await h.pass(); // captures task-fresh-med's baseline only — cond-aged-low stays ready, untouched

    // NOW open one slot and wake the fresh row, in the SAME pass both become fire candidates.
    // Without aging, low (rank 0) would lose outright to medium (rank 1); WITH aging (promoted to
    // rank 1, tied with medium), the aged row wins the tiebreak purely by having been ready longer
    // (FIFO within the tier) — proof the promotion happened, not just that medium beats low.
    (h.deps.config as DaemonConfig).maxConcurrentWorkers = 1;
    h.tasks['task-fresh-med'] = pausedTask({ awaiting_human_input: false });
    await h.pass();
    expect(h.running()).toEqual(['cond-aged-low']); // promoted low beats a same-tier-but-younger row
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-717 item 3 — multi-daemon load-balancing: steal, not just stale-takeover.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-717 item 3: stealConduction — AC3', () => {
  it('AC3: an idle daemon with a free slot steals a peer-held ready row (leg_started_at IS NULL) instead of only taking over dead leases', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'peer-host:2:bbbb2222', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: null }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });

    await h.pass(); // first sight of the foreign row — baseline only, no verdict yet
    expect(h.commands).toEqual([]);
    expect(h.deps.stealConduction).not.toHaveBeenCalled();

    await h.pass(); // first-pickup wake detected against the rolled baseline → steal attempted + won
    expect(h.deps.takeoverConduction).toHaveBeenCalled(); // still tries the stale path first…
    expect(h.deps.stealConduction).toHaveBeenCalledWith({
      id: 'cond-1',
      observed_lease_holder: 'peer-host:2:bbbb2222',
      new_lease_holder: ME,
    });
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    // On a win, fire immediately in the SAME pass — no cold-start baseline pass first.
    expect(h.commands).toEqual(['launch cond-1 task-1']);
    expect(h.running()).toEqual(['cond-1']);
    expect(h.logs.some((l) => /stole ready work from peer-host/.test(l))).toBe(true);
  });

  it('never steals a row with a non-null leg_started_at — a worker might genuinely still be running on the peer', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'peer-host:2:bbbb2222',
          last_heartbeat_at: iso(T0 - 1_000),
          leg_started_at: iso(T0 - 500), // the peer's own tracked launch, mid-flight
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    await h.pass();
    await h.pass();
    expect(h.deps.stealConduction).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
    expect(h.getConduction('cond-1').lease_holder).toBe('peer-host:2:bbbb2222');
  });

  it('never steals when this daemon has no free slot of its own', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ id: 'cond-mine', task_id: 'task-mine' }),
        conduction({
          id: 'cond-theirs',
          task_id: 'task-theirs',
          lease_holder: 'peer-host:2:bbbb2222',
          last_heartbeat_at: iso(T0 - 1_000),
          leg_started_at: null,
        }),
      ],
      tasks: {
        'task-mine': pausedTask(),
        'task-theirs': pausedTask({ awaiting_human_input: false }),
      },
      config: { ...config, maxConcurrentWorkers: 1 },
      blockLaunch: true,
    });
    await h.pass(); // baseline both
    (h.tasks['task-mine'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // this daemon's own row fires and fills the ONLY slot
    expect(h.running()).toEqual(['cond-mine']);

    await h.pass(); // no free slot ⇒ the foreign row is never even read/stolen
    expect(h.deps.stealConduction).not.toHaveBeenCalled();
    expect(h.getConduction('cond-theirs').lease_holder).toBe('peer-host:2:bbbb2222');
  });

  it('loses the steal race gracefully — no throw, row untouched, a later pass may reconsider', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'peer-host:2:bbbb2222', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: null }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    (h.deps.stealConduction as ReturnType<typeof vi.fn>).mockResolvedValue(null); // lost the race
    await h.pass();
    await h.pass();
    expect(h.deps.stealConduction).toHaveBeenCalled();
    expect(h.commands).toEqual([]);
    expect(h.getConduction('cond-1').lease_holder).toBe('peer-host:2:bbbb2222');
  });

  it('never steals a ticket a human took away from the conductor (conductor_excluded_at set)', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'peer-host:2:bbbb2222', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: null }),
      ],
      tasks: {
        'task-1': pausedTask({ awaiting_human_input: false, conductor_excluded_at: '2026-08-01T00:00:00.000Z' }),
      },
    });
    await h.pass();
    await h.pass();
    expect(h.deps.stealConduction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-717 item 4 — exponential backoff (AC4): covered by case 4a above (verifies 15_000 then 30_000,
// i.e. base * 2**(retryCount-1), replacing the old flat delay).
// ─────────────────────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-717 restart reconciliation — a newly-won takeover with a non-null leg_started_at must RE-ATTACH
// (never re-fire) when the profile's probe finds a live worker, and only reap-then-clear when it
// does not. Also the point-4 INVARIANT test (not merely a kickoff-return-site test).
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-717 restart reconciliation', () => {
  it('probe FOUND: re-attaches (no reap, no clear, no re-fire) and resumes settlement-polling each pass', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000),
          leg_started_at: iso(T0 - 300_000), // a leg was genuinely in flight when the lease went stale
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
      config: reconcilableConfig,
      probeDefaultExitCode: 0, // "still running" every time, until the test says otherwise
    });

    await h.pass(); // takeover win → probe found → RE-ATTACH
    expect(h.reaps()).toEqual([]); // no reap — the worker is genuinely still out there
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
      expect.objectContaining({ leg_started_at: null }),
    );
    expect(h.getConduction('cond-1').leg_started_at).not.toBeNull(); // untouched — still the old stamp
    expect(h.running()).toEqual(['cond-1']);
    expect(h.logs.some((l) => /reconciled — re-attached/.test(l))).toBe(true);

    // Still running on later passes — no reap, no re-fire, no clear, ever, while the probe keeps
    // finding it.
    await h.pass();
    await h.pass();
    expect(h.launches()).toEqual([]); // NEVER a fresh launch for a reconciled row
    expect(h.reaps()).toEqual([]);
    expect(h.getConduction('cond-1').leg_started_at).not.toBeNull();

    // Eventually the probe stops finding it — settlement, THEN (and only then) the clear.
    h.setProbe('cond-1', 1);
    await h.pass(); // observes non-zero probe → settled (exitCode: null, treated dirty)
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, { leg_started_at: null });
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
    // A null exit code with retryCap 0 (the base config's default) parks immediately as dirty-exit.
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('dirty-exit');
  });

  it('probe NOT FOUND: falls back to reap-then-clear exactly as an ordinary stale takeover', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000),
          leg_started_at: iso(T0 - 300_000),
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
      config: reconcilableConfig,
      probeDefaultExitCode: 1, // never found
    });

    await h.pass();
    expect(h.probes()).toEqual(['probe cond-1']);
    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, { leg_started_at: null });
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
    expect(h.running()).toEqual([]);

    await h.pass(); // wake → fires a genuinely NEW launch
    expect(h.commands).toEqual(['probe cond-1', 'reap cond-1', 'launch cond-1 task-1']);
  });

  it('a profile with NO probe template skips reconciliation entirely — unchanged pre-B-717 REAP-THEN-FIRE', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000),
          leg_started_at: iso(T0 - 300_000),
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
      // Deliberately the BASE config — no `probe` field.
    });
    await h.pass();
    expect(h.probes()).toEqual([]);
    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
  });

  it('INVARIANT (B-717 point 4, corrected): leg_started_at is cleared ONLY at tracked-settlement classification, or at reap-after-takeover on a row with NO tracked in-flight worker on this daemon — never both/neither', async () => {
    // The scenario the correction exists for: a takeover win on a row whose leg was genuinely still
    // in flight. Reconciliation FOUND it, so `running` now holds it — the reap-after-takeover clear
    // must be provably SKIPPED for as long as that tracked entry exists, and the clear that
    // eventually does land must come ONLY from settlement, never from a second, redundant path.
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000),
          leg_started_at: iso(T0 - 300_000),
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
      config: reconcilableConfig,
      probeDefaultExitCode: 0,
    });

    const clearsBeforeSettlement = () => h.legStartedWrites('cond-1').filter((v) => v === null).length;

    await h.pass(); // takeover → reconciled re-attach: running.has('cond-1') is true from here on
    expect(h.running()).toEqual(['cond-1']);
    expect(clearsBeforeSettlement()).toBe(0); // NO clear while tracked as running

    for (let i = 0; i < 5; i += 1) {
      await h.pass();
      // The invariant, checked on EVERY pass while `running` still holds the row: still zero
      // clears — the reap-after-takeover branch is provably unreachable for a row this daemon
      // itself currently tracks as running a worker.
      if (h.running().includes('cond-1')) expect(clearsBeforeSettlement()).toBe(0);
    }

    // Now let it settle — exactly ONE clear must land, and only now.
    h.setProbe('cond-1', 1);
    await h.pass();
    expect(h.running()).toEqual([]);
    expect(clearsBeforeSettlement()).toBe(1); // exactly one, from settlement — not two, not zero
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-739 — liveness independent of pass progress, and a bounded per-launch deadline.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Drive a conduction to the point where its launch is in flight (blocked) and TRACKED, but not
 *  yet settled. Under B-717 a pass never blocks, so this is just two ordinary passes. */
async function firedAndBlocked(h: ReturnType<typeof makeHarness>): Promise<void> {
  await h.pass(); // baseline
  (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved → wake
  await h.pass(); // wake → fire; the launch is blocked, tracked, unsettled
}

describe('B-739: the heartbeat keeps advancing while a worker blocks the pass', () => {
  it('THE DEFECT REPRO: a blocked launch no longer silences the lease', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);
    expect(h.launches()).toEqual(['launch cond-1 task-1']); // in flight, tracked
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
    await h.pass(); // settle
  });

  it('a SECOND held lease keeps stamping while the first is blocked (the serial-pass starvation)', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction(), conduction({ id: 'cond-2', task_id: 'task-2' })],
      tasks: { 'task-1': pausedTask(), 'task-2': pausedTask() },
    });
    await h.pass(); // both baselines; both leases now kept
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // cond-1 fires (blocked); cond-2 still just watched

    const before = h.heartbeatWrites('cond-2').length;
    h.setNow(T0 + 600_000);
    await h.fireHeartbeats();

    // cond-2's worker is not even running; the serial pass used to starve it anyway.
    expect(h.heartbeatWrites('cond-2').length).toBe(before + 1);

    await h.releaseLaunch(0, 'cond-1');
    await h.pass();
  });

  it('stops stamping a lease that left the active set (prune mirrors the watch baselines)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await h.pass();
    expect(h.keeper.running()).toEqual(['cond-1']);

    h.getConduction('cond-1').status = 'completed'; // closed elsewhere
    await h.pass();
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
    await firedAndBlocked(h);

    // A peer wins the CAS takeover elsewhere while we are blocked, and reaps our container.
    h.getConduction('cond-1').lease_holder = 'other-daemon:9:zzzz';
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.releaseLaunch(1); // dirty exit, as a reaped worker would look

    await h.pass(); // notices the lease mismatch, drops the orphaned tracked launch — no clobber

    const row = h.getConduction('cond-1');
    expect(row.status).toBe('active');
    expect(row.lease_holder).toBe('other-daemon:9:zzzz');
    expect(row.last_worker_exit_code).toBeNull();
    expect(row.last_worker_exit_class).toBeNull();
    expect(h.logs.join(' ')).toMatch(/lease lost to another daemon while a launch was tracked/);
    expect(h.running()).toEqual([]); // no longer tracked — it is not ours to act on any more
  });

  it('stops the heartbeat for a lease it no longer holds', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await h.pass();
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
    await firedAndBlocked(h);

    await h.fireDeadline();
    await h.pass(); // observes the reap-freed settlement, classifies worker-timeout, parks

    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: 137, last_worker_exit_class: 'worker-timeout' },
    ]);
    // Park on the FIRST timeout: the class is not 'dirty-exit', so B-713's ladder never engages.
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
  });

  it('cancels the deadline on a normal exit — a healthy worker is never reaped', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    hooksOnLaunchPausesAgain(h);
    await h.pass(); // fire
    await h.pass(); // settle

    expect(h.reaps()).toEqual([]);
  });

  it('gives each RETRIED attempt its own full deadline (per launch, never per run)', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchExitCodes: [1, 0], // dirty, then clean
      config: { ...config, retryCap: 1 },
    });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // fire 1
    await h.pass(); // settle 1 (dirty) → queue retry
    h.setNow(h.now() + config.retryBackoffMs);
    await h.pass(); // fire 2 (retry)

    expect(h.launches()).toHaveLength(2);
    expect(h.armedDeadlines()).toBe(2); // a fresh full deadline per attempt
  });

  it('escalates to PersistentReapFailure when the reap cannot free the daemon — surfaces on the NEXT pass via the fatal slot', async () => {
    const h = makeHarness({
      blockLaunch: true,
      reapNeverFrees: true, // a wedged container runtime
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);

    await h.fireDeadline();
    for (let i = 0; i < 4; i += 1) await h.fireReapGrace();

    // Bounded: it does not re-fire forever.
    expect(h.reaps()).toHaveLength(3);
    await expect(h.pass()).rejects.toBeInstanceOf(PersistentReapFailure);
  });

  it('PersistentReapFailure ESCAPES the per-conduction isolation — it must kill the process', async () => {
    const h = makeHarness({
      blockLaunch: true,
      reapNeverFrees: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);

    await h.fireDeadline();
    for (let i = 0; i < 4; i += 1) await h.fireReapGrace();

    const err = await runSchedulerPass(h.deps, h.state, h.keeper, h.runtime).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersistentReapFailure);
  });

  // B-761 reopen fix — CRITICAL CONSTRAINT CHECK: this loop must not be affected by the reap
  // scripts' exit-code semantics change (miss=3 vs kill=0 vs other=genuine-error). Confirmed by
  // reading fireLaunch: the deadline-escalation reap call is `void deps.runCommand(...)` — fired
  // WITHOUT `{ quiet: true }` and its settled Promise's result is never even assigned to a
  // variable, let alone inspected. Attempt counting and escalation are driven ENTIRELY by
  // `tracked.settled` (set only by the LAUNCH's own promise settling, never by the reap call). This
  // test proves it directly: the reap command here returns exit code 3 (the routine-miss code) on
  // every attempt, and — because it also never frees the blocked launch (reapNeverFrees) — settled
  // never becomes true either way, so the attempt count and the eventual PersistentReapFailure
  // escalation are IDENTICAL to the `reapExitCode` left at its default-0 case above.
  it('the deadline-escalation attempt counter is driven purely by tracked.settled, unaffected by whatever exit code a reap call returns', async () => {
    const h = makeHarness({
      blockLaunch: true,
      reapNeverFrees: true,
      reapExitCode: 3, // the routine "miss" code — must not read as a different outcome to this loop
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);

    await h.fireDeadline();
    for (let i = 0; i < 4; i += 1) await h.fireReapGrace();

    // Same bound, same escalation, as the reapExitCode-agnostic test above — exit code 3 changed
    // nothing about attempt counting or escalation.
    expect(h.reaps()).toHaveLength(3);
    await expect(h.pass()).rejects.toBeInstanceOf(PersistentReapFailure);

    // And confirm the call site itself: no quiet mode, ever, at this reap call site.
    const reapCalls = h.runCommandCalls().filter(([cmd]) => cmd.startsWith('reap'));
    for (const [, opts] of reapCalls) expect(opts).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-740: the early-reap lever. `reap_requested_at` (stamped by the web's "Reap now" button or the
// request_conduction_reap MCP tool) is consumed by the SAME per-launch deadline machinery — never a
// new kill path — via the SAME `beginReapEscalation` body the deadline timeout already runs, just
// parameterized to flip `operatorReaped` instead of `timedOut`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-740: the early-reap lever (reap_requested_at consumed by the shared reap-escalation)', () => {
  it('an early reap request fires the SAME reap-escalation body the deadline uses — freeing the blocked launch parks it operator-reap (not worker-timeout, not dirty-exit)', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: { ...config, retryCap: 2 }, // retry is ENABLED, and must still not engage
    });
    await firedAndBlocked(h);

    // The web/MCP write: `row` is re-read FRESH every pass, so mutating the fake row directly is the
    // correct harness-level stand-in for "a write landed out of band".
    h.getConduction('cond-1').reap_requested_at = iso(h.now());
    await h.pass(); // notices reap_requested_at on the fresh row → escalates; the reap frees it
    await h.pass(); // observes the reap-freed settlement, classifies operator-reap, parks

    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: 137, last_worker_exit_class: 'operator-reap' },
    ]);
    expect(h.launches()).toEqual(['launch cond-1 task-1']); // no re-fire, no retry
  });

  it('fires the reap-escalation exactly ONCE per launch even across several passes with reap_requested_at still set (the `reaping` guard)', async () => {
    const h = makeHarness({
      blockLaunch: true,
      reapNeverFrees: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);

    h.getConduction('cond-1').reap_requested_at = iso(h.now());
    await h.pass(); // triggers the escalation once
    const reapsAfterFirstPass = h.reaps().length;
    expect(reapsAfterFirstPass).toBeGreaterThan(0);

    await h.pass();
    await h.pass();
    // No SECOND escalation loop was started — attempt count stays bounded by the ONE escalation's
    // own REAP_ATTEMPT_LIMIT, not multiplied by the number of extra passes that still see
    // reap_requested_at set on the (still-unsettled, never-freed) row.
    for (let i = 0; i < 4; i += 1) await h.fireReapGrace();
    expect(h.reaps()).toHaveLength(3); // REAP_ATTEMPT_LIMIT, exactly as the deadline path bounds it
  });

  it('cancels the natural per-launch deadline timer once the early-reap path has started its own escalation', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);

    h.getConduction('cond-1').reap_requested_at = iso(h.now());
    await h.pass();
    await h.pass(); // settles via the early-reap escalation, not the natural deadline

    // The natural deadline never got a chance to ALSO fire its own escalation — only ONE reap
    // sequence ran (bounded, from the early-reap path), never two overlapping ones.
    expect(h.reaps()).toEqual(['reap cond-1']);
  });

  it('the early-reap lever stays available on an already-tracked conduction even when the ticket is ALSO archived (archived only gates a NEW fire, never an in-flight one)', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);

    (h.tasks['task-1'] as DaemonTask).archived = true;
    h.getConduction('cond-1').reap_requested_at = iso(h.now());
    await h.pass();
    await h.pass();

    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: 137, last_worker_exit_class: 'operator-reap' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-740: the archived-ticket pre-fire decline. A NEW fire against an already-archived ticket settles
// straight to 'parked'/'ticket-archived' via the SAME writeIfHeld park path — never reaches
// classifyWorkerExit (there is no worker exit to classify: this is a pre-fire decline).
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-740: archived-ticket pre-fire decline (settle instead of silently declining forever)', () => {
  it('a wake against an archived ticket declines the fire and parks with ticket-archived — no launch command ever runs', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true, archived: false }) },
    });

    await h.pass(); // baseline

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).archived = true;
    await h.pass();

    expect(h.launches()).toEqual([]); // never fired
    expect(h.ready()).toEqual([]);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: null, last_worker_exit_class: 'ticket-archived' },
    ]);
  });

  it('transition-only logging: the archived-decline line fires exactly once — the park write moves the row out of the active set, so there is no later pass to re-log it', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true, archived: false }) },
    });
    const archivedLines = () => h.logs.filter((l) => l.includes('ticket archived — declining fire'));

    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).archived = true;
    await h.pass();
    expect(archivedLines()).toHaveLength(1);

    // The row is now 'parked' in the fake conductions table — the NEXT pass's listConductions
    // (status: 'active') no longer returns it at all, so there is nothing further to (re-)log.
    await h.pass();
    await h.pass();
    expect(archivedLines()).toHaveLength(1);
  });

  it('an archived ticket with NO wake (ball stays with the human throughout) never fires and never parks either — this check only gates a NEW fire, it does not retroactively sweep', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      // awaiting_human_input stays true (the default) the whole time — no wake is ever detected, so
      // the archived check (reached only from the wake-detection block) never even runs.
      tasks: { 'task-1': pausedTask({ archived: true }) },
    });

    await h.pass(); // baseline capture only — no prior baseline to diff against yet
    await h.pass();
    await h.pass();

    expect(h.launches()).toEqual([]);
    expect(h.statusWrites()).toEqual([]);
  });

  it('does NOT gate an already-tracked (in-flight) conduction — only a NEW fire is declined', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h); // fired BEFORE the ticket was archived

    (h.tasks['task-1'] as DaemonTask).archived = true;
    await h.pass(); // tracked branch only — archived is never even consulted here

    expect(h.statusWrites()).toEqual([]); // no premature park — the launch is still genuinely running
    expect(h.running()).toEqual(['cond-1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-742 — leg_started_at: stamped fresh immediately before every launch attempt (retries
// included), cleared ONLY at tracked-settlement classification (B-717 correction — see this
// module's header). Every write lease-guarded via the same writeIfHeld/updateConductionIfHeld path.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-742/B-717: leg_started_at', () => {
  it('a clean launch sets leg_started_at to the pass-time clock immediately before firing, non-null for the ENTIRE runtime, and clears only at settlement', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);

    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, { leg_started_at: iso(T0) });
    expect(h.getConduction('cond-1').leg_started_at).toBe(iso(T0)); // non-null WHILE still running

    h.setNow(T0 + 300_000);
    await h.fireHeartbeats(); // liveness ticks; leg_started_at is untouched by the heartbeat write
    expect(h.getConduction('cond-1').leg_started_at).toBe(iso(T0)); // STILL non-null, minutes later

    await h.releaseLaunch(0);
    await h.pass(); // NOW it clears — at settlement, not before
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, { leg_started_at: null });
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
    await h.pass(); // baseline

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      if (h.launches().length === 2) (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true;
    };
    await h.pass(); // fire 1
    await h.pass(); // settle 1 (dirty) → queue retry
    h.setNow(h.now() + retryConfig.retryBackoffMs);
    await h.pass(); // fire 2
    await h.pass(); // settle 2 (clean, progressed)

    expect(h.launches()).toHaveLength(2);
    expect(h.legStartedWrites('cond-1')).toEqual([
      iso(T0),
      null,
      iso(T0 + retryConfig.retryBackoffMs),
      null,
    ]);
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
  });

  it('a takeover of a stale lease (no leg in flight) clears leg_started_at right after the reap, as part of the takeover pass itself', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000),
          leg_started_at: iso(T0 - 600_000), // the dead holder's leg — never cleared when it died
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
      // No probe configured — reconciliation is skipped, falling straight to REAP-THEN-CLEAR.
    });

    await h.pass(); // takeover pass: CAS win → reap → clear

    expect(h.commands).toEqual(['reap cond-1']);
    expect(h.launches()).toEqual([]);
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, { leg_started_at: null });
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
  });

  it('a lease lost mid-launch: the pre-launch set landed while held, and no leg_started_at write from this daemon lands after the steal (orphaned tracked launch dropped, not settled)', async () => {
    const h = makeHarness({
      blockLaunch: true,
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
    });
    await firedAndBlocked(h);
    expect(h.getConduction('cond-1').leg_started_at).toBe(iso(T0));

    h.getConduction('cond-1').lease_holder = 'other-daemon:9:zzzz';
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.releaseLaunch(1);
    await h.pass(); // the lease-mismatch check drops the tracked launch — settlement never observed

    // No leg_started_at write is EVER attempted for cond-1 by this daemon past the pre-launch set —
    // the row is simply abandoned once the mismatch is noticed, not settled-and-cleared.
    expect(
      h.legStartedWrites('cond-1').filter((v) => v === null),
    ).toEqual([]);
    expect(h.getConduction('cond-1').lease_holder).toBe('other-daemon:9:zzzz');
    expect(h.getConduction('cond-1').leg_started_at).toBe(iso(T0)); // untouched by us
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-723 — the per-leg log lines name the TICKET, alongside the full conduction id. Split under
// B-717 into a "queued" line (wake→ready) and a "launching worker" line (ready→running, the fire
// phase); the exit-classification line is unchanged.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-723: the per-leg log lines name the TICKET, alongside the full conduction id', () => {
  const TITLE = 'Name the ticket on the daemon log';

  const identified = (over: Partial<DaemonTask> = {}): DaemonTask =>
    pausedTask({ task_number: 756, title: TITLE, ...over });

  const launchLine = (h: { logs: string[] }): string =>
    h.logs.find((l) => l.includes('launching worker'))!;

  /** Baseline pass, then the human resolves and ONE leg fires (queued + fired, same pass). */
  async function fireOnce(h: ReturnType<typeof makeHarness>): Promise<void> {
    await h.pass(); // baseline (still awaiting) — no fire
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved
    await h.pass();
  }

  it('an identified ticket LEADS the launch line, with the FULL conduction id trailing', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': identified() } });
    await fireOnce(h);

    expect(launchLine(h)).toBe(`B-756 "${TITLE}" (conduction cond-1): launching worker`);
    expect(launchLine(h)).toContain('(conduction cond-1)');
  });

  it("degrades to TODAY's bare conduction form when the ticket read carries no identity", async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await fireOnce(h);

    expect(launchLine(h)).toBe('conduction cond-1: launching worker');
    expect(launchLine(h)).not.toContain('B-');
    expect(launchLine(h)).not.toContain('undefined');

    const half = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ task_number: 756 }) },
    });
    await fireOnce(half);
    expect(launchLine(half)).toBe('conduction cond-1: launching worker');
    expect(launchLine(half)).not.toContain('undefined');
  });

  it('a long title is cut at 48 chars with a single ellipsis; the conduction id still rides in full', async () => {
    const long = 'Name the ticket on the daemon log line so an operator can tell which leg is which';
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': identified({ title: long }) },
    });
    await fireOnce(h);

    expect(launchLine(h)).toBe(
      'B-756 "Name the ticket on the daemon log line so an ope…" (conduction cond-1): launching worker',
    );
    expect(launchLine(h)).toContain('(conduction cond-1)');
  });

  it('the project key is CONFIG pinned at launch, not a baked constant — another board logs its own', async () => {
    const h = makeHarness({
      projectKey: 'ACME',
      conductions: [conduction()],
      tasks: { 'task-1': identified() },
    });
    await fireOnce(h);

    expect(launchLine(h)).toContain(`ACME-756 "${TITLE}" (conduction cond-1)`);
    expect(launchLine(h)).not.toContain('B-756');
  });

  it('the exit-classification line carries identity too — from the POST-EXIT read, not the pre-launch one', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': identified() } });
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.title = 'Renamed while the leg ran'; // the worker edited the ticket
      task.awaiting_human_input = true; // …and paused cleanly on the next gate
    };
    await fireOnce(h);
    await h.pass(); // settle → classify

    expect(launchLine(h)).toContain(`B-756 "${TITLE}"`);
    expect(h.logs.find((l) => l.includes('worker exit code='))).toBe(
      'B-756 "Renamed while the leg ran" (conduction cond-1): worker exit code=0 → wait (clean-pause)',
    );
  });

  it('the wake-detected line reads "queued", distinct from the later "launching worker" line', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': identified() } });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    expect(h.logs.some((l) => l.includes('wake (agent-ball) — queued'))).toBe(true);
    expect(h.logs.some((l) => l.includes('launching worker'))).toBe(true);
  });
});

describe('B-827: {ticket} template substitution carries the visual id, never the row UUID', () => {
  // B-723 fixed the daemon's LOG LINES to name tickets; this ticket finishes the job at the
  // substitution itself — everything a conduction touches (the worker prompt, host-side RUN_DIR
  // paths, and the persisted transcript path) is templated from {ticket}, so a UUID leaking into
  // {ticket} leaks into all three. Pin the rendered COMMAND (not the log line) at every template
  // call site.
  const TICKET_PROFILE: DaemonConfig = {
    ...config,
    profile: {
      launch: 'launch {conduction_id} {ticket}',
      reap: 'reap {conduction_id} {ticket}',
      probe: 'probe {conduction_id} {ticket}',
    },
  };
  const ROW_UUID = '88fdc62d-aaaa-bbbb-cccc-000000000001'; // opaque row id — must never render
  const identified = (over: Partial<DaemonTask> = {}): DaemonTask =>
    pausedTask({ task_number: 1, title: 'Substitute the visual id', ...over });

  it('the launch command renders {ticket} as the visual id, never the raw row task_id', async () => {
    const h = makeHarness({
      config: TICKET_PROFILE,
      conductions: [conduction({ task_id: ROW_UUID })],
      tasks: { [ROW_UUID]: identified() },
    });
    await h.pass(); // baseline (still awaiting) — no wake
    (h.tasks[ROW_UUID] as DaemonTask).awaiting_human_input = false; // the human resolved
    await h.pass(); // wake → queued → fired this same pass

    expect(h.launches()).toEqual(['launch cond-1 B-1']);
    expect(h.launches()[0]).not.toContain(ROW_UUID);
  });

  it('a dirty-exit retry reap renders {ticket} as the visual id too', async () => {
    const h = makeHarness({
      config: { ...TICKET_PROFILE, retryCap: 1 },
      conductions: [conduction({ task_id: ROW_UUID })],
      tasks: { [ROW_UUID]: identified() },
      launchExitCode: 1, // dirty exit — no progress, no awaiting-flag flip
    });
    await h.pass(); // baseline
    (h.tasks[ROW_UUID] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // wake → fire
    await h.pass(); // settle dirty exit → reap + queue retry

    expect(h.reaps()).toEqual(['reap cond-1 B-1']);
    expect(h.reaps()[0]).not.toContain(ROW_UUID);
  });

  it('the restart-reconciliation probe (a newly-won takeover) renders {ticket} as the visual id', async () => {
    const h = makeHarness({
      config: TICKET_PROFILE,
      conductions: [
        conduction({
          task_id: ROW_UUID,
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000),
          leg_started_at: iso(T0 - 300_000), // a leg was in flight when the lease went stale
        }),
      ],
      tasks: { [ROW_UUID]: identified({ awaiting_human_input: false }) },
      probeDefaultExitCode: 0,
    });

    await h.pass(); // takeover win → restart-reconciliation probe

    expect(h.probes()).toEqual(['probe cond-1 B-1']);
    expect(h.probes()[0]).not.toContain(ROW_UUID);
  });

  it('the REAP-THEN-FIRE fallback on a newly-won takeover renders {ticket} as the visual id', async () => {
    const h = makeHarness({
      config: TICKET_PROFILE,
      conductions: [
        conduction({
          task_id: ROW_UUID,
          lease_holder: 'dead-host:9:zzzz9999',
          last_heartbeat_at: iso(T0 - 600_000),
          leg_started_at: iso(T0 - 300_000),
        }),
      ],
      tasks: { [ROW_UUID]: identified({ awaiting_human_input: false }) },
      probeDefaultExitCode: 1, // never found — falls back to reap-then-clear
    });

    await h.pass();

    expect(h.reaps()).toEqual(['reap cond-1 B-1']);
    expect(h.reaps()[0]).not.toContain(ROW_UUID);
  });

  it('degrades to the raw row task_id when the task carries no visual identity (never blocks the launch)', async () => {
    const h = makeHarness({
      config: TICKET_PROFILE,
      conductions: [conduction({ task_id: ROW_UUID })],
      tasks: { [ROW_UUID]: pausedTask({ awaiting_human_input: false }) }, // no task_number/title
    });
    await h.pass();
    await h.pass();

    expect(h.launches()).toEqual([`launch cond-1 ${ROW_UUID}`]);
  });
});
