// B-1011: the daemon's hint decisions — PURE. No socket, no clock, no I/O.
//
// WHAT THIS IS FOR. The scheduler's loop ends in one line — `await deps.sleep(config.pollMs)` —
// and that single 25-second sleep IS the daemon's whole reaction latency. This module is the
// decision half of an OPTIONAL interrupt for it: a hint source raced against that UNCHANGED sleep,
// so a board write can wake the loop in ~2s instead of ~25s. The impure half (the Supabase
// Realtime channel) lives in src/daemon/hint-subscription.ts; the scheduler owns the race.
//
// THE ONE RULE THAT MAKES THIS SAFE — READ-TO-DISCARD, NEVER READ-TO-DECIDE. A hint carries a
// payload (B-1010 sends the full NEW/OLD row through `realtime.broadcast_changes`). This module
// may inspect that payload ONLY to DROP a hint — never to satisfy one, and never to stand in for
// a re-read. A hint-driven pass is a FULL pass: the same reads, the same decisions, just sooner.
// The filter is an OPTIMISATION; if it were deleted the daemon would be noisier and still correct.
// Nothing downstream of this module ever sees a payload byte.
//
// WIRE CONTRACT (B-1010, cited — never re-derived here): private topic `workspace:<workspace_uuid>`,
// events `task_change` and `conduction_change`, payload from `realtime.broadcast_changes`, RLS a
// SELECT policy on `realtime.messages` gated by `is_workspace_member`. The `conductions` trigger
// carries a WHEN clause that never fires on a `last_heartbeat_at`-only write — the heartbeat-only
// filter below is therefore belt-and-braces, not the primary defence.
//
// Three pieces, all pure and separately testable:
//   1. `hintDropReason`  — the read-to-discard self-hint filter.
//   2. `createHintCoalescer` — the fixed debounce window + the sticky mid-pass flag; it IS the
//      `HintSource` the scheduler races. It holds a waiter promise (neither a clock nor I/O); the
//      WINDOW's timer belongs to the caller, which uses the scheduler's already-injected
//      `startTimeout` so the whole thing stays fake-clock testable.
//   3. `createHintLifecycle` — the latched `everSubscribed` discriminator that selects one of the
//      three lifecycle rules. Latching is REQUIRED, not stylistic: the realtime library delivers a
//      rejected join and a post-subscribe drop through the SAME status callback (verified in
//      node_modules/@supabase/realtime-js/dist/main/RealtimeChannel.js:125-128 — `_onError` /
//      `_onClose` are registered as PERSISTENT channel bindings inside `subscribe()`), so nothing
//      but a latch can tell "never worked" from "worked, then dropped".

/** The scheduler-facing contract. Deliberately value-less — a hint says "something changed, go
 *  look", never WHAT changed (read-to-discard, above).
 *
 *  TWO methods, because the race in scheduler.ts has a stale-waiter hazard that one cannot close.
 *  The loop races `Promise.race([sleep(pollMs), hints.next()])`; when the SLEEP wins, the hint
 *  promise is abandoned but still live. A wake arriving during the pass that follows would then be
 *  handed to that abandoned promise — which nobody is awaiting — and the wake would be LOST for a
 *  full poll interval, the exact failure the sticky flag exists to prevent. `abandon()` closes it:
 *  the racer says "that promise is dead to me" the moment the race settles, so any later wake is
 *  LATCHED instead of delivered into the void. Calling it after a hint-won race is a no-op. */
export interface HintSource {
  /** Resolves when a coalesced wake is owed — immediately if one is already latched. */
  next(): Promise<void>;
  /** The race settled: stop listening to the promise the last `next()` returned. MUST be called by
   *  the racer once per race, whichever side won. */
  abandon(): void;
}

/** The two events B-1010 broadcasts. Anything else on the topic is dropped unread. */
export const HINT_EVENTS = ['task_change', 'conduction_change'] as const;
export type HintEvent = (typeof HINT_EVENTS)[number];

/** A broadcast message as the realtime client hands it over. `payload` is the full NEW/OLD row —
 *  inspected ONLY by `hintDropReason`, and only ever to DROP. */
export interface HintMessage {
  event?: string;
  payload?: unknown;
}

export type HintDropReason = 'unknown-event' | 'self-lease' | 'heartbeat-only';

/** Keys whose change alone can never mean the ball moved. `last_heartbeat_at` is this daemon's own
 *  liveness stamp; `updated_at` rides along with every write, so it is only ever ignorable in the
 *  company of other ignorable keys. */
