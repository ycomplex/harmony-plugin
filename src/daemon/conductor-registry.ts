// B-1172: the conductor registry CLIENT — thin, dependency-injected wrappers over the SECURITY DEFINER
// functions harmony-web adds (conductor_acquire / _heartbeat / _release / _claim_request / _complete_request /
// _request / _status), each result CLASSIFIED into a closed union so no caller ever interprets a raw error.
//
// THE RULE THAT SHAPES EVERYTHING HERE: a call that FAILS is never evidence about who holds the row.
//   - heartbeat: 'lost' means ONLY `status:'lost'` with `lost_reason:'held-by-other-holder'` (a DIFFERENT holder
//     with a fresh heartbeat). A thrown error, a timeout, a 5xx, an expired JWT, a missing function, or any
//     payload that does not parse is 'unknown' — the conductor keeps running and retries next tick.
//   - acquire: a missing function/table is 'unavailable' ("registry not deployed" — the plugin ships to the
//     daemon host from `staging` before ./promote-prod.sh puts the schema on prod); any other failure is
//     'unknown'.
//
// Every call is bounded by a per-attempt timeout (a slow call is 'unknown', never a hang) and goes through
// withWriteRetry (B-845) so a mid-tick JWT expiry self-heals: heartbeat/claim/complete/release-style calls are
// 'idempotent'; acquire is 'cas' (never re-sent after an ambiguous failure).

import { isMissingRelationOrFunction } from '../tools/acceptance-events.js';
import { formatDaemonError } from './error-format.js';
import { withWriteRetry, type RetryWriteClass, type WriteRetryDeps } from './write-retry.js';

export const DEFAULT_SLOT = 'default';
export const DEFAULT_RPC_TIMEOUT_MS = 8_000;

export interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/** supabase.rpc, flattened: `{ data, error }`. A transport failure may also reject. */
export type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>;

export interface RegistryClientDeps extends WriteRetryDeps {
  rpc: RpcFn;
  projectId: string;
  /** Injected one-shot timer (scheduler's startTimeout seam): returns a cancel function. */
  startTimeout(ms: number, fn: () => void): () => void;
  /** Per-attempt timeout. Default 8s: three heartbeat attempts plus backoff still fit inside one 30s tick. */
  timeoutMs?: number;
}

export class RegistryTimeoutError extends Error {
  // ETIMEDOUT => classifyRetrySafety's post-send bucket (idempotent retries allowed, cas never).
  readonly code = 'ETIMEDOUT';
  constructor(fn: string, ms: number) {
    super(`${fn} timed out after ${ms}ms`);
    this.name = 'RegistryTimeoutError';
  }
}

// ---------------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------------

export interface RegistryIdentity {
  holderId: string;
  host: string;
  location: string;
  profile: string | null;
  channel: string | null;
  pluginVersion: string | null;
  logUrl: string | null;
}

export interface PendingRequest {
  id: string;
  action: 'restart' | 'update';
  requestedBy: string | null;
  requestedAt: string | null;
}

export type AcquireOutcome =
  | {
      kind: 'acquired' | 'taken_over';
      reason: string | null;
      previousHolderId: string | null;
      previousHost: string | null;
      previousPluginVersion: string | null;
      request: { id: string; action: string; state: string } | null;
    }
  | {
      kind: 'refused';
      reason: string | null;
      holderId: string | null;
      holderHost: string | null;
      holderPluginVersion: string | null;
      heartbeatAgeSeconds: number | null;
    }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'unknown'; detail: string };

export type HeartbeatOutcome =
  | { kind: 'held'; reasserted: boolean; request: PendingRequest | null }
  | { kind: 'lost'; holderId: string | null; holderHost: string | null }
  | { kind: 'unknown'; detail: string };

export type ReleaseOutcome = { kind: 'ok' } | { kind: 'not_holder' } | { kind: 'unavailable'; detail: string } | { kind: 'unknown'; detail: string };

export type ClaimOutcome =
  | { kind: 'claimed'; action: string | null }
  | { kind: 'expired' | 'refused'; reason: string | null }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'unknown'; detail: string };

export type CompleteOutcome =
  | { kind: 'ok' }
  | { kind: 'refused'; reason: string | null }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'unknown'; detail: string };

export interface RequestRef {
  id: string;
  action: string;
  state: string;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string | null;
}

