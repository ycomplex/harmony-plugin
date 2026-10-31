import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runSchedulerPass,
  runScheduler,
  createSchedulerRuntime,
  isAuthShapedError,
  killReasonFromExitCode,
  gkeWorkerJobName,
  PersistentAuthFailure,
  PersistentReapFailure,
  type SchedulerDeps,
  type SchedulerRuntime,
  type DaemonTask,
} from './scheduler.js';
import { createHeartbeatKeeper } from './heartbeat.js';
import type { WatchBaseline } from './watch.js';
import { createHintCoalescer, type HintSource } from './hints.js';
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
    leg_count: 0,
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
  /** B-720: what a LAUNCH's runCommand returns for the captured LAUNCH-COMMAND tail + the total
   *  bytes it emitted. Omitted ⇒ the fake returns only an exit code, exactly like a pre-B-720
   *  runCommand implementation (which must read as "nothing captured", never as an empty
   *  capture). */
  launchOutput?: { tail: string; bytes: number };
  /** B-720: make the SEPARATE leg-output write blow up, simulating the pre-migration prod board
   *  rejecting a table it does not have yet. Every other write — crucially the terminal status
   *  patch — is untouched. (The real dep never throws; this proves the scheduler survives even a
   *  dep that breaks that contract.) */
  throwOnLegOutputWrite?: boolean;
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
  // B-720: every conduction_leg_output row this daemon wrote, in call order.
  const legOutputRows: Array<Record<string, unknown>> = [];
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
  const pendingLaunches = new Map<
    string,
    (result: { exitCode: number | null; outputTail?: string; outputBytes?: number }) => void
  >();
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
    clearModelHandoff: vi.fn(async (taskId, marker) => {
      const row = tasks[taskId] as DaemonTask;
      const fieldValues = { ...(row.field_values ?? {}) } as Record<string, unknown>;
      const current = (row.waiting_on ?? fieldValues.waiting_on) as { kind?: unknown; ref?: unknown; since?: unknown } | null | undefined;
      if (current?.kind !== 'model-handoff' || current.ref !== marker.ref || current.since !== marker.since) return false;
      fieldValues.waiting_on = null;
      row.field_values = fieldValues;
      row.waiting_on = null;
      return true;
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
    // B-720: the launcher-diagnostics write. Records every call so a test can prove WHAT was
    // written and, above all, WHICH SOURCE it was written under — the scheduler may only ever
    // write 'launcher' rows.
    recordLegOutput: vi.fn(async (args: Record<string, unknown>) => {
      if (opts.throwOnLegOutputWrite) {
        throw new Error('relation "public.conduction_leg_output" does not exist');
      }
      legOutputRows.push({ ...args });
      return true;
    }) as unknown as SchedulerDeps['recordLegOutput'],
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
    runCommand: vi.fn(async (cmd: string, _opts?: { quiet?: boolean; env?: NodeJS.ProcessEnv }) => {
      commands.push(cmd);
      const id = condId(cmd);
      if (cmd.startsWith('launch')) {
        hooks.onLaunch?.(cmd);
        if (opts.blockLaunch || opts.blockLaunchIds?.includes(id)) {
          return new Promise<{ exitCode: number | null; outputTail?: string; outputBytes?: number }>(
            (resolve) => {
              pendingLaunches.set(id, resolve);
            },
          );
        }
        // B-720: `launchOutput` omitted ⇒ exit code ONLY, mirroring a pre-B-720 runCommand.
        const captured = opts.launchOutput
          ? { outputTail: opts.launchOutput.tail, outputBytes: opts.launchOutput.bytes }
          : {};
        if (launchExitCodesQueue && launchExitCodesQueue.length > 0) {
          return { exitCode: launchExitCodesQueue.shift()!, ...captured };
        }
        return { exitCode: opts.launchExitCode === undefined ? 0 : opts.launchExitCode, ...captured };
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
    // B-845: HarmonyAuth.forceRefresh() stand-in — real single-flight behavior is auth.test.ts's
    // job; here it just needs to be callable so withWriteRetry's PGRST303 branch has somewhere to
    // go in a test that exercises it.
    forceRefresh: vi.fn(async () => {}),
  };

  const keeper = createHeartbeatKeeper({
    now: () => t,
    startInterval: deps.startInterval,
    updateConductionIfHeld: (id, patch) => deps.updateConductionIfHeld(id, ME, patch),
    log: (line) => logs.push(line),
    heartbeatMs: cfg.heartbeatMs,
    forceRefresh: deps.forceRefresh,
    sleep: deps.sleep,
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
        [string, { quiet?: boolean; env?: NodeJS.ProcessEnv } | undefined]
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
    /** B-742: leg_started_at writes ATTEMPTED by this daemon (set or clear), in call order. B-1020:
     *  matches on the KEY'S PRESENCE, not an exact single-key patch shape — fireLaunch's fresh-leg
     *  write now bundles leg_count into the SAME patch (see scheduler.ts), so a strict
     *  single-key-only match would silently drop every SET from this list while still catching the
     *  (unchanged, leg_started_at-only) settlement CLEAR. */
    legStartedWrites: (id: string) =>
      (deps.updateConductionIfHeld as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .filter((c) => c[0] === id && 'leg_started_at' in (c[2] as object))
        .map((c) => (c[2] as Record<string, unknown>).leg_started_at as string | null),
    /** B-720: leg-output rows this daemon actually WROTE, in call order. */
    legOutputRows: () => legOutputRows,
    /** B-720: leg-output write ATTEMPTS (including ones that threw), in call order. */
    legOutputWrites: () =>
      (deps.recordLegOutput as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      ),
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
        expect(h.launches()).toEqual([`launch cond-1 task-1 --model 'claude-sonnet-5-5'`]);
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

  it('B-1040: a clean-pause exit ALSO stamps last_leg_ended_at, isolated from the (nonexistent) status write — status stays untouched', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    hooksOnLaunchPausesAgain(h);
    await h.pass(); // fire

    h.setNow(h.now() + 5_000); // a distinct clock value, active at settlement
    await h.pass(); // settle → classify 'wait'

    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      last_worker_exit_class: 'clean-pause',
      last_worker_exit_code: 0,
      last_leg_ended_at: iso(h.now()),
    });
    expect(h.getConduction('cond-1').last_leg_ended_at).toBe(iso(h.now()));
    // The isolated write never touches status — proof of isolation from the (absent) status write
    // on this branch.
    expect(h.getConduction('cond-1').status).toBe('active');
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
    // B-1040: last_leg_ended_at also landed, isolated from the status write above, at the
    // settle-time clock — read h.now() before any later h.pass() calls in this test mutate it.
    expect(h.getConduction('cond-1').last_leg_ended_at).toBe(iso(h.now()));

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
    // B-1040: the FIRST retry attempt's isolated write also landed last_leg_ended_at, at this
    // settle-time clock — read before the later backoff/park passes advance the clock further.
    expect(h.getConduction('cond-1').last_leg_ended_at).toBe(iso(h.now()));
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
    expect(h.reaps()).toHaveLength(3); // B-1187: two retry reaps + the pre-park reap, written before the parked status
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

  it('B-1187: killReasonFromExitCode maps only 71/72/73', () => {
    expect([71, 72, 73, 1, 0, 137, null].map(killReasonFromExitCode)).toEqual(['Evicted or disrupted', 'OOMKilled', 'DeadlineExceeded', null, null, null, null]);
  });

  // ── B-1187 ──────────────────────────────────────────────────────────────────────────────────
  const orderOf = (h: ReturnType<typeof makeHarness>) => {
    const reapOrders = (h.deps.runCommand as unknown as { mock: { calls: unknown[][]; invocationCallOrder: number[] } }).mock;
    const reapIdx = reapOrders.calls.map((c, i) => (String(c[0]).startsWith('reap') ? reapOrders.invocationCallOrder[i] : -1)).filter((n) => n >= 0);
    const w = (h.deps.updateConductionIfHeld as unknown as { mock: { calls: unknown[][]; invocationCallOrder: number[] } }).mock;
    const parkedIdx = w.calls.map((c, i) => ('status' in (c[2] as object) ? w.invocationCallOrder[i] : -1)).filter((n) => n >= 0);
    return { reapIdx, parkedIdx };
  };

  it('B-1187: the final dirty attempt is reaped BEFORE the parked write (3 launches, 3 reaps)', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: retryConfig,
      launchExitCodes: [1, 1, 1],
    });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    h.setNow(h.now() + 15_000);
    await h.pass();
    await h.pass();
    h.setNow(h.now() + 30_000);
    await h.pass();
    await h.pass();
    expect(h.launches()).toHaveLength(3);
    expect(h.reaps()).toHaveLength(3);
    const { reapIdx, parkedIdx } = orderOf(h);
    expect(parkedIdx).toHaveLength(1);
    expect(reapIdx[reapIdx.length - 1]).toBeLessThan(parkedIdx[0]);
  });

  it("B-1187: a dirty-exit retry writes THIS leg's class and exit code, even when the previous class was 'clean-pause'", async () => {
    const h = makeHarness({
      conductions: [conduction({ last_worker_exit_class: 'clean-pause', last_worker_exit_code: 0 })],
      tasks: { 'task-1': pausedTask() },
      config: retryConfig,
      launchExitCodes: [72],
    });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // fire
    await h.pass(); // settle -> retry queued
    expect(h.ready()).toEqual(['cond-1']);
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('dirty-exit');
    expect(h.getConduction('cond-1').last_worker_exit_code).toBe(72);
  });

  it.each([
    [71, 'Evicted or disrupted'],
    [72, 'OOMKilled'],
    [73, 'DeadlineExceeded'],
  ])('B-1187: exit %i posts a kill-reason comment on the retry path', async (code, reason) => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, config: retryConfig, launchExitCodes: [code] });
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    expect(addTicketComment).toHaveBeenCalledTimes(1);
    expect(addTicketComment).toHaveBeenCalledWith(
      'task-1',
      `Leg killed by the platform: ${reason} (exit ${code}), attempt 1 of 3 — counted as a failed leg.`,
    );
  });

  it('B-1187: a killed leg on the final attempt (park path) also posts the kill-reason comment, then parks', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCodes: [72] });
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    expect(addTicketComment).toHaveBeenCalledWith('task-1', 'Leg killed by the platform: OOMKilled (exit 72), attempt 1 of 1 — counted as a failed leg.');
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('dirty-exit');
  });

  it('B-1187: a killed leg that stays a clean pause (the ticket already shows a brief) still gets the comment', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCodes: [73] });
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true;
    };
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('clean-pause');
    expect(addTicketComment).toHaveBeenCalledTimes(1);
    expect(String(addTicketComment.mock.calls[0][1])).toContain('DeadlineExceeded (exit 73)');
    expect(String(addTicketComment.mock.calls[0][1])).toContain('clean pause');
    expect(h.reaps()).toEqual([]); // the wait path is not a park: no pre-park reap
  });

  it('B-1187: an ordinary dirty exit (1) posts no kill-reason comment', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, config: retryConfig, launchExitCodes: [1] });
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    expect(addTicketComment).not.toHaveBeenCalled();
  });

  it('B-1187: reap exit 3 (nothing there) before a park is safe — parks normally, no warning comment', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1, reapExitCode: 3 });
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    expect(h.reaps()).toHaveLength(1);
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(addTicketComment).not.toHaveBeenCalled();
  });

  it('B-1187: reap exit 1 retries 3 times (inline, no new leg), then parks with a possibly-still-running comment', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1, reapExitCode: 1 });
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    expect(h.reaps()).toHaveLength(3);
    expect(h.launches()).toHaveLength(1); // no new worker leg fired by the failing reap
    expect(h.getConduction('cond-1').status).toBe('parked');
    const { reapIdx, parkedIdx } = orderOf(h);
    expect(reapIdx[2]).toBeLessThan(parkedIdx[0]); // active until the last attempt is spent
    expect(addTicketComment).toHaveBeenCalledTimes(1);
    expect(String(addTicketComment.mock.calls[0][1])).toContain('may still be running');
  });

  it('B-1187: a reap that THROWS counts as unconfirmed (parks after 3 attempts; the pass does not throw)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1 });
    const real = h.deps.runCommand;
    h.deps.runCommand = vi.fn(async (cmd: string, o?: { quiet?: boolean }) => {
      if (cmd.startsWith('reap')) throw new Error('kubectl exploded');
      return real(cmd, o);
    }) as typeof real;
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(String(addTicketComment.mock.calls[0][1])).toContain('may still be running');
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
    expect(h.reaps()).toHaveLength(1); // B-1187: the park itself is reaped (no retry reap)
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
    // B-1040: last_leg_ended_at also landed, isolated from the terminal status write above.
    expect(h.getConduction('cond-1').last_leg_ended_at).toBe(iso(h.now()));
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
  // B-1058: resolveWorkRef is module-private; it is pinned through the fire path — the ref the
  // probe is called with IS resolveWorkRef's output, now fed by the meta projection's branch-only
  // field_values (branch values uncoerced; nulls degrade to "no ref").
  it('B-1058: a meta-shaped branch-only field_values resolves build_pr.branch, then work_branch.branch, then nothing', async () => {
    const metaFv = (fv: { build_pr?: { branch?: unknown } | null; work_branch?: { branch?: unknown } | null }) => fv;

    // 1. PR branch preferred (even with an empty-string pre-PR branch recorded).
    let h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ field_values: metaFv({ build_pr: { branch: 'feat/pr' }, work_branch: { branch: '' } }) as DaemonTask['field_values'] }) },
    });
    h.setProbeRefSha('feat/pr', 'sha-1');
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    expect(h.probeRefCalls()).toEqual([{ ref: 'feat/pr', result: 'sha-1' }]);

    // 2. Pre-PR fallback when no usable build_pr.branch (null, exactly as the projection emits).
    h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ field_values: metaFv({ build_pr: { branch: null }, work_branch: { branch: 'feat/wip' } }) as DaemonTask['field_values'] }) },
    });
    h.setProbeRefSha('feat/wip', 'sha-2');
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    expect(h.probeRefCalls()).toEqual([{ ref: 'feat/wip', result: 'sha-2' }]);

    // 3. Both null ⇒ never probed.
    h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ field_values: metaFv({ build_pr: { branch: null }, work_branch: { branch: null } }) as DaemonTask['field_values'] }) },
    });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    expect(h.probeRefCalls()).toEqual([]);
    expect(h.runtime.running.get('cond-1')?.preFireHeadSha).toBeNull();
  });

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
    // B-1166: marker set + no leg in flight ⇒ nothing to reap, so the takeover skips the reap.
    expect(h.commands).toEqual(['launch cond-1 task-1']);
    // B-761 reopen fix (legibility): the marker-driven adoption gets its OWN distinct log line —
    // no timestamp arithmetic required to tell it apart from a genuine staleness-window adoption.
    expect(h.logs.some((l) => l === 'conduction cond-1: adopted cleanly-released lease from this-host:1:dead0000')).toBe(true);
    expect(h.logs.some((l) => /took over stale lease/.test(l))).toBe(false);
  });

  it('B-1166: marker set + no leg ⇒ takeover skips BOTH the getTaskMeta read and the reap', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'this-host:1:dead0000',
          last_heartbeat_at: iso(T0 - 1_000),
          clean_shutdown_at: iso(T0 - 1_000),
          leg_started_at: null,
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    await h.pass(); // takeover win only
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    expect(h.reaps()).toEqual([]);
    // The one remaining read is the pass's own wake read — the reap snapshot read is skipped
    // (compare the stale-takeover test below, which sees one more).
    expect(h.deps.getTaskMeta).toHaveBeenCalledTimes(1);
    expect(h.logs.some((l) => l === 'conduction cond-1: adopted cleanly-released lease from this-host:1:dead0000')).toBe(true);
  });

  it('B-1166: marker set but leg_started_at non-null and probe finds nothing ⇒ the reap still runs', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'this-host:1:dead0000',
          last_heartbeat_at: iso(T0 - 1_000),
          clean_shutdown_at: iso(T0 - 1_000),
          leg_started_at: iso(T0 - 30_000),
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
      config: reconcilableConfig,
      probeDefaultExitCode: 1, // nothing live
    });
    await h.pass();
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
  });

  it('B-1166: marker unset (stale takeover) ⇒ the reap still runs', async () => {
    const h = makeHarness({
      conductions: [
        conduction({
          lease_holder: 'this-host:1:dead0000',
          last_heartbeat_at: iso(T0 - 1_000),
          clean_shutdown_at: null,
          leg_started_at: null,
        }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });
    h.setNow(T0 + config.staleMs + 1_000);
    await h.pass();
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.deps.getTaskMeta).toHaveBeenCalledTimes(2);
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-1011 — the OPTIONAL hint race against the (unchanged) poll sleep.
//
// Everything below drives the REAL src/daemon/hints.ts coalescer over a virtual clock on the
// already-injected `sleep` / `startTimeout` seams. No real timers, no socket: the impure channel
// adapter is tested separately in hint-subscription.test.ts.

/** A virtual clock for the two seams the loop actually uses. `sleep` is a promise that resolves
 *  when time reaches its deadline — which is what makes a LOSING sleep observable: it stays
 *  pending in this queue and fires later, exactly as a real abandoned timer does. */
function makeVirtualClock() {
  let now = 0;
  let seq = 0;
  const pending: Array<{ id: number; at: number; fire: () => void }> = [];
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    now: () => now,
    pendingCount: () => pending.length,
    sleep: (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        pending.push({ id: (seq += 1), at: now + ms, fire: resolve });
      }),
    startTimeout: (ms: number, fn: () => void): (() => void) => {
      const entry = { id: (seq += 1), at: now + ms, fire: fn };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    /** Advance to an ABSOLUTE time, firing everything due in (deadline, insertion) order and
     *  letting the loop run to quiescence between each. */
    advanceTo: async (t: number): Promise<void> => {
      for (;;) {
        const due = pending
          .filter((p) => p.at <= t)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        pending.splice(pending.indexOf(due), 1);
        now = due.at;
        due.fire();
        await flush();
      }
      now = t;
      await flush();
    },
  };
}

/** Wire the harness's scheduler deps onto a virtual clock + the REAL hint coalescer, and start the
 *  forever loop in the background. `passes()` counts passes by the one read every pass makes. */
function startLoopWithHints(h: ReturnType<typeof makeHarness>, opts: { hints?: boolean } = {}) {
  const clock = makeVirtualClock();
  const coalescer = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
  const sleepArgs: number[] = [];
  (h.deps as { sleep: (ms: number) => Promise<void> }).sleep = (ms: number) => {
    sleepArgs.push(ms);
    return clock.sleep(ms);
  };
  (h.deps as { startTimeout: (ms: number, fn: () => void) => () => void }).startTimeout =
    clock.startTimeout;
  if (opts.hints !== false) (h.deps as { hints?: HintSource }).hints = coalescer;
  const loop = runScheduler(h.deps, h.keeper);
  void loop.catch(() => {
    /* the loop is never stopped in these tests; the process ends with the test */
  });
  /** Deliver a broadcast message exactly as the adapter would: decide, then arm the window timer. */
  const hint = (msg: Parameters<typeof coalescer.accept>[0]): void => {
    const action = coalescer.accept(msg);
    if (action.action === 'open-window') clock.startTimeout(action.debounceMs, coalescer.closeWindow);
  };
  return {
    clock,
    hint,
    sleepArgs,
    passes: () => (h.deps.listConductions as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
  };
}

const taskHint = { event: 'task_change', payload: { record: { id: 'task-1' } } };

describe('runScheduler — B-1011 hint race', () => {
  it('a hint at t+1s runs a full pass at t+2s (first hint opens the fixed 1s window)', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    const w = startLoopWithHints(h);
    await w.clock.advanceTo(0);
    expect(w.passes()).toBe(1); // the boot pass, then the loop is asleep

    await w.clock.advanceTo(1_000);
    w.hint(taskHint);
    await w.clock.advanceTo(1_999);
    expect(w.passes()).toBe(1); // still inside the fixed 1s debounce window
    await w.clock.advanceTo(2_000);
    expect(w.passes()).toBe(2); // woken at t+2s — NOT t+25s
    expect(w.clock.now()).toBe(2_000);
  });

  it('a SILENT channel changes nothing: the next pass is at t+25s and every sleep is still pollMs', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    const w = startLoopWithHints(h);
    await w.clock.advanceTo(0);
    await w.clock.advanceTo(24_999);
    expect(w.passes()).toBe(1);
    await w.clock.advanceTo(25_000);
    expect(w.passes()).toBe(2);
    await w.clock.advanceTo(50_000);
    expect(w.passes()).toBe(3);
    expect(w.sleepArgs.every((ms) => ms === config.pollMs)).toBe(true);
  });

  it('with NO hints dep the loop is unchanged — pass at t+25s, and the same pollMs sleep', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    const w = startLoopWithHints(h, { hints: false });
    await w.clock.advanceTo(0);
    await w.clock.advanceTo(24_999);
    expect(w.passes()).toBe(1);
    await w.clock.advanceTo(25_000);
    expect(w.passes()).toBe(2);
    expect(w.sleepArgs).toEqual([config.pollMs, config.pollMs]);
  });

  it('a BURST of hints produces exactly ONE extra pass', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    const w = startLoopWithHints(h);
    await w.clock.advanceTo(0);
    for (let i = 0; i < 20; i += 1) w.hint(taskHint);
    await w.clock.advanceTo(500);
    for (let i = 0; i < 20; i += 1) w.hint(taskHint); // still inside the same fixed window
    await w.clock.advanceTo(5_000);
    expect(w.passes()).toBe(2); // ONE pass for the whole burst
  });

  it('THE RACE HAZARD: a stale losing pollMs sleep resolving later can never wake a LATER iteration', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    const w = startLoopWithHints(h);
    await w.clock.advanceTo(0);

    // Iteration 1 races a sleep due at t=25s. A hint wins it at t=2s, ABANDONING that sleep —
    // which is still queued and will resolve on schedule.
    await w.clock.advanceTo(1_000);
    w.hint(taskHint);
    await w.clock.advanceTo(2_000);
    expect(w.passes()).toBe(2);

    // Iteration 2 raced a FRESH sleep, due at t=27s. The abandoned one fires at t=25s...
    await w.clock.advanceTo(25_000);
    expect(w.passes()).toBe(2); // ...and wakes nothing: no awaiter is left holding it.
    await w.clock.advanceTo(26_999);
    expect(w.passes()).toBe(2);
    await w.clock.advanceTo(27_000);
    expect(w.passes()).toBe(3); // the FRESH sleep, a full pollMs after its own iteration began
  });

  it('a hint arriving MID-PASS is consumed at the next sleep — no wake lost, no two passes overlapping', async () => {
    const h = makeHarness({ conductions: [], tasks: {} });
    let inFlight = 0;
    let maxConcurrent = 0;
    let calls = 0;
    let release: (() => void) | null = null;
    // Pass 2 BLOCKS until the test releases it, so a wake can land in the middle of a pass — the
    // exact case the sticky flag exists for.
    (h.deps as { listConductions: () => Promise<unknown[]> }).listConductions = vi.fn(async () => {
      calls += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
      inFlight -= 1;
      return [];
    });
    const w = startLoopWithHints(h);
    await w.clock.advanceTo(0);
    await w.clock.advanceTo(25_000); // the poll fires pass 2 — which now blocks, mid-pass
    expect(w.passes()).toBe(2);

    w.hint(taskHint); // window opens at t=25s and closes at t=26s, while pass 2 still runs
    await w.clock.advanceTo(26_000);
    expect(w.passes()).toBe(2); // the wake is LATCHED, not delivered into a running pass
    expect(maxConcurrent).toBe(1);

    release!();
    await w.clock.advanceTo(26_000); // pass 2 finishes and the loop reaches its sleep
    expect(w.passes()).toBe(3); // the sticky wake is consumed there — nothing was lost
    expect(maxConcurrent).toBe(1); // and still never two passes at once

    // Consumed exactly ONCE: the sleep after it runs the full poll interval.
    await w.clock.advanceTo(50_999);
    expect(w.passes()).toBe(3);
    await w.clock.advanceTo(51_000);
    expect(w.passes()).toBe(4);
  });

  it('the hint never enters any read or decision: a hint-driven pass reads exactly what a poll-driven one reads', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': { workflow_state: 'Built', awaiting_human_input: true } },
    });
    const w = startLoopWithHints(h);
    await w.clock.advanceTo(0);
    const pollDrivenReads = (h.deps.getTaskMeta as unknown as { mock: { calls: unknown[][] } }).mock
      .calls.length;

    // A payload full of ids the daemon must NEVER act on — it is read only to DISCARD, so a
    // hint-driven pass must re-read the board and touch nothing the payload named.
    await w.clock.advanceTo(1_000);
    w.hint({
      event: 'task_change',
      payload: { record: { id: 'task-FORGED', status: 'Ready', lease_holder: 'someone-else' } },
    });
    await w.clock.advanceTo(2_000);

    const reads = (h.deps.getTaskMeta as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(reads.length).toBe(pollDrivenReads + 1); // same reads, one pass later
    expect(reads.every((c) => c[0] === 'task-1')).toBe(true); // never the payload's id
    expect(h.commands.join(' ')).not.toContain('FORGED');
    expect(h.logs.join(' ')).not.toContain('FORGED');
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

  it('B-1172: while launchPaused() is true no NEW leg launches (the row stays ready); once it clears the leg fires', async () => {
    let paused = true;
    const h = makeHarness({
      conductions: [conduction({ id: 'cond-1', task_id: 'task-1' })],
      tasks: { 'task-1': pausedTask() },
      blockLaunch: true,
    });
    (h.deps as { launchPaused?: () => boolean }).launchPaused = () => paused;
    await h.pass(); // baseline
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // wakes: ready, but paused
    expect(h.ready()).toEqual(['cond-1']);
    expect(h.launches()).toHaveLength(0);
    paused = false;
    await h.pass();
    expect(h.launches()).toHaveLength(1);
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

  // B-845: a post-send/ambiguous CAS error extends the SAME "no retry this pass, a later pass may
  // reconsider" idiom the loses-the-race case just above already uses — it is not a new mechanism.
  it('B-845: a post-send/ambiguous steal-CAS error is not retried this pass (logged skip via formatDaemonError with the endpoint, no worker fired); a later pass with a fresh read wins the CAS and fires the worker exactly once', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'peer-host:2:bbbb2222', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: null }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
    });

    await h.pass(); // first sight — baseline only, no verdict yet
    expect(h.deps.stealConduction).not.toHaveBeenCalled();

    // Pass 1: the steal CAS write itself fails ambiguously (server-side outcome unknown) — 'cas'
    // class writes NEVER retry this bucket, unlike 'idempotent' (heartbeat.ts).
    (h.deps.stealConduction as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw { code: 'ECONNRESET', message: 'read ECONNRESET' };
    });
    await h.pass();
    expect(h.deps.stealConduction).toHaveBeenCalledTimes(1);
    expect(h.commands).toEqual([]); // no retry attempted, no worker fired
    expect(h.getConduction('cond-1').lease_holder).toBe('peer-host:2:bbbb2222'); // untouched
    expect(
      h.logs.some(
        (l) => /steal error — row skipped/.test(l) && /ECONNRESET/.test(l) && /conductions\.stealConduction/.test(l),
      ),
    ).toBe(true);

    // Pass 2: a fresh read, real CAS semantics — this time the steal wins and fires immediately.
    await h.pass();
    expect(h.deps.stealConduction).toHaveBeenCalledTimes(2);
    expect(h.getConduction('cond-1').lease_holder).toBe(ME);
    expect(h.commands).toEqual(['launch cond-1 task-1']);
    expect(h.running()).toEqual(['cond-1']);
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
// B-842 — AC4: a REAPED live worker must be distinguishable from a NORMALLY-EXITED one by
// OBSERVABLE STATE, never by exit code alone (exit 137 is ambiguous: a reap, an OOM kill, and a
// peer's takeover-reap all produce it). This exercises the REAL takeover/reap code path
// (runSchedulerPass -> handleWonTakeover's unconditional reap-then-fire branch, taken here because
// the harness's base `config` carries no `probe` template — exactly the profile shape this
// ticket's boot preflight now refuses to boot without an explicit `probe: false` opt-out) so a
// regression in that logic fails this test, not a hand-built fixture comparison.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('B-842: a takeover reap genuinely kills a live worker — distinguishable from a normal settle, never by exit code alone', () => {
  it('the reap-then-fire path terminates a still-running worker: the reap template actually runs, and the killed worker is DISCARDED (never classified) — unlike a normal settle', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      blockLaunchIds: ['cond-1'],
      // Deliberately the BASE config — no `probe` template (the exact profile shape B-842's boot
      // preflight now hard-refuses to boot without an explicit `probe: false` opt-out).
    });

    await wakeAndFire(h); // this daemon's OWN worker is genuinely running: blocked on 'launch cond-1 task-1'
    expect(h.running()).toEqual(['cond-1']);
    expect(h.commands).toEqual(['launch cond-1 task-1']);
    expect(h.getConduction('cond-1').leg_started_at).not.toBeNull(); // a leg is genuinely in flight

    // Simulate this daemon's OWN process dying and a peer daemon — fresh in-memory state, exactly
    // what a real second process starts with — taking over the SAME still-live container.
    h.getConduction('cond-1').lease_holder = 'dead-host:9:zzzz9999';
    h.getConduction('cond-1').last_heartbeat_at = iso(h.now() - 600_000);

    const peerState = new Map<string, WatchBaseline>();
    const peerRuntime = createSchedulerRuntime();
    const peerKeeper = createHeartbeatKeeper({
      now: h.now,
      startInterval: h.deps.startInterval,
      updateConductionIfHeld: (id, patch) => h.deps.updateConductionIfHeld(id, ME, patch),
      log: h.deps.log,
      heartbeatMs: config.heartbeatMs,
    });

    await runSchedulerPass(h.deps, peerState, peerKeeper, peerRuntime);
    await h.settle();

    // Observable evidence the worker was genuinely REAPED (killed), not that it merely happened to
    // exit with code 137 on its own: (a) the reap template actually ran and (per the fake's
    // live-verified reap contract) FREED the still-blocked launch, (b) the peer's OWN
    // reap-after-takeover write — never a settle-time write — is what cleared leg_started_at, and
    // (c) no exit classification is EVER recorded for this worker: a reaped worker is DISCARDED,
    // not classified. That discarded/classified split is the distinguishing signal — see the
    // contrast test below, which settles normally and DOES get a recorded exit class.
    expect(h.reaps()).toEqual(['reap cond-1']);
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
    expect(h.getConduction('cond-1').last_worker_exit_class).toBeNull();
    expect(h.getConduction('cond-1').last_worker_exit_code).toBeNull();
    expect(
      h.logs.some((l) => l === 'conduction cond-1: took over stale lease from dead-host:9:zzzz9999 — reaped'),
    ).toBe(true);
  });

  it('contrast: a normally-exited worker settles via classify and DOES get a recorded exit class — its only reap is the B-1187 pre-park one', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchExitCode: 1, // any definite settle works; a dirty exit needs no task-state mutation
    });
    await wakeAndFire(h); // fire
    await h.pass(); // settle → classify

    expect(h.reaps()).toEqual(['reap cond-1']); // B-1187: only the idempotent pre-park reap; nothing was escalated
    expect(h.getConduction('cond-1').leg_started_at).toBeNull(); // cleared, but via SETTLEMENT
    expect(h.getConduction('cond-1').last_worker_exit_code).toBe(1);
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('dirty-exit'); // classified, never discarded
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
    expect(h.logs.join(' ')).toMatch(/lease lost to another conductor while a launch was tracked/);
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

    expect(h.reaps()).toEqual(['reap cond-1', 'reap cond-1']); // the escalation's reap + B-1187's pre-park reap
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

    expect(h.reaps()).toEqual(['reap cond-1', 'reap cond-1']); // the escalation's reap + B-1187's pre-park reap
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
    expect(h.reaps()).toEqual(['reap cond-1', 'reap cond-1']); // the escalation's reap + B-1187's pre-park reap
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

    expect(h.reaps()).toEqual(['reap cond-1', 'reap cond-1']); // the escalation's reap + B-1187's pre-park reap
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
// B-1052: the terminal-ticket pre-fire decline. A NEW fire against a ticket that already reached a
// TICKET_TERMINAL_STATES workflow_state (Verified/Cancelled/Parked) settles straight to
// 'completed'/'terminal-no-leg' (B-1107: an already-Parked ticket parks the conduction instead —
// 'parked'/'ticket-parked-no-leg') via the SAME writeIfHeld path the B-740 archived-ticket decline just
// above uses — never reaches classifyWorkerExit (there is no worker exit to classify: this is a
// pre-fire decline), and never fires a leg on a dead ticket.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-1052: terminal-ticket pre-fire decline (held path)', () => {
  it('a terminal ticket held by this daemon fires NO leg and closes with terminal-no-leg', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true }) },
    });

    await h.pass(); // baseline

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).workflow_state = 'Verified';
    await h.pass();

    expect(h.launches()).toEqual([]); // never fired
    expect(h.ready()).toEqual([]);
    expect(h.statusWrites()).toEqual([
      { status: 'completed', last_worker_exit_code: null, last_worker_exit_class: 'terminal-no-leg' },
    ]);
    expect(h.getConduction('cond-1').status).toBe('completed');
    expect(
      h.logs.some((l) => l.includes('ticket already terminal (Verified) — declining fire, closing conduction')),
    ).toBe(true);
  });

  it('B-1107: an already-Parked ticket fires NO leg and PARKS the conduction with ticket-parked-no-leg', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true }) },
    });
    await h.pass(); // baseline

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).workflow_state = 'Parked';
    await h.pass();

    expect(h.launches()).toEqual([]);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: null, last_worker_exit_class: 'ticket-parked-no-leg' },
    ]);
    expect(h.getConduction('cond-1').status).toBe('parked');
  });

  it('B-1107: a worker that exits with its ticket Parked parks the conduction (ticket-parked) and is never retried', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchExitCode: 1,
    });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).workflow_state = 'Parked';
    };
    await h.pass(); // fire
    await h.pass(); // settle
    await h.pass();
    await h.pass();

    expect(h.launches()).toHaveLength(1);
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('ticket-parked');
    expect(h.getConduction('cond-1').retry_count).toBe(0);
  });

  it('RE-ENTRANCY: a second pass over an already-completed (terminal-declined) conduction is a silent no-op — never a second close write, never a throw', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true }) },
    });
    await h.pass(); // baseline

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).workflow_state = 'Verified';
    await h.pass(); // declines + closes
    expect(h.statusWrites()).toHaveLength(1);

    // The row is now 'completed' in the fake conductions table — listConductions(status:'active')
    // no longer returns it, exactly like the B-740 archived-decline's transition-only-logging test.
    await expect(h.pass()).resolves.not.toThrow();
    await expect(h.pass()).resolves.not.toThrow();

    expect(h.statusWrites()).toHaveLength(1); // still exactly one close write — no double-close
    expect(h.launches()).toEqual([]);
  });

  it('CONCURRENCY: a lease that moved to another conductor in the gap between the ticket read and the terminal-decline write is rejected — only one close write ever lands (the same writeIfHeld CAS every other decline/park write already relies on)', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: true }) },
    });
    await h.pass(); // baseline

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-1'] as DaemonTask).workflow_state = 'Verified';

    // Simulate a SECOND fire path (a peer daemon's own takeover, or this daemon's own steal path in
    // a concurrent tick) winning the lease in the gap between THIS pass's getTaskMeta read and its
    // writeIfHeld call — the same shape as the existing B-739 "SUPPRESSES the outcome write when the
    // lease was taken over mid-launch" test, applied to this new decline site.
    (h.deps.getTaskMeta as ReturnType<typeof vi.fn>).mockImplementationOnce(async (taskId: string) => {
      h.getConduction('cond-1').lease_holder = 'other-daemon:9:zzzz'; // the peer won first
      return { ...(h.tasks[taskId] as DaemonTask) };
    });

    await h.pass();

    const row = h.getConduction('cond-1');
    expect(row.lease_holder).toBe('other-daemon:9:zzzz'); // untouched beyond the simulated race
    expect(row.status).toBe('active'); // our decline write was REJECTED by the CAS — no clobber
    expect(row.last_worker_exit_class).toBeNull();
    expect(h.commands).toEqual([]); // never fired a leg either
    expect(h.logs.join(' ')).toMatch(/lease lost to another conductor/);
  });
});

