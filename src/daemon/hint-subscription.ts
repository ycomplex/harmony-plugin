// B-1011: the ONLY impure piece of the daemon's hint path — the Supabase Realtime subscription.
//
// It owns exactly three things: the socket (through the client's own `.channel()`), the debounce
// TIMER (through the scheduler's already-injected `startTimeout`, so it stays fake-clock testable),
// and the logging. Every DECISION — drop-or-wake, coalesce-or-open, which lifecycle rule a status
// selects — belongs to the pure core in ./hints.ts and is merely applied here. That split is the
// house style (watch.ts decides, scheduler.ts does the I/O), and it is what lets the three-state
// lifecycle be tested exhaustively against a faked channel with no socket anywhere.
//
// NO NEW DEPENDENCY, NO TOKEN PLUMBING. The channel comes from the daemon's EXISTING authenticated
// SupabaseClient; @supabase/realtime-js is transitive, never imported here (the channel arrives as
// a structural `HintChannelLike`). The socket authenticates through the very same `accessToken`
// callback src/supabase.ts already passes — the client stores it (node_modules/@supabase/
// realtime-js/dist/main/RealtimeClient.js:558) and RE-INVOKES it on every auth refresh
// (:405-408) — so a long-lived daemon's channel re-authenticates exactly the way its reads do.
//
// NO BACKOFF IS IMPLEMENTED HERE. The library already carries two capped schedules (cited in
// ./hints.ts's createHintLifecycle doc). A third would only make recovery slower.
//
// The wire contract is B-1010's and is cited, never re-derived: private topic
// `workspace:<workspace_uuid>`, events `task_change` / `conduction_change`.

import {
  createHintCoalescer,
  createHintLifecycle,
  type HintMessage,
  type HintSource,
  HINT_EVENTS,
} from './hints.js';

/** The structural slice of a supabase-js RealtimeChannel this module uses — narrow on purpose, so
 *  a test can hand over a plain object and the real channel still satisfies it. */
export interface HintChannelLike {
  on(
    type: 'broadcast',
    filter: { event: string },
    callback: (message: { event?: string; payload?: unknown }) => void,
  ): HintChannelLike;
  subscribe(callback: (status: string, err?: unknown) => void): unknown;
}

export interface HintSubscriptionDeps {
  /** Create (do not subscribe) the channel for `topic`. Called ONCE, lazily, after boot — a throw
   *  here is treated exactly like a rejected join: state (A), a tolerant no-op. */
  createChannel(topic: string): HintChannelLike;
  /** `client.removeChannel(channel)` — tears the channel down. Called in state (A), and by
   *  `close()` at shutdown. NEVER called for a post-subscribe error (state B). */
  removeChannel(channel: HintChannelLike): Promise<unknown> | unknown;
  /** The workspace uuid, resolved ONCE at boot and pinned for the daemon's lifetime. */
  workspaceId: string;
  /** This daemon instance's lease holder — the read-to-discard self-hint filter's input. */
  leaseHolder: string;
  /** The FIXED debounce window (config.hintDebounceMs). */
  debounceMs: number;
  /** The scheduler's injected one-shot timer — never a global setTimeout. */
  startTimeout(ms: number, fn: () => void): () => void;
  log(line: string): void;
  /** B-1045: `auth.forceRefresh()` — the existing single-flight session refresh in src/auth.ts.
   *  Called on a `log-and-reauth` action, BEFORE `setAuth()`. */
  forceRefresh(): Promise<void>;
  /** B-1045: `client.realtime.setAuth()` — called with NO argument. A manually-passed token
   *  permanently opts the realtime client out of future callback-based refreshes; see
   *  createHintLifecycle's `log-and-reauth` doc comment for the citation. */
  setAuth(): void;
  /** The scheduler's poll interval — the outage-visibility timer's first delay. */
  pollMs: number;
  /** The outage-visibility timer's steady-state cadence after the first firing. Defaults to five
   *  minutes when not supplied. */
  downCadenceMs?: number;
}

export interface HintSubscription {
  /** The dep the scheduler races against its poll sleep. */
  source: HintSource;
  /** Tear the channel down (shutdown). Idempotent; resolves even when there is no channel. */
  close(): Promise<void>;
  /** Test/observability: is this process's hint source permanently dead (state A)? */
  isDead(): boolean;
}