export type RequestOutcome =
  | { kind: 'queued'; requestId: string; action: string }
  | { kind: 'refused'; reason: string; message: string; pending: RequestRef | null }
  | { kind: 'forbidden'; detail: string }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'unknown'; detail: string };

export interface RegistryStatus {
  is_owner: boolean;
  state: 'running' | 'stale' | 'not_running';
  location: string | null;
  profile: string | null;
  channel: string | null;
  plugin_version: string | null;
  started_at: string | null;
  last_heartbeat_at: string | null;
  heartbeat_age_seconds: number | null;
  host: string | null;
  holder_id: string | null;
  log_url: string | null;
  request: { id: string; action: string; state: string; reason: string | null; requested_by: string | null; requested_at: string | null } | null;
  events: unknown[];
  running_legs: unknown[];
  now: string | null;
}

export type StatusOutcome =
  | { kind: 'status'; status: RegistryStatus }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'unknown'; detail: string };

// ---------------------------------------------------------------------------------------------------
// payload helpers
// ---------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** supabase returns a scalar-jsonb rpc as the object itself, but some PostgREST versions wrap a
 *  single-row table-function result in an array — accept both. */
function payload(data: unknown): Obj | null {
  if (Array.isArray(data) && data.length === 1) return asObj(data[0]);
  return asObj(data);
}

function parsePending(v: unknown): PendingRequest | null {
  const o = asObj(v);
  if (!o) return null;
  const id = str(o.id);
  const action = o.action;
  if (!id || (action !== 'restart' && action !== 'update')) return null;
  return { id, action, requestedBy: str(o.requested_by), requestedAt: str(o.requested_at) };
}

function parseRequestRef(v: unknown): RequestRef | null {
  const o = asObj(v);
  if (!o) return null;
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    action: str(o.action) ?? '?',
    state: str(o.state) ?? '?',
    requested_by: str(o.requested_by),
    requested_by_name: str(o.requested_by_name),
    requested_at: str(o.requested_at),
  };
}

const detailOf = (err: unknown): string => {
  try {
    const o = asObj(err);
    if (o && !(err instanceof Error) && (typeof o.message === 'string' || typeof o.code === 'string')) {
      return `${typeof o.code === 'string' && o.code ? `${o.code}: ` : ''}${typeof o.message === 'string' ? o.message : ''}`.trim();
    }
    return formatDaemonError(err);
  } catch {
    return 'unreadable error';
  }
};

const isMissing = (err: unknown): boolean => {
  const o = asObj(err);
  if (!o) return false;
  return isMissingRelationOrFunction({ code: str(o.code) ?? undefined, message: str(o.message) ?? undefined });
};

// ---------------------------------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------------------------------

export interface RegistryClient {
  acquire(id: RegistryIdentity, opts?: { takeoverDeadPid?: boolean }): Promise<AcquireOutcome>;
  heartbeat(id: RegistryIdentity): Promise<HeartbeatOutcome>;
  release(holderId: string, opts?: { timeoutMs?: number }): Promise<ReleaseOutcome>;
  claimRequest(holderId: string, requestId: string): Promise<ClaimOutcome>;
  completeRequest(
    holderId: string,
    args: { requestId: string; result: 'done' | 'failed'; reason?: string | null; versionBefore?: string | null; versionAfter?: string | null },
  ): Promise<CompleteOutcome>;
  request(action: 'restart' | 'update'): Promise<RequestOutcome>;
  status(): Promise<StatusOutcome>;
}

