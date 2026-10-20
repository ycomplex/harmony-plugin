// B-1172: acting on a restart/update request that arrived on a registry heartbeat.
//
//   claim  -> conductor_claim_request. Only a 'claimed' result acts; 'expired'/'refused' are logged and dropped;
//             a transient failure asks the keeper to try again next tick.
//   act    -> STOP LAUNCHING new legs (running legs are left alone) and spawn, DETACHED, B-1171's own
//             `harmony conductor restart [--no-pull] --request <id>`. That process pulls (update only), stops
//             THIS conductor, starts the next one, confirms adoption from the board and completes the request.
//   fail   -> if the spawn itself fails, complete the request 'failed' with the reason and resume launching.
//
// If the restarter later exits while this conductor is still alive, the restart did not happen (pull failed,
// pre-flight failed...): the OLD conductor stays up with its leases, so launching resumes. A fallback timer
// covers a restarter that never exits and never stops us.

import type { PendingRequest, RegistryClient } from './conductor-registry.js';

/** Resume launching if the conductor is still running this long after the restarter was spawned. */
export const RESTART_RESUME_AFTER_MS = 15 * 60_000;

export interface RestarterChild {
  /** Called when the restarter exits. Only fires while this conductor is still alive. */
  onExit(cb: (code: number | null) => void): void;
}

export interface RequestHandlerDeps {
  client: Pick<RegistryClient, 'claimRequest' | 'completeRequest'>;
  holderId: string;
  /** Explicit --config the conductor was started with, forwarded to the restarter. */
  configPath?: string;
  /** Spawn detached (detached:true, stdio ignored, unref). Throws if the process cannot be started. */
  spawnRestarter(args: string[]): RestarterChild | void;
  pauseLaunching(): void;
  resumeLaunching(): void;
  /** One-shot timer, returns cancel. */
  startTimeout(ms: number, fn: () => void): () => void;
  log(line: string): void;
}

/** The arguments after the harmony entry point. 'restart' never pulls; 'update' pulls the configured channel. */
export function restarterArgs(req: Pick<PendingRequest, 'id' | 'action'>, configPath?: string): string[] {
  return [
    'conductor',
    'restart',
    ...(req.action === 'restart' ? ['--no-pull'] : []),
    '--request',
    req.id,
    ...(configPath ? ['--config', configPath] : []),
  ];
}

export function createRequestHandler(deps: RequestHandlerDeps): (req: PendingRequest) => Promise<'handled' | 'retry'> {
  return async (req) => {
    const claim = await deps.client.claimRequest(deps.holderId, req.id);
    if (claim.kind === 'unknown' || claim.kind === 'unavailable') {
      deps.log(`registry: could not claim request ${req.id} (${claim.detail}); will retry next tick`);
      return 'retry';
    }
    if (claim.kind !== 'claimed') {
      deps.log(`registry: request ${req.id} (${req.action}) was ${claim.kind}${claim.reason ? ` (${claim.reason})` : ''}; ignoring it`);
      return 'handled';
    }

    deps.log(`registry: claimed ${req.action} request ${req.id}${req.requestedBy ? ` from ${req.requestedBy}` : ''}; no new legs will launch, running legs are left alone`);
    deps.pauseLaunching();
    let resumed = false;
    let cancelFallback: () => void = () => {};
    const resume = (why: string): void => {
      if (resumed) return;
      resumed = true;
      cancelFallback();
      deps.resumeLaunching();
      deps.log(`registry: launching resumed (${why})`);
    };

    try {
      const child = deps.spawnRestarter(restarterArgs(req, deps.configPath));
      if (child) {
        child.onExit((code) => resume(`the restarter exited with code ${code ?? 'unknown'} while this conductor is still running; the old conductor stays`));
      }
      cancelFallback = deps.startTimeout(RESTART_RESUME_AFTER_MS, () => resume(`still running ${Math.round(RESTART_RESUME_AFTER_MS / 60_000)} minutes after the restarter was spawned`));
      deps.log(`registry: spawned the restarter (harmony ${restarterArgs(req, deps.configPath).join(' ')})`);
    } catch (err) {
      const reason = `could not spawn the restarter: ${err instanceof Error ? err.message : String(err)}`;
      deps.log(`registry: ${reason}; completing request ${req.id} as failed`);
      resume('the restarter could not be spawned');
      const done = await deps.client.completeRequest(deps.holderId, { requestId: req.id, result: 'failed', reason });
      if (done.kind !== 'ok') deps.log(`registry: completing request ${req.id} failed (${done.kind === 'refused' ? done.reason ?? 'refused' : done.detail})`);
    }
    return 'handled';
  };
}
