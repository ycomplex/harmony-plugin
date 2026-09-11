// B-1009: the ONE consumer of B-973's `notify` declaration — it SYNCS a project's declared
// subscriptions to the board and stops there. It still never opens a network connection to a
// declared `endpoint`: the dispatch itself is Supabase-hosted (an edge function driven by a pg_net
// webhook plus a pg_cron sweep, web PR #476). See docs/notify-outbox-contract.md §8 C9.
//
// AC1 IS THE WHOLE POINT: declaring `notify` in `.harmony/project.yml` is the only step an operator
// takes. Nothing is hand-edited in the database — a gate run carries the declaration across.
//
// AC6 IS THE CONSTRAINT THAT SHAPES EVERY LINE BELOW: running a project's gates must NEVER fail,
// hang or slow down because this sync could not reach the board. Concretely, and tested as such in
// gates.test.ts across four sync outcomes (success, unreachable board, absent RPC, timeout):
//
//   * NOTHING HAPPENS when the declaration's hash is unchanged — no RPC, no auth, no cache write.
//     That is the steady state for every project on every gate run, declared or not.
//   * The RPC runs under a HARD 3s timeout that ABANDONS the call (an AbortSignal handed to the
//     caller AND a race that stops waiting), never a slow-path log that still blocks.
//   * EVERY failure — unreachable board, absent RPC, timeout, malformed response, unwritable
//     cache — produces EXACTLY ONE stderr warning and nothing else. This module never throws to its
//     caller, never touches an exit code, and never writes a byte to stdout.
//
// THE ABSENT RPC IS THE CURRENT REAL-WORLD STATE, NOT A HYPOTHETICAL. The web half (the migration
// that creates `notify_sync_subscriptions`) merges on its own schedule, and per the workspace's
// propagation rules (B-846) plugin `main` runs against a board that may not have it yet. Tolerance
// over ordering: an absent RPC is a one-line warning and a no-op, the cache is NOT written, and the
// very next gate run after the migration lands syncs for real. `isMissingRelationOrFunction`
// (src/tools/acceptance-events.ts) is reused verbatim rather than re-deriving the codes here.
//
// Pure and dependency-injected, with ZERO hidden globals: the RPC caller, the cache reader/writer
// and the clock all arrive through `NotifySyncIO`. Production wiring lives only in
// src/cli/commands/gates.ts's `registerGatesCommands`.

import { createHash } from 'node:crypto';
import { isMissingRelationOrFunction } from '../tools/acceptance-events.js';
import { getNotifyEntries, type NotifyEntry, type ProjectManifest } from './project-manifest.js';

/** Where the sync's hash cache lives, relative to a project's repo root. Gitignored, exactly like
 *  B-992's `.harmony/.gate-evidence/` marker directory it sits beside — it is a local cache, never
 *  a source of truth, and deleting it costs at most one redundant (idempotent) sync. */
export const NOTIFY_SYNC_CACHE_RELATIVE_PATH = '.harmony/.notify-sync.json';

export function notifySyncCachePath(projectRoot: string): string {
  return `${projectRoot}/${NOTIFY_SYNC_CACHE_RELATIVE_PATH}`;
}

/** The HARD ceiling on the board call. Three seconds, abandoned rather than awaited (AC6). */
export const NOTIFY_SYNC_TIMEOUT_MS = 3000;

/** Bumped if `normalizeNotifyDeclaration` ever changes shape — it is mixed into the hash, so an old
 *  cache entry can never be read as "unchanged" against a differently-normalized declaration. */
const NORMALIZATION_VERSION = 1;

/** One subscription in the exact shape `notify_sync_subscriptions(p_project_id, p_subscriptions)`
 *  expects: `[{"endpoint_url": "https://...", "transitions": ["Verified", ...]}, ...]`. The RPC
 *  matches `transitions` against a `field_change` event's `new_value` for `workflow_state`, so the
 *  values here are BARE STATE NAMES ("Verified"), not the manifest's `"reaching Verified"` prose. */
export interface NotifySubscriptionDeclaration {
  endpoint_url: string;
  transitions: string[];
}

/** What the sync did, returned for tests and callers that care; no caller changes behavior on it. */
export type NotifySyncOutcome =
  | { kind: 'undeclared' }
  | { kind: 'unchanged'; hash: string }
  | { kind: 'synced'; hash: string }
  | { kind: 'warned'; reason: 'absent-rpc' | 'timeout' | 'unreachable' | 'malformed' | 'cache-write' };