/** B-1010's topic: PRIVATE, keyed by workspace uuid. */
export function hintTopic(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

/** Wire the channel and return the scheduler's hint dep.
 *
 *  SYNCHRONOUS and NON-BLOCKING by construction: it never awaits the join. Boot must not wait on a
 *  socket, and a channel that never subscribes must cost the daemon nothing — with no SUBSCRIBED,
 *  `source.next()` simply never resolves, which in `Promise.race([sleep(pollMs), next()])` is
 *  indistinguishable from the dep being absent. That is what makes state (A) a tolerant no-op: on
 *  a board where B-1010's RLS policy is not live yet (prod, until the founder promote), the daemon
 *  logs one line and runs exactly as it does today. */
export function startHintSubscription(deps: HintSubscriptionDeps): HintSubscription {
  const topic = hintTopic(deps.workspaceId);
  const coalescer = createHintCoalescer({
    leaseHolder: deps.leaseHolder,
    debounceMs: deps.debounceMs,
  });
  const lifecycle = createHintLifecycle({ topic });
  const downCadenceMs = deps.downCadenceMs ?? 300_000;
  let channel: HintChannelLike | null = null;

  // B-1045: outage-visibility timer. Armed the moment the channel goes down (post-subscribed
  // drop), disarmed the moment it recovers or goes permanently dead. Elapsed time is tracked by
  // ACCUMULATING the scheduled interval durations — never by reading a clock — using the very same
  // injected `startTimeout` seam the debounce window already uses, so this stays fake-clock
  // testable with no new dependency.
  let downTimerCancel: (() => void) | null = null;

  const cancelDownTimer = (): void => {
    if (downTimerCancel) {
      downTimerCancel();
      downTimerCancel = null;
    }
  };

  /** `elapsedAtFire` is the total down-time this timer instance represents WHEN IT FIRES —
   *  computed by the caller by accumulating scheduled durations, never by reading a clock. */
  const armDownTimer = (delayMs: number, elapsedAtFire: number): void => {
    downTimerCancel = deps.startTimeout(delayMs, () => {
      downTimerCancel = null;
      if (!lifecycle.isDown()) return; // recovered (or went dead) — nothing to say
      deps.log(`hint channel down ${Math.round(elapsedAtFire / 1000)}s, awaiting rejoin`);
      armDownTimer(downCadenceMs, elapsedAtFire + downCadenceMs);
    });
  };

  const checkDownTimer = (): void => {
    if (lifecycle.isDown()) {
      if (downTimerCancel) return; // already armed
      armDownTimer(deps.pollMs, deps.pollMs);
    } else {
      cancelDownTimer();
    }
  };

  const apply = (status: Parameters<typeof lifecycle.onStatus>[0], err?: unknown): void => {
    const action = lifecycle.onStatus(status, err);
    if (action.kind !== 'none') {
      deps.log(action.line);
      if (action.kind === 'log-and-teardown' && channel) {
        // (A) ONLY. A post-subscribe error must NEVER reach here: removing the channel would
        // destroy the library's own rejoin and turn a blip into a permanent loss of hints.
        const doomed = channel;
        channel = null;
        try {
          void Promise.resolve(deps.removeChannel(doomed)).catch(() => {
            // Best-effort teardown — the daemon is already degrading to poll-only.
          });
        } catch {
          // Same: never let a teardown failure escape into the daemon.
        }
      } else if (action.kind === 'log-and-reauth') {
        // B-1045: fire-and-forget — apply() stays synchronous. The latch in createHintLifecycle
        // guarantees this fires at most once per outage, so there is no spin to guard against here.
        deps
          .forceRefresh()
          .then(() => deps.setAuth())
          .catch((refreshErr: unknown) => {
            const message =
              refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
            deps.log(
              `hint channel re-auth failed (${message}) — staying on the poll interval until ` +
                "the client's own rejoin recovers",
            );
          });
      }
    }
    checkDownTimer();
  };

  const onMessage = (message: { event?: string; payload?: unknown }): void => {
    // (C) only: a message outside the subscribed steady state is not a wake.
    if (!lifecycle.acceptsMessages()) return;
    const action = coalescer.accept(message as HintMessage);
    if (action.action !== 'open-window') return;
    // The FIXED window: armed by the FIRST hint, and never re-armed by the ones that coalesce into
    // it (createHintCoalescer returns 'coalesce' for those).
    deps.startTimeout(action.debounceMs, coalescer.closeWindow);
  };

  try {
    channel = deps.createChannel(topic);
    for (const event of HINT_EVENTS) channel.on('broadcast', { event }, onMessage);
    channel.subscribe((status, err) => {
      apply(
        (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const).find(
          (s) => s === status,
        ) ?? 'CHANNEL_ERROR',
        err,
      );
    });
  } catch (err) {
    // No channel to report a status — synthesise one. Same tolerant (A) outcome.
    apply('SETUP_FAILED', err);
  }

  return {
    source: coalescer,
    isDead: () => lifecycle.isDead(),
    close: async () => {
      cancelDownTimer();
      const open = channel;
      channel = null;
      if (!open) return;
      await deps.removeChannel(open);
    },
  };
}