describe('B-1052: terminal-ticket pre-fire decline (steal path)', () => {
  it('a terminal ticket discovered via the foreign/steal path also declines and closes — never fires a leg', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'peer-host:2:bbbb2222', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: null }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false, workflow_state: 'Verified' }) },
    });

    await h.pass(); // first sight of the foreign row — baseline only, no verdict yet
    expect(h.deps.stealConduction).not.toHaveBeenCalled();

    await h.pass(); // first-pickup wake detected → steal attempted + won → terminal decline, not a fire
    expect(h.deps.stealConduction).toHaveBeenCalledWith({
      id: 'cond-1',
      observed_lease_holder: 'peer-host:2:bbbb2222',
      new_lease_holder: ME,
    });

    const row = h.getConduction('cond-1');
    expect(row.lease_holder).toBe(ME); // the steal genuinely won…
    expect(row.status).toBe('completed'); // …but closes instead of firing
    expect(row.last_worker_exit_code).toBeNull();
    expect(row.last_worker_exit_class).toBe('terminal-no-leg');
    expect(h.commands).toEqual([]); // never fired a leg
    expect(h.running()).toEqual([]);
    expect(
      h.logs.some((l) => l.includes('ticket already terminal (Verified) — declining stolen fire, closing conduction')),
    ).toBe(true);
  });

  it('B-1107: an already-Parked ticket discovered via the steal path parks the conduction with ticket-parked-no-leg', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'peer-host:2:bbbb2222', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: null }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false, workflow_state: 'Parked' }) },
    });
    await h.pass();
    await h.pass();

    const row = h.getConduction('cond-1');
    expect(row.lease_holder).toBe(ME);
    expect(row.status).toBe('parked');
    expect(row.last_worker_exit_code).toBeNull();
    expect(row.last_worker_exit_class).toBe('ticket-parked-no-leg');
    expect(h.commands).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-1052 contract: (a) the brief-less umbrella-auto-verify sentinel belt in handleHeldConduction