/** Everything this module touches outside itself. */
export interface NotifySyncIO {
  /** Calls `notify_sync_subscriptions` with the normalized declaration. MUST REJECT on any failure
   *  (production converts a PostgREST `{ data, error }` pair into a throw that carries `code`, so
   *  `isMissingRelationOrFunction` can classify it). MUST honour `signal`: on abort it should stop
   *  the in-flight request rather than leave it running. Resolves with the RPC's JSON result. */
  callSyncRpc: (subscriptions: NotifySubscriptionDeclaration[], signal: AbortSignal) => Promise<unknown>;
  /** The cache file's contents, or `null` when absent/unreadable. An unreadable cache is a MISS
   *  (re-sync), never a warning: the sync is idempotent, so a redundant one costs nothing. */
  readCache: (path: string) => string | null;
  /** Writes the cache file. MAY throw — a throw is the one warning for this run. */
  writeCache: (path: string, contents: string) => void;
  /** Override for tests; defaults to NOTIFY_SYNC_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Override for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface NotifySyncParams {
  projectRoot: string;
  /** The declared entries, already parsed off the manifest (`getNotifyEntries`). */
  entries: NotifyEntry[];
  io: NotifySyncIO;
  /** Emits the AT MOST ONE warning line. Production passes the gate runner's stderr writer. */
  warn: (line: string) => void;
}

interface CacheFile {
  version: number;
  hash: string;
  synced_at: string;
}

/** `"reaching Verified"` -> `"Verified"`. The manifest's `on` is human-readable prose over the
 *  fixed DECLARABLE_TRANSITIONS list; the board stores the bare workflow_state the task ARRIVES at,
 *  because that is what an activity event's `new_value` carries. A value without the prefix is
 *  passed through trimmed rather than dropped — the loader has already rejected anything outside
 *  DECLARABLE_TRANSITIONS, so this can only be a future prefix-less member of that list. */
function transitionStateOf(on: string): string {
  const trimmed = on.trim();
  return trimmed.startsWith('reaching ') ? trimmed.slice('reaching '.length).trim() : trimmed;
}

/** Declaration -> board shape, DETERMINISTICALLY: entries are grouped by endpoint (a repo declaring
 *  three transitions for one URL is ONE subscription with three transitions, which is what the
 *  board's `(project_id, endpoint_url)` key means), and both endpoints and transitions are sorted
 *  and de-duplicated. Determinism is load-bearing: the hash below must not change when someone
 *  reorders two lines in the YAML, or every reorder would cost a board call. */
export function normalizeNotifyDeclaration(entries: NotifyEntry[]): NotifySubscriptionDeclaration[] {
  const byEndpoint = new Map<string, Set<string>>();
  for (const entry of entries) {
    const url = entry.endpoint.trim();
    const transition = transitionStateOf(entry.on);
    if (!url || !transition) continue;
    const set = byEndpoint.get(url) ?? new Set<string>();
    set.add(transition);
    byEndpoint.set(url, set);
  }
  return [...byEndpoint.entries()]
    .map(([endpoint_url, transitions]) => ({ endpoint_url, transitions: [...transitions].sort() }))
    .sort((a, b) => (a.endpoint_url < b.endpoint_url ? -1 : a.endpoint_url > b.endpoint_url ? 1 : 0));
}

/** The cache key: sha256 over the normalized declaration plus the normalization version. */
export function hashNotifyDeclaration(subscriptions: NotifySubscriptionDeclaration[]): string {
  return createHash('sha256')
    .update(`v${NORMALIZATION_VERSION}\n${JSON.stringify(subscriptions)}`)
    .digest('hex');
}

function readCachedHash(io: NotifySyncIO, path: string): string | null {
  let raw: string | null;
  try {
    raw = io.readCache(path);
  } catch {
    return null; // unreadable cache == cache miss, deliberately silent (see NotifySyncIO.readCache)
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CacheFile> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== NORMALIZATION_VERSION) return null;
    return typeof parsed.hash === 'string' && parsed.hash ? parsed.hash : null;
  } catch {
    return null;
  }
}

