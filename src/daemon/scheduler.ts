// B-696: the daemon loop — one pass over every active conduction.
//
// Pure dependency-injected core (the B-532 poll-loop pattern): time, sleeping, every read, every
// conduction write, and worker launch/reap are ALL injected, so the whole loop is fake-clock
// unit-testable. The entrypoint (src/bin/daemon.ts) wires the real deps.
//
// B-717 FIRE-AND-TRACK (accepted design c4c975bd — implemented exactly; supersedes the old serial
// fire-and-AWAIT pass this module used to run under d153970b). A pass no longer blocks on any
// worker's lifetime. Every active row is one of four states, tracked across passes in two new
// per-process, per-daemon maps living alongside the existing `state` (watch baselines) and
// `HeartbeatKeeper` maps — same lifecycle discipline, pruned via the same `retain(activeIds)` shape
// every pass:
//
//   ready   — Map<conductionId, ReadyEntry>: a wake fired but the row has not been FIRED yet,
//             either this pass (no free slot) or a prior one. Entering `ready` deliberately does
//             NOT roll the watch baseline (rolling would make the next pass's detectWake see no
//             transition and the row would starve — a queued-but-unfired row must keep reading as
//             "ready" until it is actually fired).
//   running — Map<conductionId, TrackedLaunch>: a `runCommand(launch)` is in flight, fired-and-
//             NOT-awaited. Holds the same per-launch state the old inline code held on the call
//             stack (settled/exitCode/timedOut flags, the deadline canceller, and the pre-fire
//             ticket read `ClassifyArgs.progressed` compares against) — now living across passes.
//
// Per row, per pass (handleConduction):
//   (a) `running` holds it        → check settlement ONLY. Settled: run the unchanged post-exit
//                                    classify/write logic and drop it from `running`. Not settled:
//                                    do nothing this pass — the HeartbeatKeeper stamps liveness on
//                                    its own cadence regardless, exactly as it always has.
//   (b) neither map holds it      → today's takeover/heartbeat/wake logic, unchanged, except a
//                                    detected wake adds the row to `ready` instead of firing inline.
//   (c) `ready` holds it          → nothing to do per-row; a SEPARATE once-per-pass phase
//                                    (fireReadyCandidates, run after every row's been triaged)
//                                    picks the highest-priority eligible candidates for however many
//                                    slots are free (item 2's queue discipline needs to see the
//                                    WHOLE ready set to rank it, which a single per-row pass over
//                                    `listConductions`'s started_at-ascending order cannot do) and
//                                    fires them — stamp `leg_started_at`, kick off `runCommand`
//                                    WITHOUT awaiting it, move ready → running. The pass never
//                                    blocks on a worker's lifetime again.
//
// leg_started_at lifecycle (load-bearing — B-742 point 3, corrected by this ticket's accept-with-
// remark): SET at fire (unchanged timing), CLEARED ONLY at tracked-settlement classification —
// never at the fire-and-forget kickoff's own return. Between fire and settlement it stays non-null
// for the worker's entire real runtime — stronger than the old guarantee (non-null only for a
// synchronous await's duration). This is what makes B-717 item 3's steal CAS safe by construction:
// `leg_started_at IS NULL` can only mean "no worker is executing for this row, on ANY daemon", for
// that row's whole actual runtime, not a transient in-flight state.
//
// B-742 point 4 (reap-after-takeover clear), CONDITIONAL per this ticket's accept-with-remark: the
// takeover win branch's `leg_started_at: null` clear only ever fires for a row with NO tracked
// in-flight worker on THIS daemon — by construction, since `running` only ever holds rows this
// daemon currently HOLDS THE LEASE for, and a takeover win means we did not hold it a moment ago.
// The one case that could otherwise collide — a restarted daemon (or a peer) with a genuinely still-
// running worker under a stale-looking lease — is handled by RECONCILIATION below, which re-attaches
// instead of reaping, so the clear is correctly skipped in that case too.
//
// Restart reconciliation: `ready`/`running` are process-local and do not survive a restart. A newly
// won takeover (self-restart or a genuinely dead peer) with a non-null `leg_started_at` MUST NOT be
// treated as "not running" without first checking: probe the launch profile's own tracking surface
// (`LaunchProfile.probe`, optional — a profile that omits it just skips straight to the old REAP-
// THEN-FIRE). Found ⇒ RE-ATTACH: populate `running` with a reconciled TrackedLaunch that resumes
// settlement-polling via the same probe each pass (never spawns a new launch). Not found ⇒ treat as
// already-settled: fall through to today's reap + clear. Runs ONCE per newly-claimed/taken-over
// lease, not every pass.
//
// Multi-daemon steal (item 3): today's takeover CAS only matches a STALE lease. For a foreign row
// whose takeover CAS lost (the holder is alive), an idle daemon with a free running slot does its
// own read + wake computation; if it would be ready AND `leg_started_at IS NULL`, it attempts
// `stealConduction` (conduction-record.ts, beside `takeoverConduction`). Win → fire immediately in
// the SAME pass (the eligibility read already happened, so there is no cold-start baseline pass to
// run first). Loss → do nothing; a later pass may reconsider. The original holder's own writes are
// all `updateConductionIfHeld`-guarded, so a steal-winner mid-flight just makes the original
// holder's next write a no-op — the existing "lease lost to another daemon" path, no new primitive.
//
// B-761: a same-host successor of a DELIBERATE daemon exit (SIGTERM/SIGINT) adopts every row that
// instance held IMMEDIATELY — `takeoverConduction`'s CAS (conduction-record.ts) now also matches a
// non-null `clean_shutdown_at`, a marker the daemon's stop() handler stamps right before exit, and
// clears it on the same write that reassigns `lease_holder` (single-use). An UNCLEAN death never
// stamps it, so that row still falls through to the unchanged stale-heartbeat branch — the fail-safe
// holds by construction, no extra logic here. A MID-LEG foreign row (`leg_started_at` non-null) is
// the one case still genuinely costing wall-clock time: it is never steal-eligible (see item 3
// above), so the stale-window CAS is its only path to adoption. handleForeignConduction tracks a
// waiting set every pass and `announceWaiting` logs an edge-triggered summary (count + earliest
// adoption time) on transition, mirroring B-771's log-once WeakMap-keyed-on-`state` discipline
// (exclusionMemory/exclusionSetFor, just below) rather than logging every pass. REOPEN FIX (live
// verify, 2026-08-05): the waiting set used to be gated on `leg_started_at !== null`, so it only
// ever covered the mid-leg sub-case — real production dead windows over IDLE rows (ball-with-human,
// nothing running) announced NOTHING for 4+ minutes each, leaving an operator unable to tell
// "waiting on a stale lease" apart from "no work exists" for that case. The waiting set is now
// UNCONDITIONAL on leg state: every row whose takeover CAS just lost this pass is tracked, covering
// the whole dead window, not just the throughput-costing mid-leg sub-case. Separately, the routine
// "reap a container the dead holder already lost" case at handleWonTakeover's reap-before-adopt call
// site now asks runCommand for quiet rendering (real implementation in src/bin/daemon.ts) — a calm
// one-line outcome instead of raw Docker stderr.
//
// PersistentReapFailure now surfaces from a DETACHED background chain (the deadline/reap escalation
// is fired-and-forgotten, never awaited by a pass) rather than a synchronous throw a pass's own
// await chain would propagate. It is stashed on `SchedulerRuntime.fatal` and every pass checks that
// slot FIRST, before touching a single row — see the class doc below for why this must still escape
// both per-conduction and per-pass isolation exactly as it always has.
//
// Errors in one conduction's handling (including a fire attempt) are logged and that row skipped —
// never the pass — with the sole exception of PersistentReapFailure (above) and a fatal already
// parked on SchedulerRuntime.fatal from a previous pass's detached escalation.
//
// B-827: {ticket} template substitution now carries the ticket's VISUAL id (project key +
// task_number — resolveVisualId, the same composition label()'s B-723 log lines already use), not
// the row UUID, so the worker prompt, host-side RUN_DIR paths, and the B-788 persisted transcript
// path all name the ticket. MIGRATION WRINKLE, examined (not assumed away): a conduction already
// mid-leg when this ships was launched with the OLD (UUID) {ticket} value, so its host-side RUN_DIR
// (`~/.harmony-conductions/<uuid>/<conduction-id>/`) was built from that old value. After a daemon
// restart post-fix, the restart-reconciliation probe and the REAP-THEN-FIRE fallback
// (handleWonTakeover, below) render {ticket} FRESH from a best-effort getTaskMeta read — which now
// resolves the NEW (visual-id) value for that same task, a RUN_DIR path that was never created at
// launch time. This does NOT strand the conduction: every reap/probe wrapper this daemon ships
// (container/docker-worker-reap.sh, container/cloud-worker-reap.sh, container/cloud-worker-probe.sh,
// and the docker profile's inline `docker ps --filter name=harmony-worker-{conduction_id}` probe)
// targets the worker by CONDUCTION_ID (a Docker container name / a Cloud Run execution's
// conduction-id label) — never by TICKET or RUN_DIR — confirmed by reading every wrapper script,
// not assumed. {ticket}/RUN_DIR there is used ONLY to locate the per-run minted-secret env-file for
// cleanup (`rm -f "$RUN_DIR/run.env"`), so an old-UUID-launched conduction reaped/probed post-
// restart still has its live worker found and killed correctly by conduction-id; the sole
// consequence of the RUN_DIR mismatch is that ONE already-in-flight leg's env-file (a short-lived
// minted GIT_TOKEN) is not cleaned up by that reap call — a bounded, self-resolving disk-cleanliness
// gap (the container's own filesystem is ephemeral for Cloud Run; for local Docker it is an orphan
// file an operator can sweep), never a stranded conduction. A brand-new conduction launched AFTER
// this fix ships has a consistent visual-id RUN_DIR from launch through to its own reap/probe, by
// construction (same resolveVisualId call, same task, same result every time — project key and
// task_number never change over a task's lifetime). No read-fallback-to-old-path-shape or drain-
// before-flip was needed as a result; see profile-contract.test.ts's existing 'reap resolves the
// execution by that SAME conduction-id label' / docker-name-by-conduction-id assertions for the
// executed proof this reasoning rests on.

