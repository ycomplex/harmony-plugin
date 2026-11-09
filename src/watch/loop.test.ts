import { describe, expect, it } from 'vitest';
import { TokenExchangeError } from '../auth.js';
import { startHintSubscription, type HintChannelLike } from '../daemon/hint-subscription.js';
import type { WatchEvent } from './classify.js';
import { backoffMs, retryWithBackoff, runWatch, type RunWatchDeps, type WatchMode } from './loop.js';
import { openSeatStarts } from './markers.js';
import type { Heartbeat, SeatProfile, WatchCursor, WatchScope } from './seat-files.js';
import { HeartbeatSchema, WatchCursorSchema } from './seat-files.js';
import { conduction, FakeBoard, FakeClock, paused, T0, ticket } from './test-fakes.js';

const SEC = 1000;
const MIN = 60 * SEC;
const MILESTONE: WatchScope = { kind: 'milestone', id: 'm1' };

function profile(over: Partial<SeatProfile> = {}): SeatProfile {
  return { session_id: 'own-session', project: 'B', milestone: 'm1', anchor: 'B-1', owns: [], held_for_founder: [], remind: null, ...over };
}

interface Harness {
  clock: FakeClock;
  board: FakeBoard;
  events: WatchEvent[];
  cursors: WatchCursor[];
  heartbeats: Heartbeat[];
  abort: AbortController;
  deps: (mode: WatchMode, over?: Partial<RunWatchDeps>) => RunWatchDeps;
}

function harness(): Harness {
  const clock = new FakeClock();
  const board = new FakeBoard(clock);
  const events: WatchEvent[] = [];
  const cursors: WatchCursor[] = [];
  const heartbeats: Heartbeat[] = [];
  const abort = new AbortController();
  const h: Harness = {
    clock,
    board,
    events,
    cursors,
    heartbeats,
    abort,
    deps: (mode, over = {}) => ({
      now: clock.now,
      sleep: clock.sleep,
      reader: board,
      scope: MILESTONE,
      hint: null,
      emit: (e) => events.push(e),
      cursor: null,
      writeCursor: (c) => cursors.push(structuredClone(c)),
      writeHeartbeat: (hb) => heartbeats.push(HeartbeatSchema.parse(hb) as Heartbeat),
      signal: abort.signal,
      mode,
      options: { seat: 'orch', projectKey: 'B', scopeSlug: 'milestone-m1', profile: null, pid: 4242 },
      ...over,
    }),
  };
  return h;
}

/** Abort the loop once the clock passes `at`. */
function stopAt(h: Harness, at: number) {
  h.clock.onTick((t) => {
    if (t >= at) h.abort.abort();
  });
}

const names = (evs: WatchEvent[]) => evs.map((e) => (e.event === 'health' ? `health:${e.status}` : e.event));

describe('AC2: Realtime blocked entirely (hint = null)', () => {
  it('a pause filed on the board is reported within one poll interval', async () => {
    const h = harness();
    h.board.put(ticket(1, { conduction: conduction() }));
    const filedAt = T0 + 10 * SEC;
    h.clock.onTick((t) => {
      if (t >= filedAt && !h.board.tickets.get('task-1')!.awaiting_human_input) {
        const p = paused(1);
        h.board.update('task-1', { awaiting_human_input: true, awaiting_human_reason: 'plan-draft', awaiting_human_ref: p.awaiting_human_ref, conduction: p.conduction, meta: p.meta });
      }
    });
    stopAt(h, T0 + 2 * MIN);
    const res = await runWatch(h.deps('follow', { hint: null }));
    expect(res.exitCode).toBe(0);
    const ready = h.events.find((e) => e.event === 'ready')!;
    expect(ready).toBeTruthy();
    expect(Date.parse(ready.ts) - filedAt).toBeLessThanOrEqual(30 * SEC);
    // polling cadence is the 30 s interval
    expect(new Set(h.clock.sleeps)).toEqual(new Set([30 * SEC]));
  });
});