// never lets a leg fire for that exact shape — even adversarially, independent of the wake gate;
// (b) the terminal-decline logic must never mistake a LIVE split-umbrella parent (Decomposed, ≥1
// non-archived child in flight, no terminal workflow_state of its own) for a terminal ticket. Pins
// both directions so a future change to either shape is caught here first.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-1052 contract: umbrella-auto-verify sentinel belt + live split-umbrella non-regression', () => {
  it('never fires a leg for the brief-less umbrella-auto-verify sentinel shape, even when awaiting_human_input is (adversarially) false — the belt holds independent of the wake gate', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: {
        'task-1': pausedTask({
          awaiting_human_input: false, // adversarial: would otherwise first-pickup-wake
          workflow_state: 'Deployed',
          awaiting_human_reason: 'verification-ack-pending',
          awaiting_human_ref: { kind: 'umbrella-auto-verify' },
        }),
      },
    });

    await h.pass();
    await h.pass();
    await h.pass();

    expect(h.launches()).toEqual([]);
    expect(h.ready()).toEqual([]);
    expect(h.statusWrites()).toEqual([]);
    expect(h.logs.some((l) => l.includes('umbrella-auto-verify sentinel awaiting human ack'))).toBe(true);
  });

  it('a LIVE Decomposed split-umbrella parent (non-archived children in flight, no build_pr of its own) is NOT declined by the terminal check — Decomposed is not in TICKET_TERMINAL_STATES — and its children keep firing normally alongside it', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ id: 'cond-parent', task_id: 'task-parent' }),
        conduction({ id: 'cond-child', task_id: 'task-child' }),
      ],
      tasks: {
        'task-parent': pausedTask({ workflow_state: 'Decomposed', awaiting_human_input: true }),
        'task-child': pausedTask(),
      },
      childCount: 1, // ≥1 non-archived child in flight for the parent
    });
    await h.pass(); // baseline both

    (h.tasks['task-parent'] as DaemonTask).awaiting_human_input = false; // ball returns to the agent
    (h.tasks['task-child'] as DaemonTask).awaiting_human_input = false;
    await h.pass();

    expect(h.launches().sort()).toEqual(['launch cond-child task-child', 'launch cond-parent task-parent']);
    expect(h.statusWrites()).toEqual([]); // neither was declined/closed
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

    // B-1020: leg_count lands in the SAME lease-guarded write as leg_started_at — conduction()'s
    // default leg_count is 0, so this first fire's leg is 1.
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      leg_started_at: iso(T0),
      leg_count: 1,
    });
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
// B-1020 — a conductor leg's writes name their leg number, not just their run: fireLaunch bundles
// leg_count into the same lease-guarded write as leg_started_at, and delivers the leg number to the
// worker via a PER-CALL `env` option on the launch runCommand (never a process.env mutation — see
// scheduler.ts's fireLaunch comment for why that matters under concurrent legs).
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-1020: HARMONY_LEG delivery', () => {
  it('fires the launch runCommand with an env option carrying HARMONY_LEG, alongside process.env, and increments leg_count on each successive fire', async () => {
    const h = makeHarness({
      conductions: [conduction({ leg_count: 4 })], // a run already 4 legs in
      tasks: { 'task-1': pausedTask() },
    });
    await h.pass(); // baseline
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved -> wake
    await h.pass(); // wake -> fire

    const launchCall = h.runCommandCalls().find(([cmd]) => cmd.startsWith('launch'));
    expect(launchCall).toBeDefined();
    const [, launchOpts] = launchCall!;
    expect(launchOpts?.env).toMatchObject({ ...process.env, HARMONY_LEG: '5' });

    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith('cond-1', ME, {
      leg_started_at: iso(T0),
      leg_count: 5,
    });
    expect(h.getConduction('cond-1').leg_count).toBe(5);
  });

  it('a conduction with no prior legs (leg_count undefined/0) fires its first leg as HARMONY_LEG=1', async () => {
    const h = makeHarness({
      conductions: [conduction()], // leg_count defaults to 0
      tasks: { 'task-1': pausedTask() },
    });
    await h.pass(); // baseline
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // the human resolved -> wake
    await h.pass(); // wake -> fire

    const launchCall = h.runCommandCalls().find(([cmd]) => cmd.startsWith('launch'));
    const [, launchOpts] = launchCall!;
    expect(launchOpts?.env?.HARMONY_LEG).toBe('1');
  });
});

