// B-739: the per-lease heartbeat keeper.
//
// The daemon used to stamp liveness as a SIDE EFFECT of pass progress, immediately before a
// blocking worker launch (the old scheduler.ts step 3, one write per pass per row). While a pass
// waited on a worker no stamp was written at all — so a perfectly healthy daemon waiting on a
// normal build became indistinguishable from a dead one and advertised itself as reapable. With a
// 5-minute stale window and multi-minute builds, that was the NORMAL case, not an edge case.
//
// This module decouples the stamp from pass progress: one repeating timer per HELD LEASE, ticking
// on its own cadence (config.heartbeatMs), whatever the pass is doing.
//
// Three invariants it exists to hold:
//
//   1. IN-PROCESS, always. A wedged event loop must stop the stamping, so a genuinely dead daemon
//      still goes stale and its run stays recoverable by takeover. Moving this off-process would
//      trade "healthy looks dead" for the strictly worse "dead looks healthy".
//
//   2. The write IS the ownership probe. Lease loss is otherwise discoverable only in the pass
//      loop — which is exactly what a blocked launch stalls — so without this a daemon blocked on
//      a 90-minute worker would keep asserting liveness for a lease it no longer holds, for the
//      whole worker lifetime. The guarded write's `null` is how a blocked daemon finds out.
//
//   3. null and throw are DIFFERENT. `null` (no row matched) means the lease is gone: stop. A
//      throw means nothing is known: keep the timer and retry next tick. Conflating them would
//      stop stamping during precisely the transient blip that makes a healthy daemon look dead —
//      this ticket's own bug, re-created inside its fix.
//
// Per-lease timers rather than one global sweeping tick: a sweep that awaited each lease's write
// in turn would reintroduce head-of-line blocking, a smaller instance of the fault being fixed.
//
// Pure dependency-injected core (the B-532 pattern): time and timers are injected, so the whole
// keeper is fake-clock unit-testable with no real setInterval.

import type { ConductionPatch, ConductionRecord } from '../tools/conduction-record.js';
import { formatDaemonError } from './error-format.js';

export interface HeartbeatDeps {
  now(): number;
  /** Start a repeating timer; returns a stop function. Injected — never global setInterval. */
  startInterval(ms: number, fn: () => void): () => void;
  /** MUST be the LEASE-GUARDED write (updateConductionIfHeld, bound to this daemon's holder id):
   *  null = the lease is gone, a throw = nothing is known. See invariant 3. */
  updateConductionIfHeld(id: string, patch: ConductionPatch): Promise<ConductionRecord | null>;
  log(line: string): void;
  heartbeatMs: number;
}

export interface HeartbeatKeeper {
  /** Begin stamping this lease. Idempotent — a second call for a running lease is a no-op. */
  ensure(conductionId: string): void;
  /** Stop stamping this lease (lease lost, conduction terminal). Idempotent. */
  stop(conductionId: string): void;
  /** Stop every lease NOT in the given set — the pass's prune, mirroring the watch-baseline prune. */
  retain(activeIds: Set<string>): void;
  /** Stop everything — daemon shutdown. A lease must go quiet the moment the process leaves. */
  stopAll(): void;
  /** The lease ids currently being stamped (test/observability surface). */
  running(): string[];
}

export function createHeartbeatKeeper(deps: HeartbeatDeps): HeartbeatKeeper {
  const timers = new Map<string, () => void>();

  const stop = (id: string): void => {
    const cancel = timers.get(id);
    if (cancel === undefined) return;
    cancel();
    timers.delete(id);
  };

  const beat = async (id: string): Promise<void> => {
    try {
      const row = await deps.updateConductionIfHeld(id, {
        last_heartbeat_at: new Date(deps.now()).toISOString(),
      });
      if (row === null) {
        // NO ROW MATCHED — the lease was taken over, or the row is gone. Go quiet on this run at
        // once; the scheduler's own guarded writes will likewise no-op, so we can never clobber
        // the new holder's record.
        deps.log(`conduction ${id}: lease no longer held — heartbeat stopped`);
        stop(id);
      }
    } catch (err) {
      // A THROW means nothing is known (invariant 3). Do NOT stop and do NOT infer lease loss.
      deps.log(
        `conduction ${id}: heartbeat write failed, retrying next tick (${formatDaemonError(err)})`,
      );
    }
  };

  return {
    ensure(id: string): void {
      if (timers.has(id)) return;
      timers.set(
        id,
        deps.startInterval(deps.heartbeatMs, () => {
          void beat(id);
        }),
      );
    },
    stop,
    retain(activeIds: Set<string>): void {
      for (const id of [...timers.keys()]) if (!activeIds.has(id)) stop(id);
    },
    stopAll(): void {
      for (const id of [...timers.keys()]) stop(id);
    },
    running(): string[] {
      return [...timers.keys()];
    },
  };
}