describe('AC3: failures never escape the loop', () => {
  it('injected fetch failures: one offline line, backoff 5/15/30/60 s, one recovered line, then catch-up', async () => {
    const h = harness();
    h.board.put(paused(1));
    const err = { code: '', message: 'TypeError: fetch failed' };
    h.board.failures = [err, err, err, err, err];
    stopAt(h, T0 + 4 * MIN);
    const res = await runWatch(h.deps('follow'));
    expect(res.exitCode).toBe(0);
    expect(names(h.events).slice(0, 3)).toEqual(['health:offline', 'health:recovered', 'ready']);
    expect(h.clock.sleeps.slice(0, 5)).toEqual([5 * SEC, 15 * SEC, 30 * SEC, 60 * SEC, 60 * SEC]);
    expect(h.heartbeats[0]).toMatchObject({ health: 'offline', last_ok_at: null, poll_interval_s: 30 });
    const okBeat = h.heartbeats.find((b) => b.last_ok_at !== null)!;
    expect(okBeat.health).toBe('ok');
    // every attempt wrote a heartbeat, seq increasing
    expect(h.heartbeats.map((b) => b.seq)).toEqual(h.heartbeats.map((_, i) => i));
    expect(h.board.reads).toBeGreaterThanOrEqual(7);
  });

  it('a TokenExchangeError from the accessToken path reports auth-failed, then recovered', async () => {
    const h = harness();
    h.board.put(paused(1));
    h.board.failures = [new TokenExchangeError('/functions/v1/auth-token', 401, {}), { code: '', message: 'Token exchange failed (401)' }];
    stopAt(h, T0 + 2 * MIN);
    await expect(runWatch(h.deps('follow'))).resolves.toMatchObject({ exitCode: 0 });
    expect(names(h.events).slice(0, 3)).toEqual(['health:auth-failed', 'health:recovered', 'ready']);
    expect(h.heartbeats[0].health).toBe('auth-failed');
  });

  it('a CHANNEL_ERROR on the hint channel (dead source): one degraded line, keeps polling', async () => {
    const h = harness();
    h.board.put(ticket(1, { conduction: conduction() }));
    const channel: HintChannelLike = {
      on: () => channel,
      subscribe: (cb) => cb('CHANNEL_ERROR', new Error('refused')),
    };
    const logs: string[] = [];
    const sub = startHintSubscription({
      createChannel: () => channel,
      removeChannel: () => Promise.resolve(),
      projectId: 'p1',
      leaseHolder: 'watch:test',
      debounceMs: 1000,
      startTimeout: () => () => {},
      log: (l) => logs.push(l),
      forceRefresh: async () => {},
      setAuth: async () => {},
      pollMs: 30_000,
    });
    expect(sub.isDead()).toBe(true);
    stopAt(h, T0 + 3 * MIN);
    const res = await runWatch(h.deps('follow', { hint: sub.source, hintDead: () => sub.isDead() }));
    await sub.close();
    expect(res.exitCode).toBe(0);
    expect(names(h.events)).toEqual(['health:degraded']);
    expect(h.board.reads).toBeGreaterThanOrEqual(6);
    expect(h.heartbeats.at(-1)!.health).toBe('degraded');
  });

  it('a hint shortens the wait to the hint delay', async () => {
    const h = harness();
    h.board.put(ticket(1, { conduction: conduction() }));
    let hintCalls = 0;
    const hint = {
      next: () => (++hintCalls === 1 ? Promise.resolve() : new Promise<void>(() => {})),
      abandon: () => {},
    };
    const readTimes: number[] = [];
    const reader = {
      resolveScope: (s: WatchScope) => h.board.resolveScope(s),
      readSnapshot: async (ids: string[]) => {
        readTimes.push(h.clock.now());
        if (readTimes.length === 2) h.abort.abort();
        return h.board.readSnapshot(ids);
      },
    };
    // the 30 s poll sleep only ends when the race aborts it; other sleeps advance the clock
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        if (ms === 30 * SEC) {
          signal?.addEventListener('abort', () => resolve(), { once: true });
          return;
        }
        h.clock.t += ms;
        resolve();
      });
    await runWatch(h.deps('follow', { hint, sleep, reader }));
    expect(readTimes).toEqual([T0, T0 + 10 * SEC]);
  });

  it('backoff schedule', () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([5000, 15000, 30000, 60000, 60000]);
  });

  it('retryWithBackoff stops on a fatal answer and retries otherwise', async () => {
    const clock = new FakeClock();
    let n = 0;
    const r = await retryWithBackoff(async () => {
      if (++n < 3) throw new Error('down');
      return 'up';
    }, { now: clock.now, sleep: clock.sleep, onFailure: () => 'retry' });
    expect(r).toEqual({ ok: true, value: 'up' });
    expect(clock.sleeps).toEqual([5000, 15000]);
    const s = await retryWithBackoff(async () => Promise.reject(new Error('no')), { now: clock.now, sleep: clock.sleep, onFailure: () => 'stop' });
    expect(s.ok).toBe(false);
  });
});

