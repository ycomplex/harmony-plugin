// B-1172: every heartbeat / acquire / request outcome is CLASSIFIED; no raw error ever reaches a caller.

import { describe, it, expect } from 'vitest';
import {
  buildLogUrl,
  createRegistryClient,
  parseHolderId,
  type RegistryClient,
  type RegistryIdentity,
  type RpcFn,
} from './conductor-registry.js';

const ID: RegistryIdentity = {
  holderId: 'macmini:4242:abcd1234',
  host: 'macmini',
  location: 'local',
  profile: 'gke',
  channel: 'staging',
  pluginVersion: '1.2.3',
  logUrl: null,
};

type Reply = { data?: unknown; error?: { code?: string; message?: string } | null } | Error | 'hang';

interface World {
  client: RegistryClient;
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  timers: Array<() => void>;
  refreshes: () => number;
  sleeps: number[];
}

function world(replies: Reply[]): World {
  const calls: World['calls'] = [];
  const timers: Array<() => void> = [];
  const sleeps: number[] = [];
  let refreshes = 0;
  let i = 0;
  const rpc: RpcFn = (fn, args) => {
    calls.push({ fn, args });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r === 'hang') return new Promise(() => {});
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  };
  const client = createRegistryClient({
    rpc,
    projectId: 'proj-1',
    startTimeout: (_ms, fn) => {
      timers.push(fn);
      return () => {};
    },
    forceRefresh: async () => {
      refreshes += 1;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, timers, refreshes: () => refreshes, sleeps };
}

const missingFn = { error: { code: '42883', message: 'function conductor_heartbeat does not exist' } };

describe('heartbeat classification', () => {
  it('ok -> held (reasserted flag and pending request carried)', async () => {
    const w = world([{ data: { status: 'ok', reasserted: true, request: { id: 'r1', action: 'update', requested_by: 'u1', requested_at: 't' } } }]);
    expect(await w.client.heartbeat(ID)).toEqual({ kind: 'held', reasserted: true, request: { id: 'r1', action: 'update', requestedBy: 'u1', requestedAt: 't' } });
    expect(w.calls[0].fn).toBe('conductor_heartbeat');
    expect(w.calls[0].args).toMatchObject({ p_project_id: 'proj-1', p_holder_id: ID.holderId, p_slot: 'default', p_plugin_version: '1.2.3', p_host: 'macmini', p_location: 'local' });
  });

  it('lost + held-by-other-holder -> lost', async () => {
    const w = world([{ data: { status: 'lost', lost_reason: 'held-by-other-holder', holder_id: 'h2:1:x', holder_host: 'h2' } }]);
    expect(await w.client.heartbeat(ID)).toEqual({ kind: 'lost', holderId: 'h2:1:x', holderHost: 'h2' });
  });

  it.each([
    ['lost without the held-by-other-holder reason', { data: { status: 'lost', lost_reason: null } }],
    ['lost with an unrelated reason', { data: { status: 'lost', lost_reason: 'expired' } }],
    ['a null payload', { data: null }],
    ['a string payload', { data: 'ok' }],
    ['an unknown status', { data: { status: 'weird' } }],
    ['an empty object', { data: {} }],
  ] as Array<[string, Reply]>)('%s -> unknown, never lost', async (_n, reply) => {
    const w = world([reply]);
    expect((await w.client.heartbeat(ID)).kind).toBe('unknown');
  });

  it.each([
    ['a thrown network error', new TypeError('fetch failed')],
    ['a 5xx PostgREST error', { error: { code: '', message: 'upstream connect error (HTTP 503)' } }],
    ['a database error', { error: { code: 'XX000', message: 'internal error' } }],
    ['a missing function (42883)', missingFn],
    ['a missing function (PGRST202)', { error: { code: 'PGRST202', message: 'Could not find the function public.conductor_heartbeat in the schema cache' } }],
    ['a missing table (42P01)', { error: { code: '42P01', message: 'relation "conductor_registry" does not exist' } }],
    ['a missing table (PGRST205)', { error: { code: 'PGRST205', message: 'table not found' } }],
  ] as Array<[string, Reply]>)('%s -> unknown, never lost', async (_n, reply) => {
    const w = world([reply]);
    expect((await w.client.heartbeat(ID)).kind).toBe('unknown');
  });

  it('a timeout -> unknown (never a hang), after the idempotent retries', async () => {
    const w = world(['hang']);
    const p = w.client.heartbeat(ID);
    // each attempt arms one timer; fire them as they appear
    for (let n = 0; n < 3; n++) {
      await new Promise((r) => setTimeout(r, 0));
      w.timers[n]?.();
    }
    const r = await p;
    expect(r.kind).toBe('unknown');
    expect(w.calls.length).toBe(3); // 1 + two idempotent network retries
    expect(w.sleeps).toEqual([250, 750]);
    if (r.kind === 'unknown') expect(r.detail).toContain('timed out');
  });

  it('an expired JWT (PGRST303) forces ONE refresh then succeeds', async () => {
    const w = world([{ error: { code: 'PGRST303', message: 'JWT expired' } }, { data: { status: 'ok', reasserted: false, request: null } }]);
    expect(await w.client.heartbeat(ID)).toEqual({ kind: 'held', reasserted: false, request: null });
    expect(w.refreshes()).toBe(1);
    expect(w.calls.length).toBe(2);
  });

  it('a malformed pending request is ignored but the heartbeat is still held', async () => {
    const w = world([{ data: { status: 'ok', request: { id: 'r1', action: 'reboot' } } }]);
    expect(await w.client.heartbeat(ID)).toEqual({ kind: 'held', reasserted: false, request: null });
  });
});

describe('acquire classification', () => {
  it('acquired / taken_over carry the previous holder', async () => {
    const w = world([{ data: { status: 'taken_over', reason: 'stale', previous_holder_id: 'old:1:x', previous_host: 'old', previous_plugin_version: '1.0.0', request: null } }]);
    expect(await w.client.acquire(ID)).toEqual({ kind: 'taken_over', reason: 'stale', previousHolderId: 'old:1:x', previousHost: 'old', previousPluginVersion: '1.0.0', request: null });
    expect(w.calls[0].args).toMatchObject({ p_takeover_dead_pid: false, p_slot: 'default', p_log_url: null });
  });

  it('acquired', async () => {
    const w = world([{ data: { status: 'acquired', reason: null } }]);
    expect((await w.client.acquire(ID, { takeoverDeadPid: true })).kind).toBe('acquired');
    expect(w.calls[0].args.p_takeover_dead_pid).toBe(true);
  });

  it('refused carries the holder host and heartbeat age', async () => {
    const w = world([{ data: { status: 'refused', reason: 'held-fresh', holder_id: 'other:9:z', holder_host: 'other', holder_plugin_version: '2.0.0', heartbeat_age_seconds: 12 } }]);
    expect(await w.client.acquire(ID)).toEqual({ kind: 'refused', reason: 'held-fresh', holderId: 'other:9:z', holderHost: 'other', holderPluginVersion: '2.0.0', heartbeatAgeSeconds: 12 });
  });

  it.each([
    ['42883', missingFn],
    ['PGRST202', { error: { code: 'PGRST202', message: 'x' } }],
    ['42P01', { error: { code: '42P01', message: 'x' } }],
    ['PGRST205', { error: { code: 'PGRST205', message: 'x' } }],
  ] as Array<[string, Reply]>)('missing function/table (%s) -> unavailable', async (_c, reply) => {
    expect((await world([reply]).client.acquire(ID)).kind).toBe('unavailable');
  });

  it.each([
    ['a network failure', new TypeError('fetch failed')],
    ['a 5xx', { error: { code: '', message: 'bad gateway' } }],
    ['a JWT problem that persists', { error: { code: 'PGRST301', message: 'JWT invalid' } }],
    ['a malformed payload', { data: { status: 'maybe' } }],
    ['no payload', { data: null }],
  ] as Array<[string, Reply]>)('%s -> unknown', async (_n, reply) => {
    expect((await world([reply]).client.acquire(ID)).kind).toBe('unknown');
  });

  it('an acquire timeout is unknown and is NOT re-sent (cas class)', async () => {
    const w = world(['hang']);
    const p = w.client.acquire(ID);
    await new Promise((r) => setTimeout(r, 0));
    w.timers[0]();
    expect((await p).kind).toBe('unknown');
    expect(w.calls.length).toBe(1);
  });
});

describe('the other calls', () => {
  it('release', async () => {
    expect(await world([{ data: { status: 'ok' } }]).client.release(ID.holderId)).toEqual({ kind: 'ok' });
    expect(await world([{ data: { status: 'not_holder' } }]).client.release(ID.holderId)).toEqual({ kind: 'not_holder' });
    expect((await world([missingFn]).client.release(ID.holderId)).kind).toBe('unavailable');
    expect((await world([new Error('boom')]).client.release(ID.holderId)).kind).toBe('unknown');
  });

  it('claimRequest', async () => {
    expect(await world([{ data: { status: 'claimed', action: 'update' } }]).client.claimRequest(ID.holderId, 'r1')).toEqual({ kind: 'claimed', action: 'update' });
    expect(await world([{ data: { status: 'expired', reason: 'too old' } }]).client.claimRequest(ID.holderId, 'r1')).toEqual({ kind: 'expired', reason: 'too old' });
    expect(await world([{ data: { status: 'refused', reason: 'not holder' } }]).client.claimRequest(ID.holderId, 'r1')).toEqual({ kind: 'refused', reason: 'not holder' });
    expect((await world([{ error: { code: 'XX', message: 'down' } }]).client.claimRequest(ID.holderId, 'r1')).kind).toBe('unknown');
  });

  it('completeRequest sends the version pair and the result', async () => {
    const w = world([{ data: { status: 'ok' } }]);
    expect(await w.client.completeRequest(ID.holderId, { requestId: 'r1', result: 'failed', reason: 'pull failed', versionBefore: '1', versionAfter: '1' })).toEqual({ kind: 'ok' });
    expect(w.calls[0].args).toMatchObject({ p_request_id: 'r1', p_result: 'failed', p_reason: 'pull failed', p_version_before: '1', p_version_after: '1', p_slot: 'default' });
    expect(await world([{ data: { status: 'refused', reason: 'not claimed' } }]).client.completeRequest(ID.holderId, { requestId: 'r', result: 'done' })).toEqual({ kind: 'refused', reason: 'not claimed' });
  });

  it('request: queued / refused (with the pending request) / forbidden / unavailable', async () => {
    expect(await world([{ data: { status: 'queued', request_id: 'r9', action: 'restart' } }]).client.request('restart')).toEqual({ kind: 'queued', requestId: 'r9', action: 'restart' });
    const refused = await world([
      { data: { status: 'refused', reason: 'request_pending', message: 'already pending', pending: { id: 'r1', action: 'update', state: 'pending', requested_by: 'u', requested_by_name: 'Ada', requested_at: 't' } } },
    ]).client.request('update');
    expect(refused).toMatchObject({ kind: 'refused', reason: 'request_pending', message: 'already pending', pending: { requested_by_name: 'Ada' } });
    expect((await world([{ error: { code: '42501', message: 'only the owner' } }]).client.request('update')).kind).toBe('forbidden');
    expect((await world([missingFn]).client.request('update')).kind).toBe('unavailable');
  });

  it('status', async () => {
    const w = world([{ data: { available: true, is_owner: false, state: 'running', location: 'local', profile: 'gke', channel: 'staging', plugin_version: '1', host: null, holder_id: 'h:1:x', heartbeat_age_seconds: 4, request: null, events: [], running_legs: [], now: 'n' } }]);
    const r = await w.client.status();
    expect(r.kind).toBe('status');
    if (r.kind === 'status') {
      expect(r.status.state).toBe('running');
      expect(r.status.host).toBeNull();
    }
    expect((await world([missingFn]).client.status()).kind).toBe('unavailable');
    expect((await world([{ data: { available: true, state: 'bogus' } }]).client.status()).kind).toBe('unknown');
  });
});

describe('helpers', () => {
  it('parseHolderId reads host:pid:uuid from the right', () => {
    expect(parseHolderId('macmini:4242:abcd1234')).toEqual({ host: 'macmini', pid: 4242 });
    expect(parseHolderId('a:b:77:u')).toEqual({ host: 'a:b', pid: 77 });
    expect(parseHolderId('nope')).toBeNull();
    expect(parseHolderId('h:notapid:u')).toBeNull();
  });

  it('buildLogUrl names the project and the log', () => {
    const u = buildLogUrl('my-proj', 'harmony-conductor');
    expect(u).toContain('project=my-proj');
    expect(decodeURIComponent(u)).toContain('projects/my-proj/logs/harmony-conductor');
  });
});