describe('B-1188: GKE worker identity', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const gkeConfig: DaemonConfig = {
    ...config,
    profile: {
      ...config.profile,
      launch: 'bash gke-worker-launch.sh {conduction_id} {ticket}',
      reap: 'reap {conduction_id} {worker_ref}',
      probe: 'probe {conduction_id} {worker_ref}',
    },
  };

  it('derives a DNS-safe attempt name and rejects names beyond Kubernetes limits', () => {
    expect(gkeWorkerJobName(id.toUpperCase(), 12)).toBe(`leg-${id}-12`);
    expect(gkeWorkerJobName(id, Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(63);
    expect(() => gkeWorkerJobName('bad/name', 1)).toThrow(/DNS-safe/);
    expect(() => gkeWorkerJobName(id, 0)).toThrow(/positive safe attempt/);
  });

  it('persists the attempt identity before launch, supplies it to the launcher, then clears it on settlement', async () => {
    const h = makeHarness({
      conductions: [conduction({ id })],
      tasks: { 'task-1': pausedTask() },
      config: gkeConfig,
    });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();

    const name = `leg-${id}-1`;
    expect(h.deps.updateConductionIfHeld).toHaveBeenCalledWith(id, ME, {
      leg_started_at: iso(T0), leg_count: 1, worker_ref: name,
    });
    const launchCall = h.runCommandCalls().find(([cmd]) => cmd.startsWith('bash gke-worker-launch.sh'));
    expect(launchCall?.[1]?.env).toMatchObject({ HARMONY_GKE_JOB_NAME: name, HARMONY_LEG: '1' });
    expect(h.getConduction(id).worker_ref).toBe(name);
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
      'B-756 "Renamed while the leg ran" (conduction cond-1): worker exit code=0 → conduction waiting (clean-pause)',
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-720 captured LAUNCH-COMMAND output — the bounded tail the operator reads in the browser instead
// of shelling into the daemon host. What this daemon captures is the LAUNCH COMMAND's stdout, which
// is the worker's own only on the docker profile; on the cloud profile (the one production runs) it
// is Cloud Run client chatter. So it is written as a `source='launcher'` row and rendered under its
// own "Launcher diagnostics" label — the worker writes its OWN output from inside the container.
// Four properties matter here, and only these four:
//   (a) it LANDS on a normal settle, as a LAUNCHER row, with its own capture time + the total bytes;
//   (b) THE ANTI-MASQUERADE PROPERTY: this daemon may NEVER write a `source='worker'` row, and may
//       never write the retired `conductions.last_worker_output*` columns;
//   (c) a THROWING output write leaves the terminal status write intact — the recorded build gate
//       from the technical design (the daemon runs plugin `main` against the PROD board, so this
//       write genuinely fails for every settlement between the plugin merging and harmony-web's
//       migration being promoted);
//   (d) a re-attached (reconciled) launch writes NOTHING — this daemon never held that stream.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-720 captured launcher output', () => {
  it('(a) writes ONE launcher row with the tail, its own capture time and the total byte count', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchOutput: { tail: 'launching…\ngcloud: PERMISSION_DENIED\n', bytes: 4096 },
    });

    await wakeAndFire(h);
    await h.pass(); // settle → classify → terminal write → SEPARATE output write

    expect(h.legOutputRows()).toEqual([
      {
        conduction_id: 'cond-1',
        source: 'launcher',
        task_id: 'task-1',
        // The daemon CANNOT know the worker-minted leg key (the worker mints it inside the
        // container, after this launch command was rendered) — null here is informative, not lost.
        leg_key: null,
        gate: null,
        tail: 'launching…\ngcloud: PERMISSION_DENIED\n',
        total_bytes: 4096,
        captured_at: iso(T0),
      },
    ]);
  });

  it('(b) ANTI-MASQUERADE: never writes a worker row, and never writes the retired last_worker_output columns', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchOutput: { tail: 'gcloud chatter', bytes: 14 },
    });

    await wakeAndFire(h);
    await h.pass();

    // EVERY row this daemon writes is a launcher row. This is the whole fix: the UI selects worker
    // output by source alone, so a daemon that could write source='worker' would put launcher bytes
    // straight back under the "Worker output" heading.
    expect(h.legOutputWrites().map((r) => r.source)).toEqual(['launcher']);
    expect(h.legOutputWrites().some((r) => r.source === 'worker')).toBe(false);

    // B-947: the three retired columns are now fully gone from ConductionRecord and
    // CONDUCTION_PATCHABLE_FIELDS (src/tools/conduction-record.ts) — nothing here writes them, and
    // nothing could even NAME them in a typed patch any more. The runtime string check below still
    // guards the shape of what the daemon actually sends on the wire.
    const patches = (h.deps.updateConductionIfHeld as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => c[2] as Record<string, unknown>,
    );
    expect(patches.some((p) => 'last_worker_output' in p)).toBe(false);
    expect(patches.some((p) => 'last_worker_output_at' in p)).toBe(false);
    expect(patches.some((p) => 'last_worker_output_bytes' in p)).toBe(false);
  });

  it('(a) the output write is SEPARATE from — and lands after — the terminal status patch', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchOutput: { tail: 'tail', bytes: 4 },
    });

    await wakeAndFire(h);
    await h.pass();

    // The terminal patch names exactly the three status fields it always has — the captured output
    // is never folded into it, and now does not even travel on the same write path.
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: 0, last_worker_exit_class: 'no-progress' },
    ]);
    expect(h.legOutputRows()).toHaveLength(1);

    // ORDER, proven rather than assumed: the terminal status write is issued BEFORE the output
    // write, so a rejected output write can never be the reason a settlement did not land.
    const statusOrder = (h.deps.updateConductionIfHeld as unknown as {
      mock: { calls: unknown[][]; invocationCallOrder: number[] };
    });
    const statusIdx = statusOrder.mock.calls.findIndex((c) => 'status' in (c[2] as object));
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    const outputOrder = (h.deps.recordLegOutput as unknown as {
      mock: { invocationCallOrder: number[] };
    }).mock.invocationCallOrder[0];
    expect(outputOrder).toBeGreaterThan(statusOrder.mock.invocationCallOrder[statusIdx]);
  });

  it('(a) a launch that settles here having written NOTHING records a null tail with a real capture time', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchOutput: { tail: '', bytes: 0 },
    });

    await wakeAndFire(h);
    await h.pass();

    // A row IS written — "this launch said nothing" is a different, weaker claim than "nobody
    // looked", and only the row can tell them apart. The empty tail becomes NULL in the record
    // module (see recordLegOutput), so what is asserted here is what the scheduler HANDED it.
    expect(h.legOutputRows()).toEqual([
      {
        conduction_id: 'cond-1',
        source: 'launcher',
        task_id: 'task-1',
        leg_key: null,
        gate: null,
        tail: '',
        total_bytes: 0,
        captured_at: iso(T0),
      },
    ]);
  });

  it('(a) a CLEAN completion carries its launcher output too, not only a park', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      childCount: 2,
      launchOutput: { tail: 'container exited 0', bytes: 18 },
    });
    await h.pass();

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    h.hooks.onLaunch = () => {
      const task = h.tasks['task-1'] as DaemonTask;
      task.workflow_state = 'Decomposed';
      task.awaiting_human_input = false;
    };
    await h.pass(); // fire
    await h.pass(); // settle → complete

    expect(h.getConduction('cond-1').status).toBe('completed');
    expect(h.legOutputRows()).toHaveLength(1);
    expect(h.legOutputRows()[0].tail).toBe('container exited 0');
  });

  it('(c) BUILD GATE: a THROWING output write leaves the terminal status write intact', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      launchOutput: { tail: 'boom', bytes: 4 },
      // The pre-migration prod board: conduction_leg_output does not exist yet.
      throwOnLegOutputWrite: true,
    });

    await wakeAndFire(h);
    await expect(h.pass()).resolves.toBeDefined(); // the pass itself must not blow up

    // The settlement landed in full, exactly as it does with no output write at all.
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_code).toBe(0);
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
    expect(h.getConduction('cond-1').leg_started_at).toBeNull();
    // The failure was attempted, swallowed, and NAMED in the log — never silent.
    expect(h.legOutputWrites()).toHaveLength(1);
    expect(h.legOutputRows()).toEqual([]);
    expect(h.logs.some((l) => /launcher output not captured/.test(l))).toBe(true);
    expect(h.logs.some((l) => /the settlement above is unaffected/.test(l))).toBe(true);
  });

  it('(d) a re-attached (reconciled) launch writes NOTHING — this daemon never held that stream', async () => {
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
      // Even with a tail available from the fake, a reconciled launch never calls runCommand(launch)
      // at all — there is nothing to capture.
      launchOutput: { tail: 'should never be written', bytes: 23 },
    });

    await h.pass(); // takeover → probe found → RE-ATTACH (exitCode stays null)
    expect(h.running()).toEqual(['cond-1']);

    h.setProbe('cond-1', 1);
    await h.pass(); // probe no longer finds it → settle with a null exit code

    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.legOutputWrites()).toEqual([]);
    expect(h.legOutputRows()).toEqual([]);
  });

  it('a pre-B-720 runCommand (exit code only) reads as "nothing captured", never as an empty capture', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });

    await wakeAndFire(h);
    await h.pass();

    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.legOutputWrites()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-1073 (post-review wiring) — the fast-track ADMISSION CHECK at the fire path (fireLaunch): a
