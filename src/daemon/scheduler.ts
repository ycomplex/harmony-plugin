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

function templateVars(row: ConductionRecord): { conduction_id: string; ticket: string } {
  // {ticket} carries the task UUID — resolveTaskId fast-paths UUIDs in every consumer, with no
  // project-key lookup and no cross-project ambiguity.
  return { conduction_id: row.id, ticket: row.task_id };
}

/** ONE scheduler pass over every active conduction (exported for tests). */
export async function runSchedulerPass(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
): Promise<void> {
  const rows = await deps.listConductions({ status: 'active' });

  // Prune baselines for conductions that left the active set (completed/parked elsewhere).
  const activeIds = new Set(rows.map((r) => r.id));
  for (const id of [...state.keys()]) if (!activeIds.has(id)) state.delete(id);

  for (const row of rows) {
    try {
      await handleConduction(deps, state, row);
    } catch (err) {
      // Isolation per conduction: one row's failure must never kill the pass (and a READ failure
      // must never park anything — parking is a classification, not an error handler).
      deps.log(
        `conduction ${row.id}: pass error — row skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
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

    // REAP-THEN-FIRE: the dead holder may have left a worker running; remove it BEFORE this daemon
    // ever fires one, so two workers can never conduct the same ticket.
    await deps.runCommand(renderTemplate(deps.config.profile.reap, templateVars(row)));
    state.delete(row.id); // fresh read — takeover starts with no baseline.
    deps.log(`conduction ${row.id}: took over stale lease from ${row.lease_holder ?? '(none)'} — reaped`);
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
 *  logged and the loop keeps going — supervision (launchd) owns process death, not transients. */
export async function runScheduler(deps: SchedulerDeps): Promise<never> {
  const state = new Map<string, WatchBaseline>();
  for (;;) {
    try {
      await runSchedulerPass(deps, state);
    } catch (err) {
      deps.log(`scheduler pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await deps.sleep(deps.config.pollMs);
  }
}
