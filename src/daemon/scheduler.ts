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
//   3. Heartbeat every held row every pass (pollMs ≤ heartbeatMs).
//   4. Read the ticket meta; first sight captures the baseline, later passes run wake detection.
//   5. On wake: fire the launch template and await its exit, then classify PURELY from exit code +
//      a fresh ticket read (never worker stdout) and write the outcome:
//        wait     → store the post-exit read as the new baseline (stay active);
//        complete → status 'completed' + exit code/class;
//        park     → status 'parked' + exit code/class — park-IMMEDIATELY, no auto-retry (the
//                   B-659 endless-re-arm class), retry_count untouched.
//   6. Errors in one conduction's handling are logged and that row skipped — never the pass.

import { captureBaseline, detectWake, type WatchBaseline } from './watch.js';
import { classifyWorkerExit, exitClass, type ClassifyArgs } from './classify.js';
import { renderTemplate, type DaemonConfig } from './config.js';
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
  takeoverConduction(args: TakeoverConductionArgs): Promise<ConductionRecord | null>;
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
): Promise<PassSummary> {
  const rows = await deps.listConductions({ status: 'active' });

  // Prune baselines for conductions that left the active set (completed/parked elsewhere).
  const activeIds = new Set(rows.map((r) => r.id));
  for (const id of [...state.keys()]) if (!activeIds.has(id)) state.delete(id);

  let authShapedFailures = 0;
  for (const row of rows) {
    try {
      await handleConduction(deps, state, row);
    } catch (err) {
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

async function handleConduction(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
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

  // ── Heartbeat (step 3): every pass ≈ heartbeat cadence (pollMs ≤ heartbeatMs). ────────────────
  await deps.updateConduction(row.id, { last_heartbeat_at: iso(deps.now()) });

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
  const { exitCode } = await deps.runCommand(
    renderTemplate(deps.config.profile.launch, templateVars(row)),
  );

  const after = await deps.getTaskMeta(row.task_id);
  const nonArchivedChildCount =
    after.workflow_state === 'Decomposed' ? await deps.countNonArchivedChildren(row.task_id) : 0;
  const progressed =
    (after.workflow_state ?? null) !== (current.workflow_state ?? null) ||
    (after.awaiting_human_input ?? null) !== (current.awaiting_human_input ?? null);

  const classifyArgs: ClassifyArgs = { row: after, nonArchivedChildCount, exitCode, progressed };
  const outcome = classifyWorkerExit(classifyArgs);
  const cls = exitClass(outcome, classifyArgs);
  deps.log(`conduction ${row.id}: worker exit code=${exitCode ?? 'null'} → ${outcome.action} (${cls})`);

  if (outcome.action === 'wait') {
    state.set(row.id, captureBaseline(after));
    return;
  }

  // Park-immediately / complete: one terminal status write; retry_count untouched (no auto-retry).
  state.delete(row.id);
  await deps.updateConduction(row.id, {
    status: outcome.action === 'complete' ? 'completed' : 'parked',
    last_worker_exit_code: exitCode,
    last_worker_exit_class: cls,
  });
}

/** The forever loop: pass; sleep(pollMs). A pass-level failure (e.g. a transient list error) is
 *  logged and the loop keeps going — supervision (launchd) owns process death, not transients.
 *  ONE exception (B-696): AUTH_FAILURE_PASS_LIMIT consecutive auth-shaped-failing passes throw
 *  PersistentAuthFailure — a zombie daemon must die loudly, not heartbeat forever. */
export async function runScheduler(deps: SchedulerDeps): Promise<never> {
  const state = new Map<string, WatchBaseline>();
  let consecutiveAuthFailingPasses = 0;
  for (;;) {
    // A pass counts as auth-failing when the pass ITSELF died auth-shaped (e.g. the list read),
    // or when it attempted ≥1 conduction and EVERY attempt failed auth-shaped. Anything else —
    // a success, an idle pass, a non-auth error, one healthy row — resets the counter.
    let authFailingPass: boolean;
    try {
      const summary = await runSchedulerPass(deps, state);
      authFailingPass = summary.attempted > 0 && summary.authShapedFailures === summary.attempted;
    } catch (err) {
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
