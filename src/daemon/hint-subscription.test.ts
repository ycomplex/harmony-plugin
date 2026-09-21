import { describe, it, expect, vi } from 'vitest';
import { startHintSubscription, hintTopic, type HintChannelLike } from './hint-subscription.js';

const ME = 'this-host:1:abcd1234';
const WS = '11111111-2222-3333-4444-555555555555';
const TOPIC = `workspace:${WS}`;

/** A FAKED channel — no socket anywhere. It records what was bound and lets a test drive the
 *  status callback by hand, which is the only way to exercise all three lifecycle states. */
function fakeChannel() {
  const handlers = new Map<string, (m: { event?: string; payload?: unknown }) => void>();
  let statusCb: ((status: string, err?: unknown) => void) | null = null;
  let subscribeCalls = 0;
  const channel: HintChannelLike & {
    events: () => string[];
    subscribeCalls: () => number;
    emit: (event: string, payload?: unknown) => void;
    status: (status: string, err?: unknown) => void;
  } = {
    on(_type, filter, callback) {
      handlers.set(filter.event, callback);
      return channel;
    },
    subscribe(callback) {
      subscribeCalls += 1;
      statusCb = callback;
      return channel;
    },
    events: () => [...handlers.keys()],
    subscribeCalls: () => subscribeCalls,
    emit: (event, payload) => handlers.get(event)?.({ event, payload }),
    status: (status, err) => statusCb?.(status, err),
  };
  return channel;
}

interface HarnessOpts {
  createChannel?: (topic: string) => HintChannelLike;
  pollMs?: number;
  downCadenceMs?: number;
  forceRefresh?: () => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const channel = fakeChannel();
  const logs: string[] = [];
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const removed: HintChannelLike[] = [];
  const topics: string[] = [];
  const forceRefreshCalls: number[] = [];
  const setAuthCalls: unknown[][] = [];
  const sub = startHintSubscription({
    createChannel: (topic) => {
      topics.push(topic);
      return opts.createChannel ? opts.createChannel(topic) : channel;
    },
    removeChannel: (c) => {
      removed.push(c);
      return Promise.resolve('ok');
    },
    workspaceId: WS,
    leaseHolder: ME,
    debounceMs: 1_000,
    startTimeout: (ms, fn) => {
      const entry = { ms, fn };
      timers.push(entry);
      return () => {
        const i = timers.indexOf(entry);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    log: (line) => logs.push(line),
    forceRefresh: (...args: unknown[]) => {
      forceRefreshCalls.push(args.length);
      return opts.forceRefresh ? opts.forceRefresh() : Promise.resolve();
    },
    setAuth: (...args: unknown[]) => {
      setAuthCalls.push(args);
    },
    pollMs: opts.pollMs ?? 25_000,
    downCadenceMs: opts.downCadenceMs,
  });
  return {
    sub,
    channel,
    logs,
    topics,
    removed,
    timers,
    forceRefreshCalls,
    setAuthCalls,
    /** Fire every armed debounce window (there is at most one at a time). */
    fireTimers: () => {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    },
    /** Fire the OLDEST still-armed timer only (used for the down-visibility timer, which may
     *  coexist with a debounce window timer). */
    fireOldestTimer: () => {
      const entry = timers.shift();
      entry?.fn();
    },
  };
}

/** Did the scheduler's hint promise resolve? */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe('startHintSubscription — wiring', () => {
  it("subscribes to B-1010's private workspace topic for both broadcast events, and never blocks", () => {
    const h = makeHarness();
    expect(h.topics).toEqual([TOPIC]);
    expect(hintTopic(WS)).toBe(TOPIC);
    expect(h.channel.events()).toEqual(['task_change', 'conduction_change']);
    expect(h.channel.subscribeCalls()).toBe(1);
    expect(h.removed).toEqual([]);
  });
});

describe('startHintSubscription — (C) SUBSCRIBED steady state', () => {
  it('a message opens the FIXED debounce window and wakes the scheduler when it closes', async () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    const wake = h.sub.source.next();

    h.channel.emit('task_change', { record: { id: 'task-1' } });
    expect(h.timers.map((t) => t.ms)).toEqual([1_000]);
    expect(await settled(wake)).toBe(false); // nothing before the window closes

    h.fireTimers();
    expect(await settled(wake)).toBe(true);
  });

  it('a BURST across both events arms exactly ONE window and produces exactly ONE wake', async () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    const wake = h.sub.source.next();
    for (let i = 0; i < 10; i += 1) {
      h.channel.emit('task_change', { record: { id: `task-${i}` } });
      h.channel.emit('conduction_change', { record: { id: `cond-${i}` } });
    }
    expect(h.timers).toHaveLength(1);
    h.fireTimers();
    expect(await settled(wake)).toBe(true);
    expect(await settled(h.sub.source.next())).toBe(false);
  });

  it("READ-TO-DISCARD: this instance's own write arms no window and wakes nobody", async () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    const wake = h.sub.source.next();
    h.channel.emit('conduction_change', { record: { id: 'cond-1', lease_holder: ME } });
    expect(h.timers).toHaveLength(0);
    expect(await settled(wake)).toBe(false);
  });