export function createRegistryClient(deps: RegistryClientDeps): RegistryClient {
  const defaultTimeout = deps.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  /** One bounded, self-healing rpc. Resolves to the data, or REJECTS with the (possibly PostgREST-shaped) error. */
  const call = (name: string, args: Record<string, unknown>, cls: RetryWriteClass, timeoutMs = defaultTimeout): Promise<unknown> =>
    withWriteRetry(deps, { class: cls, endpoint: `rpc(${name})` }, () =>
      new Promise<unknown>((resolve, reject) => {
        let done = false;
        const cancel = deps.startTimeout(timeoutMs, () => {
          if (done) return;
          done = true;
          reject(new RegistryTimeoutError(name, timeoutMs));
        });
        let pending: ReturnType<RpcFn>;
        try {
          pending = deps.rpc(name, { p_project_id: deps.projectId, ...args });
        } catch (err) {
          done = true;
          cancel();
          reject(err);
          return;
        }
        pending.then(
          ({ data, error }) => {
            if (done) return;
            done = true;
            cancel();
            if (error) reject(error);
            else resolve(data);
          },
          (err: unknown) => {
            if (done) return;
            done = true;
            cancel();
            reject(err);
          },
        );
      }),
    );

  const idArgs = (id: RegistryIdentity): Record<string, unknown> => ({
    p_holder_id: id.holderId,
    p_host: id.host,
    p_location: id.location,
    p_profile: id.profile,
    p_channel: id.channel,
    p_plugin_version: id.pluginVersion,
    p_log_url: id.logUrl,
    p_slot: DEFAULT_SLOT,
  });

  return {
    async acquire(id, opts = {}) {
      try {
        const data = await call('conductor_acquire', { ...idArgs(id), p_takeover_dead_pid: opts.takeoverDeadPid === true }, 'cas');
        const o = payload(data);
        const status = o && str(o.status);
        if (!o || (status !== 'acquired' && status !== 'taken_over' && status !== 'refused')) {
          return { kind: 'unknown', detail: 'conductor_acquire returned an unrecognised payload' };
        }
        if (status === 'refused') {
          return {
            kind: 'refused',
            reason: str(o.reason),
            holderId: str(o.holder_id),
            holderHost: str(o.holder_host),
            holderPluginVersion: str(o.holder_plugin_version),
            heartbeatAgeSeconds: num(o.heartbeat_age_seconds),
          };
        }
        const req = asObj(o.request);
        return {
          kind: status,
          reason: str(o.reason),
          previousHolderId: str(o.previous_holder_id),
          previousHost: str(o.previous_host),
          previousPluginVersion: str(o.previous_plugin_version),
          request: req && str(req.id) ? { id: str(req.id) as string, action: str(req.action) ?? '?', state: str(req.state) ?? '?' } : null,
        };
      } catch (err) {
        return isMissing(err) ? { kind: 'unavailable', detail: detailOf(err) } : { kind: 'unknown', detail: detailOf(err) };
      }
    },

    async heartbeat(id) {
      try {
        const data = await call('conductor_heartbeat', idArgs(id), 'idempotent');
        const o = payload(data);
        const status = o && str(o.status);
        if (o && status === 'ok') return { kind: 'held', reasserted: o.reasserted === true, request: parsePending(o.request) };
        // 'lost' is deliberately narrow: ONLY a different holder with a fresh heartbeat.
        if (o && status === 'lost' && str(o.lost_reason) === 'held-by-other-holder') {
          return { kind: 'lost', holderId: str(o.holder_id), holderHost: str(o.holder_host) };
        }
        return { kind: 'unknown', detail: `conductor_heartbeat returned an unrecognised payload (status ${JSON.stringify(status)})` };
      } catch (err) {
        return { kind: 'unknown', detail: detailOf(err) };
      }
    },

    async release(holderId, opts = {}) {
      try {
        const data = await call('conductor_release', { p_holder_id: holderId, p_slot: DEFAULT_SLOT }, 'cas', opts.timeoutMs);
        const status = str(payload(data)?.status);
        if (status === 'ok') return { kind: 'ok' };
        if (status === 'not_holder') return { kind: 'not_holder' };
        return { kind: 'unknown', detail: 'conductor_release returned an unrecognised payload' };
      } catch (err) {
        return isMissing(err) ? { kind: 'unavailable', detail: detailOf(err) } : { kind: 'unknown', detail: detailOf(err) };
      }
    },

    async claimRequest(holderId, requestId) {
      try {
        const data = await call('conductor_claim_request', { p_holder_id: holderId, p_request_id: requestId, p_slot: DEFAULT_SLOT }, 'cas');
        const o = payload(data);
        const status = o && str(o.status);
        if (o && status === 'claimed') return { kind: 'claimed', action: str(o.action) };
        if (o && (status === 'expired' || status === 'refused')) return { kind: status, reason: str(o.reason) };
        return { kind: 'unknown', detail: 'conductor_claim_request returned an unrecognised payload' };
      } catch (err) {
        return isMissing(err) ? { kind: 'unavailable', detail: detailOf(err) } : { kind: 'unknown', detail: detailOf(err) };
      }
    },

    async completeRequest(holderId, args) {
      try {
        const data = await call(
          'conductor_complete_request',
          {
            p_holder_id: holderId,
            p_request_id: args.requestId,
            p_result: args.result,
            p_reason: args.reason ?? null,
            p_version_before: args.versionBefore ?? null,
            p_version_after: args.versionAfter ?? null,
            p_slot: DEFAULT_SLOT,
          },
          'idempotent',
        );
        const o = payload(data);
        const status = o && str(o.status);
        if (o && status === 'ok') return { kind: 'ok' };
        if (o && status === 'refused') return { kind: 'refused', reason: str(o.reason) };
        return { kind: 'unknown', detail: 'conductor_complete_request returned an unrecognised payload' };
      } catch (err) {
        return isMissing(err) ? { kind: 'unavailable', detail: detailOf(err) } : { kind: 'unknown', detail: detailOf(err) };
      }
    },

    async request(action) {
      try {
        const data = await call('conductor_request', { p_action: action }, 'cas');
        const o = payload(data);
        const status = o && str(o.status);
        if (o && status === 'queued') {
          const requestId = str(o.request_id);
          if (requestId) return { kind: 'queued', requestId, action: str(o.action) ?? action };
        }
        if (o && status === 'refused') {
          return { kind: 'refused', reason: str(o.reason) ?? 'refused', message: str(o.message) ?? 'the request was refused', pending: parseRequestRef(o.pending) };
        }
        return { kind: 'unknown', detail: 'conductor_request returned an unrecognised payload' };
      } catch (err) {
        if (isMissing(err)) return { kind: 'unavailable', detail: detailOf(err) };
        if (asObj(err)?.code === '42501') return { kind: 'forbidden', detail: detailOf(err) };
        return { kind: 'unknown', detail: detailOf(err) };
      }
    },

    async status() {
      try {
        const data = await call('conductor_status', {}, 'idempotent');
        const o = payload(data);
        const state = o && str(o.state);
        if (!o || o.available === false || (state !== 'running' && state !== 'stale' && state !== 'not_running')) {
          return { kind: 'unknown', detail: 'conductor_status returned an unrecognised payload' };
        }
        const r = asObj(o.request);
        return {
          kind: 'status',
          status: {
            is_owner: o.is_owner === true,
            state,
            location: str(o.location),
            profile: str(o.profile),
            channel: str(o.channel),
            plugin_version: str(o.plugin_version),
            started_at: str(o.started_at),
            last_heartbeat_at: str(o.last_heartbeat_at),
            heartbeat_age_seconds: num(o.heartbeat_age_seconds),
            host: str(o.host),
            holder_id: str(o.holder_id),
            log_url: str(o.log_url),
            request:
              r && str(r.id)
                ? { id: str(r.id) as string, action: str(r.action) ?? '?', state: str(r.state) ?? '?', reason: str(r.reason), requested_by: str(r.requested_by), requested_at: str(r.requested_at) }
                : null,
            events: Array.isArray(o.events) ? o.events : [],
            running_legs: Array.isArray(o.running_legs) ? o.running_legs : [],
            now: str(o.now),
          },
        };
      } catch (err) {
        return isMissing(err) ? { kind: 'unavailable', detail: detailOf(err) } : { kind: 'unknown', detail: detailOf(err) };
      }
    },
  };
}

/** Adapt a supabase client to RpcFn without importing supabase types into the pure core. */
export function rpcFromClient(client: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }): RpcFn {
  return async (fn, args) => {
    const r = await client.rpc(fn, args);
    return { data: r.data, error: (r.error as RpcError | null) ?? null };
  };
}

// ---------------------------------------------------------------------------------------------------
// holder ids
// ---------------------------------------------------------------------------------------------------

/** The daemon's lease holder is `host:pid:uuid8`. Parse from the RIGHT so a host containing ':' still works. */
export function parseHolderId(holderId: string): { host: string; pid: number } | null {
  const parts = holderId.split(':');
  if (parts.length < 3) return null;
  const pid = Number(parts[parts.length - 2]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { host: parts.slice(0, -2).join(':'), pid };
}

/** A Cloud Logging console URL for the conductor's shipped log, or null when shipping is off. */
export function buildLogUrl(gcpProject: string, logName: string): string {
  const query = `logName="projects/${gcpProject}/logs/${logName}"`;
  return `https://console.cloud.google.com/logs/query;query=${encodeURIComponent(query)}?project=${encodeURIComponent(gcpProject)}`;
}