// fast-track conduction (run_config.fast_track, ticket at Captured/Proposed) must pass the same
// five-item eligibility floor BEFORE its worker ever launches. Covers both branches: admissible ⇒
// launches exactly as any other conduction would; inadmissible ⇒ no worker launched, the conduction
// parks, the ticket's own workflow advances to 'parking', and the five-item verdict lands as a
// comment.
//
// B-1073 BUGFIX (this ticket) — ALWAYS-EMPTY ADMISSION EVIDENCE: the original landing fed the
// admission check one `{ repo }` evidence entry PER `deps.declaredRepos` entry (the deployment's
// configured repo set — e.g. workspace/web/plugin for a 3-repo deployment), which made
// `evaluateMultiRepoItem` see >1 distinct repo and FAIL every fast-track conduction a multi-repo
// deployment ever ran, before any work started. fireLaunch now always calls
// `evaluateFastTrackAdmission` with `[]`, so `deps.declaredRepos` no longer has ANY effect on
// admission — every test below that still sets it does so DELIBERATELY, to prove it is ignored.
// Only a title that trips the single-sentence-statable item (d) can still produce an inadmissible
// report at this call site, since items (a) multi-repo and (b) migration now always read vacuous
// (0 repos, 0 migration paths) on empty evidence, and item (c) risk-class needs an auth/shared-core/
// irreversible-destructive signal this file's test titles never carry.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-1073 (post-review wiring): fast-track admission check at fireLaunch', () => {
  it('admissible (clean title, no declared repos): launches the worker exactly as any other conduction would', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { fast_track: true } })],
      tasks: {
        'task-1': pausedTask({ workflow_state: 'Captured', title: 'Fix the flaky retry timer in the poller.' }),
      },
    });
    const advanceTicketWorkflow = vi.fn(async () => {});
    const addTicketComment = vi.fn(async () => {});
    h.deps.advanceTicketWorkflow = advanceTicketWorkflow;
    h.deps.addTicketComment = addTicketComment;

    await wakeAndFire(h);

    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(h.running()).toEqual(['cond-1']);
    expect(advanceTicketWorkflow).not.toHaveBeenCalled();
    expect(addTicketComment).not.toHaveBeenCalled();
  });

  it('B-1073 BUGFIX regression: a 3-repo deployment (the exact bug scenario — e.g. workspace/web/plugin) no longer parks a clean fast-track conduction, because declaredRepos is never fed to the admission check as evidence', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { fast_track: true } })],
      tasks: {
        'task-1': pausedTask({ workflow_state: 'Captured', title: 'Fix the flaky retry timer in the poller.' }),
      },
    });
    // The exact shape of the original bug report: a deployment declaring 3 repos.
    h.deps.declaredRepos = ['ycomplex/workspace', 'ycomplex/harmony-web', 'ycomplex/harmony-plugin'];
    const advanceTicketWorkflow = vi.fn(async () => {});
    const addTicketComment = vi.fn(async () => {});
    h.deps.advanceTicketWorkflow = advanceTicketWorkflow;
    h.deps.addTicketComment = addTicketComment;

    await wakeAndFire(h);

    // Before this fix, this would have parked ("evidence spans 3 repos") and launched no worker.
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(h.running()).toEqual(['cond-1']);
    expect(advanceTicketWorkflow).not.toHaveBeenCalled();
    expect(addTicketComment).not.toHaveBeenCalled();
  });

  it('inadmissible (title not single-sentence-statable — the one failure path still reachable with empty evidence): parks the conduction, advances the ticket to parking, comments the verdict, and launches NO worker', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { fast_track: true } })],
      tasks: {
        'task-1': pausedTask({
          workflow_state: 'Captured',
          title: 'Fix the timer. Also touch up the retry logic while we are in there.',
        }),
      },
    });
    // Declared regardless, to prove it has no bearing on this verdict either.
    h.deps.declaredRepos = ['ycomplex/harmony-web', 'ycomplex/harmony-plugin'];
    const advanceTicketWorkflow = vi.fn(async () => {});
    const addTicketComment = vi.fn(async () => {});
    h.deps.advanceTicketWorkflow = advanceTicketWorkflow;
    h.deps.addTicketComment = addTicketComment;

    await wakeAndFire(h);

    expect(h.launches()).toEqual([]); // never fired
    expect(h.running()).toEqual([]);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: null, last_worker_exit_class: 'fast-track-inadmissible' },
    ]);
    expect(advanceTicketWorkflow).toHaveBeenCalledWith('task-1', 'parking');
    expect(addTicketComment).toHaveBeenCalledTimes(1);
    const [taskId, comment] = addTicketComment.mock.calls[0];
    expect(taskId).toBe('task-1');
    expect(comment).toContain('harmony fast-track refuses admission');
    expect(comment).toContain('Single-sentence-statable change');
  });

  it('inadmissible with NEITHER advanceTicketWorkflow NOR addTicketComment wired (both optional): still parks the conduction and launches NO worker', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { fast_track: true } })],
      tasks: {
        'task-1': pausedTask({
          workflow_state: 'Captured',
          title: 'Fix the timer. Also touch up the retry logic while we are in there.',
        }),
      },
    });

    await wakeAndFire(h);

    expect(h.launches()).toEqual([]);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: null, last_worker_exit_class: 'fast-track-inadmissible' },
    ]);
  });

  it('a non-fast-track conduction at Captured is NEVER subject to this check, even with multiple declared repos', async () => {
    const h = makeHarness({
      conductions: [conduction()], // no run_config at all
      tasks: {
        'task-1': pausedTask({ workflow_state: 'Captured', title: 'Fix the flaky retry timer in the poller.' }),
      },
    });
    h.deps.declaredRepos = ['ycomplex/harmony-web', 'ycomplex/harmony-plugin'];

    await wakeAndFire(h);

    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(h.running()).toEqual(['cond-1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-1077 — the agent-adapter ELIGIBILITY CHECK at fireLaunch: the run's adapter
// (run_config.agent.adapter, absent = claude-code) must be registered AND in the profile's `agents`
// list (absent = claude-code only). Refused ⇒ parked like a fast-track refusal, no worker launched,
// no leg counted. The pure rules are pinned in agent-eligibility.test.ts; these pin the wiring.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-1077: agent-adapter eligibility check at fireLaunch', () => {
  const task = () => ({ 'task-1': pausedTask({ workflow_state: 'Building', title: 'Wire the thing.' }) });

  it('no agent key on a profile with no agents list: launches exactly as before', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: task() });
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await wakeAndFire(h);
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(addTicketComment).not.toHaveBeenCalled();
  });

  it('an unregistered adapter: parks the conduction, advances the ticket to parking, comments the registered adapters, launches NO worker and counts no leg', async () => {
    const h = makeHarness({ conductions: [conduction({ run_config: { agent: { adapter: 'opencode' } } })], tasks: task() });
    const advanceTicketWorkflow = vi.fn(async () => {});
    const addTicketComment = vi.fn(async () => {});
    h.deps.advanceTicketWorkflow = advanceTicketWorkflow;
    h.deps.addTicketComment = addTicketComment;

    await wakeAndFire(h);

    expect(h.launches()).toEqual([]);
    expect(h.running()).toEqual([]);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: null, last_worker_exit_class: 'agent-ineligible' },
    ]);
    expect(h.getConduction('cond-1').leg_count ?? 0).toBe(0);
    expect(advanceTicketWorkflow).toHaveBeenCalledWith('task-1', 'parking');
    expect(addTicketComment).toHaveBeenCalledTimes(1);
    const [taskId, comment] = addTicketComment.mock.calls[0] as unknown as [string, string];
    expect(taskId).toBe('task-1');
    expect(comment).toContain("Unknown agent adapter 'opencode' — registered: claude-code, codex");
    expect(comment).toContain('This launch profile allows: claude-code.');
  });

  it("a registered adapter missing from the profile's agents list is refused too", async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: task(),
      config: { ...config, profile: { ...config.profile, agents: ['codex'] } },
    });
    await wakeAndFire(h);
    expect(h.launches()).toEqual([]);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: null, last_worker_exit_class: 'agent-ineligible' },
    ]);
  });

  // B-1076: codex is now a REGISTERED adapter, so these are the two real second-adapter cases.
  it('B-1076: codex on a profile that allows it but whose launch template lacks {run_config_json}: parked before any worker, naming the placeholder', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { agent: { adapter: 'codex' } } })],
      tasks: task(),
      config: { ...config, profile: { ...config.profile, agents: ['claude-code', 'codex'] } },
    });
    const addTicketComment = vi.fn(async () => {});
    h.deps.advanceTicketWorkflow = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await wakeAndFire(h);
    expect(h.launches()).toEqual([]);
    expect(h.statusWrites()).toEqual([
      { status: 'parked', last_worker_exit_code: null, last_worker_exit_class: 'agent-ineligible' },
    ]);
    const comment = (addTicketComment.mock.calls[0] as unknown as [string, string])[1];
    expect(comment).toContain('no {run_config_json} placeholder');
    expect(comment).toContain('Registered agent adapters: claude-code, codex.');
  });

  it('B-1076: codex on a profile that allows it AND delivers {run_config_json}: launches', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { agent: { adapter: 'codex' } } })],
      tasks: task(),
      config: { ...config, profile: { ...config.profile, launch: 'launch {conduction_id} {ticket} {run_config_json}', agents: ['claude-code', 'codex'] } },
    });
    await wakeAndFire(h);
    expect(h.launches()).toHaveLength(1);
    expect(h.statusWrites()).not.toContainEqual(expect.objectContaining({ last_worker_exit_class: 'agent-ineligible' }));
  });

  it('config-only rollback: the same conduction with agent.adapter switched back to claude-code launches', async () => {
    const h = makeHarness({ conductions: [conduction({ run_config: { agent: { adapter: 'claude-code' } } })], tasks: task() });
    await wakeAndFire(h);
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-1073 x B-1020 interaction: a fast-track leg the admission check parks BEFORE launch must never
// be counted as a leg (B-1020's leg_count) or receive a HARMONY_LEG assignment it will never use —
// the admission check runs strictly before the leg-number computation in fireLaunch, so an
// inadmissible report short-circuits out before leg_count (or leg_started_at) is ever touched.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-1073 x B-1020: an admission-parked fast-track leg is never counted or HARMONY_LEG-assigned', () => {
  it('inadmissible fast-track conduction: leg_count is untouched, no runCommand launch fires, and no HARMONY_LEG is ever computed', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { fast_track: true }, leg_count: 2 })], // 2 prior legs
      tasks: {
        'task-1': pausedTask({
          workflow_state: 'Captured',
          // B-1073 bugfix (this ticket): declaredRepos is never fed to admission evidence any more
          // (see the describe block above), so a multi-sentence title — tripping item (d),
          // single-sentence-statable — is the trigger used here instead of a multi-repo deployment.
          title: 'Fix the timer. Also touch up the retry logic while we are in there.',
        }),
      },
    });

    await wakeAndFire(h);

    // No launch fired at all — the admission check short-circuited before fireLaunch ever reaches
    // the leg_count/leg_started_at write or the launch runCommand call.
    expect(h.launches()).toEqual([]);
    expect(h.running()).toEqual([]);
    expect(h.runCommandCalls().find(([cmd]) => cmd.startsWith('launch'))).toBeUndefined();

    // leg_count stays exactly what it was before this fire — a parked-before-launch leg must never
    // consume a leg number.
    expect(h.getConduction('cond-1').leg_count).toBe(2);

    // The lease-guarded write the admission-check park performs carries no leg_count/leg_started_at
    // at all — only the park's own status fields (see fireLaunch's early-return branch).
    expect(h.deps.updateConductionIfHeld).not.toHaveBeenCalledWith(
      'cond-1',
      ME,
      expect.objectContaining({ leg_count: expect.anything() }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-845: withWriteRetry must NEVER wrap the worker-launch/fire call — a launch is not a write this
// module's retry contract applies to, and re-firing a worker on a transient blip is a completely
// different (and much larger) hazard than retrying a guarded DB write. This is pinned by SOURCE
// INSPECTION rather than a behavioral assertion: a successful launch is indistinguishable, from the
// outside, whether or not it happens to be wrapped, so the only way to prove the ABSENCE of the
// wrapper is to look at the call site itself.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('B-845: withWriteRetry exclusion — the fire/worker-launch path is never wrapped', () => {
  it('the launch runCommand call inside fireLaunch carries no withWriteRetry wrapper', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('./scheduler.ts', import.meta.url)), 'utf8');

    const fnStart = src.indexOf('async function fireLaunch(');
    expect(fnStart).toBeGreaterThan(-1);
    // The next top-level function declaration after fireLaunch's — bounds the extraction to
    // fireLaunch's OWN body, not the rest of the module (which legitimately uses withWriteRetry
    // elsewhere, for the CAS writes). Covers every declaration shape this file actually uses
    // ('function ', 'async function ', 'export function ', 'export async function ').
    const candidates = [
      '\nasync function ',
      '\nfunction ',
      '\nexport async function ',
      '\nexport function ',
    ]
      .map((marker) => src.indexOf(marker, fnStart + 1))
      .filter((idx) => idx !== -1);
    expect(candidates.length).toBeGreaterThan(0);
    const bodyEnd = Math.min(...candidates);
    expect(bodyEnd).toBeGreaterThan(fnStart);
    const body = src.slice(fnStart, bodyEnd);

    // B-1020 reformatted this call across multiple lines (to carry the new `env` option) — match
    // the two pieces separately rather than one brittle single-line substring.
    expect(body).toContain('.runCommand('); // the launch call is really in here
    expect(body).toContain('renderTemplate(');
    expect(body).toContain('deps.config.profile.launch');
    expect(body).not.toContain('withWriteRetry');
  });
});

// ——————————————————————————————————————————————————————————————————————————————————————————————————
// B-1073 (daemon-files-recording round): a FAST-TRACK conduction whose release brief was ACCEPTED and
// whose PR is MERGED needs NO worker leg — the daemon files the post-merge `recorded_walk_requests` row
// itself (under its lease, in handleHeldConduction, before a wake would be queued), consumes the accept
// remark, rolls the baseline, and the in-process drain lands release -> deploy -> verify brief. Every
// uncertain precondition FALLS THROUGH to the ordinary queue-a-worker path.
// ——————————————————————————————————————————————————————————————————————————————————————————————————

/** A tiny in-memory Supabase stand-in covering exactly the calls the recording path makes. */
function makeFakeBoard(seed: {
  activity?: Array<Record<string, unknown>>;
  briefs?: Array<Record<string, unknown>>;
  requests?: Array<Record<string, unknown>>;
  task?: Record<string, unknown>;
  failInsert?: boolean;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    activity_events: seed.activity ?? [],
    task_comments: [],
    briefs: seed.briefs ?? [],
    recorded_walk_requests: seed.requests ?? [],
    tasks: [seed.task ?? { id: 'task-1', project_id: 'proj-1', title: 'B-2000: Fix the flaky retry timer', field_values: {} }],
  };
  let clock = Date.parse('2026-10-10T11:00:00Z');
  const calls: string[] = [];
  const from = (name: string) => {
    calls.push(name);
    const rows = tables[name];
    if (!rows) throw new Error(`unexpected table ${name}`);
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    let orderCol: string | null = null;
    let ascending = true;
    let limitN = Infinity;
    const run = () => {
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        const c = orderCol;
        out = [...out].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (ascending ? 1 : -1));
      }
      out = out.slice(0, limitN);
      if (patch) out.forEach((r) => Object.assign(r, patch));
      return out;
    };
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      not: (c: string) => (filters.push((r) => r[c] != null), q),
      is: (c: string) => (filters.push((r) => r[c] == null), q),
      order: (c: string, o?: { ascending?: boolean }) => ((orderCol = c), (ascending = o?.ascending !== false), q),
      limit: (n: number) => ((limitN = n), q),
      update: (p: Record<string, unknown>) => ((patch = p), q),
      insert: async (row: Record<string, unknown>) => {
        if (seed.failInsert) return { error: { message: 'insert denied' } };
        clock += 1000;
        rows.push({ id: `req-${rows.length + 1}`, status: 'pending', requested_at: new Date(clock).toISOString(), ...row });
        return { error: null };
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: run(), error: null }),
    };
    return q;
  };
  return { client: { from } as any, tables, calls };
}

const PR_URL = 'https://github.com/ycomplex/harmony-plugin/pull/42';
const builtEvent = { event_type: 'field_change', field_name: 'workflow_state', new_value: 'Built', metadata: null, task_id: 'task-1', created_at: '2026-10-10T10:00:00Z' };
const acceptEvent = {
  event_type: 'brief_resolved', field_name: null, new_value: null, task_id: 'task-1', created_at: '2026-10-10T10:05:00Z',
  metadata: { reason: 'release-decision-pending', command: 'accept', brief_id: 'brief-rel', provenance: 'human-in-browser' },
};
const releaseBrief = (remark: string | null) => ({
  id: 'brief-rel', task_id: 'task-1', reason: 'release-decision-pending', accept_remark: remark, accept_remark_consumed_at: null,
  decision_ref: null, doc: {}, created_at: '2026-10-10T10:01:00Z',
});

function recordingScenario(over: {
  conduction?: Partial<ConductionRecord>;
  board?: Parameters<typeof makeFakeBoard>[0];
  prState?: 'merged' | 'open' | 'closed' | 'unknown' | 'throw';
  omitPrDep?: boolean;
  omitBoard?: boolean;
  task?: Partial<DaemonTask>;
}) {
  const board = makeFakeBoard({
    activity: [builtEvent, acceptEvent],
    briefs: [releaseBrief(null)],
    task: { id: 'task-1', project_id: 'proj-1', title: 'B-2000: Fix the flaky retry timer', field_values: { build_pr: { pr_url: PR_URL } } },
    ...over.board,
  });
  const h = makeHarness({
    conductions: [conduction({ run_config: { fast_track: true }, ...over.conduction })],
    tasks: { 'task-1': pausedTask(over.task) },
  });
  const getPrMergeState = vi.fn(async (_url: string) => {
    if (over.prState === 'throw') throw new Error('network');
    return over.prState ?? 'merged';
  });
  if (!over.omitPrDep) h.deps.getPrMergeState = getPrMergeState as SchedulerDeps['getPrMergeState'];
  if (!over.omitBoard) h.deps.fastTrackRecording = { client: board.client, projectId: 'proj-1', userId: 'daemon-user' };
  return { h, board, getPrMergeState };
}