import { captureBaseline, detectWake, type WatchBaseline } from './watch.js';
import { classifyWorkerExit, exitClass, type ClassifyArgs } from './classify.js';
import { exchangeWentInactive } from '../conductor/ball-axis.js';
import { renderTemplate, type DaemonConfig } from './config.js';
import type { HeartbeatKeeper } from './heartbeat.js';
import { formatDaemonError } from './error-format.js';
import type {
  ConductionPatch,
  ConductionRecord,
  ConductionStatus,
  StealConductionArgs,
  TakeoverConductionArgs,
} from '../tools/conduction-record.js';
import type { Taskish } from '../conductor/poll-loop.js';

/** The ticket shape the daemon reads (a getTask view:'meta' result is structurally assignable). */
export type DaemonTask = Taskish & {
  workflow_state?: string | null;
  stale?: boolean | null;
  task_number?: number | null;
  title?: string | null;
  conductor_excluded_at?: string | null;
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
  /** B-717 item 3: the multi-daemon steal CAS — see conduction-record.ts's stealConduction. */
  stealConduction(args: StealConductionArgs): Promise<ConductionRecord | null>;
  /** B-739: start a repeating timer; returns a stop function. Injected so the loop stays
   *  fake-clock testable (the B-532 pattern) — never call global setInterval in this module. */
  startInterval(ms: number, fn: () => void): () => void;
  /** B-739: start a one-shot timer; returns a cancel function. Same dependency-injection rule. */
  startTimeout(ms: number, fn: () => void): () => void;
  /** Run a rendered launch/reap/probe command to completion; the daemon consumes ONLY the exit
   *  code (never stdout — the agent-portability guardrail). `opts.quiet` (B-761) is set ONLY at
   *  the reap-before-adopt call site in `handleWonTakeover`: the routine "container already gone"
   *  case there must render calmly rather than as raw Docker stderr — see the real implementation
   *  (src/bin/daemon.ts) for the quiet rendering itself; this module only decides WHERE to ask
   *  for it. */
  runCommand(cmd: string, opts?: { quiet?: boolean }): Promise<{ exitCode: number | null }>;
  /** B-792: a LIVE `git ls-remote <ref>` head-SHA probe — narrow, structured-output read, distinct
   *  from `runCommand`'s exit-code-only discipline (this reads one CLI's stdout, never the LLM
   *  worker's — the agent-portability guardrail is unaffected). Returns null when the ref cannot be
   *  resolved (not found, no repo configured, any error) — NEVER throws; this is best-effort
   *  repo-progress detection and must never crash the daemon. The real implementation
   *  (src/bin/daemon.ts) tries every configured repo in `deploymentConfig.repos` and returns the
   *  first non-empty SHA found. */
  probeRef(ref: string): Promise<string | null>;
  log(line: string): void;
  leaseHolder: string;
  config: DaemonConfig;
  /** B-723: the deployment's project key, pinned once at daemon launch — visual IDs are composed
   *  from config, never a baked constant (the per-deployment-config architecture entry). */
  projectKey: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

// B-771: per-conduction "have I already logged this exclusion state" memory, keyed by the SAME
// `state` baseline map instance runSchedulerPass already receives — so a fresh state map (daemon
// restart, or a fresh test map) gets fresh, empty exclusion memory automatically, with no extra
// plumbing. This is in-memory/per-process by design (no new DB column): a daemon restart
// re-observing an already-excluded conduction and logging it once more is acceptable (B-771 AC).
const exclusionMemory = new WeakMap<Map<string, WatchBaseline>, Set<string>>();

function exclusionSetFor(state: Map<string, WatchBaseline>): Set<string> {
  let set = exclusionMemory.get(state);
  if (!set) {
    set = new Set<string>();
    exclusionMemory.set(state, set);
  }
  return set;
}

// B-761: per-daemon memory of the mid-leg foreign rows currently waiting out a dead lease's stale
// window — the SAME WeakMap-keyed-on-`state` lifecycle as exclusionMemory above (a fresh state map,
// e.g. a daemon restart, gets fresh, empty waiting memory automatically). A mid-leg row
// (leg_started_at non-null) is never steal-eligible (see handleForeignConduction), so the
// stale-window takeoverConduction CAS is the ONLY path that can ever free it — this is the one case
// B-761 still costs real wall-clock time for, even after the clean-shutdown fast path. Rebuilt FRESH
// every pass from that pass's own observations (never incremental), so a row that resolves (fires,
// gets adopted, leaves the active set) simply does not reappear next time — no separate pruning
// needed, unlike exclusionMemory/excluded which persist across many passes.
const waitingMemory = new WeakMap<Map<string, WatchBaseline>, Map<string, number>>();

function waitingMapFor(state: Map<string, WatchBaseline>): Map<string, number> {
  let map = waitingMemory.get(state);
  if (!map) {
    map = new Map<string, number>();
    waitingMemory.set(state, map);
  }
  return map;
}

function sameWaitingMembership(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a.keys()) if (!b.has(id)) return false;
  return true;
}

