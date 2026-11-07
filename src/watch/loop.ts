/**
 * `harmony watch` loop (B-1422). Everything impure is injected (`now`, `sleep`, the board reader,
 * the hint source, the writers), so the whole loop runs on a fake clock in tests.
 *
 * Wait between fetches: `Promise.race([sleep(pollMs), hint.next()])`; when a hint wins, a further
 * `hintDelayMs` before fetching. Realtime only shortens the wait: with `hint = null` every change
 * still arrives within one poll interval.
 *
 * Failures never escape: a fetch or auth error backs off 5 s, 15 s, 30 s, then every 60 s, with ONE
 * `health` line on the first failure (`offline`, or `auth-failed` for a rejected credential) and ONE
 * `health recovered` line when a fetch succeeds again, followed by the catch-up from the cursor.
 * A dead Realtime channel is one `health degraded` line; polling goes on.
 *
 * Modes:
 *   - `until-event`: exit 0 once a seat-owned event (other than `health`) has been seen and a
 *     `settleMs` window has passed (events that arrive together are reported together); exit 3
 *     when `maxWaitMs` passes with nothing seat-owned.
 *   - `follow`: stream forever (until aborted).
 *   - `once`: catch up, print the current state of every watched ticket, exit 0. The cursor is
 *     never written in this mode. If the board cannot be read after `ONCE_MAX_ATTEMPTS` tries it
 *     exits 3.
 * Exit 2 is reserved for fatal configuration (a scope that cannot resolve). The `start` event is
 * the command's, not the loop's; it is `info` and never a wake.
 */
import type { BoardReader, BoardSnapshot } from './board-read.js';
import { healthEvent, type WatchEvent } from './classify.js';
import { catchUp, currentRows, DEFAULT_REMIND_MS, type CurrentRow } from './cursor.js';
import { isAuthError, safeErrorMessage } from './guarded-client.js';
import type { SeatMarker } from './markers.js';
import type { Heartbeat, SeatProfile, WatchCursor, WatchHealth, WatchScope } from './seat-files.js';

export type WatchMode = 'until-event' | 'follow' | 'once';

export const DEFAULT_POLL_MS = 30_000;
export const DEFAULT_HINT_DELAY_MS = 10_000;
export const DEFAULT_SETTLE_MS = 3_000;
export const DEFAULT_MARKER_SCAN_MS = 10 * 60_000;
/** `once` gives up (exit 3) after this many consecutive failed fetches. */
export const ONCE_MAX_ATTEMPTS = 3;
export const BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

/** Backoff before the next attempt after `failures` consecutive failures (1-based). */
export function backoffMs(failures: number): number {
  return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1];
}

export interface HintLike {
  next(): Promise<unknown>;
  abandon?(): void;
}

export interface RunWatchOptions {
  seat: string;
  projectKey: string;
  scopeSlug: string;
  profile: SeatProfile | null;
  pid?: number;
  pollMs?: number;
  hintDelayMs?: number;
  settleMs?: number;
  maxWaitMs?: number | null;
  remindMs?: number;
  quietMs?: number;
  idleMs?: number;
  markerScanMs?: number;
}

export interface RunWatchDeps {
  now(): number;
  /** Resolve after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  reader: Pick<BoardReader, 'resolveScope' | 'readSnapshot'>;
  scope: WatchScope;
  hint: HintLike | null;
  /** True once the hint channel is permanently dead. */
  hintDead?: () => boolean;
  emit(event: WatchEvent): void;
  cursor: WatchCursor | null;
  writeCursor?(cursor: WatchCursor): void;
  writeHeartbeat?(hb: Heartbeat): void;
  /** Open seat-starts on these tickets from OTHER sessions (milestone scope only). */
  markerScan?: (taskIds: string[]) => Promise<SeatMarker[]>;
  /** `once` mode's current-state listing. */
  printCurrent?(rows: CurrentRow[]): void;
  /** Diagnostics (stderr). */
  log?(line: string): void;
  signal?: AbortSignal;
  mode: WatchMode;
  options: RunWatchOptions;
}

export interface RunWatchResult {
  exitCode: 0 | 2 | 3;
  reason: 'event' | 'max-wait' | 'once' | 'aborted' | 'fatal';
  cursor: WatchCursor | null;
  detail?: string;
}

/** A wake: a seat-owned event other than `health` or `start`. */
export function isWake(e: WatchEvent): boolean {
  return e.owner === 'seat' && e.event !== 'health' && e.event !== 'start';
}

function isScopeError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'ScopeError';
}