/** baseline pass (still awaiting) → the human accepts (flag down) → the pass under test. */
async function acceptAndPass(h: ReturnType<typeof makeHarness>): Promise<void> {
  await h.pass();
  (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
  await h.pass();
}

describe('B-1073: the daemon files a fast-track release accept\'s post-merge recording itself', () => {
  it('files the row (summary=title, evidence=build_pr, attestation=the remark), consumes the remark, rolls the baseline, queues NO leg and makes NO runCommand call', async () => {
    const remark = 'orchestrator, 2026-10-08, under 3 minutes: walked the dialog end to end';
    const { h, board, getPrMergeState } = recordingScenario({ board: { briefs: [releaseBrief(remark)] } });

    await acceptAndPass(h);

    expect(board.tables.recorded_walk_requests).toEqual([
      expect.objectContaining({
        task_id: 'task-1',
        summary: 'B-2000: Fix the flaky retry timer',
        evidence_links: [{ url: PR_URL }],
        attest_walk: remark,
        requested_by: 'daemon-user',
        status: 'pending',
      }),
    ]);
    expect(board.tables.briefs[0].accept_remark_consumed_at).toEqual(expect.any(String));
    expect(getPrMergeState).toHaveBeenCalledWith(PR_URL);
    expect((h.deps.runCommand as any).mock.calls).toEqual([]); // NO runCommand call of any kind
    expect(h.commands).toEqual([]);
    expect(h.launches()).toEqual([]);
    expect(h.ready()).toEqual([]);
    expect(h.running()).toEqual([]);
    expect(h.state.get('cond-1')).toEqual({ awaitingHumanInput: false, activeExchange: null }); // baseline rolled
    expect(h.logs.some((l) => l.includes('no worker leg'))).toBe(true);
  });

  it('the founder\'s real remark "not walked — attest at verify" files the row with NO attestation', async () => {
    const { h, board } = recordingScenario({ board: { briefs: [releaseBrief('not walked — attest at verify')] } });
    await acceptAndPass(h);
    expect(board.tables.recorded_walk_requests).toHaveLength(1);
    expect(board.tables.recorded_walk_requests[0].attest_walk).toBeNull();
    expect(board.tables.briefs[0].accept_remark_consumed_at).toEqual(expect.any(String)); // still consumed
    expect(h.commands).toEqual([]);
  });

  it('an accept with NO remark at all files a row with no attestation and consumes nothing', async () => {
    const { h, board } = recordingScenario({});
    await acceptAndPass(h);
    expect(board.tables.recorded_walk_requests).toHaveLength(1);
    expect(board.tables.recorded_walk_requests[0].attest_walk).toBeNull();
    expect(h.commands).toEqual([]);
  });

  it('a verify brief results: the drain (stubbed faithfully) walks the filed row from Built -> Deployed + verify brief', async () => {
    const { h, board } = recordingScenario({ board: { briefs: [releaseBrief('not walked — attest at verify')] } });
    // Faithful stub of runRecordedWalkDrainPass for this fixture: claim the pending row, derive
    // from_gate from the ticket ('Built' -> 'deploy'), forward attest_walk ?? undefined, walk.
    const walks: Array<{ from_gate: string; attest_walk: string | undefined }> = [];
    h.deps.drainRecordedWalkRequests = async () => {
      const pending = board.tables.recorded_walk_requests.find((r) => r.status === 'pending');
      if (!pending) return;
      pending.status = 'done';
      walks.push({ from_gate: 'deploy', attest_walk: (pending.attest_walk as string | null) ?? undefined });
      (h.tasks['task-1'] as DaemonTask).workflow_state = 'Deployed';
      (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true; // verify brief composed
    };
    await acceptAndPass(h);
    await h.deps.drainRecordedWalkRequests!();
    expect(walks).toEqual([{ from_gate: 'deploy', attest_walk: undefined }]);
    await h.pass(); // Deployed + awaiting the verify ack: nothing wakes
    expect(h.commands).toEqual([]);
    expect(h.getConduction('cond-1').status).toBe('active');
  });

  it('is idempotent: a second pass while the row is still pending files NO second row and still queues no leg', async () => {
    const { h, board } = recordingScenario({ board: { briefs: [releaseBrief('walked it for ten minutes')] } });
    await acceptAndPass(h);
    await h.pass();
    await h.pass();
    expect(board.tables.recorded_walk_requests).toHaveLength(1);
    expect(h.commands).toEqual([]);
    expect(h.ready()).toEqual([]);
  });

  it('a crash between filing and consuming self-heals: the next pass consumes the remark without a second row', async () => {
    const { h, board } = recordingScenario({
      board: {
        briefs: [releaseBrief('walked it')],
        requests: [{ id: 'req-0', task_id: 'task-1', status: 'pending', requested_at: '2026-10-10T10:06:00Z', attest_walk: 'walked it' }],
      },
    });
    await acceptAndPass(h);
    expect(board.tables.recorded_walk_requests).toHaveLength(1);
    expect(board.tables.briefs[0].accept_remark_consumed_at).toEqual(expect.any(String));
    expect(h.commands).toEqual([]);
  });

  // ——— fall-through cases: every one takes the ORDINARY queue-a-worker path ———————————————————
  const expectsOrdinaryLeg = async (h: ReturnType<typeof makeHarness>, board: ReturnType<typeof makeFakeBoard>) => {
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(board.tables.recorded_walk_requests.filter((r) => r.status === 'pending' && r.requested_by === 'daemon-user')).toEqual([]);
  };

  it('NON-fast-track conduction: byte-identical ordinary path — the board is never even read', async () => {
    const { h, board, getPrMergeState } = recordingScenario({ conduction: { run_config: {} } });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(getPrMergeState).not.toHaveBeenCalled();
    expect(board.calls).toEqual([]);
    expect(h.logs.some((l) => l.includes('fast-track recording not taken'))).toBe(false);
  });

  it('PR not merged (open) => ordinary worker path, nothing filed, remark untouched', async () => {
    const { h, board } = recordingScenario({ prState: 'open', board: { briefs: [releaseBrief('walked it')] } });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(board.tables.recorded_walk_requests).toEqual([]);
    expect(board.tables.briefs[0].accept_remark_consumed_at).toBeNull();
  });

  it.each(['closed', 'unknown'] as const)('PR state %s => ordinary worker path', async (prState) => {
    const { h, board } = recordingScenario({ prState });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(board.tables.recorded_walk_requests).toEqual([]);
  });

  it('PR state read throws => ordinary worker path', async () => {
    const { h, board } = recordingScenario({ prState: 'throw' });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
  });

  it('no getPrMergeState dep => no interception at all', async () => {
    const { h, board } = recordingScenario({ omitPrDep: true });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(board.calls).toEqual([]);
  });

  it('no board handle => no interception at all', async () => {
    const { h, board, getPrMergeState } = recordingScenario({ omitBoard: true });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(getPrMergeState).not.toHaveBeenCalled();
  });

  it('accept NOT positively evidenced (a torn pause: Built, flag down, no brief_resolved) => ordinary worker path', async () => {
    const { h, board, getPrMergeState } = recordingScenario({ board: { activity: [builtEvent] } });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(getPrMergeState).not.toHaveBeenCalled();
  });

  it('an accept from a PREVIOUS release cycle (before the latest advance into Built) is not evidence', async () => {
    const laterBuilt = { ...builtEvent, created_at: '2026-10-10T10:30:00Z' };
    const { h, board } = recordingScenario({ board: { activity: [builtEvent, acceptEvent, laterBuilt] } });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
  });

  it('a DEFER (command != accept) is not an accept', async () => {
    const defer = { ...acceptEvent, metadata: { ...acceptEvent.metadata, command: 'defer' } };
    const { h, board } = recordingScenario({ board: { activity: [builtEvent, defer] } });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
  });

  it('Built with the awaiting flag UP is never intercepted (no wake at all)', async () => {
    const { h, board, getPrMergeState } = recordingScenario({});
    await h.pass();
    await h.pass(); // flag stays up
    expect(h.commands).toEqual([]);
    expect(getPrMergeState).not.toHaveBeenCalled();
    expect(board.calls).toEqual([]);
  });

  it('a ticket not at Built (e.g. Planned) is never intercepted', async () => {
    const { h, board, getPrMergeState } = recordingScenario({ task: { workflow_state: 'Planned' } });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(getPrMergeState).not.toHaveBeenCalled();
  });

  it('an unconsumed remark on a DIFFERENT brief is ambiguous => ordinary worker path', async () => {
    const other = { ...releaseBrief('walked it'), id: 'brief-other', reason: 'plan-draft' };
    const { h, board } = recordingScenario({ board: { briefs: [other] } });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
  });

  it('no recorded build_pr.pr_url => ordinary worker path', async () => {
    const { h, board, getPrMergeState } = recordingScenario({
      board: { task: { id: 'task-1', project_id: 'proj-1', title: 'T', field_values: {} } },
    });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(getPrMergeState).not.toHaveBeenCalled();
  });

  it('a failed insert (table absent / RLS) => ordinary worker path, remark not consumed', async () => {
    const { h, board } = recordingScenario({ board: { failInsert: true, briefs: [releaseBrief('walked it')] } });
    await acceptAndPass(h);
    await expectsOrdinaryLeg(h, board);
    expect(board.tables.briefs[0].accept_remark_consumed_at).toBeNull();
  });

  it('a request already processed (done/error) for this accept is never refiled — ordinary worker path', async () => {
    const { h, board } = recordingScenario({
      board: { requests: [{ id: 'req-0', task_id: 'task-1', status: 'error', requested_at: '2026-10-10T10:06:00Z' }] },
    });
    await acceptAndPass(h);
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(board.tables.recorded_walk_requests).toHaveLength(1);
  });
});

// ── B-1149: quota / rate-limit refusals pause the runtime instead of dirty-exiting ─────────────────
describe('B-1149: quota and rate-limit refusals', () => {
  type Refusal = { kind: 'quota' | 'rate-limit'; resets_at: string | null };
  const HOUR = 60 * 60 * 1000;
  const twoRuntimeConfig: DaemonConfig = {
    ...config,
    profile: { ...config.profile, launch: 'launch {conduction_id} {ticket} {run_config_json}', agents: ['claude-code', 'codex'] },
  };

  /** Wire the three optional B-1149 deps onto a harness. `columns: false` simulates the pre-migration
   *  board (reads null, writes 'missing-columns'). */
  function withQuota(
    h: ReturnType<typeof makeHarness>,
    opts: { refusals?: Array<Refusal | null>; columns?: boolean; seed?: Record<string, { paused_until: string | null; quota_pauses: number }> } = {},
  ) {
    const store = new Map(Object.entries(opts.seed ?? {}).map(([k, v]) => [k, { ...v }]));
    const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const comments: Array<{ taskId: string; content: string }> = [];
    const refusals = [...(opts.refusals ?? [])];
    const columns = opts.columns !== false;
    h.deps.getLastLegRefusal = vi.fn(async () => (refusals.length ? refusals.shift()! : null));
    h.deps.readQuotaState = vi.fn(async (ids: string[]) => {
      if (!columns) return null;
      return new Map(ids.filter((id) => store.has(id)).map((id) => [id, { ...store.get(id)! }]));
    });
    h.deps.writeQuotaState = vi.fn(async (id: string, patch: Record<string, unknown>) => {
      writes.push({ id, patch: { ...patch } });
      if (!columns) return 'missing-columns' as const;
      const cur = store.get(id) ?? { paused_until: null, quota_pauses: 0 };
      store.set(id, { ...cur, ...(patch as object) });
      return 'ok' as const;
    });
    h.deps.addTicketComment = vi.fn(async (taskId: string, content: string) => {
      comments.push({ taskId, content });
    });
    return { store, writes, comments };
  }

  it('a quota refusal PAUSES (stays active, ticket untouched, comment with the resume time) — never parked, never the dirty-exit ladder', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1, config: { ...config, retryCap: 2 } });
    const q = withQuota(h, { refusals: [{ kind: 'quota', resets_at: null }] });
    await wakeAndFire(h);
    const ticketBefore = { ...(h.tasks['task-1'] as DaemonTask) };
    await h.pass(); // settle
    const row = h.getConduction('cond-1');
    expect(row.status).toBe('active');
    expect(row.last_worker_exit_class).toBe('quota');
    expect(row.retry_count).toBe(0); // B-713's dirty-exit ladder never engaged
    expect(h.reaps()).toEqual([]);
    const until = iso(h.now() + HOUR); // the 60-minute default: no reset reported
    expect(q.writes).toContainEqual({ id: 'cond-1', patch: { paused_until: until, quota_pauses: 1 } });
    expect(q.comments).toEqual([{ taskId: 'task-1', content: `Paused — quota on claude-code, resumes ${until}` }]);
    expect(h.tasks['task-1']).toEqual(ticketBefore); // workflow state / awaiting flag unchanged
    expect(h.deps.advanceTicketWorkflow).toBeUndefined();
  });

  it('a reported reset time is the hold; when it passes the NEXT leg is the re-check, and only one', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1 });
    const reset = iso(T0 + 2 * HOUR);
    const q = withQuota(h, { refusals: [{ kind: 'quota', resets_at: reset }] });
    await wakeAndFire(h);
    await h.pass(); // settle → pause until `reset`
    expect(q.store.get('cond-1')?.paused_until).toBe(reset);
    expect(q.comments[0].content).toBe(`Paused — quota on claude-code, resumes ${reset}`);
    expect(h.launches()).toHaveLength(1);
    await h.pass();
    await h.pass(); // still paused: no hot loop
    expect(h.launches()).toHaveLength(1);
    h.setNow(T0 + 2 * HOUR + 1);
    await h.pass(); // hold over → the re-check leg is queued and fired
    expect(h.launches()).toHaveLength(2);
    expect(q.store.get('cond-1')?.paused_until).toBeNull();
  });

  it('the 60-minute default hold re-checks once after leg end + 60 minutes', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1 });
    withQuota(h, { refusals: [{ kind: 'quota', resets_at: null }] });
    await wakeAndFire(h);
    await h.pass();
    const legEnd = h.now();
    h.setNow(legEnd + HOUR - 1);
    await h.pass();
    expect(h.launches()).toHaveLength(1);
    h.setNow(legEnd + HOUR + 1);
    await h.pass();
    expect(h.launches()).toHaveLength(2);
  });

  it('rate-limit: at most 2 retries (30s, then 120s), then it converts to a quota pause', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1 });
    const rl: Refusal = { kind: 'rate-limit', resets_at: null };
    const q = withQuota(h, { refusals: [rl, rl, rl] });
    await wakeAndFire(h);
    await h.pass(); // settle #1 → retry 1 after 30s
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('rate-limit');
    expect(h.logs.some((l) => l.includes('rate limit on claude-code — retrying (1/2)') && l.includes('30000ms'))).toBe(true);
    await h.pass();
    expect(h.launches()).toHaveLength(1); // backoff not elapsed
    h.setNow(h.now() + 30_000);
    await h.pass(); // fires attempt 2
    expect(h.launches()).toHaveLength(2);
    await h.pass(); // settle #2 → retry 2 after 120s
    expect(h.logs.some((l) => l.includes('retrying (2/2)') && l.includes('120000ms'))).toBe(true);
    h.setNow(h.now() + 119_000);
    await h.pass();
    expect(h.launches()).toHaveLength(2);
    h.setNow(h.now() + 1_000);
    await h.pass(); // fires attempt 3
    expect(h.launches()).toHaveLength(3);
    await h.pass(); // settle #3 → budget spent → quota pause
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('quota');
    expect(q.store.get('cond-1')?.quota_pauses).toBe(1);
    expect(q.comments).toHaveLength(1);
    h.setNow(h.now() + 10 * 60_000);
    await h.pass();
    expect(h.launches()).toHaveLength(3); // paused, not retrying
  });

  it("the 3rd consecutive quota pause parks the conduction ('quota-repeated') with a comment", async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1 });
    // Two pauses already persisted (e.g. by a previous daemon process) — the hold itself has passed.
    const q = withQuota(h, { refusals: [{ kind: 'quota', resets_at: null }], seed: { 'cond-1': { paused_until: null, quota_pauses: 2 } } });
    await wakeAndFire(h);
    await h.pass();
    const row = h.getConduction('cond-1');
    expect(row.status).toBe('parked');
    expect(row.last_worker_exit_class).toBe('quota-repeated');
    expect(q.store.get('cond-1')?.quota_pauses).toBe(3);
    expect(q.comments).toHaveLength(1);
    expect(q.comments[0].content).toMatch(/^Parked — quota on claude-code refused 3 consecutive legs/);
  });

  it('a leg that makes board progress resets quota_pauses to 0', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 0 });
    const q = withQuota(h, { seed: { 'cond-1': { paused_until: null, quota_pauses: 2 } } });
    h.hooks.onLaunch = () => {
      (h.tasks['task-1'] as DaemonTask).workflow_state = 'Deployed';
    };
    await wakeAndFire(h);
    await h.pass();
    expect(q.writes).toContainEqual({ id: 'cond-1', patch: { quota_pauses: 0 } });
    expect(q.store.get('cond-1')?.quota_pauses).toBe(0);
  });

  it('the WHOLE runtime is held (persisted paused_until — survives a restart); the other runtime keeps launching', async () => {
    const codexRc = { agent: { adapter: 'codex' } } as ConductionRecord['run_config'];
    const h = makeHarness({
      conductions: [
        conduction({ id: 'cond-1', task_id: 'task-1' }),
        conduction({ id: 'cond-2', task_id: 'task-2', run_config: codexRc }),
        conduction({ id: 'cond-3', task_id: 'task-3' }),
      ],
      tasks: { 'task-1': pausedTask(), 'task-2': pausedTask(), 'task-3': pausedTask() },
      config: twoRuntimeConfig,
    });
    // A fresh runtime (as after a daemon restart) reading a persisted hold on cond-1 (claude-code).
    withQuota(h, { seed: { 'cond-1': { paused_until: iso(T0 + HOUR), quota_pauses: 1 } } });
    await h.pass(); // baselines
    (h.tasks['task-2'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-3'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    expect(h.launches().map((c) => c.split(' ')[1])).toEqual(['cond-2']); // codex launched; claude-code held
    expect(h.ready()).toEqual(['cond-3']); // queued, waiting out the hold
    expect(h.logs.filter((l) => l.includes('cond-3: claude-code runtime is held'))).toHaveLength(1);
    h.setNow(T0 + HOUR + 1);
    await h.pass();
    expect(h.launches().map((c) => c.split(' ')[1])).toEqual(expect.arrayContaining(['cond-2', 'cond-3', 'cond-1']));
  });

  it('tolerant of the columns not existing yet: the hold lives in memory and still holds the runtime', async () => {
    const h = makeHarness({
      conductions: [conduction({ id: 'cond-1', task_id: 'task-1' }), conduction({ id: 'cond-3', task_id: 'task-3' })],
      tasks: { 'task-1': pausedTask(), 'task-3': pausedTask() },
      launchExitCodes: [1],
    });
    const q = withQuota(h, { refusals: [{ kind: 'quota', resets_at: null }], columns: false });
    await h.pass(); // baselines
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass(); // cond-1 fires
    await h.pass(); // cond-1 settles → quota pause (columns absent)
    expect(q.writes.length).toBeGreaterThan(0);
    expect(h.logs.some((l) => l.includes('columns absent (pre-migration) — holding in memory only'))).toBe(true);
    expect(h.getConduction('cond-1').status).toBe('active');
    (h.tasks['task-3'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    expect(h.launches().map((c) => c.split(' ')[1])).toEqual(['cond-1']); // cond-3 held in memory
    h.setNow(h.now() + HOUR + 1);
    await h.pass();
    expect(h.launches().map((c) => c.split(' ')[1])).toEqual(expect.arrayContaining(['cond-1', 'cond-3']));
  });

  it('no refusal on the row ⇒ an unrecognised failure stays dirty-exit (today\'s ladder)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() }, launchExitCode: 1 });
    withQuota(h, { refusals: [null] });
    await wakeAndFire(h);
    await h.pass();
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('dirty-exit');
  });
});

// B-1171: record and honour the launching backend per lease (conductions.leg_backend). The column is
// added by a web migration that promotes after the plugin, so every path must tolerate it being absent.
describe('B-1171 leg_backend — recorded at launch, honoured at adoption', () => {
  type LB = NonNullable<SchedulerDeps['legBackend']>;
  const cloudTemplates = { reap: 'reap-cloud {conduction_id}', probe: 'probe-cloud {conduction_id}' };
  const gkeTemplates = { reap: 'reap-gke {conduction_id}', probe: 'probe-gke {conduction_id}' };

  function withBackend(
    h: ReturnType<typeof makeHarness>,
    over: Partial<LB> & { tag?: string } = {},
  ): { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } {
    const read = vi.fn(over.read ?? (async () => ({ absent: false as const, backend: null })));
    const write = vi.fn(over.write ?? (async () => 'ok' as const));
    h.deps.legBackend = {
      tag: over.tag ?? 'gke',
      resolveTemplates: over.resolveTemplates ?? ((t) => (t === 'cloud' ? cloudTemplates : t === 'gke' ? gkeTemplates : null)),
      read: read as unknown as LB['read'],
      write: write as unknown as LB['write'],
    };
    return { read, write };
  }

  /** A mid-leg row held by a dead conductor, stale by the time the pass runs. */
  function staleMidLegHarness(profile: DaemonConfig['profile']) {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'this-host:1:dead0000', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: iso(T0 - 500) }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }) },
      config: { ...config, profile },
    });
    h.setNow(T0 + config.staleMs + 1_000);
    return h;
  }
  const gkeOwn = { launch: 'launch {conduction_id} {ticket}', reap: 'reap-gke {conduction_id}', probe: 'probe-gke {conduction_id}' };
  const cloudOwn = { launch: 'launch {conduction_id} {ticket}', reap: 'reap-cloud {conduction_id}', probe: 'probe-cloud {conduction_id}' };

  it('column present: the launching backend tag is written (lease-guarded) when a leg is launched', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const { write } = withBackend(h, { tag: 'gke' });
    await wakeAndFire(h);
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('cond-1', ME, 'gke');
  });

  it('column present: the tag is NEVER part of the shared conduction patch', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    withBackend(h);
    await wakeAndFire(h);
    const patches = (h.deps.updateConductionIfHeld as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[2] as object);
    expect(patches.some((p) => 'leg_backend' in p)).toBe(false);
  });

  it('column absent on write: no throw, the launch still fires, and no further write is attempted', async () => {
    const h = makeHarness({
      conductions: [conduction(), conduction({ id: 'cond-2', task_id: 'task-2' })],
      tasks: { 'task-1': pausedTask(), 'task-2': pausedTask() },
    });
    const { write } = withBackend(h, { write: async () => 'missing-column' as const });
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    (h.tasks['task-2'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    expect(h.launches().sort()).toEqual(['launch cond-1 task-1', 'launch cond-2 task-2']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.runtime.legBackendAbsent).toBe(true);
  });

  it('any other write error is logged and never blocks the launch (and is not cached as absent)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    const { write } = withBackend(h, { write: async () => { throw new Error('network down'); } });
    await wakeAndFire(h);
    expect(h.launches()).toEqual(['launch cond-1 task-1']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.runtime.legBackendAbsent).toBeUndefined();
    expect(h.logs.some((l) => /could not record the launching backend/.test(l))).toBe(true);
  });

  it('without the legBackend dep, launch and adoption behave exactly as before', async () => {
    const h = staleMidLegHarness(gkeOwn);
    await h.pass();
    expect(h.probes()).toEqual(['probe-gke cond-1']);
    expect(h.reaps()).toEqual(['reap-gke cond-1']);
  });

  it('a cloud-launched leg adopted by a gke conductor is probed and reaped with the CLOUD templates', async () => {
    const h = staleMidLegHarness(gkeOwn);
    const { read } = withBackend(h, { tag: 'gke', read: async () => ({ absent: false as const, backend: 'cloud' }) });
    await h.pass();
    expect(read).toHaveBeenCalledWith('cond-1');
    expect(h.probes()).toEqual(['probe-cloud cond-1']);
    expect(h.reaps()).toEqual(['reap-cloud cond-1']);
    expect(h.logs.some((l) => /cond-1: adopting a leg launched by the 'cloud' backend/.test(l))).toBe(true);
  });

  it('and vice versa: a gke-launched leg adopted by a cloud conductor uses the GKE reap', async () => {
    const h = staleMidLegHarness(cloudOwn);
    withBackend(h, { tag: 'cloud', read: async () => ({ absent: false as const, backend: 'gke' }) });
    await h.pass();
    expect(h.probes()).toEqual(['probe-gke cond-1']);
    expect(h.reaps()).toEqual(['reap-gke cond-1']);
  });

  it('a recorded backend equal to the conductor\'s own, or a legacy null, uses today\'s own templates', async () => {
    for (const backend of ['gke', null]) {
      const h = staleMidLegHarness(gkeOwn);
      withBackend(h, { tag: 'gke', read: async () => ({ absent: false as const, backend }) });
      await h.pass();
      expect(h.reaps()).toEqual(['reap-gke cond-1']);
      expect(h.probes()).toEqual(['probe-gke cond-1']);
    }
  });

  it('column absent on read: no throw, behaviour identical to today, and no further read is attempted', async () => {
    const h = makeHarness({
      conductions: [
        conduction({ lease_holder: 'this-host:1:dead0000', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: iso(T0 - 500) }),
        conduction({ id: 'cond-2', task_id: 'task-2', lease_holder: 'this-host:1:dead0000', last_heartbeat_at: iso(T0 - 1_000), leg_started_at: iso(T0 - 500) }),
      ],
      tasks: { 'task-1': pausedTask({ awaiting_human_input: false }), 'task-2': pausedTask({ awaiting_human_input: false }) },
      config: { ...config, profile: gkeOwn },
    });
    h.setNow(T0 + config.staleMs + 1_000);
    const { read } = withBackend(h, { read: async () => ({ absent: true as const }) });
    await h.pass();
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.reaps().sort()).toEqual(['reap-gke cond-1', 'reap-gke cond-2']);
    expect(h.runtime.legBackendAbsent).toBe(true);
  });

  it('an unresolvable recorded backend: no probe, no reap, no launch, a conductor-worded warning, and it stays refused', async () => {
    const h = staleMidLegHarness(gkeOwn);
    withBackend(h, { tag: 'gke', read: async () => ({ absent: false as const, backend: 'mystery' }) });
    await h.pass();
    await h.pass();
    expect(h.commands).toEqual([]);
    const warn = h.logs.filter((l) => /NOT adopting/.test(l));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain("'mystery'");
    expect(warn[0]).toContain('cond-1');
    expect(warn[0]).toMatch(/conductor/);
    expect(warn[0]).not.toMatch(/daemon/);
  });
});