/** Sentinel for the hard timeout, so the classifier can tell "we abandoned it" from "it failed". */
class NotifySyncTimeoutError extends Error {
  constructor(ms: number) {
    super(`the board did not answer within ${ms}ms`);
    this.name = 'NotifySyncTimeoutError';
  }
}

/** The hard timeout: aborts the caller's request AND stops waiting on it. Both halves matter — the
 *  abort is what makes it a real abandonment rather than a leaked in-flight promise, and the race is
 *  what guarantees the gate run proceeds on schedule even if a caller ignores the signal. */
async function callWithHardTimeout(
  io: NotifySyncIO,
  subscriptions: NotifySubscriptionDeclaration[],
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NotifySyncTimeoutError(timeoutMs));
    }, timeoutMs);
    // Never hold the process open on account of this timer.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    const call = Promise.resolve(io.callSyncRpc(subscriptions, controller.signal));
    // A rejection from the abandoned call after the race resolves must not become an unhandled
    // rejection — it is already accounted for by whichever branch won.
    call.catch(() => undefined);
    return await Promise.race([call, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describe(err: unknown): string {
  const message = (err as { message?: string })?.message;
  return message && message.trim() ? message.trim() : String(err);
}

/** The whole sync. Returns what it did; NEVER throws, NEVER writes to stdout, NEVER affects an exit
 *  code, and emits at most one line through `warn`. */
export async function syncNotifySubscriptions(params: NotifySyncParams): Promise<NotifySyncOutcome> {
  const { projectRoot, entries, io } = params;
  let warned = false;
  const warnOnce = (detail: string): void => {
    if (warned) return;
    warned = true;
    params.warn(
      `harmony notify sync: WARNING — the notify declaration was NOT synced to the board ` +
        `(${detail}); this gate run is unaffected and the next run retries.`,
    );
  };

  try {
    if (!entries || entries.length === 0) return { kind: 'undeclared' };

    const subscriptions = normalizeNotifyDeclaration(entries);
    if (subscriptions.length === 0) return { kind: 'undeclared' };

    const hash = hashNotifyDeclaration(subscriptions);
    const cachePath = notifySyncCachePath(projectRoot);
    if (readCachedHash(io, cachePath) === hash) return { kind: 'unchanged', hash };

    let result: unknown;
    try {
      result = await callWithHardTimeout(io, subscriptions, io.timeoutMs ?? NOTIFY_SYNC_TIMEOUT_MS);
    } catch (err: unknown) {
      if (err instanceof NotifySyncTimeoutError) {
        warnOnce(`timed out after ${io.timeoutMs ?? NOTIFY_SYNC_TIMEOUT_MS}ms and was abandoned`);
        return { kind: 'warned', reason: 'timeout' };
      }
      if (isMissingRelationOrFunction(err as { message?: string; code?: string })) {
        warnOnce(
          `this board has no notify_sync_subscriptions RPC yet — the B-1009 migration has not been ` +
            `applied to it: ${describe(err)}`,
        );
        return { kind: 'warned', reason: 'absent-rpc' };
      }
      warnOnce(`the board could not be reached or refused the call: ${describe(err)}`);
      return { kind: 'warned', reason: 'unreachable' };
    }

    if (result === null || result === undefined || typeof result !== 'object') {
      warnOnce(`notify_sync_subscriptions returned an unreadable result (${typeof result})`);
      return { kind: 'warned', reason: 'malformed' };
    }

    const cache: CacheFile = {
      version: NORMALIZATION_VERSION,
      hash,
      synced_at: (io.now ?? (() => new Date()))().toISOString(),
    };
    try {
      io.writeCache(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    } catch (err: unknown) {
      warnOnce(`the declaration synced, but its hash cache could not be written: ${describe(err)}`);
      return { kind: 'warned', reason: 'cache-write' };
    }

    return { kind: 'synced', hash };
  } catch (err: unknown) {
    // The backstop. Nothing above is expected to reach here; if it does, it is still ONE line.
    warnOnce(describe(err));
    return { kind: 'warned', reason: 'malformed' };
  }
}

/** Convenience for the gate runner: does the manifest declare `notify` at all? Gating on this keeps
 *  the steady state at ZERO board calls for every project that declares nothing. */
export function manifestDeclaresNotify(manifest: ProjectManifest): boolean {
  return getNotifyEntries(manifest).length > 0;
}
