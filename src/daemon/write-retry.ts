// B-845: a flaky auth-token exchange (JWT expiry, PGRST303) or a transient network blip must
// self-heal within the SAME daemon tick instead of failing the whole pass. This module is the one
// place that decides WHETHER a caught write failure is safe to retry, and HOW — table-driven
// classification (classifyRetrySafety) plus a dependency-injected wrapper (withWriteRetry) that
// every retried write goes through.
//
// Two retry-safety CLASSES, named at each call site (never inferred here):
//
//   'idempotent' — the write's own guard makes a retry safe unconditionally (heartbeat.ts's
//                  updateConductionIfHeld: guarded on id + self-held lease_holder only). Retries on
//                  PGRST303 AND both network buckets below.
//   'cas'        — a compare-and-swap write (scheduler.ts's takeoverConduction / stealConduction)
//                  whose retry, against the CALLER's originally observed value, would silently
//                  misread a landed write as a loss: if attempt 1 actually reached the server,
//                  `lease_holder` is now THIS daemon's own id, so the retry's compare predicate no
//                  longer matches and returns null (read as "lost", when it actually won). Retries
//                  on PGRST303 and PRE-SEND network errors only — NEVER a post-send/ambiguous one,
//                  because the server-side outcome of that attempt is genuinely unknown.
//
// classifyRetrySafety's three buckets (by the undici cause-chain error code — same traversal
// error-format.ts's describeCause walks, reused via its sibling export findCauseCode):
//
//   pre-send  — the request never reached the server: ECONNREFUSED, ENOTFOUND, EAI_AGAIN, a TLS
//               handshake failure (UNABLE_TO_VERIFY_LEAF_SIGNATURE, CERT_HAS_EXPIRED). Safe to
//               retry freely, for either class.
//   post-send — the request may or may not have reached the server: ETIMEDOUT, ECONNRESET,
//               UND_ERR_SOCKET, the literal message 'socket hang up' (see the inline comment at
//               that check for why it is the one string-match exception), or a response stream
//               failing mid-read. Also the default for a missing/unrecognized code — an unknown
//               failure mode gets the CONSERVATIVE (never-retry-for-CAS) classification, not the
//               permissive one.
//   pgrst303  — the Supabase JWT expired mid-tick. Handled separately from the two network buckets
//               (see withWriteRetry): force a fresh exchange, then retry the write exactly once.

import { findCauseCode } from './error-format.js';

export type RetrySafety = 'pre-send' | 'post-send' | 'pgrst303';

export type RetryWriteClass = 'idempotent' | 'cas';

const PRE_SEND_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
]);

const POST_SEND_CODES: ReadonlySet<string> = new Set(['ETIMEDOUT', 'ECONNRESET', 'UND_ERR_SOCKET']);

function isPgrst303(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'PGRST303'
  );
}

/** Classify a caught write failure into one retry-safety bucket. Table-driven and free of
 *  message-string matching, with exactly ONE named exception: undici surfaces a peer reset mid-
 *  request as a plain Error whose `.message` is literally 'socket hang up' with NO machine-readable
 *  `.code` anywhere in its shape — there is nothing else to key on, and the safe classification for
 *  it (post-send/ambiguous: the server may already have applied the write before the socket
 *  dropped) has to be reached some way, so this one case matches on message text rather than being
 *  silently mis-bucketed as "unknown". Every other bucket is decided purely by error CODE. */
export function classifyRetrySafety(err: unknown): RetrySafety {
  if (isPgrst303(err)) return 'pgrst303';

  // The one string-match exception — see the function doc above.
  if (err instanceof Error && err.message === 'socket hang up') return 'post-send';

  const code = findCauseCode(err);
  if (code && PRE_SEND_CODES.has(code)) return 'pre-send';
  if (code && POST_SEND_CODES.has(code)) return 'post-send';
  // none/unknown code — default to the conservative ambiguous bucket, never the permissive one.
  return 'post-send';
}

