// B-1174: ships the conductor's structured log entries to Cloud Logging.
//
// FULLY OFF unless the merged conductor config names `gcp.project` AND `log_shipping` is not false. The
// check is re-run on every enqueue and every flush (both getters are live), so a hot config change takes
// effect within one flush and no restart. When off, nothing happens: no token fetch, no gcloud spawn, no
// fetch, and nothing is queued.
//
// NEVER blocks the conductor: enqueue() is synchronous and O(1); every network/spawn step is async,
// fire-and-forget and time-bounded. The local JSON-lines file (conductor-logger.ts) is written BEFORE an
// entry reaches enqueue(), so shipping being down, slow or off can never lose a local entry.
//
// Auth: an access token from the host's gcloud account (`gcloud auth print-access-token`; the account is
// chosen by CLOUDSDK_CORE_ACCOUNT, which B-1170 maps from the host file's gcloud.account). Cached and
// refreshed before expiry. Secret VALUES never appear here: the token is held in memory only.

import { execFile } from 'node:child_process';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  message: string;
  ticket?: string;
  conduction?: string;
  leg?: string;
  project?: string;
}

export const LOG_NAME = 'harmony-conductor';
export const FLUSH_INTERVAL_MS = 5_000;
export const FLUSH_BATCH = 500;
export const QUEUE_CAP = 10_000;
export const PERMISSION_RETRY_MS = 5 * 60_000;
export const TOKEN_TTL_MS = 50 * 60_000; // gcloud tokens last ~1h; refresh well before
export const ENTRIES_WRITE_URL = 'https://logging.googleapis.com/v2/entries:write';
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;

export interface LogShipperDeps {
  /** Live: the merged gcp.project, or undefined. */
  getProject: () => string | undefined;
  /** Live: the merged log_shipping value (undefined = unset = ship when a project is named). */
  getLogShipping: () => boolean | undefined;
  /** Live: the gcloud account to authenticate as, if the config names one. */
  getAccount?: () => string | undefined;
  /** Live: the Harmony project key, used as a label. */
  getProjectKey?: () => string | undefined;
  /** Writes a line to the conductor's own log (local file first). Must not throw. */
  logLocal: (level: LogLevel, event: string, message: string) => void;
  fetchImpl?: typeof fetch;
  /** Fetch an access token. Default spawns `gcloud auth print-access-token`. */
  fetchToken?: (account: string | undefined) => Promise<string>;
  now?: () => number;
  setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => unknown } | number | undefined;
  clearIntervalImpl?: (h: unknown) => void;
  queueCap?: number;
  flushBatch?: number;
  flushIntervalMs?: number;
  permissionRetryMs?: number;
}

export interface LogShipper {
  enqueue(entry: LogEntry): void;
  /** One flush attempt (what the timer runs). Never rejects. */
  flush(): Promise<void>;
  start(): void;
  stop(): void;
  /** Test/inspection hook. */
  stats(): { queued: number; dropped: number };
}

export function gcloudAccessToken(account: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = account ? { ...process.env, CLOUDSDK_CORE_ACCOUNT: account } : process.env;
    execFile('gcloud', ['auth', 'print-access-token'], { env, timeout: TOKEN_TIMEOUT_MS }, (err, stdout) => {
      const token = String(stdout ?? '').trim();
      if (err || !token) reject(new Error(err ? `gcloud auth print-access-token failed (${(err as Error).message.split('\n')[0]})` : 'gcloud returned no token'));
      else resolve(token);
    });
  });
}

const SEVERITY: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

