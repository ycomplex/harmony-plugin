// B-1172: the registry keeper — owns the conductor's row in the registry for this process's lifetime.
// Sits beside heartbeat.ts (which keeps the per-LEASE heartbeats) and follows the same conventions: a pure
// dependency-injected core, time and timers injected, in-process only (a wedged event loop must stop the
// stamping so a genuinely dead conductor goes stale).
//
// THE SAFETY RULES (the founder's, non-negotiable — the prod host runs under nohup with no supervisor, so a
// conductor that exits on a hiccup is a conductor that stays down):
//
//   1. A call that FAILS (network error, timeout, 5xx, JWT problem, missing function) is NEVER 'lost'. The
//      conductor keeps running and launching, logs ONCE per outage and ONCE on recovery, retries next tick.
//   2. 'lost' means exactly one thing: the row is held by a DIFFERENT holder with a fresh heartbeat. Only then
//      does the keeper call onLost (the daemon stops launching and exits the way SIGTERM does).
//   3. If OUR lease went stale and nobody else took it, the next heartbeat re-asserts it (the database
//      function does that) and the conductor does not exit.
//
// BOOT: acquire before the scheduler starts. A refusal is the only outcome that stops a boot. 'unavailable'
// (the functions are not on this database yet — plugin `staging` runs against prod until ./promote-prod.sh)
// logs ONE line, boots as before, and re-probes at most every reprobeMs. 'unknown' (transient) boots as
// before and retries on later ticks.

import type { PendingRequest, RegistryClient, RegistryIdentity, AcquireOutcome } from './conductor-registry.js';
import { parseHolderId } from './conductor-registry.js';

export const DEFAULT_REPROBE_MS = 5 * 60_000;

export type KeeperState = 'held' | 'unacquired' | 'lost' | 'stopped';

export interface RegistryKeeperDeps {
  client: RegistryClient;
  identity: RegistryIdentity;
  now(): number;
  /** Repeating timer; returns a stop function. Injected — never a global setInterval. */
  startInterval(ms: number, fn: () => void): () => void;
  heartbeatMs: number;
  /** How often an 'unavailable' registry is re-probed (default 5 minutes). */
  reprobeMs?: number;
  /** True when a process with this pid exists on THIS host. */
  isPidAlive(pid: number): boolean;
  ownPid: number;
  log(line: string): void;
  /** The row is held by a different holder with a fresh heartbeat. Called at most once. */
  onLost(info: { holderId: string | null; holderHost: string | null }): void;
  /** A pending restart/update request arrived on a heartbeat. 'retry' = ask again next tick. */
  onRequest?(req: PendingRequest): Promise<'handled' | 'retry'>;
  /** Bound for the release call at shutdown (default 2s). */
  releaseTimeoutMs?: number;
}

export type BootDecision = { proceed: true } | { proceed: false; message: string };

export interface RegistryKeeper {
  /** Acquire before the scheduler starts. */
  boot(): Promise<BootDecision>;
  /** Begin heartbeating (and re-probing when not yet registered). Idempotent. */
  start(): void;
  /** One tick, exposed for tests. */
  tick(): Promise<void>;
  /** Stop ticking without releasing. */
  stop(): void;
  /** Stop ticking and release the row (bounded; never throws). Skips the call when we do not hold it. */
  release(): Promise<void>;
  state(): KeeperState;
}

export function refusalMessage(r: Extract<AcquireOutcome, { kind: 'refused' }>): string {
  const where = r.holderHost ? r.holderHost : 'another host';
  const age = r.heartbeatAgeSeconds === null ? 'age unknown' : `last heartbeat ${Math.round(r.heartbeatAgeSeconds)}s ago`;
  return `a conductor for this project is already running on ${where} (${age}); refusing to start`;
}