const IGNORABLE_KEYS = new Set(['last_heartbeat_at', 'updated_at']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** READ-TO-DISCARD. Returns why this message must be DROPPED, or null to let it wake the loop.
 *
 *  Every branch here is one-directional: it can only ever say "drop", never "this hint means X".
 *  When the payload is absent, partial, or an unexpected shape, the answer is null — WAKE. Waking
 *  on a hint that turns out to be uninteresting costs one early pass; failing to wake costs up to
 *  a full poll interval, so the bias is deliberate and always toward waking. */
export function hintDropReason(msg: HintMessage, leaseHolder: string): HintDropReason | null {
  if (!msg.event || !(HINT_EVENTS as readonly string[]).includes(msg.event)) return 'unknown-event';

  const payload = asRecord(msg.payload);
  if (!payload) return null;
  const record = asRecord(payload.record);
  if (!record) return null;

  // (a) This instance's OWN write. The daemon writes lease/heartbeat/status rows constantly; every
  //     one of them broadcasts back. A row whose lease holder is this very process has nothing to
  //     tell this process that it did not already know when it wrote it.
  if (typeof record.lease_holder === 'string' && record.lease_holder === leaseHolder) {
    return 'self-lease';
  }

  // (b) A heartbeat-only change: every key that differs is in IGNORABLE_KEYS. Needs BOTH rows —
  //     with no `old_record` (a table without REPLICA IDENTITY FULL) nothing can be compared, so
  //     the hint wakes, exactly per the bias above.
  const oldRecord = asRecord(payload.old_record);
  if (oldRecord) {
    const keys = new Set([...Object.keys(record), ...Object.keys(oldRecord)]);
    let differs = false;
    for (const key of keys) {
      if (JSON.stringify(record[key]) === JSON.stringify(oldRecord[key])) continue;
      if (!IGNORABLE_KEYS.has(key)) return null; // a real change — wake.
      differs = true;
    }
    if (differs) return 'heartbeat-only';
  }

  return null;
}

/** What the impure caller must DO with a message. The coalescer never starts a timer itself. */
export type HintAction =
  /** Dropped by the read-to-discard filter — no window, no wake. */
  | { action: 'drop'; reason: HintDropReason }
  /** First hint of a window: the caller must schedule `closeWindow()` `debounceMs` from now. */
  | { action: 'open-window'; debounceMs: number }
  /** A window is already open — this hint folds into it. The caller does nothing. */
  | { action: 'coalesce' };

export interface HintCoalescer extends HintSource {
  /** Offer a message. Pure decision — see HintAction. */
  accept(msg: HintMessage): HintAction;
  /** The window the caller scheduled has elapsed: latch exactly ONE wake and close the window. */
  closeWindow(): void;
  /** Test/observability: is a wake latched and not yet consumed? */
  pendingWake(): boolean;
  /** Test/observability: is a debounce window currently open? */
  windowOpen(): boolean;
}

/** The debounce window + the sticky mid-pass flag.
 *
 *  WINDOW: FIXED, opened by the FIRST hint, and NEVER slid by the ones that follow. A sliding
 *  window is the tempting shape and it is wrong here — the daemon's own write burst (lease,
 *  heartbeat, status, output) broadcasts back at it, so a sliding window could be re-extended
 *  indefinitely and starve the wake it exists to schedule.
 *
 *  STICKY FLAG: a wake that fires while a pass is running has no one awaiting it. It is LATCHED
 *  and consumed by the very next `next()` — i.e. at the next sleep. That is what makes "no wake is
 *  lost and no two passes overlap" a property of the structure: a wake can only ever be delivered
 *  at the loop's one sleep point, never into the middle of a pass. */
export function createHintCoalescer(opts: {
  leaseHolder: string;
  debounceMs: number;
}): HintCoalescer {
  let open = false;
  let latched = false;
  let waiter: (() => void) | null = null;

  return {
    accept(msg) {
      const reason = hintDropReason(msg, opts.leaseHolder);
      if (reason) return { action: 'drop', reason };
      if (open) return { action: 'coalesce' };
      open = true;
      return { action: 'open-window', debounceMs: opts.debounceMs };
    },

    closeWindow() {
      open = false;
      const resolve = waiter;
      waiter = null;
      if (resolve) {
        // A LIVE waiter means the loop is AT its sleep right now (a dead one was dropped by
        // `abandon()` when its race settled): deliver the wake straight to it — nothing to latch,
        // because it is being consumed this instant.
        resolve();
        return;
      }
      // Nobody is awaiting: a pass is running. LATCH it. This is the sticky flag — the wake
      // survives the pass and is consumed by the very next `next()` call, i.e. at the next sleep.
      // A wake can therefore only ever be delivered at the loop's one sleep point, which is what
      // makes "no wake lost, no two passes overlapping" structural rather than incidental.
      latched = true;
    },

    next() {
      if (latched) {
        latched = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        // One consumer (the scheduler loop), one waiter at a time.
        waiter = resolve;
      });
    },

    abandon() {
      // The racer has stopped listening. Dropping the resolver here is what turns a later wake
      // into a LATCH instead of a resolution nobody hears — see the HintSource doc comment.
      waiter = null;
    },

    pendingWake: () => latched,
    windowOpen: () => open,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The three-state lifecycle.

/** The four statuses the realtime library reports through the subscribe callback, plus the
 *  synthetic SETUP_FAILED the adapter raises when there is no channel to report one (the workspace
 *  uuid could not be resolved, or `client.channel()` itself threw). */
export type HintStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | 'SETUP_FAILED';

export type HintLifecycleAction =
  /** (A) PRE-SUBSCRIBED failure: log this ONE line, `removeChannel`, and stay silent for the rest
   *  of the process lifetime. The next boot retries; this process does not. */
  | { kind: 'log-and-teardown'; line: string }
  /** (B)/(C): log this ONE line and do nothing else. Crucially NOT a teardown — the library's own
   *  capped rejoin is left to run unwrapped. `onStatus()` NEVER decides a recovery action itself
   *  (B-1045 round 2) — a post-subscribed drop is always just this. */
  | { kind: 'log'; line: string }
  /** Nothing to say: a repeat of the status already reported, or a status after (A) latched. */
  | { kind: 'none' };

/** B-1045 round 2: the ONE recovery action `armRecovery()` hands back to the down-timer's first
 *  tick. Which action depends on what the pinned `@supabase/realtime-js`/`@supabase/phoenix`
 *  source does with each status once it has dropped a channel that WAS subscribed:
 *   - 'reauth'   — CHANNEL_ERROR / TIMED_OUT still have a LIVE scheduled rejoin in the library; a
 *                  stale session JWT is the dominant real-world cause, so `forceRefresh()` then
 *                  `setAuth()` (no argument) corrects it and the library's own rejoin does the rest.
 *   - 'recreate' — CLOSED cancels the library's own scheduled rejoin and de-lists the channel at
 *                  BOTH the phoenix layer and the realtime-js wrapper layer — there is no scheduled
 *                  rejoin left for `setAuth()` to correct, so the only way back is to discard the
 *                  dead channel reference and re-run the exact create+wire+subscribe sequence boot
 *                  itself uses.
 *   - 'none'     — nothing tracked worth recovering (latched-out, or a status outside the two above). */
export type RecoveryAction = 'reauth' | 'recreate' | 'none';

export interface HintLifecycle {
  /** Feed a status from the subscribe callback; get the ONE thing to do about it. */
  onStatus(status: HintStatus, err?: unknown): HintLifecycleAction;
  /** (C): may a message be handed to the coalescer right now? */
  acceptsMessages(): boolean;
  /** Has (A) latched — is this process's hint source dead for good? */
  isDead(): boolean;
  /** Has a first SUBSCRIBED ever been seen? (the discriminator itself) */
  everSubscribed(): boolean;
  /** Is the channel down RIGHT NOW — subscribed at least once, not live, and not permanently dead
   *  (state A)? True exactly for the span an outage-visibility timer should be armed. */
  isDown(): boolean;
  /** B-1045 round 2/3: a PURE query, never called from `onStatus()` — the down-timer's first tick
   *  (and every subsequent tick, per the cadence) is the only caller. Returns which recovery action
   *  to run based on the currently-tracked last status, and is CAPPED: at most 3 attempts per
   *  outage, counted by a counter reset on the next SUBSCRIBED (round 3 widened round 1's
   *  `reauthedThisOutage` flag, then round 2's once-per-outage latch, into this capped counter — same
   *  call site as round 2). A 4th (or later) call within the same outage returns 'none'. */
  armRecovery(): RecoveryAction;
}

function describe(status: HintStatus, err: unknown): string {
  const detail = err instanceof Error ? err.message : err == null ? '' : String(err);
  return detail ? `${status} (${detail})` : status;
}

/** B-1045: does this error's message name an expired/invalid session JWT? Case-insensitive
 *  substring match against the same message extraction `describe()` uses. Matches Supabase
 *  Realtime's own wording for both shapes it has been observed to send (`InvalidJWTToken` and
 *  `token has expired`). PURE — never re-authenticates itself; only names the condition. */
export function isExpiredJwtError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : err == null ? '' : String(err);
  const lower = message.toLowerCase();
  return lower.includes('invalidjwttoken') || lower.includes('token has expired');
}

/** The latched `everSubscribed` discriminator and the three rules it selects.
 *
 *   (A) PRE-SUBSCRIBED failure — an error/timeout/close arriving before any SUBSCRIBED, or a
 *       SETUP_FAILED. On prod the dominant cause is an RLS denial (B-1010's policy is live on
 *       staging; prod waits on a founder promote), which no amount of retrying inside this process
 *       will fix. Log ONCE, tear the channel down, go permanently quiet. The daemon then behaves
 *       exactly as it does today — a 25s poll — which is why this state is a tolerant no-op.
 *
 *   (B) POST-SUBSCRIBED drop — the same statuses, but after a first SUBSCRIBED. This is an
 *       ordinary network blip on a subscription that demonstrably WORKS. Do NOT `removeChannel`:
 *       that would destroy the library's own rejoin and turn a blip into a permanent loss of
 *       hints. One log line per transition, the dep stays present, hints resume on re-SUBSCRIBED.
 *       (This was an earlier draft's defect — tests assert against it directly.) `onStatus()`
 *       itself never reacts further (B-1045 round 2) — `armRecovery()` below is a separate PURE
 *       query the down-timer's first tick calls once the drop has persisted past one poll
 *       interval, and it is what picks 'reauth' vs 'recreate' vs 'none'.
 *
 *   (C) SUBSCRIBED — steady state; messages flow to the coalescer.
 *
 *  No backoff is implemented anywhere in this module or its adapter. The library already carries
 *  TWO capped schedules and stacking a third would only slow recovery: the channel's rejoin
 *  [1s,2s,5s]→flat 10s (node_modules/@supabase/phoenix/assets/js/phoenix/socket.js:127-131, reached
 *  via RealtimeChannel's channelAdapter) and the socket's RECONNECT_INTERVALS [1s,2s,5s,10s]→flat
 *  10s (node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js:16, :568-571). */
/** B-1045 round 3: the cap on recovery attempts per outage — see `armRecovery()`'s doc. */
const MAX_RECOVERY_ATTEMPTS = 3;

export function createHintLifecycle(opts: { topic: string }): HintLifecycle {
  let subscribedOnce = false;
  let dead = false;
  let live = false;
  let lastStatus: HintStatus | null = null;
  // B-1045 round 3: capped at MAX_RECOVERY_ATTEMPTS (3) attempts per outage, one per down-timer
  // tick (reusing the existing pollMs-then-downCadenceMs cadence — no new timer). Incremented the
  // moment `armRecovery()` hands back a real action (not 'none'); reset to 0 on every SUBSCRIBED
  // (first or repeat) so a LATER outage can trigger it again for up to 3 more attempts. This widens
  // round 2's once-per-outage latch, which itself replaced round 1's `reauthedThisOutage` flag that
  // `onStatus()` used to set — the arming decision stays entirely out of `onStatus()`.
  let recoveryAttemptsThisOutage = 0;

  return {
    onStatus(status, err) {
      if (dead) return { kind: 'none' }; // (A) has latched — never speak again.
      const repeat = status === lastStatus;
      lastStatus = status;

      if (status === 'SUBSCRIBED') {
        const first = !subscribedOnce;
        subscribedOnce = true;
        live = true;
        recoveryAttemptsThisOutage = 0;
        if (repeat) return { kind: 'none' };
        return {
          kind: 'log',
          line: first
            ? `hint channel subscribed: ${opts.topic} — waking on board changes`
            : `hint channel re-subscribed: ${opts.topic} — hints resume`,
        };
      }

      live = false;
      if (!subscribedOnce) {
        // (A) — latch before returning; this is the last word from this process.
        dead = true;
        return {
          kind: 'log-and-teardown',
          line:
            `hint channel unavailable (${describe(status, err)}) on ${opts.topic} — ` +
            'continuing on the poll interval alone; not retried in this process',
        };
      }
      // (B) — onStatus() ONLY logs (round 2); the down-timer's first tick is what decides and
      // triggers a recovery action, via armRecovery() below. The library's own rejoin (for
      // CHANNEL_ERROR/TIMED_OUT) or the recreate path (for CLOSED) owns recovery from here.
      if (repeat) return { kind: 'none' };
      return {
        kind: 'log',
        line: `hint channel ${describe(status, err)} on ${opts.topic} — awaiting the client's own rejoin`,
      };
    },

    armRecovery() {
      if (recoveryAttemptsThisOutage >= MAX_RECOVERY_ATTEMPTS) return 'none';
      if (lastStatus === 'CHANNEL_ERROR' || lastStatus === 'TIMED_OUT') {
        recoveryAttemptsThisOutage += 1;
        return 'reauth';
      }
      if (lastStatus === 'CLOSED') {
        recoveryAttemptsThisOutage += 1;
        return 'recreate';
      }
      return 'none';
    },

    acceptsMessages: () => live && !dead,
    isDead: () => dead,
    everSubscribed: () => subscribedOnce,
    isDown: () => subscribedOnce && !live && !dead,
  };
}