  it('messages arriving BEFORE the first SUBSCRIBED are not wakes', async () => {
    const h = makeHarness();
    const wake = h.sub.source.next();
    h.channel.emit('task_change', { record: { id: 'task-1' } });
    expect(h.timers).toHaveLength(0);
    expect(await settled(wake)).toBe(false);
  });
});

describe('startHintSubscription — (A) PRE-SUBSCRIBED failure', () => {
  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
    '%s before any SUBSCRIBED: ONE log line, removeChannel ONCE, dead for the process lifetime',
    async (status) => {
      const h = makeHarness();
      h.channel.status(status, new Error('permission denied for realtime.messages'));
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toContain('permission denied');
      expect(h.logs[0]).toContain(TOPIC);
      expect(h.removed).toEqual([h.channel]);
      expect(h.sub.isDead()).toBe(true);

      // Not retried in-process, and never louder than that one line.
      h.channel.status(status);
      h.channel.status('CHANNEL_ERROR');
      h.channel.status('SUBSCRIBED');
      expect(h.logs).toHaveLength(1);
      expect(h.removed).toHaveLength(1);

      // Dep effectively absent: the scheduler's race is left to the poll sleep alone, forever.
      const wake = h.sub.source.next();
      h.channel.emit('task_change', { record: { id: 'task-1' } });
      h.fireTimers();
      expect(await settled(wake)).toBe(false);
    },
  );

  it('a createChannel throw is the same tolerant no-op — one log line, no throw, no channel', async () => {
    const h = makeHarness({
      createChannel: () => {
        throw new Error('realtime disabled');
      },
    });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('realtime disabled');
    expect(h.removed).toEqual([]); // there was never a channel to remove
    expect(h.sub.isDead()).toBe(true);
    expect(await settled(h.sub.source.next())).toBe(false);
    await expect(h.sub.close()).resolves.toBeUndefined();
  });

  it('a removeChannel that rejects during teardown never escapes', async () => {
    const channel = fakeChannel();
    const logs: string[] = [];
    const sub = startHintSubscription({
      createChannel: () => channel,
      removeChannel: () => Promise.reject(new Error('socket already gone')),
      workspaceId: WS,
      leaseHolder: ME,
      debounceMs: 1_000,
      startTimeout: () => () => {},
      log: (l) => logs.push(l),
      forceRefresh: () => Promise.resolve(),
      setAuth: () => {},
      pollMs: 25_000,
    });
    expect(() => channel.status('CHANNEL_ERROR')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(sub.isDead()).toBe(true);
    expect(logs).toHaveLength(1);
  });
});

describe('startHintSubscription — (B) POST-SUBSCRIBED drop', () => {
  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
    'NEVER calls removeChannel for a %s arriving AFTER the first SUBSCRIBED',
    (status) => {
      const h = makeHarness();
      h.channel.status('SUBSCRIBED');
      h.channel.status(status, new Error('websocket closed'));
      // THE ASSERTION THIS TEST EXISTS FOR: tearing the channel down here would destroy the
      // library's own capped rejoin and turn a transient blip into a permanent loss of hints.
      expect(h.removed).toEqual([]);
      expect(h.sub.isDead()).toBe(false);
      expect(h.logs).toHaveLength(2); // one for SUBSCRIBED, one for the drop
    },
  );

  it('logs AT MOST ONE line per transition — a repeated status says nothing', () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    h.channel.status('CHANNEL_ERROR');
    h.channel.status('CHANNEL_ERROR');
    h.channel.status('CHANNEL_ERROR');
    expect(h.logs).toHaveLength(2);
    h.channel.status('TIMED_OUT'); // a real transition speaks again
    expect(h.logs).toHaveLength(3);
    expect(h.removed).toEqual([]);
  });

  it('hints RESUME on re-SUBSCRIBED, with the dep never having gone away', async () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    h.channel.status('CHANNEL_ERROR');

    // While down, a message is not a wake — no DEBOUNCE window is opened by it. (A down-
    // visibility timer, B-1045, is legitimately armed at this point; that is a separate concern
    // from the debounce window this assertion guards.)
    const wake = h.sub.source.next();
    h.channel.emit('task_change', { record: { id: 'task-1' } });
    expect(h.timers.map((t) => t.ms)).not.toContain(1_000);
    expect(await settled(wake)).toBe(false);

    // ...and the library's own rejoin (unwrapped, never re-implemented here) brings it back.
    h.channel.status('SUBSCRIBED');
    expect(h.logs[h.logs.length - 1]).toContain('re-subscribed');
    h.channel.emit('task_change', { record: { id: 'task-1' } });
    h.fireTimers();
    expect(await settled(wake)).toBe(true);
    expect(h.removed).toEqual([]);
    expect(h.channel.subscribeCalls()).toBe(1); // we never re-subscribe by hand either
  });
});

