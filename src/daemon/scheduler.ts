// B-696: the daemon loop — one pass over every active conduction.
//
// Pure dependency-injected core (the B-532 poll-loop pattern): time, sleeping, every read, every
// conduction write, and worker launch/reap are ALL injected, so the whole loop is fake-clock
// unit-testable. The entrypoint (src/bin/daemon.ts) wires the real deps.
//
// Pass algorithm (Accepted design d153970b — implemented exactly):
//   1. List active conductions.
//   2. Foreign lease → CAS takeover (guarded on the OBSERVED holder + the stale-heartbeat window,
//      measured from now() AT PASS TIME — the B-651 stale-time-origin class). Lost → skip the row
//      untouched. Won → REAP-THEN-FIRE: run the reap template FIRST (the dead holder's zombie
//      worker must be gone before we ever launch), then treat the row as held with NO baseline.
//   3. Stamp the heartbeat immediately, then hand the lease to the B-739 KEEPER, which stamps it
//      on its own cadence thereafter — including while step 5 blocks this pass for the worker's
//      whole lifetime. Every post-claim write is LEASE-GUARDED, so the stamp doubles as the
//      ownership probe: a blocked pass cannot otherwise discover that its lease was taken over.
//   4. Read the ticket meta; first sight captures the baseline, later passes run wake detection.
//   5. On wake: fire the launch template and await its exit, then classify PURELY from exit code +
//      a fresh ticket read (never worker stdout) and write the outcome:
//        wait     → store the post-exit read as the new baseline (stay active);
//        complete → status 'completed' + exit code/class;
//        park     → status 'parked' + exit code/class — park-IMMEDIATELY (the B-659 endless-re-arm
//                   class), EXCEPT a 'dirty-exit' reason gets a bounded retry first (B-713):
//                   reap, deps.sleep(retryBackoffMs), re-fire, up to config.retryCap attempts,
//                   bumping retry_count on the conduction record each attempt — before parking.
//                   config.retryCap=0 reproduces the pre-B-713 immediate-park behavior exactly;
//                   every other park reason (stale, no-progress) is still immediate, no retry.
//   6. Errors in one conduction's handling are logged and that row skipped — never the pass.

import { captureBaseline, detectWake, type WatchBaseline } from './watch.js';
import { classifyWorkerExit, exitClass, type ClassifyArgs } from './classify.js';
import { renderTemplate, type DaemonConfig } from './config.js';
import type { HeartbeatKeeper } from './heartbeat.js';
import type {
  ConductionPatch,
  ConductionRecord,
  ConductionStatus,
  TakeoverConductionArgs,
} from '../tools/conduction-record.js';
import type { Taskish } from '../conductor/poll-loop.js';

/** The ticket shape the daemon reads (a getTask view:'meta' result is structurally assignable). */
export type DaemonTask = Taskish & {
  workflow_state?: string | null;
  stale?: boolean | null;
  task_number?: number | null;
};

export interface SchedulerDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  listConductions(args: { status?: ConductionStatus }): Promise<ConductionRecord[]>;
  getTaskMeta(taskId: string): Promise<DaemonTask>;
  countNonArchivedChildren(taskId: string): Promise<number>;
  updateConduction(id: string, patch: ConductionPatch): Promise<ConductionRecord>;
  /** B-739: the LEASE-GUARDED write. Every post-claim write goes through this — `null` means the
   *  lease is gone (go quiet on that run), a throw means nothing is known. */
  updateConductionIfHeld(
    id: string,
    expectedLeaseHolder: string,
    patch: ConductionPatch,
  ): Promise<ConductionRecord | null>;
  takeoverConduction(args: TakeoverConductionArgs): Promise<ConductionRecord | null>;
  /** B-739: start a repeating timer; returns a stop function. Injected so the loop stays
   *  fake-clock testable (the B-532 pattern) — never call global setInterval in this module. */
  startInterval(ms: number, fn: () => void): () => void;
  /** B-739: start a one-shot timer; returns a cancel function. Same dependency-injection rule. */
  startTimeout(ms: number, fn: () => void): () => void;
  /** Run a rendered launch/reap command to completion; the daemon consumes ONLY the exit code
   *  (never stdout — the agent-portability guardrail). */
  runCommand(cmd: string): Promise<{ exitCode: number | null }>;
  log(line: string): void;
  leaseHolder: string;
  config: DaemonConfig;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** B-696 backstop: thrown by runScheduler after AUTH_FAILURE_PASS_LIMIT consecutive passes in
 *  which every attempted conduction handling (or the pass itself) failed auth-shaped. The
 *  entrypoint catches it and exits non-zero so launchd restarts the daemon with fresh auth —
 *  restart over zombie. */
