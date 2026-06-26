// B-532: the pure, dependency-injected core of the conductor's background watch.
//
// The conductor (skills/harmony-conduct, §4c) launches a bundled background poll script
// (src/bin/poll.ts → dist/bin/poll.js) via Bash(run_in_background) after surfacing a brief at a
// controlled pause. That script reads the ticket via the IN-PROCESS shared core (getTask), captures a
// baseline + an anchored launch stamp, and drives THIS loop. The loop watches one Harmony ticket and
// resolves the instant something the human did becomes visible — or after a bounded ~90-minute window.
//
// This module is deliberately pure: time (`now`), waiting (`sleep`), and the read (`readTask`) are all
// INJECTED, so the whole loop — change detection, the elapsed-anchored window, and the backoff schedule —
// is unit-testable with a fake clock and a fake reader, no real timers or network. The entrypoint
// (src/bin/poll.ts) supplies the real `Date.now`, a real `setTimeout` sleep, and a real `getTask` read.

/** The subset of a Harmony task row the watch cares about (a `getTask` result is structurally assignable). */
export interface Taskish {
  workflow_state?: string | null;
  pending_resolution?: PendingResolutionish | null;
}

/** The browser-submitted reshape marker (`briefs.pending_resolution`); shape mirrors PendingResolution. */
export interface PendingResolutionish {
  command?: string;
  detail?: string | null;
}

/** The state captured at launch, against which every poll is compared. */
export interface PollBaseline {
  workflowState?: string | null;
  pendingResolution?: PendingResolutionish | null;
}

/** Which of the three watched signals fired. Mirrors the §4c consume cases. */
export type ChangeTrigger = 'state-advanced' | 'pending_resolution' | 'parked';

export interface ChangeDetail {
  trigger: ChangeTrigger;
  workflow_state?: string | null;
  pending_resolution?: PendingResolutionish | null;
}

export type PollResult =
  | { reason: 'changed'; detail: ChangeDetail }
  | { reason: 'timeout' };

// ── Cadence / backoff (tunable) ───────────────────────────────────────────────────────────────────
// The total watch window — long enough for the human to step away and resolve from the browser later,
// bounded so an abandoned session doesn't spin forever (§4c: "~90 minutes").
export const WATCH_WINDOW_MS = 90 * 60 * 1000;

// The backoff is keyed on ELAPSED-since-launch (never on a poll counter), so it composes cleanly with the
// anchored window. Early: a tight ~120s poll while the human is likely present (keeps the prompt cache
// warm). Steady: back off but stay under ~300s. Tail: once clearly idle, widen to a coarse ~900s poll.
export const POLL_CADENCE = {
  /** First poll delay — ~2 min (§4c "first poll ~120s"). */
  firstDelayMs: 120_000,
  /** Steady delay — kept under ~300s so a present human isn't kept waiting (§4c "under ~300s"). */
  steadyDelayMs: 240_000,
  /** Coarse tail delay once clearly idle — ~15 min (§4c "widen to a coarse tail ~900s"). */
  tailDelayMs: 900_000,
  /** After the first ~2-min poll, settle into the steady cadence. */
  steadyAfterMs: 120_000,
  /** After ~30 min with no change, widen to the coarse tail. */
  tailAfterMs: 30 * 60 * 1000,
} as const;

/** The default elapsed→delay schedule: ramps first(120s) → steady(<300s) → coarse tail(~900s). */
export function defaultCadence(elapsedMs: number): number {
  if (elapsedMs < POLL_CADENCE.steadyAfterMs) return POLL_CADENCE.firstDelayMs;
  if (elapsedMs < POLL_CADENCE.tailAfterMs) return POLL_CADENCE.steadyDelayMs;
  return POLL_CADENCE.tailDelayMs;
}

function pendingPresent(pr: PendingResolutionish | null | undefined): pr is PendingResolutionish {
  return pr != null;
}