export function createRegistryKeeper(deps: RegistryKeeperDeps): RegistryKeeper {
  const reprobeMs = deps.reprobeMs ?? DEFAULT_REPROBE_MS;
  const { identity, log } = deps;
  let state: KeeperState = 'unacquired';
  let cancelTimer: (() => void) | null = null;
  let inFlight = false;
  let outage = false;
  let outageTicks = 0;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  /** 'absent' = the functions are missing (re-probe slowly); 'transient' = an error (retry every tick). */
  let notHeldBecause: 'absent' | 'transient' = 'absent';
  let halted = false;
  let loggedRefusalFor: string | null = null;
  const requestsSeen = new Set<string>();

  /** Same-host dead-pid test on a refusal's holder (the one case that must not wait out the stale window). */
  const deadSameHostHolder = (r: Extract<AcquireOutcome, { kind: 'refused' }>): { pid: number } | null => {
    if (!r.holderId || !r.holderHost || r.holderHost !== identity.host) return null;
    const parsed = parseHolderId(r.holderId);
    if (!parsed || parsed.host !== identity.host) return null;
    // Our own pid under a different holder id is a previous incarnation (container restarts reuse pid 1).
    if (parsed.pid === deps.ownPid) return { pid: parsed.pid };
    return deps.isPidAlive(parsed.pid) ? null : { pid: parsed.pid };
  };

  const adopt = (r: Extract<AcquireOutcome, { kind: 'acquired' | 'taken_over' }>, how: string): void => {
    state = 'held';
    outage = false;
    const prev = r.previousHolderId ? ` (previous holder ${r.previousHolderId}${r.previousHost ? ` on ${r.previousHost}` : ''}${r.reason ? `, ${r.reason}` : ''})` : '';
    log(`registry: ${r.kind === 'taken_over' ? 'took over' : 'acquired'} the conductor row${how}${prev}`);
    if (r.request) log(`registry: request ${r.request.id} (${r.request.action}) is ${r.request.state}; the restarter completes it`);
  };

  /** One acquire attempt including the same-host dead-pid retry. */
  const acquireOnce = async (): Promise<AcquireOutcome> => {
    let r = await deps.client.acquire(identity);
    if (r.kind === 'refused') {
      const dead = deadSameHostHolder(r);
      if (dead) {
        log(`registry: holder ${r.holderId} is on this host and pid ${dead.pid} is not running — taking over its row`);
        r = await deps.client.acquire(identity, { takeoverDeadPid: true });
      }
    }
    return r;
  };

  const heartbeatOnce = async (): Promise<void> => {
    const r = await deps.client.heartbeat(identity);
    if (r.kind === 'held') {
      if (outage) {
        log(`registry: heartbeat recovered after ${outageTicks} failed attempt${outageTicks === 1 ? '' : 's'}`);
        outage = false;
        outageTicks = 0;
      }
      if (r.reasserted) log('registry: our lease had gone stale and no other conductor took it; re-asserted, continuing');
      const req = r.request;
      if (req && deps.onRequest && !requestsSeen.has(req.id)) {
        requestsSeen.add(req.id);
        let verdict: 'handled' | 'retry' = 'retry';
        try {
          verdict = await deps.onRequest(req);
        } catch (err) {
          log(`registry: handling request ${req.id} failed (${err instanceof Error ? err.message : String(err)})`);
        }
        if (verdict === 'retry') requestsSeen.delete(req.id);
      }
      return;
    }
    if (r.kind === 'lost') {
      state = 'lost';
      cancelTimer?.();
      cancelTimer = null;
      log(
        `registry: the conductor row is held by ${r.holderHost ?? 'another host'}${r.holderId ? ` (${r.holderId})` : ''} with a fresh heartbeat; ` +
          'this conductor is no longer the registered one — stopping launches and shutting down',
      );
      deps.onLost({ holderId: r.holderId, holderHost: r.holderHost });
      return;
    }
    // unknown: nothing is known. Keep running, keep launching, retry next tick.
    outageTicks += 1;
    if (!outage) {
      outage = true;
      log(`registry: heartbeat failed (${r.detail}); continuing, will retry every ${Math.round(deps.heartbeatMs / 1000)}s`);
    }
  };

  const reacquireOnce = async (): Promise<void> => {
    if (notHeldBecause === 'absent' && deps.now() - lastProbeAt < reprobeMs) return;
    lastProbeAt = deps.now();
    const r = await acquireOnce();
    switch (r.kind) {
      case 'acquired':
      case 'taken_over':
        adopt(r, ' (the registry is now reachable)');
        return;
      case 'refused': {
        // We are already running; another conductor holds the row. Do not exit (rule 1 spirit): say so once.
        notHeldBecause = 'absent';
        const key = r.holderId ?? r.holderHost ?? 'unknown';
        if (loggedRefusalFor !== key) {
          loggedRefusalFor = key;
          log(`registry: ${refusalMessage(r)} — NOT applied: this conductor is already running, so it continues unregistered and re-checks every ${Math.round(reprobeMs / 60_000)} minutes`);
        }
        return;
      }
      case 'unavailable':
        notHeldBecause = 'absent'; // already logged at boot; never log again
        return;
      case 'unknown':
        notHeldBecause = 'transient';
        if (!outage) {
          outage = true;
          log(`registry: acquire failed (${r.detail}); continuing unregistered, will retry`);
        }
        return;
    }
  };

  const tick = async (): Promise<void> => {
    if (state === 'lost' || halted || inFlight) return;
    inFlight = true;
    try {
      if (state === 'held') await heartbeatOnce();
      else await reacquireOnce();
    } catch (err) {
      // The client classifies and never throws; this is the belt to its braces.
      log(`registry: tick failed unexpectedly (${err instanceof Error ? err.message : String(err)}); continuing`);
    } finally {
      inFlight = false;
    }
  };

  return {
    async boot() {
      lastProbeAt = deps.now();
      const r = await acquireOnce();
      switch (r.kind) {
        case 'acquired':
        case 'taken_over':
          adopt(r, '');
          return { proceed: true };
        case 'refused':
          return { proceed: false, message: refusalMessage(r) };
        case 'unavailable':
          notHeldBecause = 'absent';
          log(`registry unavailable (${r.detail}) — the conductor registry is not deployed on this project; continuing with the same-machine check only, re-checking every ${Math.round(reprobeMs / 60_000)} minutes`);
          return { proceed: true };
        case 'unknown':
          notHeldBecause = 'transient';
          outage = true;
          log(`registry: could not acquire at boot (${r.detail}); starting anyway and retrying every ${Math.round(deps.heartbeatMs / 1000)}s`);
          return { proceed: true };
      }
    },
    start() {
      if (cancelTimer || state === 'lost' || halted) return;
      cancelTimer = deps.startInterval(deps.heartbeatMs, () => {
        void tick();
      });
    },
    tick,
    stop() {
      halted = true;
      cancelTimer?.();
      cancelTimer = null;
    },
    async release() {
      halted = true;
      cancelTimer?.();
      cancelTimer = null;
      if (state !== 'held') return;
      try {
        const r = await deps.client.release(identity.holderId, { timeoutMs: deps.releaseTimeoutMs ?? 2_000 });
        if (r.kind === 'ok') log('registry: released the conductor row');
        else if (r.kind === 'not_holder') log('registry: release skipped — the row is held by another holder');
        else log(`registry: release failed (${r.detail}) — exiting anyway; the row goes stale on its own`);
      } catch (err) {
        log(`registry: release failed (${err instanceof Error ? err.message : String(err)}) — exiting anyway`);
      }
    },
    state: () => (halted && state !== 'lost' ? 'stopped' : state),
  };
}

/** The daemon's boot step: acquire, and on a refusal write the message to stderr, log it and exit non-zero.
 *  Returns true when the boot should continue. `exit` is process.exit in the daemon (it never returns there);
 *  a test passes a recorder, so the caller MUST NOT start the scheduler when this returns false. */
export async function bootRegistry(
  keeper: Pick<RegistryKeeper, 'boot'>,
  io: { writeStderr(text: string): void; log(line: string): void; exit(code: number): void },
): Promise<boolean> {
  const decision = await keeper.boot();
  if (decision.proceed) return true;
  io.writeStderr(`${decision.message}\n`);
  io.log(decision.message);
  io.exit(1);
  return false;
}