// B-1171: container/gke/switch-daemon-profile.sh corroborates an adoption by grepping the conductor log for
// the conduction id plus a fixed pattern. Every adoption / takeover / reconcile line this scheduler emits
// must keep matching it — run that script's OWN grep (pattern read out of the script) over the real lines.
describe('B-1171: adoption log lines keep matching switch-daemon-profile.sh\'s corroboration grep', () => {
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'container', 'gke', 'switch-daemon-profile.sh'), 'utf8');
  const pattern = /grep -qiE '([^']+)'/.exec(script)?.[1];

  const corroborates = (logs: string[], cid: string): boolean => {
    const r = spawnSync(
      'bash',
      ['-c', `printf '%s\\n' "$LOGS" | grep -F -- "$CID" | grep -qiE '${pattern}'`],
      { env: { ...process.env, LOGS: logs.join('\n'), CID: cid } },
    );
    return r.status === 0;
  };

  it('reads the pattern out of the script (guards the test itself)', () => {
    expect(pattern).toBe('adopt|took over|reconcil|re-attach|settle|reap');
    expect(corroborates(['conduction cond-1: took over stale lease from x — reaped'], 'cond-1')).toBe(true);
    expect(corroborates(['conduction cond-1: nothing relevant here'], 'cond-1')).toBe(false); // negative control
    expect(corroborates(['conduction cond-2: took over stale lease'], 'cond-1')).toBe(false);
  });

  const dead = { lease_holder: 'this-host:1:dead0000', last_heartbeat_at: iso(T0 - 1_000) };
  const awake = { 'task-1': pausedTask({ awaiting_human_input: false }) };

  it('cleanly-released adoption', async () => {
    const h = makeHarness({ conductions: [conduction({ ...dead, clean_shutdown_at: iso(T0 - 500) })], tasks: awake });
    await h.pass();
    expect(corroborates(h.logs, 'cond-1')).toBe(true);
  });

  it('stale-window takeover', async () => {
    const h = makeHarness({ conductions: [conduction({ ...dead })], tasks: awake });
    h.setNow(T0 + config.staleMs + 1_000);
    await h.pass();
    expect(corroborates(h.logs, 'cond-1')).toBe(true);
  });

  it('mid-leg reconcile (re-attach to a live worker)', async () => {
    const h = makeHarness({
      conductions: [conduction({ ...dead, leg_started_at: iso(T0 - 500) })],
      tasks: awake,
      config: reconcilableConfig,
      probeDefaultExitCode: 0,
    });
    h.setNow(T0 + config.staleMs + 1_000);
    await h.pass();
    expect(h.logs.some((l) => /re-attached/.test(l))).toBe(true);
    expect(corroborates(h.logs, 'cond-1')).toBe(true);
  });

  it('mid-leg reconcile that finds no live worker, reaping defensively', async () => {
    const h = makeHarness({
      conductions: [conduction({ ...dead, leg_started_at: iso(T0 - 500) })],
      tasks: awake,
      config: reconcilableConfig,
      probeDefaultExitCode: 1,
    });
    h.setNow(T0 + config.staleMs + 1_000);
    await h.pass();
    expect(h.logs.some((l) => /reconciliation probe found no live worker/.test(l))).toBe(true);
    // the reconcile line alone must corroborate, not only the later takeover line
    expect(corroborates(h.logs.filter((l) => /reconciliation probe/.test(l)), 'cond-1')).toBe(true);
    expect(corroborates(h.logs, 'cond-1')).toBe(true);
  });

  it('the leg_backend adoption and refusal lines', async () => {
    for (const backend of ['cloud', 'mystery']) {
      const h = makeHarness({
        conductions: [conduction({ ...dead, leg_started_at: iso(T0 - 500) })],
        tasks: awake,
        config: reconcilableConfig,
      });
      h.deps.legBackend = {
        tag: 'gke',
        resolveTemplates: (t) => (t === 'cloud' ? { reap: 'reap-cloud {conduction_id}', probe: 'probe-cloud {conduction_id}' } : null),
        read: async () => ({ absent: false, backend }),
        write: async () => 'ok',
      };
      h.setNow(T0 + config.staleMs + 1_000);
      await h.pass();
      const lines = h.logs.filter((l) => /adopting/.test(l));
      expect(lines).toHaveLength(1);
      expect(corroborates(lines, 'cond-1')).toBe(true);
    }
  });
});