describe('AC4: restart from the cursor', () => {
  it('a pause filed while the watch was down is reported by the next watch (not silently seeded)', async () => {
    const h = harness();
    h.board.put(ticket(1, { conduction: conduction() }));
    stopAt(h, T0 + 1 * MIN);
    await runWatch(h.deps('follow'));
    expect(h.events).toEqual([]);
    const persisted = WatchCursorSchema.parse(JSON.parse(JSON.stringify(h.cursors.at(-1)))) as WatchCursor;

    // watch is down; the board changes
    h.clock.t += 10 * MIN;
    const p = paused(1);
    h.board.update('task-1', { awaiting_human_input: true, awaiting_human_reason: 'plan-draft', awaiting_human_ref: p.awaiting_human_ref, conduction: p.conduction, meta: p.meta });

    const h2 = harness();
    h2.clock.t = h.clock.t;
    h2.board.tickets = h.board.tickets;
    stopAt(h2, h2.clock.t + 1);
    await runWatch(h2.deps('follow', { cursor: persisted }));
    expect(names(h2.events)).toEqual(['ready']);
    expect(h2.events[0].cursor).toBe(persisted.seq + 1);
  });

  it('first run with no cursor reports the existing seat-owned pauses', async () => {
    const h = harness();
    h.board.put(paused(1));
    h.board.put(paused(2, 'release-decision-pending'));
    h.board.put(ticket(3, { conduction: conduction() }));
    const res = await runWatch(h.deps('until-event', { options: { ...h.deps('once').options, settleMs: 3000 } }));
    expect(res).toMatchObject({ exitCode: 0, reason: 'event' });
    expect(h.events.map((e) => [e.event, e.key])).toEqual([
      ['ready', 'B-1'],
      ['ready', 'B-2'],
    ]);
  });
});

describe('AC5: reminders and founder-held items', () => {
  it('an owned item still open after --remind emits reminder 1, then 2', async () => {
    const h = harness();
    h.board.put(paused(1));
    stopAt(h, T0 + 45 * MIN);
    await runWatch(h.deps('follow', { options: { ...h.deps('follow').options, remindMs: 20 * MIN } }));
    expect(h.events.map((e) => [e.event, e.reminder])).toEqual([
      ['ready', 0],
      ['ready', 1],
      ['ready', 2],
    ]);
    expect(Date.parse(h.events[1].ts) - T0).toBe(20 * MIN);
    expect(Date.parse(h.events[2].ts) - T0).toBe(40 * MIN);
  });

  it('a founder-held item never triggers until-event exit, but --once lists it with its age', async () => {
    const p = profile({ held_for_founder: ['verify'] });
    const h = harness();
    h.board.put(paused(1, 'verification-ack-pending', { updated_at: new Date(T0 - 2 * 3600_000).toISOString() }));
    const base = h.deps('until-event').options;
    const res = await runWatch(h.deps('until-event', { options: { ...base, profile: p, maxWaitMs: 2 * MIN } }));
    expect(res).toMatchObject({ exitCode: 3, reason: 'max-wait' });
    expect(h.events.map((e) => [e.event, e.owner])).toEqual([['ready', 'founder']]);

    const rows: unknown[] = [];
    const o = harness();
    o.board.tickets = h.board.tickets;
    const once = await runWatch(o.deps('once', { options: { ...base, profile: p }, printCurrent: (r) => rows.push(...r) }));
    expect(once.exitCode).toBe(0);
    expect(rows).toEqual([expect.objectContaining({ key: 'B-1', waiting: 'ready', on: 'founder', age_s: 7200 })]);
  });
});