export interface WriteRetryDeps {
  /** HarmonyAuth.forceRefresh(), bound to the daemon's single lifetime auth instance. A rejection
   *  here is NOT caught by withWriteRetry — it carries its own `.endpoint` (src/auth.ts's exchange)
   *  and surfaces directly to the caller, which reports it and lets the next tick retry. */
  forceRefresh(): Promise<void>;
  /** Injected backoff sleep — the B-532 pattern, so retry timing is fake-clock unit-testable. */
  sleep(ms: number): Promise<void>;
}

export interface WriteRetryOptions {
  class: RetryWriteClass;
  /** A descriptive label for this write (e.g. 'conductions.stealConduction') — tagged onto a
   *  final (non-retried) failure's `.endpoint` property, mirroring src/auth.ts's own endpoint-
   *  tagging convention, so ANY downstream `formatDaemonError(err)` call (even one that passes no
   *  `opts` at all — every existing daemon catch site) still names which write failed. Never
   *  overwrites an `.endpoint` the error already carries (e.g. a forceRefresh() failure's own auth
   *  endpoint) — see tagEndpoint below. */
  endpoint?: string;
}

/** Network-error backoff, bounded: 250ms then 750ms (two retries) — comfortably inside
 *  HARMONY_DAEMON_POLL_MS's 25s default (src/daemon/config.ts), so a burst delays a pass rather
 *  than ever overlapping the next one. */
const NETWORK_BACKOFFS_MS = [250, 750] as const;

function tagEndpoint(err: unknown, endpoint: string | undefined): void {
  if (!endpoint) return;
  if (typeof err === 'object' && err !== null && !('endpoint' in err)) {
    (err as { endpoint?: string }).endpoint = endpoint;
  }
}

/** Wrap ONE write with B-845's self-healing retry policy. Deliberately excluded from this wrapper
 *  everywhere in the daemon: the worker-launch/fire call (`runCommand` in fireLaunch) and the reap
 *  call — a launch is not a write this module's contract applies to, and re-firing a worker on a
 *  transient blip is a completely different (and much larger) hazard than retrying a guarded DB
 *  write. See scheduler.test.ts's source-inspection test pinning that exclusion.
 *
 *  Three PGRST303 outcomes (never more than one forced refresh, never a loop):
 *    (a) forceRefresh() succeeds, the retried write lands  → return its result.
 *    (b) forceRefresh() itself fails                       → that failure (carrying its own
 *        `.endpoint`, see src/auth.ts) propagates directly, uncaught by this loop — report it and
 *        let the next tick retry.
 *    (c) forceRefresh() succeeds but the retried write fails for a DIFFERENT reason → report THAT
 *        error; the original expiry is never re-reported. */
export async function withWriteRetry<T>(
  deps: WriteRetryDeps,
  opts: WriteRetryOptions,
  fn: () => Promise<T>,
): Promise<T> {
  let pgrstRefreshed = false;
  let networkRetriesUsed = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const safety = classifyRetrySafety(err);

      if (safety === 'pgrst303' && !pgrstRefreshed) {
        pgrstRefreshed = true;
        // (b): a forceRefresh() failure propagates straight out of this catch, untagged and
        // unretried — it already carries its own endpoint.
        await deps.forceRefresh();
        // Retry exactly once — (a) success, or (c) whatever THIS attempt throws, on the next loop
        // iteration. Never a second forced refresh even if the retry hits PGRST303 again (falls
        // through to the non-retryable branch below, since `pgrstRefreshed` is now true).
        continue;
      }

      const networkRetryAllowed =
        safety === 'pre-send' || (safety === 'post-send' && opts.class === 'idempotent');

      if (networkRetryAllowed && networkRetriesUsed < NETWORK_BACKOFFS_MS.length) {
        const backoffMs = NETWORK_BACKOFFS_MS[networkRetriesUsed];
        networkRetriesUsed += 1;
        await deps.sleep(backoffMs);
        continue;
      }

      tagEndpoint(err, opts.endpoint);
      throw err;
    }
  }
}
