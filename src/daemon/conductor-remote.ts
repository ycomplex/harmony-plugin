// B-1173: the REMOTE conductor — the same daemon running as one Deployment pod (`harmony-conductor` in the
// namespace of the same name) on the project's GKE cluster. Pure, dependency-injected pieces that
// src/bin/daemon.ts wires; nothing here touches the real machine.
//
//   mode        HARMONY_CONDUCTOR_REMOTE=1 (set by the pod spec; KUBERNETES_SERVICE_HOST is deliberately not used,
//               same rule as the logger). Local behaviour is byte-unchanged when it is unset.
//   standby     a rolling update surges a SECOND pod while the first still holds the registry lease. A refused
//               boot must therefore not exit (the surge pod would crash-loop and the rollout never finish): the
//               new pod logs once, stays alive launching nothing, retries the acquire, and boots normally the
//               moment the old pod releases.
//   readiness   a file the pod's readinessProbe checks. Written once pre-flight passed and the process is either
//               conducting or standing by; removed on shutdown.
//   carry-over  the restart/update request the old pod's restarter patched the Deployment for is completed by
//               the NEW holder, which reports the plugin version before (the previous holder's, from the
//               takeover result) and after (its own).

import type { RegistryClient } from './conductor-registry.js';
import type { BootDecision, CarriedRequest } from './conductor-registry-keeper.js';

export const REMOTE_ENV = 'HARMONY_CONDUCTOR_REMOTE';
export const READY_FILE_ENV = 'HARMONY_READY_FILE';
export const DEFAULT_READY_FILE = '/tmp/harmony-ready';
/** A standby pod re-probes at most this often (a rollout must not wait out the 5-minute 'absent' cadence). */
export const STANDBY_RETRY_MS = 10_000;

type Env = Record<string, string | undefined>;

export const isRemoteConductor = (env: Env): boolean => env[REMOTE_ENV] === '1';

export const readyFilePath = (env: Env): string => env[READY_FILE_ENV] || DEFAULT_READY_FILE;

/** The channel the registry row records, from the plugin posture (shared with daemon.ts and the restarter). */
export function channelFromPosture(posture: string | undefined): 'prod' | 'staging' | null {
  if (posture === 'prod') return 'prod';
  return posture === 'ack:staging' || posture === 'staging' ? 'staging' : null;
}

export interface Readiness {
  /** Write the readiness file. Never throws (a failure is logged; the probe then keeps the pod NotReady). */
  markReady(): void;
  /** Remove it (shutdown). Never throws. */
  clear(): void;
}

export function createReadiness(deps: {
  path: string;
  writeFile(path: string, text: string): void;
  removeFile(path: string): void;
  log(line: string): void;
}): Readiness {
  return {
    markReady() {
      try {
        deps.writeFile(deps.path, 'ready\n');
        deps.log(`readiness: wrote ${deps.path}`);
      } catch (err) {
        deps.log(`readiness: could not write ${deps.path} (${err instanceof Error ? err.message : String(err)}); the pod stays NotReady`);
      }
    },
    clear() {
      try {
        deps.removeFile(deps.path);
      } catch {
        // already gone
      }
    },
  };
}

export interface StandbyIo {
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  retryMs: number;
  /** True once a shutdown signal arrived while standing by. */
  isStopped(): boolean;
  /** Called once, when the first attempt was refused and this process starts standing by. */
  onStandby?(): void;
}

/** Boot the registry in remote mode. A refusal never exits: log ONCE, stand by (no scheduler, no launching) and
 *  retry the acquire every `retryMs` until it is granted. 'acquired' = proceed to the normal boot; 'stopped' = a
 *  shutdown signal arrived first. The loop's timer is a ref'd sleep, which is what keeps the process alive. */
export async function bootRemoteRegistry(
  keeper: { boot(): Promise<BootDecision> },
  io: StandbyIo,
): Promise<'acquired' | 'stopped'> {
  let decision = await keeper.boot();
  if (decision.proceed) return 'acquired';
  io.log(`standby: ${decision.message}; staying alive without launching and retrying every ${Math.round(io.retryMs / 1000)}s until the lease is free`);
  io.onStandby?.();
  while (!io.isStopped()) {
    await io.sleep(io.retryMs);
    if (io.isStopped()) break;
    decision = await keeper.boot();
    if (decision.proceed) {
      io.log('standby: the lease is free; acquired it, booting normally');
      return 'acquired';
    }
  }
  return 'stopped';
}

const REASON_MAX = 500;

/** Completes the request a previous holder claimed. 'done' with a reason recording the plugin version before and
 *  after; 'failed' only for a request this build cannot interpret. A request that is not 'claimed' (already
 *  settled, or never claimed) is left alone. */
export function createCarriedRequestCompleter(deps: {
  client: Pick<RegistryClient, 'completeRequest'>;
  holderId: string;
  /** This process's own plugin version. */
  pluginVersion: string | null;
  log(line: string): void;
}): (info: CarriedRequest) => Promise<void> {
  return async ({ request, previousPluginVersion }) => {
    if (request.state !== 'claimed') {
      deps.log(`registry: carried-over request ${request.id} is ${request.state}, not claimed; leaving it alone`);
      return;
    }
    const before = previousPluginVersion ?? 'unknown';
    const after = deps.pluginVersion ?? 'unknown';
    let result: 'done' | 'failed';
    let reason: string;
    if (request.action !== 'restart' && request.action !== 'update') {
      result = 'failed';
      reason = `unrecognised request action "${request.action}"; plugin ${before} -> ${after}`;
    } else {
      result = 'done';
      reason = `${request.action} completed by the new conductor pod: plugin ${before === after ? `${after} (unchanged)` : `${before} -> ${after}`}`;
    }
    const r = await deps.client.completeRequest(deps.holderId, {
      requestId: request.id,
      result,
      reason: reason.slice(0, REASON_MAX),
      versionBefore: previousPluginVersion,
      versionAfter: deps.pluginVersion,
    });
    const note = r.kind === 'ok' ? 'ok' : r.kind === 'refused' ? `refused (${r.reason ?? 'no reason'})` : `${r.kind} (${r.detail})`;
    deps.log(`registry: completed carried-over request ${request.id} as ${result}: ${note} — ${reason}`);
  };
}