describe('until-event mode', () => {
  it('exit 0 after the settle window; two events arriving together are reported together', async () => {
    const h = harness();
    h.board.put(paused(1));
    h.board.put(ticket(2, { conduction: conduction() }));
    h.clock.onTick(() => {
      if (!h.board.tickets.get('task-2')!.awaiting_human_input) {
        const p = paused(2);
        h.board.update('task-2', { awaiting_human_input: true, awaiting_human_reason: 'plan-draft', awaiting_human_ref: p.awaiting_human_ref, conduction: p.conduction, meta: p.meta });
      }
    });
    const res = await runWatch(h.deps('until-event'));
    expect(res).toMatchObject({ exitCode: 0, reason: 'event' });
    expect(h.events.map((e) => e.key)).toEqual(['B-1', 'B-2']);
    expect(h.clock.sleeps).toEqual([3 * SEC]);
  });

  it('exit 3 when --max-wait passes with nothing seat-owned; info events are printed but do not exit', async () => {
    const h = harness();
    h.board.put(ticket(1, { conduction: conduction({ leg_started_at: new Date(T0).toISOString() }) }));
    h.clock.onTick((t) => {
      if (t >= T0 + 30 * SEC && h.board.tickets.get('task-1')!.workflow_state === 'In Progress') h.board.update('task-1', { workflow_state: 'Built' });
    });
    const base = h.deps('until-event').options;
    const res = await runWatch(h.deps('until-event', { options: { ...base, maxWaitMs: 90 * SEC } }));
    expect(res).toMatchObject({ exitCode: 3, reason: 'max-wait' });
    expect(names(h.events)).toEqual(['state']);
    expect(h.events[0].owner).toBe('info');
  });

  it('health lines never end an until-event wait', async () => {
    const h = harness();
    h.board.failures = [{ message: 'fetch failed' }];
    const base = h.deps('until-event').options;
    const res = await runWatch(h.deps('until-event', { options: { ...base, maxWaitMs: 60 * SEC } }));
    expect(res.exitCode).toBe(3);
    expect(names(h.events)).toEqual(['health:offline', 'health:recovered']);
  });

  it('a scope that cannot resolve is fatal (exit 2)', async () => {
    const h = harness();
    const reader = {
      resolveScope: async () => {
        const e = new Error('no milestone named "x"');
        e.name = 'ScopeError';
        throw e;
      },
      readSnapshot: h.board.readSnapshot.bind(h.board),
    };
    const res = await runWatch(h.deps('until-event', { reader }));
    expect(res).toMatchObject({ exitCode: 2, reason: 'fatal' });
  });
});

describe('--once', () => {
  it('catches up, lists, exits 0 and never writes the cursor', async () => {
    const h = harness();
    h.board.put(paused(1));
    h.board.put(ticket(2));
    const rows: unknown[] = [];
    let wrote = 0;
    const res = await runWatch(h.deps('once', { writeCursor: () => wrote++, printCurrent: (r) => rows.push(...r) }));
    expect(res).toMatchObject({ exitCode: 0, reason: 'once' });
    expect(wrote).toBe(0);
    expect(names(h.events)).toEqual(['ready']);
    expect(rows).toHaveLength(2);
  });

  it('gives up with exit 3 when the board stays unreachable', async () => {
    const h = harness();
    h.board.failures = [{ message: 'down' }, { message: 'down' }, { message: 'down' }];
    const res = await runWatch(h.deps('once'));
    expect(res.exitCode).toBe(3);
    expect(names(h.events)).toEqual(['health:offline']);
  });
});

describe('AC7: seat-start markers', () => {
  it('an open SEAT-START from another session is a health warning, never a block', async () => {
    const h = harness();
    h.board.put(paused(1));
    h.board.comments = [
      { task_id: 'task-1', content: 'SEAT-START v1 seat=other milestone=m1 session=sess-b', created_at: '2026-11-07T09:00:00Z' },
      { task_id: 'task-1', content: 'SEAT-START v1 seat=orch milestone=m1 session=own-session', created_at: '2026-11-07T09:01:00Z' },
      { task_id: 'task-1', content: 'note\nSEAT-START v1 seat=gone milestone=m1 session=sess-c', created_at: '2026-11-07T09:02:00Z' },
      { task_id: 'task-1', content: 'SEAT-STANDDOWN v1 seat=gone milestone=m1 session=sess-c', created_at: '2026-11-07T09:03:00Z' },
    ];
    const p = profile();
    const base = h.deps('until-event').options;
    const res = await runWatch(
      h.deps('until-event', {
        options: { ...base, profile: p },
        markerScan: async (ids) => openSeatStarts(await h.board.listMarkerComments(ids), p.session_id),
      }),
    );
    expect(res.exitCode).toBe(0);
    expect(h.events.map((e) => [e.event, e.status ?? null, e.detail ?? null])).toEqual([
      ['ready', null, null],
      ['health', 'warning', 'another seat (other, session sess-b) has an open seat-start on this milestone'],
    ]);
  });

  it('openSeatStarts pairs by session', () => {
    const c = (content: string, at: string) => ({ task_id: 't', content, created_at: at });
    expect(
      openSeatStarts(
        [
          c('SEAT-STANDDOWN v1 seat=a milestone=m session=s1', '2026-11-07T09:05:00Z'),
          c('SEAT-START v1 seat=a milestone=m session=s1', '2026-11-07T09:00:00Z'),
          c('SEAT-START v1 seat=b milestone=m session=s2', '2026-11-07T09:00:00Z'),
        ],
        null,
      ).map((m) => m.session),
    ).toEqual(['s2']);
  });
});