describe('B-1157: a declared external wait HOLDS the conduction instead of parking no-progress', () => {
  const MIN = 60_000;

  /** The marker a leg writes through update_task: since = now (so >= the leg's fire time). */
  function marker(h: ReturnType<typeof makeHarness>, over: Record<string, unknown> = {}) {
    return {
      kind: 'ci',
      ref: 'pr#42',
      since: iso(h.now()),
      first_since: iso(h.now()),
      resume_after: iso(h.now() + 10 * MIN),
      ...over,
    };
  }

  it('B-1050: model-handoff immediately relaunches with the requested alias', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask() },
      config: { ...config, profile: { ...config.profile, launch: "launch {conduction_id} {ticket} --model '{model}'" } },
    });
    let declarations = 0;
    h.hooks.onLaunch = () => {
      declarations += 1;
      if (declarations !== 1) return;
      const t = h.tasks['task-1'] as DaemonTask;
      t.field_values = { ...(t.field_values ?? {}), waiting_on: marker(h, { kind: 'model-handoff', ref: 'claude-opus-5' }) };
    };
    await runOneLeg(h);
    await h.pass();
    expect(h.launches()).toHaveLength(2);
    expect(h.launches()[1]).toContain("--model 'claude-opus-5'");
    expect((h.tasks['task-1'] as DaemonTask).field_values?.waiting_on).toBeNull();
    expect(h.deps.clearModelHandoff).toHaveBeenCalledTimes(1);
  });

  /** Arm the fake leg to declare a wait while it runs (writes the marker on the task row). */
  function declareWaitDuringLeg(h: ReturnType<typeof makeHarness>, over: Record<string, unknown> = {}) {
    h.hooks.onLaunch = () => {
      const t = h.tasks['task-1'] as DaemonTask;
      t.field_values = { ...(t.field_values ?? {}), waiting_on: marker(h, over) };
    };
  }

  /** baseline -> wake -> fire -> settle; returns after the settle pass. */
  async function runOneLeg(h: ReturnType<typeof makeHarness>) {
    await wakeAndFire(h);
    await h.pass(); // settle
  }

  it('leg exits 0 with a live marker => stays active, class waiting-on, no park write', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    declareWaitDuringLeg(h);
    await runOneLeg(h);

    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('waiting-on');
    expect(h.statusWrites()).toEqual([]);
    expect(h.logs.some((l) => l.includes('declared an external wait on pr#42'))).toBe(true);
  });

  it("meta-shaped task rows: the marker rides the projection's own `waiting_on` key (no field_values) and still holds", async () => {
    // The real daemon reads getTask(view:'meta'), which carries `waiting_on` but OMITS field_values
    // (seat finding, B-1157 AC 6). The hand-built rows above carry field_values; this one must not.
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    h.hooks.onLaunch = () => {
      const t = h.tasks['task-1'] as DaemonTask;
      delete (t as { field_values?: unknown }).field_values;
      t.waiting_on = marker(h);
    };
    await runOneLeg(h);
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('waiting-on');
    expect(h.statusWrites()).toEqual([]);

    await h.pass();
    await h.pass();
    expect(h.launches()).toHaveLength(1); // held: no second leg before resume_after
    h.setNow(h.now() + 10 * MIN);
    await h.pass();
    expect(h.launches()).toHaveLength(2); // resume_after reached
  });

  it('the next pass before the resume time queues no leg; at/after resume a leg is queued', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    declareWaitDuringLeg(h);
    await runOneLeg(h);
    expect(h.launches()).toHaveLength(1);

    await h.pass();
    await h.pass();
    expect(h.launches()).toHaveLength(1);
    expect(h.ready()).toEqual([]);
    expect(h.logs.filter((l) => l.includes('holding on declared wait'))).toHaveLength(1); // once per hold

    h.setNow(h.now() + 10 * MIN); // resume_after reached
    await h.pass(); // wake -> queued -> fired
    expect(h.launches()).toHaveLength(2);
  });

  it('releases early when the ball flips (a human round trip on the held ticket)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    declareWaitDuringLeg(h);
    await runOneLeg(h);

    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = true; // agent files a brief mid-hold
    await h.pass();
    expect(h.launches()).toHaveLength(1);
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false; // human resolves: true -> false
    await h.pass();
    expect(h.launches()).toHaveLength(2);
  });

  it('a stale marker (since < the leg fire time) parks no-progress', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: {
        'task-1': pausedTask({
          field_values: { waiting_on: { kind: 'ci', ref: 'old', since: iso(T0 - 5 * MIN), first_since: iso(T0 - 5 * MIN) } },
        }),
      },
    });
    await runOneLeg(h);
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
  });

  it('a marker past the 24h ceiling parks no-progress', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    h.setNow(T0 + 30 * 60 * MIN);
    declareWaitDuringLeg(h, { first_since: iso(h.now() - 25 * 60 * MIN) });
    await runOneLeg(h);
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
  });

  it('holds from the ticket marker alone after a daemon restart (fresh state + runtime)', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    declareWaitDuringLeg(h);
    await runOneLeg(h);
    expect(h.launches()).toHaveLength(1);

    h.state.clear(); // restart: no baseline, no runtime memory
    h.runtime.waitLogged?.clear();
    await h.pass(); // first sight of the row
    await h.pass(); // would be 'agent-ball' wake without the hold
    expect(h.launches()).toHaveLength(1);
    expect(h.ready()).toEqual([]);

    h.setNow(h.now() + 10 * MIN);
    await h.pass();
    expect(h.launches()).toHaveLength(2);
  });

  it('pre-park re-read: a late submitted answer is not parked; baseline comes from the fresh row', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await wakeAndFire(h);
    const orig = h.deps.getTaskMeta;
    let reads = 0;
    h.deps.getTaskMeta = vi.fn(async (id: string) => {
      const r = await orig(id);
      reads += 1;
      return reads >= 2
        ? { ...r, active_exchange: { exchange_id: 'ex1', status: 'active', answers_submitted_at: iso(h.now()) } }
        : r;
    });
    await h.pass(); // settle
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('late-answers-landed');
    expect(h.state.get('cond-1')?.activeExchange?.answers_submitted_at).toBeTruthy();
  });

  it('pre-park re-read: a late human ball is not parked', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await wakeAndFire(h);
    const orig = h.deps.getTaskMeta;
    let reads = 0;
    h.deps.getTaskMeta = vi.fn(async (id: string) => {
      const r = await orig(id);
      reads += 1;
      return reads >= 2 ? { ...r, awaiting_human_input: true } : r;
    });
    await h.pass();
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('late-human-ball');
    expect(h.state.get('cond-1')?.awaitingHumanInput).toBe(true);
  });

  it('pre-park re-read: a signal the leg ALREADY had its chance at (present at fire time and in the fresh read) parks no-progress', async () => {
    // Seat review of #364: an unconsumed acceptance event the leg could not consume must not keep the
    // conduction active forever — only a signal that is NEW relative to what the leg saw counts.
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ pending_acceptance_event_id: 'ev-1' }) },
    });
    await wakeAndFire(h);
    await h.pass(); // settle
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
    expect(h.logs.some((l) => l.includes('stranded work'))).toBe(false);
  });

  it('pre-park re-read: the same pre-existing signal queues no second leg across passes', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ pending_acceptance_event_id: 'ev-1' }) },
    });
    await wakeAndFire(h);
    await h.pass(); // settle -> parked
    expect(h.launches()).toHaveLength(1);
    await h.pass();
    await h.pass();
    expect(h.launches()).toHaveLength(1);
    expect(h.ready()).toEqual([]);
    expect(h.getConduction('cond-1').status).toBe('parked');
  });

  it('pre-park re-read: a pre-existing submitted answer (same stamp at fire time and fresh) parks too', async () => {
    const exchange = { exchange_id: 'ex1', status: 'active', answers_submitted_at: '2026-10-21T00:00:00Z' };
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ active_exchange: exchange }) },
    });
    await wakeAndFire(h);
    await h.pass();
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
  });

  it('pre-park re-read: a signal that CHANGED since the leg saw it (new event id) still stays active', async () => {
    const h = makeHarness({
      conductions: [conduction()],
      tasks: { 'task-1': pausedTask({ pending_acceptance_event_id: 'ev-1' }) },
    });
    await wakeAndFire(h);
    const orig = h.deps.getTaskMeta;
    let reads = 0;
    h.deps.getTaskMeta = vi.fn(async (id: string) => {
      const r = await orig(id);
      reads += 1;
      return reads >= 2 ? { ...r, pending_acceptance_event_id: 'ev-2' } : r;
    });
    await h.pass();
    expect(h.getConduction('cond-1').status).toBe('active');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('late-acceptance');
  });

  it('pre-park re-read failure parks exactly as before', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await wakeAndFire(h);
    const orig = h.deps.getTaskMeta;
    let reads = 0;
    h.deps.getTaskMeta = vi.fn(async (id: string) => {
      reads += 1;
      if (reads >= 2) throw new Error('boom');
      return orig(id);
    });
    await h.pass();
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
    expect(h.logs.some((l) => l.includes('pre-park re-read failed'))).toBe(true);
  });

  it('no marker: unchanged — a quiet leg parks no-progress after one extra read only', async () => {
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() } });
    await runOneLeg(h);
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('no-progress');
    expect(h.getConduction('cond-1').last_worker_exit_code).toBe(0);
  });
});

describe('B-1185 fireLaunch catalog wiring', () => {
  it.each(['codex:gpt-6.1-sol', 'gpt-6.1-sol'])('fires the first leg with the runtime id for %s', async (model) => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { agent: { adapter: 'codex' }, model: { default: model } } })],
      tasks: { 'task-1': pausedTask() },
      config: { ...config, profile: { ...config.profile, agents: ['codex'], launch: "launch {conduction_id} --model '{model}' --run-config '{run_config_json}'" } },
    });
    h.deps.getModelCatalog = async () => [{ alias: 'codex:gpt-6.1-sol', model_id: 'gpt-6.1-sol', agent: 'codex', active: true, label: 'Sol', context_budget_bytes: 1, verified_at: null }];
    await wakeAndFire(h);
    expect(h.launches()).toHaveLength(1);
    expect(h.launches()[0]).toContain("--model 'gpt-6.1-sol'");
  });
  it('still fires a bare-id leg when the catalog read throws', async () => {
    const h = makeHarness({
      conductions: [conduction({ run_config: { agent: { adapter: 'codex' }, model: { default: 'gpt-6-luna' } } })],
      tasks: { 'task-1': pausedTask() },
      config: { ...config, profile: { ...config.profile, agents: ['codex'], launch: "launch {conduction_id} --model '{model}' --run-config '{run_config_json}'" } },
    });
    h.deps.getModelCatalog = async () => { throw new Error('offline'); };
    await wakeAndFire(h);
    expect(h.launches()).toHaveLength(1);
    expect(h.launches()[0]).toContain("--model 'gpt-6-luna'");
  });
});


describe('B-1267 startup-unavailable settlement', () => {
  it.each([true, false])('parks immediately without retry and posts bounded diagnostics (captured=%s)', async captured => {
    const diagnostic = 'gke-worker-launch: startup-unavailable: job leg-123: PVC Pending; ProvisioningFailed: quota exhausted';
    const h = makeHarness({ conductions: [conduction()], tasks: { 'task-1': pausedTask() },
      config: { ...config, retryCap: 2 }, launchExitCode: 74,
      ...(captured ? { launchOutput: { tail: 'other launcher noise\n' + diagnostic + '\n', bytes: 200 } } : {}) });
    const addTicketComment = vi.fn(async () => {});
    h.deps.addTicketComment = addTicketComment;
    await h.pass();
    (h.tasks['task-1'] as DaemonTask).awaiting_human_input = false;
    await h.pass();
    await h.pass();
    expect(h.getConduction('cond-1').status).toBe('parked');
    expect(h.getConduction('cond-1').last_worker_exit_class).toBe('startup-unavailable');
    expect(h.getConduction('cond-1').last_worker_exit_code).toBe(74);
    expect(h.ready()).toEqual([]);
    expect(h.reaps()).toHaveLength(1);
    expect(addTicketComment).toHaveBeenCalledTimes(1);
    const message = String(addTicketComment.mock.calls[0][1]);
    expect(message).toContain(captured ? 'ProvisioningFailed: quota exhausted' : 'diagnostic unavailable');
    expect(message).toContain('ticket disk is retained');
    expect(message).not.toContain('other launcher noise');
    expect(h.logs.some(line => line.includes('startup-unavailable') && line.includes(captured ? 'quota exhausted' : 'diagnostic unavailable'))).toBe(true);
  });
});