export function createLogShipper(deps: LogShipperDeps): LogShipper {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const getToken = deps.fetchToken ?? gcloudAccessToken;
  const cap = deps.queueCap ?? QUEUE_CAP;
  const batchSize = deps.flushBatch ?? FLUSH_BATCH;
  const permRetry = deps.permissionRetryMs ?? PERMISSION_RETRY_MS;

  let queue: LogEntry[] = [];
  let dropped = 0;
  let dropFirst = 0;
  let dropLast = 0;
  let token: { value: string; expires: number } | null = null;
  let inflight: Promise<void> | null = null;
  let permWarned = false;
  let retryAt = 0;
  let timer: unknown;
  let stopped = false;

  const enabled = (): string | undefined => {
    const p = deps.getProject();
    return p && deps.getLogShipping() !== false ? p : undefined;
  };

  const noteDrop = (n: number): void => {
    if (dropped === 0) dropFirst = now();
    dropped += n;
    dropLast = now();
  };

  const enqueue = (entry: LogEntry): void => {
    if (stopped || !enabled()) return;
    queue.push(entry);
    while (queue.length > cap) {
      queue.shift();
      noteDrop(1);
    }
    if (queue.length >= batchSize) void flush();
  };

  const isPermission = (status: number, body: string): boolean => status === 403 || /PERMISSION_DENIED/.test(body);

  const flushOnce = async (): Promise<void> => {
    const project = enabled();
    if (!project) {
      // Disabled (or hot-disabled): hold nothing.
      queue = [];
      return;
    }
    if (queue.length === 0 || now() < retryAt) return;
    const batch = queue.slice(0, batchSize);
    try {
      if (!token || now() >= token.expires) {
        token = { value: await getToken(deps.getAccount?.()), expires: now() + TOKEN_TTL_MS };
      }
      const projectKey = deps.getProjectKey?.();
      const res = await doFetch(ENTRIES_WRITE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          logName: `projects/${project}/logs/${LOG_NAME}`,
          resource: { type: 'global', labels: { project_id: project } },
          ...(projectKey ? { labels: { harmony_project: projectKey } } : {}),
          entries: batch.map((e) => ({
            timestamp: e.ts,
            severity: SEVERITY[e.level],
            jsonPayload: {
              event: e.event,
              message: e.message,
              ...(e.ticket ? { ticket: e.ticket } : {}),
              ...(e.conduction ? { conduction: e.conduction } : {}),
              ...(e.leg ? { leg: e.leg } : {}),
            },
          })),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        queue = queue.slice(batch.length);
        permWarned = false;
        retryAt = 0;
        if (dropped > 0) {
          const n = dropped;
          const from = new Date(dropFirst).toISOString();
          const to = new Date(dropLast).toISOString();
          dropped = 0;
          deps.logLocal('warn', 'log_shipping.dropped', `log shipping dropped ${n} entries between ${from} and ${to} (queue full while Cloud Logging was unreachable); the local log has them`);
        }
        return;
      }
      const body = await res.text().catch(() => '');
      if (isPermission(res.status, body)) {
        retryAt = now() + permRetry;
        if (!permWarned) {
          permWarned = true;
          deps.logLocal(
            'error',
            'log_shipping.permission_denied',
            `Cloud Logging refused the write to project ${project} (HTTP ${res.status}); grant the conductor host's gcloud account roles/logging.logWriter on that project. Retrying every ${Math.round(permRetry / 60_000)} minutes.`,
          );
        }
        return;
      }
      if (res.status === 401) token = null; // refresh on the next flush
      if (res.status === 400) {
        // A batch Cloud Logging will never accept must not wedge the queue.
        queue = queue.slice(batch.length);
        noteDrop(batch.length);
      }
    } catch {
      // Network cut, timeout, or gcloud failure: keep the batch, try again next flush.
    }
  };

  const flush = (): Promise<void> => {
    inflight ??= flushOnce().catch(() => undefined).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    enqueue,
    flush,
    start() {
      if (timer !== undefined) return;
      const set = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
      timer = set(() => void flush(), deps.flushIntervalMs ?? FLUSH_INTERVAL_MS);
      if (typeof timer === 'object' && timer !== null) (timer as { unref?: () => unknown }).unref?.();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) (deps.clearIntervalImpl ?? ((h) => clearInterval(h as Parameters<typeof clearInterval>[0])))(timer);
      timer = undefined;
    },
    stats: () => ({ queued: queue.length, dropped }),
  };
}