describe('startHintSubscription — B-1045 JWT-expiry reauth', () => {
  it('forceRefresh() is called exactly once, and setAuth() is called once with NO arguments once it resolves', async () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    h.channel.status('CHANNEL_ERROR', new Error('InvalidJWTToken'));
    expect(h.forceRefreshCalls).toEqual([0]); // called with zero arguments, exactly once
    expect(h.setAuthCalls).toEqual([]); // not yet — forceRefresh hasn't resolved

    await new Promise((r) => setTimeout(r, 0));
    expect(h.setAuthCalls).toEqual([[]]); // resolved: setAuth() called once, with no arguments
    expect(h.logs.some((l) => l.includes('token expired, re-authenticating'))).toBe(true);
  });

  it('when forceRefresh() rejects, setAuth() is never called and a failure line is logged — no throw escapes', async () => {
    const h = makeHarness({ forceRefresh: () => Promise.reject(new Error('refresh denied')) });
    h.channel.status('SUBSCRIBED');
    expect(() =>
      h.channel.status('CHANNEL_ERROR', new Error('InvalidJWTToken')),
    ).not.toThrow();

    await new Promise((r) => setTimeout(r, 0));
    expect(h.setAuthCalls).toEqual([]);
    expect(
      h.logs.some((l) => l.includes('hint channel re-auth failed (refresh denied)')),
    ).toBe(true);
  });

  it('a non-expired-JWT CHANNEL_ERROR never calls forceRefresh or setAuth', () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    h.channel.status('CHANNEL_ERROR', new Error('websocket closed'));
    expect(h.forceRefreshCalls).toEqual([]);
    expect(h.setAuthCalls).toEqual([]);
  });
});

describe('startHintSubscription — B-1045 outage-visibility timer', () => {
  it('logs nothing until the FIRST timer (armed at pollMs) fires', () => {
    const h = makeHarness({ pollMs: 10_000 });
    h.channel.status('SUBSCRIBED');
    h.channel.status('CHANNEL_ERROR');
    expect(h.logs.some((l) => l.includes('hint channel down'))).toBe(false);
    expect(h.timers.map((t) => t.ms)).toEqual([10_000]);
  });

  it('the first firing logs one down-line; later firings repeat at the downCadenceMs cadence', () => {
    const h = makeHarness({ pollMs: 10_000, downCadenceMs: 60_000 });
    h.channel.status('SUBSCRIBED');
    h.channel.status('CHANNEL_ERROR');

    h.fireTimers();
    expect(h.logs.filter((l) => l.includes('hint channel down'))).toEqual([
      'hint channel down 10s, awaiting rejoin',
    ]);
    expect(h.timers.map((t) => t.ms)).toEqual([60_000]); // re-armed at the cadence, not pollMs

    h.fireTimers();
    expect(h.logs.filter((l) => l.includes('hint channel down'))).toEqual([
      'hint channel down 10s, awaiting rejoin',
      'hint channel down 70s, awaiting rejoin',
    ]);
    expect(h.timers.map((t) => t.ms)).toEqual([60_000]);
  });

  it('a re-SUBSCRIBED cancels the down-timer — no further down-line, and nothing left armed', () => {
    const h = makeHarness({ pollMs: 10_000 });
    h.channel.status('SUBSCRIBED');
    h.channel.status('CHANNEL_ERROR');
    expect(h.timers).toHaveLength(1);

    h.channel.status('SUBSCRIBED');
    expect(h.timers).toHaveLength(0); // cancelled on recovery — nothing left to fire

    h.fireTimers(); // no-op: nothing armed
    expect(h.logs.some((l) => l.includes('hint channel down'))).toBe(false);
  });
});

describe('startHintSubscription — B-1045 integration: a token-expiry-shaped cycle', () => {
  it('re-authenticates on an expired-JWT drop, and hints resume on the next SUBSCRIBED', async () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    h.channel.status('CHANNEL_ERROR', new Error('InvalidJWTToken'));
    expect(h.forceRefreshCalls).toEqual([0]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.setAuthCalls).toEqual([[]]);

    h.channel.status('SUBSCRIBED');
    expect(h.logs[h.logs.length - 1]).toContain('re-subscribed');
    expect(h.sub.isDead()).toBe(false);
    expect(h.removed).toEqual([]); // never torn down — this was always state (B)
  });
});

describe('startHintSubscription — close()', () => {
  it('removes the channel once and is idempotent', async () => {
    const h = makeHarness();
    h.channel.status('SUBSCRIBED');
    await h.sub.close();
    expect(h.removed).toEqual([h.channel]);
    await h.sub.close();
    expect(h.removed).toHaveLength(1);
  });

  it('awaits the removeChannel promise (so the caller can bound it)', async () => {
    const channel = fakeChannel();
    let release: (() => void) | null = null;
    const sub = startHintSubscription({
      createChannel: () => channel,
      removeChannel: () => new Promise<void>((resolve) => (release = resolve)),
      workspaceId: WS,
      leaseHolder: ME,
      debounceMs: 1_000,
      startTimeout: () => () => {},
      log: vi.fn(),
      forceRefresh: () => Promise.resolve(),
      setAuth: () => {},
      pollMs: 25_000,
    });
    channel.status('SUBSCRIBED');
    const closing = sub.close();
    let done = false;
    void closing.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false); // still waiting on the socket teardown
    release!();
    await closing;
  });
});