export async function runWatch(deps: RunWatchDeps): Promise<RunWatchResult> {
  const o = deps.options;
  const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  const hintDelayMs = o.hintDelayMs ?? DEFAULT_HINT_DELAY_MS;
  const settleMs = o.settleMs ?? DEFAULT_SETTLE_MS;
  const markerScanMs = o.markerScanMs ?? DEFAULT_MARKER_SCAN_MS;
  const remindMs = o.remindMs ?? DEFAULT_REMIND_MS;
  const startedAt = deps.now();
  const startedIso = new Date(startedAt).toISOString();
  const log = deps.log ?? (() => {});

  let cursor = deps.cursor;
  let failures = 0;
  let failureKind: 'offline' | 'auth-failed' | null = null;
  let failureSince: string | null = null;
  let lastFetchAt: string | null = null;
  let lastOkAt: string | null = null;
  let hbSeq = 0;
  let degradedReported = false;
  let lastMarkerScan = -Infinity;
  const warnedSessions = new Set<string>();
  let lastIds: string[] = [];
  let firstWakeAt: number | null = null;
  const exitSeen = new Map<string, string | null>();

  const aborted = () => deps.signal?.aborted === true;

  const emit = (e: WatchEvent) => {
    try {
      deps.emit(e);
    } catch (err) {
      log(`watch: emit failed: ${safeErrorMessage(err)}`);
    }
  };

  const healthNow = (): WatchHealth => {
    if (failureKind) return failureKind;
    if (deps.hintDead?.()) return 'degraded';
    return 'ok';
  };

  const heartbeat = () => {
    if (!deps.writeHeartbeat) return;
    try {
      deps.writeHeartbeat({
        schema: 1,
        pid: o.pid ?? process.pid,
        seat: o.seat,
        scope: o.scopeSlug,
        mode: deps.mode,
        poll_interval_s: pollMs / 1000,
        started_at: startedIso,
        last_fetch_at: lastFetchAt,
        last_ok_at: lastOkAt,
        health: healthNow(),
        seq: hbSeq++,
      });
    } catch (err) {
      log(`watch: heartbeat write failed: ${safeErrorMessage(err)}`);
    }
  };

  const healthSeq = (e: WatchEvent): WatchEvent => {
    e.cursor = cursor?.seq ?? 0;
    return e;
  };

  /** One fetch + catch-up. */
  const fetchOnce = async (): Promise<{ ok: true; events: WatchEvent[]; snapshot: BoardSnapshot } | { ok: false; fatal?: string }> => {
    const t = deps.now();
    lastFetchAt = new Date(t).toISOString();
    let snapshot: BoardSnapshot;
    let ids: string[];
    try {
      ids = await deps.reader.resolveScope(deps.scope);
      const union = [...new Set([...ids, ...Object.keys(cursor?.tickets ?? {})])];
      snapshot = await deps.reader.readSnapshot(union);
    } catch (err) {
      if (isScopeError(err)) return { ok: false, fatal: safeErrorMessage(err) };
      failures += 1;
      const kind = isAuthError(err) ? 'auth-failed' : 'offline';
      if (failureKind !== kind) {
        failureKind = kind;
        failureSince = failureSince ?? lastFetchAt;
        emit(healthSeq(healthEvent(t, kind, o.profile, { since: failureSince, detail: safeErrorMessage(err) })));
      }
      heartbeat();
      return { ok: false };
    }
    lastIds = ids;
    lastOkAt = lastFetchAt;
    if (failureKind) {
      emit(healthSeq(healthEvent(t, 'recovered', o.profile, { since: failureSince ?? undefined, detail: `${failureKind} since ${failureSince}` })));
      failures = 0;
      failureKind = null;
      failureSince = null;
    }
    const result = catchUp(cursor, snapshot, {
      now: t,
      profile: o.profile,
      projectKey: o.projectKey,
      seat: o.seat,
      remindMs,
      quietMs: o.quietMs,
      idleMs: o.idleMs,
      inScope: new Set(ids),
      exitSeen,
    });
    for (const e of result.events) emit(e);
    if (result.changed) {
      if (deps.mode !== 'once' && deps.writeCursor) {
        try {
          deps.writeCursor(result.next);
        } catch (err) {
          log(`watch: cursor write failed: ${safeErrorMessage(err)}`);
        }
      }
    }
    cursor = result.next;
    heartbeat();
    return { ok: true, events: result.events, snapshot };
  };

  const scanMarkers = async () => {
    if (!deps.markerScan || lastIds.length === 0) return;
    const t = deps.now();
    if (t - lastMarkerScan < markerScanMs) return;
    lastMarkerScan = t;
    try {
      const hits = await deps.markerScan(lastIds);
      for (const h of hits) {
        if (warnedSessions.has(h.session)) continue;
        warnedSessions.add(h.session);
        emit(
          healthSeq(
            healthEvent(deps.now(), 'warning', o.profile, {
              detail: `another seat (${h.seat}, session ${h.session}) has an open seat-start on this milestone`,
            }),
          ),
        );
      }
    } catch (err) {
      log(`watch: seat-marker scan failed: ${safeErrorMessage(err)}`);
    }
  };

  const checkDegraded = () => {
    if (!degradedReported && deps.hint && deps.hintDead?.()) {
      degradedReported = true;
      emit(healthSeq(healthEvent(deps.now(), 'degraded', o.profile, { detail: 'realtime hints unavailable; polling every ' + pollMs / 1000 + 's' })));
    }
  };

  /** Wait up to `ms`; a hint shortens it to `hintDelayMs`. */
  const waitNext = async (ms: number, allowHint: boolean) => {
    if (ms <= 0 || aborted()) return;
    const child = new AbortController();
    const onAbort = () => child.abort();
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (!allowHint || !deps.hint) {
        await deps.sleep(ms, child.signal);
        return;
      }
      let hinted = false;
      const hintP = Promise.resolve()
        .then(() => deps.hint!.next())
        .then(
          () => {
            hinted = true;
          },
          () => {},
        );
      await Promise.race([deps.sleep(ms, child.signal), hintP]);
      try {
        deps.hint.abandon?.();
      } catch {
        // ignore
      }
      child.abort();
      if (hinted && !aborted()) await deps.sleep(Math.min(hintDelayMs, ms), deps.signal);
    } finally {
      child.abort();
      deps.signal?.removeEventListener('abort', onAbort);
    }
  };

  const maxWait = deps.mode === 'until-event' ? (o.maxWaitMs ?? null) : null;
  const remaining = () => (maxWait === null ? Infinity : maxWait - (deps.now() - startedAt));

  for (;;) {
    if (aborted()) return { exitCode: 0, reason: 'aborted', cursor };
    const res = await fetchOnce();
    if (!res.ok && res.fatal) {
      return { exitCode: 2, reason: 'fatal', cursor, detail: res.fatal };
    }
    if (res.ok) {
      if (deps.mode === 'once') {
        deps.printCurrent?.(currentRows(res.snapshot, { now: deps.now(), profile: o.profile, quietMs: o.quietMs }));
        return { exitCode: 0, reason: 'once', cursor };
      }
      await scanMarkers();
      if (deps.mode === 'until-event' && firstWakeAt === null && res.events.some(isWake)) firstWakeAt = deps.now();
    }
    checkDegraded();

    if (deps.mode === 'until-event') {
      if (firstWakeAt !== null) {
        const settleLeft = settleMs - (deps.now() - firstWakeAt);
        if (settleLeft <= 0) return { exitCode: 0, reason: 'event', cursor };
        await waitNext(settleLeft, false);
        continue;
      }
      if (remaining() <= 0) return { exitCode: 3, reason: 'max-wait', cursor };
    }

    if (deps.mode === 'once' && !res.ok && failures >= ONCE_MAX_ATTEMPTS) {
      return { exitCode: 3, reason: 'max-wait', cursor, detail: 'board unreachable' };
    }

    const base = res.ok ? pollMs : backoffMs(failures);
    await waitNext(Math.min(base, remaining()), res.ok);
    if (deps.mode === 'until-event' && firstWakeAt === null && remaining() <= 0 && !aborted()) {
      // One last look before giving up, so a change that landed during the final wait is not lost.
      const last = await fetchOnce();
      if (last.ok && last.events.some(isWake)) {
        firstWakeAt = deps.now();
        continue;
      }
      return { exitCode: 3, reason: 'max-wait', cursor };
    }
  }
}

/**
 * Retry `fn` with the watch's backoff until it succeeds, `signal` aborts or `deadlineMs` passes.
 * `onFailure` is called on EVERY failure with the attempt number (1-based); the caller decides
 * which ones to print. Returns `{ ok: false }` on abort / deadline.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    signal?: AbortSignal;
    deadlineMs?: number | null;
    onFailure(err: unknown, attempt: number): 'retry' | 'stop';
  },
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const start = opts.now();
  let attempt = 0;
  let lastErr: unknown = null;
  for (;;) {
    if (opts.signal?.aborted) return { ok: false, error: lastErr };
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (opts.onFailure(err, attempt) === 'stop') return { ok: false, error: err };
    }
    let wait = backoffMs(attempt);
    if (opts.deadlineMs != null) {
      const left = opts.deadlineMs - (opts.now() - start);
      if (left <= 0) return { ok: false, error: lastErr };
      wait = Math.min(wait, left);
    }
    await opts.sleep(wait, opts.signal);
  }
}