/** B-771 log-once discipline: log ONE line when the waiting set transitions (empty → non-empty, or
 *  its membership changes) — never per pass, and never again while the same set of ids persists.
 *  B-761 reopen fix: the waiting set this is fed used to be mid-leg-only, so the line's old
 *  "(mid-leg — no fast steal available)" parenthetical was accurate; now that
 *  handleForeignConduction tracks EVERY row whose takeover CAS lost (idle rows included), that
 *  qualifier no longer holds universally, so it is dropped — the line covers the whole dead window
 *  regardless of leg state. */
function announceWaiting(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  waitingCandidates: Array<{ id: string; adoptAt: number }>,
): void {
  const previous = waitingMapFor(state);
  const next = new Map(waitingCandidates.map((w) => [w.id, w.adoptAt] as const));
  if (!sameWaitingMembership(previous, next)) {
    if (next.size > 0) {
      const earliestAdoptAt = Math.min(...next.values());
      deps.log(
        `${next.size} conduction${next.size === 1 ? '' : 's'} waiting out a dead lease's stale ` +
          `window — earliest adoption at ${iso(earliestAdoptAt)}`,
      );
    } else {
      deps.log('no conductions waiting on a dead lease stale window anymore');
    }
  }
  waitingMemory.set(state, next);
}

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
 *  REAP_ATTEMPT_LIMIT attempts, so that ONE tracked launch is still stuck with its deadline already
 *  spent. The entrypoint catches it and exits non-zero — a daemon that cannot leave a state must
 *  not keep advertising liveness from inside it (the same "restart over zombie" logic as
 *  PersistentAuthFailure). Restart hands recovery back to machinery that already exists: the new
 *  instance has a fresh lease holder id, the dead process's heartbeat has stopped, so the lease
 *  goes stale on schedule and the restarted daemon wins its own CAS takeover — whose first action
 *  is reconciliation-then-REAP-THEN-FIRE.
 *
 *  B-717: this now escapes isolation via `SchedulerRuntime.fatal` (checked at the top of every
 *  pass), not a synchronous re-thrown await — the deadline/reap escalation that discovers it is a
 *  DETACHED background chain under fire-and-track, since nothing awaits a tracked launch's lifetime
 *  anymore. Swallowing it would convert "I cannot free myself" into a skipped row, which is
 *  precisely the zombie this class exists to prevent. */
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

/** B-718: JSON.stringify the conduction row's run_config for embedding in a SINGLE-QUOTED shell
 *  template literal (see container/daemon-profile.example.json / .cloud.example.json — both wrap
 *  {run_config_json} in literal `'...'` quotes at the template call site, matching the hardcoded
 *  `'{}'` they replace). v1's RunConfigSchema is boolean/object-only (session_resume.enabled), so
 *  its JSON.stringify output can never contain a raw single quote in practice — this guard throws
 *  LOUDLY rather than silently mis-quoting the shell command if that ever stops being true (e.g. a
 *  future run_config key carrying a free-text string with an apostrophe). */
function runConfigJsonFor(row: ConductionRecord): string {
  const json = JSON.stringify(row.run_config ?? {});
  if (json.includes("'")) {
    throw new Error(
      `conduction ${row.id}: run_config JSON contains a single quote, which is not safe to embed ` +
        'in the single-quoted shell template literal every launch profile uses for ' +
        '{run_config_json} — v1 run_config values must be boolean/object only, no free-text strings',
    );
  }
  return json;
}

function templateVars(
  row: ConductionRecord,
  task: DaemonTask | null,
  projectKey: string,
): { conduction_id: string; ticket: string; run_config_json: string } {
  // B-827: {ticket} now carries the ticket's VISUAL id (project key + task_number), never the row
  // UUID — everything downstream (the worker prompt, host-side RUN_DIR paths, and, since B-788, the
  // persisted cloud transcript path) must name the ticket the same way B-723's log lines already
  // do. resolveVisualId degrades to the raw task_id when `task` is unavailable (a best-effort
  // metadata read failed, or a reconciled re-attach has no snapshot yet) — a template substitution
  // must never be able to block a launch/reap/probe.
  return {
    conduction_id: row.id,
    ticket: resolveVisualId(task, projectKey, row.task_id),
    // B-718: always computed (harmless when the active template's reap/probe strings don't
    // reference {run_config_json} — renderTemplate only substitutes placeholders actually present).
    run_config_json: runConfigJsonFor(row),
  };
}

/** B-723: how much of a ticket title a log line carries — enough to recognize the ticket, short
 *  enough that the line stays scannable. */
const TITLE_MAX = 48;