export class PersistentAuthFailure extends Error {
  readonly consecutivePasses: number;

  constructor(consecutivePasses: number) {
    super(
      `persistent auth failure: ${consecutivePasses} consecutive scheduler passes failed auth-shaped`,
    );
    this.name = 'PersistentAuthFailure';
    this.consecutivePasses = consecutivePasses;
  }
}

const AUTH_FAILURE_PASS_LIMIT = 3;

/** B-739: how many times the deadline re-fires the reap before giving up on freeing this daemon. */
const REAP_ATTEMPT_LIMIT = 3;
/** B-739: how long to wait for a fired reap to actually free the blocked launch. */
const REAP_GRACE_MS = 30_000;

/** B-739 backstop: thrown when a worker this daemon ruled OVERRUN could not be reaped after
 *  REAP_ATTEMPT_LIMIT attempts, so the pass is STILL blocked with its deadline already spent.
 *  The entrypoint catches it and exits non-zero — a daemon that cannot leave a state must not keep
 *  advertising liveness from inside it (the same "restart over zombie" logic as
 *  PersistentAuthFailure). Restart hands recovery back to machinery that already exists: the new
 *  instance has a fresh lease holder id, the dead process's heartbeat has stopped, so the lease
 *  goes stale on schedule and the restarted daemon wins its own CAS takeover — whose first action
 *  is REAP-THEN-FIRE. If the container runtime is genuinely wedged that reap fails too, and dying
 *  loudly is then the only honest outcome.
 *
 *  MUST escape the per-conduction and per-pass error isolation — see runSchedulerPass/runScheduler,
 *  which re-throw it unchanged. Swallowing it would convert "I cannot free myself" into a skipped
 *  row, which is precisely the zombie this class exists to prevent. */
export class PersistentReapFailure extends Error {
  readonly conductionId: string;

  constructor(conductionId: string) {
    super(
      `persistent reap failure: the worker for conduction ${conductionId} did not stop after ` +
        `${REAP_ATTEMPT_LIMIT} reap attempts`,
    );
    this.name = 'PersistentReapFailure';
    this.conductionId = conductionId;
  }
}

/** Auth-shaped error detection (exported for tests): 401s, expired/invalid JWTs and tokens. */
export function isAuthShapedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b401\b|jwt expired|invalid (jwt|token)|token .*expired/i.test(message);
}

function templateVars(row: ConductionRecord): { conduction_id: string; ticket: string } {
  // {ticket} carries the task UUID — resolveTaskId fast-paths UUIDs in every consumer, with no
  // project-key lookup and no cross-project ambiguity.
  return { conduction_id: row.id, ticket: row.task_id };
}

/** What one pass observed — consumed only by runScheduler's auth-failure counter. */
export interface PassSummary {
  attempted: number;
  authShapedFailures: number;
}