function samePending(
  a: PendingResolutionish | null | undefined,
  b: PendingResolutionish | null | undefined,
): boolean {
  if (!pendingPresent(a) && !pendingPresent(b)) return true;
  if (!pendingPresent(a) || !pendingPresent(b)) return false;
  return a.command === b.command && (a.detail ?? null) === (b.detail ?? null);
}

/**
 * Compare a freshly-read task against the launch baseline and report what (if anything) the human did.
 * Returns the matching ChangeDetail, or null when nothing watch-worthy changed. The three signals mirror
 * the §4c consume cases:
 *   1. `parked`          — the ticket is now Parked (a browser defer/deny). Surfaced explicitly because it
 *                          is terminal and must not be mistaken for a forward advance.
 *   2. `state-advanced`  — `workflow_state` differs from the baseline (a browser accept advanced the gate).
 *   3. `pending_resolution` — a browser reshape left a (new/changed) `pending_resolution` marker on the
 *                          active brief with the state unchanged.
 * Order matters: Parked is checked before the generic state-diff so a defer/deny reports `parked`, and the
 * pending_resolution check requires the marker to be genuinely new (present and not equal to the baseline
 * marker) so a pre-existing marker can't false-trigger an immediate exit.
 */
export function detectChange(baseline: PollBaseline, task: Taskish): ChangeDetail | null {
  const state = task.workflow_state ?? null;
  const baseState = baseline.workflowState ?? null;

  if (state === 'Parked') {
    return { trigger: 'parked', workflow_state: state };
  }
  if (state !== baseState) {
    return { trigger: 'state-advanced', workflow_state: state };
  }
  const pr = task.pending_resolution ?? null;
  if (pendingPresent(pr) && !samePending(pr, baseline.pendingResolution)) {
    return { trigger: 'pending_resolution', workflow_state: state, pending_resolution: pr };
  }
  return null;
}

export interface PollLoopOpts {
  /** Reads the watched task. The entrypoint injects `() => getTask(client, projectId, { task_id })`. */
  readTask: () => Promise<Taskish>;
  /** The clock. The entrypoint injects `Date.now`. */
  now: () => number;
  /** Awaits `ms` milliseconds. The entrypoint injects a real setTimeout-based sleep. */
  sleep: (ms: number) => Promise<void>;
  /** The clock value captured ONCE at launch — the anchor the window is measured against (B-548). */
  launchStamp: number;
  /** The state captured at launch to diff every poll against. */
  baseline: PollBaseline;
  /** Total watch window; defaults to WATCH_WINDOW_MS (~90 min). */
  windowMs?: number;
  /** Elapsed→delay schedule; defaults to {@link defaultCadence}. */
  cadence?: (elapsedMs: number) => number;
}

/**
 * Watch one ticket until it changes or the bounded window expires.
 *
 * - Reads FIRST each iteration, so a change already visible at launch is caught before any sleep.
 * - Exits `{ reason: 'changed', detail }` on the first detected change (see {@link detectChange}).
 * - Exits `{ reason: 'timeout' }` once `now() - launchStamp >= windowMs`.
 *
 * B-548 GUARD: elapsed is ALWAYS `now() - launchStamp`, measured against the anchored launch stamp passed
 * in — it is never accumulated from sleep durations and never conflated with the budget. The final sleep
 * is capped to the remaining window so the loop wakes at most at the window boundary rather than overshoot.
 */
export async function runPollLoop(opts: PollLoopOpts): Promise<PollResult> {
  const windowMs = opts.windowMs ?? WATCH_WINDOW_MS;
  const cadence = opts.cadence ?? defaultCadence;

  for (;;) {
    const task = await opts.readTask();
    const change = detectChange(opts.baseline, task);
    if (change) return { reason: 'changed', detail: change };

    const elapsed = opts.now() - opts.launchStamp;
    if (elapsed >= windowMs) return { reason: 'timeout' };

    const remaining = windowMs - elapsed;
    const delay = Math.min(cadence(elapsed), remaining);
    await opts.sleep(delay);
  }
}