function truncateTitle(title: string, max = TITLE_MAX): string {
  // A single ellipsis CHARACTER (U+2026), not three dots — one glyph keeps the budget honest.
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

/** B-723: the human-facing line prefix for a per-leg log line. The ticket LEADS (that is what an
 *  operator scans for); the FULL conduction id follows in parentheses — never shortened, because a
 *  line must stay matchable to its worker container (harmony-worker-<id>) and its transcript
 *  directory. Degrades to the bare conduction form when ticket identity is unavailable: a logging
 *  path must not be able to break the loop it reports on. */
function label(row: ConductionRecord, task: DaemonTask | null, projectKey: string): string {
  const number = task?.task_number;
  const title = task?.title;
  if (typeof number !== 'number' || typeof title !== 'string' || title === '') {
    return `conduction ${row.id}`;
  }
  return `${projectKey}-${number} "${truncateTitle(title)}" (conduction ${row.id})`;
}

/** B-827: resolve a ticket's visual id (project key + task_number) — the same composition label()
 *  builds above, reused for {ticket} template substitution itself (see templateVars). Degrades to
 *  `fallback` (the row's raw task_id) when the task/task_number is unavailable. */
function resolveVisualId(task: DaemonTask | null, projectKey: string, fallback: string): string {
  const number = task?.task_number;
  return typeof number === 'number' ? `${projectKey}-${number}` : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-792: the repo-progress probe — a LIVE head-SHA read of the leg's known work branch, bracketing
// fire and settle, independent of whatever `field_values` says (the B-758 rebase-push blind spot:
// a rebase-push moves the PR head without re-recording `build_pr.head_sha`).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Resolve the leg's known work-branch ref from a ticket's `field_values` — `build_pr.branch` when
 *  present (a PR exists), else `work_branch.branch` (start-work's pre-PR record, item 2). Returns
 *  null when neither is a non-empty string — the probe is skipped entirely in that case. */
function resolveWorkRef(task: DaemonTask): string | null {
  const fv = task.field_values as Record<string, unknown> | null | undefined;
  const buildPr = fv?.['build_pr'] as { branch?: unknown } | null | undefined;
  if (typeof buildPr?.branch === 'string' && buildPr.branch.length > 0) return buildPr.branch;
  const workBranch = fv?.['work_branch'] as { branch?: unknown } | null | undefined;
  if (typeof workBranch?.branch === 'string' && workBranch.branch.length > 0) return workBranch.branch;
  return null;
}

/** Probe a ref, NEVER throwing — a probe failure degrades to null (treated as "no signal", never as
 *  progress) exactly like `deps.probeRef` itself is documented to. Defensive on top of that contract
 *  so a deps implementation that does throw can't take down a pass. */
async function safeProbeRef(deps: SchedulerDeps, ref: string): Promise<string | null> {
  try {
    const sha = await deps.probeRef(ref);
    return typeof sha === 'string' && sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-717: fire-and-track state — ready/running maps + the priority-aging queue-discipline math.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ReadyEntry {
  /** When this row became ready — the oldest-ready-first tiebreak AND the aging-escalation clock. */
  since: number;
  /** The task's `priority` ('high'/'medium'/'low') captured when the row became ready — a fresh
   *  read purely for ranking; a slightly stale priority is an acceptable tradeoff against re-reading
   *  every queued row's ticket every single pass just to sort it. */
  priority: string | null;
  /** Set only for a B-713 dirty-exit retry waiting out its backoff: the row occupies a ready slot
   *  but is not ELIGIBLE to fire until `now() >= notBefore`, even with a free running slot. */
  notBefore?: number;
  /** The durable retry_count this attempt would bump FROM — carried across the ready detour so a
   *  retried re-fire never inherits a stale count (mirrors the old inline loop's own `retryCount`). */
  retryCount: number;
}

export interface TrackedLaunch {
  /** The pre-fire ticket read `ClassifyArgs.progressed` compares the post-exit read against.
   *  Captured AT FIRE TIME (not when the row entered `ready`) — a row that queued for several
   *  passes must compare against what the ticket looked like right before ITS launch, matching the
   *  old inline code's `current` variable, not a stale ready-time snapshot. */
  current: DaemonTask;
  /** The durable retry_count this launch is attempt number `retryCount + 1` of. */
  retryCount: number;
  /** B-739: did THIS daemon's own deadline rule this launch overrun and reap it? */
  timedOut: boolean;
  /** Flips true once a genuine settlement signal is available — see settleTrackedLaunch. */
  settled: boolean;
  /** null = unknown/reaped/reconciled-with-no-real-signal — classify.ts already treats a null exit
   *  code as dirty-exit, same fallback the cloud wrapper's own ambiguous-completion branch uses. */
  exitCode: number | null;
  /** Cancel this launch's own per-launch deadline timer (B-739, unchanged mechanism — only the
   *  anchor moved: one deadline per TRACKED CHILD, started at fire, not one per scheduler pass). */
  cancelDeadline: () => void;
  /** True for a re-attached (restart-reconciliation) launch this daemon did not itself fire —
   *  settlement is discovered by re-probing each pass (see handleConduction) rather than a local
   *  `runCommand(launch)` promise settling. Cosmetic beyond that: classification is identical. */
  reconciled: boolean;
  /** B-792: the leg's known work-branch head SHA, probed ONCE at fire time (see fireLaunch /
   *  resolveWorkRef) — null when no `build_pr.branch`/`work_branch.branch` was resolvable, or the
   *  probe found nothing. Compared against a fresh settle-time probe of the SAME ref resolution
   *  (settleTrackedLaunch) to compute `repoProgressed` — a LIVE repo-progress signal, independent of
   *  whatever `field_values` says (the B-758 rebase-push blind spot). */
  preFireHeadSha: string | null;
}

export interface SchedulerRuntime {
  ready: Map<string, ReadyEntry>;
  running: Map<string, TrackedLaunch>;
  /** Set by a DETACHED (fire-and-forget) deadline/reap escalation that must escape both
   *  per-conduction and per-pass error isolation — see PersistentReapFailure's class doc. Every
   *  pass checks this FIRST, before touching a single row. */
  fatal: Error | null;
}

export function createSchedulerRuntime(): SchedulerRuntime {
  return { ready: new Map(), running: new Map(), fatal: null };
}

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
const MAX_PRIORITY_RANK = PRIORITY_RANK.high;

/** B-717 item 2: rank a ready candidate for firing order — its own priority tier, promoted ONE
 *  tier (capped at 'high') once it has waited at least `readyAgeMs`. An unrecognized/absent
 *  priority reads as 'medium' — the same default `create_task` itself applies. */
function agedPriorityRank(entry: ReadyEntry, now: number, readyAgeMs: number): number {
  const base = PRIORITY_RANK[entry.priority ?? 'medium'] ?? PRIORITY_RANK.medium;
  const waitedLongEnough = now - entry.since >= readyAgeMs;
  return Math.min(waitedLongEnough ? base + 1 : base, MAX_PRIORITY_RANK);
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
  runtime: SchedulerRuntime,
): Promise<PassSummary> {
  // B-717: a fatal parked by a PRIOR pass's detached escalation must escape before this pass
  // touches a single row — see SchedulerRuntime.fatal / PersistentReapFailure.
  if (runtime.fatal) throw runtime.fatal;

  const rows = await deps.listConductions({ status: 'active' });

  // Prune baselines, heartbeat timers, AND the fire-and-track maps for conductions that left the
  // active set (completed/parked elsewhere) — all four live on the same lifecycle.
  const activeIds = new Set(rows.map((r) => r.id));
  for (const id of [...state.keys()]) if (!activeIds.has(id)) state.delete(id);
  const excluded = exclusionSetFor(state);
  for (const id of [...excluded]) if (!activeIds.has(id)) excluded.delete(id);
  keeper.retain(activeIds);
  for (const id of [...runtime.ready.keys()]) if (!activeIds.has(id)) runtime.ready.delete(id);
  for (const id of [...runtime.running.keys()]) if (!activeIds.has(id)) runtime.running.delete(id);

  let authShapedFailures = 0;
  const stealCandidates: StealCandidate[] = [];
  // B-761: rows whose takeover CAS lost AND which are mid-leg (not steal-eligible) — rebuilt fresh
  // every pass and handed to announceWaiting below. See waitingMemory's own doc for why fresh
  // rebuild needs no separate pruning.
  const waitingCandidates: Array<{ id: string; adoptAt: number }> = [];
  for (const row of rows) {
    try {
      // B-717: a row this daemon was tracking as `running` whose FRESH read now shows a different
      // lease holder means a peer stole/took over the lease while the launch was in flight — the
      // old blocking code discovered this synchronously inside the same await chain; under
      // fire-and-track that chain spans many passes, so it must be discovered here instead, by
      // simply no longer routing this row through the (a) settlement-check branch at all (its own
      // guarded writes would no-op anyway — see writeIfHeld — this just avoids tracking a launch
      // this daemon can no longer act on).
      const tracked = runtime.running.get(row.id);
      if (tracked && row.lease_holder !== deps.leaseHolder) {
        runtime.running.delete(row.id);
        deps.log(
          `conduction ${row.id}: lease lost to another daemon while a launch was tracked — ` +
            `abandoning (no clobber)`,
        );
      }
      await handleConduction(deps, state, keeper, excluded, runtime, row, stealCandidates, waitingCandidates);
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

  // B-717 item 2: the fire phase — a SEPARATE, once-per-pass step (not fused into the per-row loop
  // above) because ranking the ready set by priority requires seeing the WHOLE set at once; the
  // per-row loop's iteration order is `listConductions`'s started_at-ascending, not priority order.
  // This daemon's OWN ready backlog fires FIRST — steal candidates (item 3) only ever get to use
  // whatever capacity is genuinely LEFTOVER afterward (an "idle daemon steals ready work" — never
  // ahead of its own queue), which is also what keeps the fire order independent of `rows`'
  // interleaving of local and foreign conductions.
  const byId = new Map(rows.map((r) => [r.id, r]));
  authShapedFailures += await fireReadyCandidates(deps, state, keeper, runtime, byId);
  authShapedFailures += await fireStealCandidates(deps, state, keeper, runtime, stealCandidates);

  // B-761: announce the mid-leg wait ONCE per transition, not per pass — see announceWaiting.
  announceWaiting(deps, state, waitingCandidates);

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
  excluded: Set<string>,
  runtime: SchedulerRuntime,
  row: ConductionRecord,
  stealCandidates: StealCandidate[],
  waitingCandidates: Array<{ id: string; adoptAt: number }>,
): Promise<void> {
  if (row.lease_holder !== deps.leaseHolder) {
    await handleForeignConduction(deps, state, keeper, excluded, runtime, row, stealCandidates, waitingCandidates);
    return;
  }
  await handleHeldConduction(deps, state, keeper, excluded, runtime, row);
}

/** The full per-pass handling for a row THIS daemon currently holds the lease for — states
 *  (a)/(b)/(c) of the module header. Shared by the normal per-row dispatch AND by a takeover win's
 *  fallthrough (today's pre-B-717 code fell through to this exact continuation, unconditionally,
 *  right after claiming a lease — B-717 preserves that ordering; see handleForeignConduction). */
async function handleHeldConduction(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  excluded: Set<string>,
  runtime: SchedulerRuntime,
  row: ConductionRecord,
): Promise<void> {
  // ── (a) a launch is tracked for this row ─────────────────────────────────────────────────────
  const tracked = runtime.running.get(row.id);
  if (tracked) {
    if (tracked.reconciled && !tracked.settled) {
      // B-717 restart reconciliation: this daemon did not fire this launch itself, so there is no
      // local runCommand(launch) promise to settle — re-probe the SAME tracking surface each pass.
      const probed = await deps.runCommand(
        renderTemplate(deps.config.profile.probe as string, templateVars(row, tracked.current, deps.projectKey)),
      );
      if (probed.exitCode !== 0) {
        tracked.settled = true;
        tracked.exitCode = null; // no real exit signal survives a re-attach; classify.ts treats a
        // null exit code as dirty-exit — the same fallback the cloud wrapper's own
        // ambiguous-completion branch already uses.
      }
    }
    if (!tracked.settled) return; // do nothing this pass — the HeartbeatKeeper ticks independently.
    await settleTrackedLaunch(deps, state, keeper, runtime, row, tracked);
    return;
  }

  // ── Heartbeat: B-739 — an IMMEDIATE stamp, then hand this lease to the keeper. ──────────────────
  if (!(await writeIfHeld(deps, state, keeper, row, { last_heartbeat_at: iso(deps.now()) }))) return;
  keeper.ensure(row.id);

  // ── (c) already ready, waiting its turn — the separate fire phase decides when. ─────────────────
  if (runtime.ready.has(row.id)) return;

  // ── (b) neither tracked nor ready — today's watch logic, unchanged, except a wake QUEUES rather
  //        than fires. ─────────────────────────────────────────────────────────────────────────────
  const current = await deps.getTaskMeta(row.task_id);
  const baseline = state.get(row.id);
  if (!baseline) {
    state.set(row.id, captureBaseline(current));
    return;
  }
  const wake = detectWake(baseline, current);
  if (wake === null) {
    // B-691: ROLL the baseline on a no-wake pass — see watch.ts's own header for the defect class
    // this prevents.
    state.set(row.id, captureBaseline(current));
    return;
  }

  // B-756: a human took this ticket away from the conductor via the web UI — do not queue the next
  // leg. ROLL the baseline for the same B-691 reason as the no-wake branch.
  if (current.conductor_excluded_at) {
    if (!excluded.has(row.id)) {
      deps.log(
        `${label(row, current, deps.projectKey)}: taken away from conductor (conductor_excluded_at set) — skipping fire`,
      );
      excluded.add(row.id);
    }
    state.set(row.id, captureBaseline(current));
    return;
  }
  if (excluded.delete(row.id)) {
    deps.log(
      `${label(row, current, deps.projectKey)}: returned to conductor (conductor_excluded_at cleared)`,
    );
  }

  // B-717 item 1: QUEUE rather than fire — the fire phase (fireReadyCandidates) decides WHEN,
  // ranked by tasks.priority + aging across the whole ready set (item 2).
  deps.log(`${label(row, current, deps.projectKey)}: wake (${wake}) — queued`);
  runtime.ready.set(row.id, {
    since: deps.now(),
    priority: row.task_priority ?? null,
    retryCount: row.retry_count,
  });
}

/** A steal-eligible foreign row found by handleForeignConduction: the takeover CAS lost (holder
 *  alive), but a fresh read+wake computation shows it would be ready with no worker executing
 *  anywhere (leg_started_at IS NULL). The actual steal CAS + fire is deferred to
 *  fireStealCandidates, run AFTER this daemon's own ready backlog has already claimed its own free
 *  slots — see that function's header for why. */
interface StealCandidate {
  row: ConductionRecord;
  current: DaemonTask;
}

/** A row this daemon does NOT hold: attempt the stale-lease takeover; on a win, fall through to
 *  the SAME held-row continuation `handleHeldConduction` runs for an already-held row (today's
 *  pre-B-717 code did this unconditionally, in one function, right after claiming — B-717
 *  preserves that ordering exactly, via `handleWonTakeover`'s boolean return). On a loss (the
 *  holder is alive), evaluate B-717 item 3's STEAL eligibility and hand any eligible candidate to
 *  the caller — see StealCandidate's own doc for why the actual steal is deferred. */
async function handleForeignConduction(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  excluded: Set<string>,
  runtime: SchedulerRuntime,
  row: ConductionRecord,
  stealCandidates: StealCandidate[],
  waitingCandidates: Array<{ id: string; adoptAt: number }>,
): Promise<void> {
  const won = await deps.takeoverConduction({
    id: row.id,
    observed_lease_holder: row.lease_holder,
    // B-651 guard: the stale window originates from now() AT PASS TIME, never a stored stamp.
    stale_before: iso(deps.now() - deps.config.staleMs),
    new_lease_holder: deps.leaseHolder,
  });
  if (won !== null) {
    const fallThrough = await handleWonTakeover(deps, state, keeper, runtime, row, won);
    // On a win, fall through to the SAME held-row continuation as an already-held row would get
    // this same pass (today's pre-B-717 code did this unconditionally) — the caller's own
    // `excluded` set is reused so B-771's log-once bookkeeping stays correct across a takeover.
    if (fallThrough) await handleHeldConduction(deps, state, keeper, excluded, runtime, won);
    return;
  }

  // B-761 reopen fix (AC-3): record EVERY row whose takeover CAS just lost for this pass's wait
  // summary (announceWaiting, called once after every row is triaged) — regardless of leg state.
  // This used to be gated on `row.leg_started_at !== null` (mid-leg only), because the mid-leg case
  // is the only one costing real throughput (it is never steal-eligible — see the check below — so
  // the stale-window CAS is its sole path to adoption). But a live production verify run found real
  // dead windows over IDLE rows too (ball-with-human, leg_started_at null, nothing running): an
  // operator watching the log during one of those windows saw NOTHING for 4+ minutes and could not
  // tell "waiting on a stale lease" apart from "no work exists" — exactly the operator-legibility
  // gap this AC exists to close, and it applies for the WHOLE dead window, not just the throughput-
  // costing mid-leg sub-case. We cannot tell here whether the holder is genuinely dead (will
  // eventually go stale) or genuinely alive (never will); the daemon has no cheaper signal than
  // that, and the log is informational either way.
  waitingCandidates.push({
    id: row.id,
    adoptAt:
      (row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : deps.now()) + deps.config.staleMs,
  });

  // ── B-717 item 3: the holder is alive — the takeover lost, so consider a STEAL candidate instead
  //    of giving up. Eligibility only; the actual CAS + fire happens later, against whatever
  //    capacity is genuinely LEFTOVER after this daemon's own ready work fires (fireStealCandidates
  //    / StealCandidate doc). ──────────────────────────────────────────────────────────────────────
  let current: DaemonTask;
  try {
    current = await deps.getTaskMeta(row.task_id);
  } catch {
    return; // a foreign read failure is not this daemon's row to report — stay quiet, retry later.
  }
  const baseline = state.get(row.id);
  const wake = baseline ? detectWake(baseline, current) : null; // no baseline yet ⇒ first sight only
  // B-691: roll the baseline for foreign rows exactly like local ones — the same starvation class
  // applies regardless of who currently holds the lease.
  state.set(row.id, captureBaseline(current));

  if (wake === null) return;
  if (current.conductor_excluded_at) return; // never steal a ticket a human took away from the conductor
  // The steal precondition is safe BY CONSTRUCTION only because leg_started_at now clears ONLY at
  // tracked-settlement classification (see this module's header) — non-null here would mean a
  // worker might genuinely still be running, on some daemon, right now.
  if (row.leg_started_at !== null) return;

  stealCandidates.push({ row, current });
}

/** Returns true when the caller should fall through to `handleHeldConduction` THIS SAME pass
 *  (first-claim, or a completed reap-then-clear — today's pre-B-717 code always fell through
 *  after a takeover win); false when this function already fully handled the row itself
 *  (a reconciled re-attach, or a lease lost mid-handling). */
async function handleWonTakeover(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  runtime: SchedulerRuntime,
  row: ConductionRecord,
  won: ConductionRecord,
): Promise<boolean> {
  state.delete(row.id); // fresh read — the claim starts with no baseline.
  if (row.lease_holder === null) {
    // B-696 first-claim polish: a never-held conduction has no dead holder and no worker to
    // reap — running the reap template would target a container that never existed.
    deps.log(`conduction ${row.id}: first claim of a never-held conduction`);
    return true;
  }

  // ── B-717 restart reconciliation ─────────────────────────────────────────────────────────────
  // A row with a non-null leg_started_at may still have a genuinely live worker: this daemon's OWN
  // prior process restarting, or a peer that died mid-leg. REAP-THEN-FIRE on that worker would
  // launch a SECOND one alongside it — RE-ATTACH, never re-fire. Runs ONCE, right here, on the
  // newly-won lease (never every pass).
  if (won.leg_started_at !== null && deps.config.profile.probe) {
    // B-827: best-effort pre-probe snapshot so the rendered probe command's {ticket} names the
    // ticket's visual id, not the row UUID — a metadata read failure must not block the probe
    // itself (templateVars falls back to the raw task_id when the task is unavailable).
    let probeTask: DaemonTask | null = null;
    try {
      probeTask = await deps.getTaskMeta(row.task_id);
    } catch {
      // best-effort — see above.
    }
    const probed = await deps.runCommand(
      renderTemplate(deps.config.profile.probe, templateVars(row, probeTask, deps.projectKey)),
    );
    if (probed.exitCode === 0) {
      let current: DaemonTask;
      try {
        current = await deps.getTaskMeta(row.task_id);
      } catch {
        // Best-effort pre-fire snapshot; classify degrades safely on a missing awaiting-flag (a
        // reconciled launch's eventual settlement already falls back to a null exit code).
        current = {} as DaemonTask;
      }
      // B-717: a reconciled lease does NOT fall through to handleHeldConduction this pass (there is
      // nothing more to do — it is already tracked as running), so it needs its OWN immediate
      // heartbeat stamp + keeper here — handleHeldConduction's running-branch deliberately skips
      // the per-pass heartbeat write for a tracked-but-unsettled row (see the module header); this
      // is the only stamp a reconciled lease gets before the keeper's own cadence takes over.
      if (!(await writeIfHeld(deps, state, keeper, row, { last_heartbeat_at: iso(deps.now()) }))) {
        return false;
      }
      keeper.ensure(row.id);
      deps.log(
        `${label(row, current, deps.projectKey)}: reconciled — re-attached to a still-running ` +
          `worker (no reap, no re-fire)`,
      );
      runtime.running.set(row.id, {
        current,
        retryCount: row.retry_count,
        timedOut: false,
        settled: false,
        exitCode: null,
        cancelDeadline: () => {},
        reconciled: true,
        // B-792: no real fire happened on THIS daemon for a reconciled re-attach — there is no
        // genuine fire-time probe to anchor against, so repoProgressed reads false at this launch's
        // eventual settlement (conservative: never a false positive from an un-anchored comparison).
        preFireHeadSha: null,
      });
      return false;
    }
    deps.log(
      `${label(row, null, deps.projectKey)}: reconciliation probe found no live worker — ` +
        `reaping defensively and clearing the stale leg`,
    );
  }

  // No leg was in flight, or reconciliation found nothing live: today's REAP-THEN-FIRE. The dead
  // holder may have left a worker running; remove it BEFORE this daemon ever fires one. B-761:
  // this is the ROUTINE case — the dead holder usually left NOTHING to reap, so quiet=true here
  // (and ONLY here — the dirty-exit retry reap and the deadline-escalation reap stay verbose,
  // since those ARE genuinely operationally interesting).
  // B-827: best-effort pre-reap snapshot — same degrade rationale as the reconciliation probe
  // fetch above (a metadata read failure must not block this reap).
  let reapTask: DaemonTask | null = null;
  try {
    reapTask = await deps.getTaskMeta(row.task_id);
  } catch {
    // best-effort — see above.
  }
  await deps.runCommand(
    renderTemplate(deps.config.profile.reap, templateVars(row, reapTask, deps.projectKey)),
    { quiet: true },
  );
  // B-742/B-717 point 4 (corrected): this clear is reached ONLY for a row with NO tracked in-flight
  // worker on THIS daemon — `running` cannot already hold this id (we just won the takeover, and
  // `running` only ever holds rows this daemon currently holds the lease for), and reconciliation
  // above has already re-attached (and returned) the one case that could otherwise collide.
  if (!(await writeIfHeld(deps, state, keeper, row, { leg_started_at: null }))) return false;
  // B-761 reopen fix (legibility): distinguish a marker-driven adoption (instant, via the clean-
  // shutdown marker) from a genuine staleness-window adoption (waited out the full window) — the
  // PRE-takeover `row` (not `won`, whose CAS write always clears clean_shutdown_at back to null as
  // part of the same UPDATE — see takeoverConduction) is the only place left to read whether the
  // marker was set going in. Without this, a human reading the log needs timestamp arithmetic to
  // tell the two cases apart.
  if (row.clean_shutdown_at !== null) {
    deps.log(`conduction ${row.id}: adopted cleanly-released lease from ${row.lease_holder}`);
  } else {
    deps.log(`conduction ${row.id}: took over stale lease from ${row.lease_holder} — reaped`);
  }
  return true;
}

/** (a) settled: run the unchanged post-exit classify/write logic and drop the row from `running`.
 *  A B-713 dirty-exit retry within cap re-queues into `ready` (gated by `notBefore`) instead of
 *  blocking the pass on `deps.sleep` — see the module header. */
async function settleTrackedLaunch(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  runtime: SchedulerRuntime,
  row: ConductionRecord,
  tracked: TrackedLaunch,
): Promise<void> {
  runtime.running.delete(row.id);
  tracked.cancelDeadline();

  // B-742: the launch has settled — clear immediately, regardless of how it ended. A later
  // park/complete/retry write (below) is a SEPARATE patch; do not fold this into it.
  if (!(await writeIfHeld(deps, state, keeper, row, { leg_started_at: null }))) return;

  const after = await deps.getTaskMeta(row.task_id);
  const nonArchivedChildCount =
    after.workflow_state === 'Decomposed' ? await deps.countNonArchivedChildren(row.task_id) : 0;

  // B-792: widen `progressed` to see BOARD-progress beyond the two original fields — an in-place
  // brief iterate (active_brief_iteration bump), a newly-recorded/referenced knowledge decision
  // (knowledge_reference_count bump), or a marker present at launch being CONSUMED by settle time
  // (pending_resolution cleared, or the active exchange going non-active — exchangeWentInactive is
  // the SAME B-691 predicate the watch itself uses for "went inactive", reused here rather than
  // reimplemented). None of these touch workflow_state/awaiting_human_input, so the pre-B-792
  // formula alone would misclassify a leg that did real board work as a no-op spin.
  const pendingResolutionConsumed =
    (tracked.current.pending_resolution ?? null) !== null && (after.pending_resolution ?? null) === null;
  const progressed =
    (after.workflow_state ?? null) !== (tracked.current.workflow_state ?? null) ||
    (after.awaiting_human_input ?? null) !== (tracked.current.awaiting_human_input ?? null) ||
    (after.active_brief_iteration ?? null) !== (tracked.current.active_brief_iteration ?? null) ||
    (after.knowledge_reference_count ?? 0) !== (tracked.current.knowledge_reference_count ?? 0) ||
    pendingResolutionConsumed ||
    exchangeWentInactive(tracked.current, after);

  // B-792: repo-progress — a LIVE head-SHA probe of the SAME ref resolution, off the POST-EXIT read
  // (`after.field_values`), bracketing the fire-time probe (tracked.preFireHeadSha). A probe
  // failure/absence on EITHER side reads as "no signal", never as progress — this is exactly the
  // B-758 specimen's blind spot: a rebase-push moves the PR head without re-recording
  // `build_pr.head_sha`, so `progressed` alone (a board-field read) cannot see it.
  const settleRef = resolveWorkRef(after);
  const settleHeadSha = settleRef ? await safeProbeRef(deps, settleRef) : null;
  const repoProgressed =
    tracked.preFireHeadSha !== null && settleHeadSha !== null && tracked.preFireHeadSha !== settleHeadSha;

  const classifyArgs: ClassifyArgs = {
    row: after,
    nonArchivedChildCount,
    exitCode: tracked.exitCode,
    progressed,
    timedOut: tracked.timedOut,
    repoProgressed,
  };
  const outcome = classifyWorkerExit(classifyArgs);
  const cls = exitClass(outcome, classifyArgs);
  deps.log(
    `${label(row, after, deps.projectKey)}: worker exit code=${tracked.exitCode ?? 'null'} → ` +
      `${outcome.action} (${cls})`,
  );

  if (outcome.action === 'wait') {
    state.set(row.id, captureBaseline(after));
    return;
  }

  // A 'worker-timeout' park never reaches the retry branch: its class is not 'dirty-exit', so the
  // ladder is bypassed by construction and the run parks on the first occurrence (B-739).
  if (outcome.action === 'park' && cls === 'dirty-exit' && tracked.retryCount < deps.config.retryCap) {
    const retryCount = tracked.retryCount + 1;
    if (!(await writeIfHeld(deps, state, keeper, row, { retry_count: retryCount }))) return;
    // B-717 item 4: EXPONENTIAL backoff (was a flat deps.config.retryBackoffMs) — a flat delay lets
    // N concurrently-dirty-exiting conductions pile every retry back onto a rate limit at the same
    // instant; the base config knob is unchanged, no new env var.
    const backoffMs = deps.config.retryBackoffMs * 2 ** (retryCount - 1);
    deps.log(
      `${label(row, after, deps.projectKey)}: dirty exit — retrying ` +
        `(attempt ${retryCount}/${deps.config.retryCap}) after reap + ${backoffMs}ms backoff`,
    );
    await deps.runCommand(renderTemplate(deps.config.profile.reap, templateVars(row, after, deps.projectKey)));
    // B-717: no synchronous deps.sleep here — a blocked pass is exactly what fire-and-track
    // removes. Queue the retry as a ready candidate gated by `notBefore` so every OTHER row keeps
    // getting served while this one backs off.
    runtime.ready.set(row.id, {
      since: deps.now(),
      priority: row.task_priority ?? null,
      notBefore: deps.now() + backoffMs,
      retryCount,
    });
    return;
  }

  // Park (retry cap exhausted, or a non-dirty-exit park reason) / complete: one terminal status
  // write, exactly as before B-713/B-717.
  state.delete(row.id);
  keeper.stop(row.id);
  await writeIfHeld(deps, state, keeper, row, {
    status: outcome.action === 'complete' ? 'completed' : 'parked',
    last_worker_exit_code: tracked.exitCode,
    last_worker_exit_class: cls,
  });
}

/** B-717 item 1/2: fire whatever the free running slots allow, ranked by aged priority (item 2)
 *  across the WHOLE ready set — see runSchedulerPass's call site for why this cannot be fused into
 *  the per-row loop. Returns the number of auth-shaped fire failures (folded into the pass's
 *  authShapedFailures count, same isolation contract as a per-row error). */
async function fireReadyCandidates(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  runtime: SchedulerRuntime,
  byId: Map<string, ConductionRecord>,
): Promise<number> {
  let authShapedFailures = 0;
  const now = deps.now();
  const eligible = [...runtime.ready.entries()].filter(
    ([id, entry]) => (entry.notBefore === undefined || entry.notBefore <= now) && byId.has(id),
  );
  eligible.sort(([, a], [, b]) => {
    const rankDiff = agedPriorityRank(b, now, deps.config.readyAgeMs) - agedPriorityRank(a, now, deps.config.readyAgeMs);
    if (rankDiff !== 0) return rankDiff;
    return a.since - b.since; // oldest-ready-first tiebreak
  });

  for (const [id, entry] of eligible) {
    if (runtime.running.size >= deps.config.maxConcurrentWorkers) break;
    const row = byId.get(id);
    if (!row) continue;
    try {
      await fireLaunch(deps, state, keeper, runtime, row, null, entry.retryCount);
    } catch (err) {
      // B-717: a pre-fire read failure leaves the row OUT of `ready` (see fireLaunch) so the next
      // pass's step (b) re-derives the still-true wake against the UNROLLED baseline and re-queues
      // it — the same per-row error isolation the main loop applies, just for the fire phase.
      if (isAuthShapedError(err)) authShapedFailures += 1;
      deps.log(
        `conduction ${id}: fire error — row skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return authShapedFailures;
}

/** B-717 item 3: fire whatever capacity is LEFTOVER after this daemon's own ready backlog
 *  (fireReadyCandidates) has already claimed its own free slots — an idle daemon steals ready work
 *  from a busy peer, never ahead of its own queue. Each candidate's steal CAS is attempted in
 *  encounter order; a loss just means a later pass may reconsider (no retry within this pass). */
async function fireStealCandidates(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  runtime: SchedulerRuntime,
  candidates: StealCandidate[],
): Promise<number> {
  let authShapedFailures = 0;
  for (const { row, current } of candidates) {
    if (runtime.running.size >= deps.config.maxConcurrentWorkers) break;
    try {
      const stolen = await deps.stealConduction({
        id: row.id,
        observed_lease_holder: row.lease_holder as string,
        new_lease_holder: deps.leaseHolder,
      });
      if (stolen === null) continue; // lost the steal race — a later pass may reconsider.

      deps.log(`${label(row, current, deps.projectKey)}: stole ready work from ${row.lease_holder}`);
      state.delete(row.id);
      keeper.ensure(row.id);
      // On a win, fire IMMEDIATELY in the same pass — skip the cold-start baseline-capture pass,
      // since eligibility (the wake) was already established when this candidate was collected.
      await fireLaunch(deps, state, keeper, runtime, stolen, current, stolen.retry_count);
    } catch (err) {
      if (isAuthShapedError(err)) authShapedFailures += 1;
      deps.log(
        `conduction ${row.id}: steal error — row skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return authShapedFailures;
}

/** Fire ONE launch: read a fresh pre-fire ticket snapshot (unless one was already read — the
 *  steal-win path already established eligibility this same pass, per the module header), stamp
 *  leg_started_at, kick off runCommand WITHOUT awaiting it, and track it in `running`. Arms this
 *  launch's OWN per-launch deadline (B-739 — one per tracked child, anchored at fire, never one per
 *  pass). */
async function fireLaunch(
  deps: SchedulerDeps,
  state: Map<string, WatchBaseline>,
  keeper: HeartbeatKeeper,
  runtime: SchedulerRuntime,
  row: ConductionRecord,
  preReadCurrent: DaemonTask | null,
  retryCount: number,
): Promise<void> {
  const current = preReadCurrent ?? (await deps.getTaskMeta(row.task_id));

  if (!(await writeIfHeld(deps, state, keeper, row, { leg_started_at: iso(deps.now()) }))) {
    runtime.ready.delete(row.id);
    return;
  }
  runtime.ready.delete(row.id);

  deps.log(`${label(row, current, deps.projectKey)}: launching worker`);

  // B-792: probe the leg's known work branch ONCE at fire time — skip entirely (preFireHeadSha:
  // null) when neither build_pr.branch nor work_branch.branch is resolvable yet (e.g. a brand-new
  // ticket's very first leg, before start-work has recorded either).
  const fireRef = resolveWorkRef(current);
  const preFireHeadSha = fireRef ? await safeProbeRef(deps, fireRef) : null;

  const tracked: TrackedLaunch = {
    current,
    retryCount,
    timedOut: false,
    settled: false,
    exitCode: null,
    cancelDeadline: () => {},
    reconciled: false,
    preFireHeadSha,
  };
  runtime.running.set(row.id, tracked);

  // Rejects ONLY when the reap cannot free us; otherwise `launch` always settles first — mirrors
  // the old inline Promise.race exactly, just no longer awaited by the pass itself.
  const launch = deps
    .runCommand(renderTemplate(deps.config.profile.launch, templateVars(row, current, deps.projectKey)))
    .then((result) => {
      tracked.settled = true;
      tracked.exitCode = result.exitCode;
    });

  const cancelDeadline = deps.startTimeout(deps.config.workerTimeoutMs, () => {
    tracked.timedOut = true;
    deps.log(
      `${label(row, current, deps.projectKey)}: worker exceeded ` +
        `${deps.config.workerTimeoutMs}ms — reaping`,
    );
    void (async () => {
      // B-761 reopen fix — CONFIRMED (verified against this exact code, not assumed): this loop
      // does NOT pass `{ quiet: true }` (stays verbose, unlike handleWonTakeover's reap-before-
      // adopt call site) and does NOT consume the reap command's exit code AT ALL — the call below
      // is fired-and-forgotten (`void`), its settled Promise's result never assigned anywhere.
      // Attempt counting / escalation below is driven ENTIRELY by `tracked.settled` (set only by
      // the LAUNCH promise settling, a few lines up). The reap scripts' exit-code semantics change
      // (miss=3 / kill=0 / other=genuine-error, see container/cloud-worker-reap.sh and
      // container/docker-worker-reap.sh) is therefore automatically safe here BY CONSTRUCTION —
      // see scheduler.test.ts's "the deadline-escalation attempt counter is driven purely by
      // tracked.settled" test for a direct EXECUTED proof.
      for (let attempt = 1; attempt <= REAP_ATTEMPT_LIMIT; attempt += 1) {
        // NEVER await the reap: a wedged container runtime can hang the reap command itself, and
        // the call we make to unblock ourselves must not be able to block us.
        void deps.runCommand(renderTemplate(deps.config.profile.reap, templateVars(row, current, deps.projectKey)));
        await new Promise<void>((resolveGrace) => {
          deps.startTimeout(REAP_GRACE_MS, resolveGrace);
        });
        if (tracked.settled) return;
        deps.log(
          `${label(row, current, deps.projectKey)}: reap ${attempt}/${REAP_ATTEMPT_LIMIT} ` +
            `did not free the launch`,
        );
      }
      // B-717: this used to `reject(new PersistentReapFailure(...))` into a Promise.race a pass
      // awaited — nothing awaits a tracked launch's lifetime under fire-and-track anymore, so it
      // must escape via the shared fatal slot instead. See SchedulerRuntime.fatal.
      runtime.fatal = new PersistentReapFailure(row.id);
    })();
  });
  tracked.cancelDeadline = cancelDeadline;
  void launch.finally(cancelDeadline);
}

/** The forever loop: pass; sleep(pollMs). A pass-level failure (e.g. a transient list error) is
 *  logged and the loop keeps going — supervision (launchd) owns process death, not transients.
 *  ONE exception (B-696): AUTH_FAILURE_PASS_LIMIT consecutive auth-shaped-failing passes throw
 *  PersistentAuthFailure — a zombie daemon must die loudly, not heartbeat forever. */
export async function runScheduler(deps: SchedulerDeps, keeper: HeartbeatKeeper): Promise<never> {
  const state = new Map<string, WatchBaseline>();
  const runtime = createSchedulerRuntime();
  let consecutiveAuthFailingPasses = 0;
  for (;;) {
    // A pass counts as auth-failing when the pass ITSELF died auth-shaped (e.g. the list read),
    // or when it attempted ≥1 conduction and EVERY attempt failed auth-shaped. Anything else —
    // a success, an idle pass, a non-auth error, one healthy row — resets the counter.
    let authFailingPass: boolean;
    try {
      const summary = await runSchedulerPass(deps, state, keeper, runtime);
      authFailingPass = summary.attempted > 0 && summary.authShapedFailures === summary.attempted;
    } catch (err) {
      // B-739: a daemon that cannot free itself from a worker it ruled overrun must DIE, not log
      // and loop. Re-throw before the transient handling below can swallow it.
      if (err instanceof PersistentReapFailure) throw err;
      deps.log(`scheduler pass failed: ${formatDaemonError(err)}`);
      authFailingPass = isAuthShapedError(err);
    }
    consecutiveAuthFailingPasses = authFailingPass ? consecutiveAuthFailingPasses + 1 : 0;
    if (consecutiveAuthFailingPasses >= AUTH_FAILURE_PASS_LIMIT) {
      throw new PersistentAuthFailure(consecutiveAuthFailingPasses);
    }
    await deps.sleep(deps.config.pollMs);
  }
}