/** ONE scheduler pass over every active conduction (exported for tests). */
export async function runSchedulerPass(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
): Promise<PassSummary> {
  const rows = await deps.listConductions({ status: 'active' });

  // Prune baselines AND heartbeat timers for conductions that left the active set
  // (completed/parked elsewhere) — the two live on the same lifecycle.
  const activeIds = new Set(rows.map((r) => r.id));
  for (const id of [...state.keys()]) if (!activeIds.has(id)) state.delete(id);
  keeper.retain(activeIds);

  let authShapedFailures = 0;
  for (const row of rows) {
    try {
      await handleConduction(deps, state, keeper, row);
    } catch (err) {
      // B-739: "I cannot free myself" is NOT a per-row transient — it must escape this isolation
      // and kill the process, or the daemon keeps heartbeating from inside a state it cannot
      // leave. Re-throw before anything else looks at it.
      if (err instanceof PersistentReapFailure) throw err;
      // Isolation per conduction: one row's failure must never kill the pass (and a READ failure
      // must never park anything — parking is a classification, not an error handler).
      if (isAuthShapedError(err)) authShapedFailures += 1;
      deps.log(
        `conduction ${row.id}: pass error — row skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return { attempted: rows.length, authShapedFailures };
}

/** B-739: every write AFTER the lease is claimed goes through the lease guard. A `null` means
 *  another daemon owns this run now — go quiet immediately rather than clobbering its record.
 *  Returns false when the lease was lost, in which case the caller must write nothing further.
 *  An operational error still THROWS (nothing is known; it must not read as lease loss). */
async function writeIfHeld(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  row: ConductionRecord,
  patch: ConductionPatch,
): Promise<boolean> {
  const updated = await deps.updateConductionIfHeld(row.id, deps.leaseHolder, patch);
  if (updated !== null) return true;
  deps.log(`conduction ${row.id}: lease lost to another daemon — abandoning this run`);
  keeper.stop(row.id);
  state.delete(row.id);
  return false;
}

async function handleConduction(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  row: ConductionRecord,
): Promise<void> {
  // ── Takeover (step 2) ──────────────────────────────────────────────────────────────────────────
  if (row.lease_holder !== deps.leaseHolder) {
    const won = await deps.takeoverConduction({
      id: row.id,
      observed_lease_holder: row.lease_holder,
      // B-651 guard: the stale window originates from now() AT PASS TIME, never a stored stamp.
      stale_before: iso(deps.now() - deps.config.staleMs),
      new_lease_holder: deps.leaseHolder,
    });
    if (won === null) return; // holder alive, or lost the CAS race — row untouched.

    state.delete(row.id); // fresh read — the claim starts with no baseline.
    if (row.lease_holder === null) {
      // B-696 first-claim polish: a never-held conduction has no dead holder and no worker to
      // reap — running the reap template would target a container that never existed.
      deps.log(`conduction ${row.id}: first claim of a never-held conduction`);
    } else {
      // REAP-THEN-FIRE: the dead holder may have left a worker running; remove it BEFORE this
      // daemon ever fires one, so two workers can never conduct the same ticket.
      await deps.runCommand(renderTemplate(deps.config.profile.reap, templateVars(row)));
      deps.log(`conduction ${row.id}: took over stale lease from ${row.lease_holder} — reaped`);
    }
  }

  // ── Heartbeat (step 3): B-739 — an IMMEDIATE stamp, then hand this lease to the keeper. ───────
  // The immediate write means a freshly claimed lease does not wait a full interval for its first
  // stamp. The keeper then stamps it on its OWN cadence (config.heartbeatMs) — crucially including
  // while the launch below blocks this pass for the worker's entire lifetime, which is exactly
  // when the old pass-coupled write went silent and made a healthy daemon look reapable.
  if (!(await writeIfHeld(deps, state, keeper, row, { last_heartbeat_at: iso(deps.now()) }))) return;
  keeper.ensure(row.id);

  // ── Watch (step 4) ────────────────────────────────────────────────────────────────────────────
  const current = await deps.getTaskMeta(row.task_id);
  const baseline = state.get(row.id);
  if (!baseline) {
    state.set(row.id, captureBaseline(current));
    return;
  }
  const wake = detectWake(baseline, current);
  if (wake === null) return;

  // ── Fire → classify → write (step 5) ──────────────────────────────────────────────────────────
  deps.log(`conduction ${row.id}: wake (${wake}) — launching worker`);

  // B-713: a 'dirty-exit' park is retried in place — reap, back off, re-fire — up to
  // config.retryCap attempts before the conduction ever parks. Every other outcome (wait,
  // complete, or a park for any OTHER reason) falls straight through to the write below exactly
  // as before B-713. retryCount starts from the row's own durable retry_count so a takeover or a
  // prior pass's partial progress is never double-counted or reset.
  let retryCount = row.retry_count;
  for (;;) {
    // ── B-739: the per-LAUNCH deadline ────────────────────────────────────────────────────────
    // Armed inside the loop, so each retried attempt gets its OWN full deadline and none inherits
    // a partly spent one.
    //
    // Note what enforces it: firing the profile's REAP template, never an exec timeout. Verified
    // live (Docker 29.2.1 / Node 24.11.0): a 2s exec timeout on a 300s container left it "Up 9
    // seconds" seven seconds past the deadline with NEITHER the exit nor the close event fired —
    // the exec timeout stopped neither the container nor the daemon. Running the reap produced
    // both at once. So the reap is not cleanup AFTER the timeout; the reap IS the mechanism, for
    // stopping the worker and for freeing this pass.
    let timedOut = false;
    let settled = false;
    const launch = deps
      .runCommand(renderTemplate(deps.config.profile.launch, templateVars(row)))
      .then((result) => {
        settled = true;
        return result;
      });

    // Rejects ONLY when the reap cannot free us; otherwise `launch` always settles first.
    const escalation = new Promise<never>((_resolve, reject) => {
      const cancelDeadline = deps.startTimeout(deps.config.workerTimeoutMs, () => {
        timedOut = true;
        deps.log(
          `conduction ${row.id}: worker exceeded ${deps.config.workerTimeoutMs}ms — reaping`,
        );
        void (async () => {
          for (let attempt = 1; attempt <= REAP_ATTEMPT_LIMIT; attempt += 1) {
            // NEVER await the reap: a wedged container runtime can hang the reap command itself,
            // and the call we make to unblock ourselves must not be able to block us.
            void deps.runCommand(renderTemplate(deps.config.profile.reap, templateVars(row)));
            await new Promise<void>((resolveGrace) => {
              deps.startTimeout(REAP_GRACE_MS, resolveGrace);
            });
            if (settled) return;
            deps.log(
              `conduction ${row.id}: reap ${attempt}/${REAP_ATTEMPT_LIMIT} did not free the launch`,
            );
          }
          reject(new PersistentReapFailure(row.id));
        })();
      });
      void launch.finally(cancelDeadline);
    });

    const { exitCode } = await Promise.race([launch, escalation]);

    const after = await deps.getTaskMeta(row.task_id);
    const nonArchivedChildCount =
      after.workflow_state === 'Decomposed' ? await deps.countNonArchivedChildren(row.task_id) : 0;
    const progressed =
      (after.workflow_state ?? null) !== (current.workflow_state ?? null) ||
      (after.awaiting_human_input ?? null) !== (current.awaiting_human_input ?? null);

    const classifyArgs: ClassifyArgs = {
      row: after,
      nonArchivedChildCount,
      exitCode,
      progressed,
      timedOut,
    };
    const outcome = classifyWorkerExit(classifyArgs);
    const cls = exitClass(outcome, classifyArgs);
    deps.log(
      `conduction ${row.id}: worker exit code=${exitCode ?? 'null'} → ${outcome.action} (${cls})`,
    );

    if (outcome.action === 'wait') {
      state.set(row.id, captureBaseline(after));
      return;
    }

    // A 'worker-timeout' park never reaches here: its class is not 'dirty-exit', so the ladder is
    // bypassed by construction and the run parks on the first occurrence (B-739).
    if (outcome.action === 'park' && cls === 'dirty-exit' && retryCount < deps.config.retryCap) {
      retryCount += 1;
      if (!(await writeIfHeld(deps, state, keeper, row, { retry_count: retryCount }))) return;
      deps.log(
        `conduction ${row.id}: dirty exit — retrying (attempt ${retryCount}/${deps.config.retryCap}) ` +
          `after reap + ${deps.config.retryBackoffMs}ms backoff`,
      );
      await deps.runCommand(renderTemplate(deps.config.profile.reap, templateVars(row)));
      await deps.sleep(deps.config.retryBackoffMs);
      continue;
    }

    // Park (retry cap exhausted, or a non-dirty-exit park reason) / complete: one terminal status
    // write, exactly as before B-713. retry_count is left at whatever it reached — never reset.
    // B-739: LEASE-GUARDED. A daemon blocked on a long worker whose container a peer reaped will
    // reach here holding a stale claim; writing unguarded would clobber the new holder's record.
    state.delete(row.id);
    keeper.stop(row.id);
    await writeIfHeld(deps, state, keeper, row, {
      status: outcome.action === 'complete' ? 'completed' : 'parked',
      last_worker_exit_code: exitCode,
      last_worker_exit_class: cls,
    });
    return;
  }
}

/** The forever loop: pass; sleep(pollMs). A pass-level failure (e.g. a transient list error) is
 *  logged and the loop keeps going — supervision (launchd) owns process death, not transients.
 *  ONE exception (B-696): AUTH_FAILURE_PASS_LIMIT consecutive auth-shaped-failing passes throw
 *  PersistentAuthFailure — a zombie daemon must die loudly, not heartbeat forever. */
export async function runScheduler(deps: SchedulerDeps, keeper: HeartbeatKeeper): Promise<never> {
  const state = new Map<string, WatchBaseline>();
  let consecutiveAuthFailingPasses = 0;
  for (;;) {
    // A pass counts as auth-failing when the pass ITSELF died auth-shaped (e.g. the list read),
    // or when it attempted ≥1 conduction and EVERY attempt failed auth-shaped. Anything else —
    // a success, an idle pass, a non-auth error, one healthy row — resets the counter.
    let authFailingPass: boolean;
    try {
      const summary = await runSchedulerPass(deps, state, keeper);
      authFailingPass = summary.attempted > 0 && summary.authShapedFailures === summary.attempted;
    } catch (err) {
      // B-739: a daemon that cannot free itself from a worker it ruled overrun must DIE, not log
      // and loop. Re-throw before the transient handling below can swallow it.
      if (err instanceof PersistentReapFailure) throw err;
      deps.log(`scheduler pass failed: ${err instanceof Error ? err.message : String(err)}`);
      authFailingPass = isAuthShapedError(err);
    }
    consecutiveAuthFailingPasses = authFailingPass ? consecutiveAuthFailingPasses + 1 : 0;
    if (consecutiveAuthFailingPasses >= AUTH_FAILURE_PASS_LIMIT) {
      throw new PersistentAuthFailure(consecutiveAuthFailingPasses);
    }
    await deps.sleep(deps.config.pollMs);
  }
}
