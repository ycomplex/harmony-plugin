import { describe, it, expect } from 'vitest';
import {
  createHintCoalescer,
  createHintLifecycle,
  hintDropReason,
  type HintMessage,
} from './hints.js';

const ME = 'this-host:1:abcd1234';

/** Did this promise resolve by the next macrotask? The whole module is clock-free, so "did the
 *  loop get woken" is exactly "did `next()` settle without anyone advancing anything". */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

function taskChange(over: Record<string, unknown> = {}): HintMessage {
  return { event: 'task_change', payload: { table: 'tasks', record: { id: 't-1' }, ...over } };
}

describe('hintDropReason — READ-TO-DISCARD, never read-to-decide', () => {
  it('keeps both B-1010 events and drops anything else on the topic', () => {
    expect(hintDropReason({ event: 'task_change' }, ME)).toBeNull();
    expect(hintDropReason({ event: 'conduction_change' }, ME)).toBeNull();
    expect(hintDropReason({ event: 'presence_state' }, ME)).toBe('unknown-event');
    expect(hintDropReason({}, ME)).toBe('unknown-event');
  });

  it("drops this instance's OWN write (the row carries this process's lease holder)", () => {
    const mine: HintMessage = {
      event: 'conduction_change',
      payload: { record: { id: 'c-1', lease_holder: ME } },
    };
    expect(hintDropReason(mine, ME)).toBe('self-lease');
    // ...and another daemon's row is NOT this instance's own write.
    expect(hintDropReason(mine, 'other-host:2:zzzz')).toBeNull();
  });

  it('drops a heartbeat-only change (every differing key is ignorable)', () => {
    const msg: HintMessage = {
      event: 'conduction_change',
      payload: {
        record: { id: 'c-1', status: 'active', last_heartbeat_at: 't2', updated_at: 't2' },
        old_record: { id: 'c-1', status: 'active', last_heartbeat_at: 't1', updated_at: 't1' },
      },
    };
    expect(hintDropReason(msg, ME)).toBe('heartbeat-only');
  });

  it('WAKES on a real change that merely rides ALONGSIDE a heartbeat stamp', () => {
    const msg: HintMessage = {
      event: 'conduction_change',
      payload: {
        record: { id: 'c-1', status: 'settled', last_heartbeat_at: 't2' },
        old_record: { id: 'c-1', status: 'active', last_heartbeat_at: 't1' },
      },
    };
    expect(hintDropReason(msg, ME)).toBeNull();
  });

  it('BIASES TOWARD WAKING on anything it cannot read: no payload, no record, no old_record', () => {
    // The filter may only ever DROP. An absent/partial/odd payload must never be read as a reason
    // to stay asleep — that would be reading it to DECIDE.
    expect(hintDropReason({ event: 'task_change' }, ME)).toBeNull();
    expect(hintDropReason({ event: 'task_change', payload: 'nonsense' }, ME)).toBeNull();
    expect(hintDropReason({ event: 'task_change', payload: { record: null } }, ME)).toBeNull();
    expect(hintDropReason(taskChange(), ME)).toBeNull(); // record, but no old_record to diff
    expect(hintDropReason({ event: 'task_change', payload: { record: [] } }, ME)).toBeNull();
  });

  it('an identical old_record (no differing key at all) still wakes — it is not a heartbeat change', () => {
    const msg: HintMessage = {
      event: 'task_change',
      payload: { record: { id: 't-1', a: 1 }, old_record: { id: 't-1', a: 1 } },
    };
    expect(hintDropReason(msg, ME)).toBeNull();
  });
});

describe('createHintCoalescer — the fixed window', () => {
  it('coalesces a BURST into exactly ONE wake: one window opened, one wake, then quiet', async () => {
    const c = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
    const actions = [taskChange(), taskChange(), taskChange(), taskChange(), taskChange()].map(
      (m) => c.accept(m),
    );
    expect(actions[0]).toEqual({ action: 'open-window', debounceMs: 1_000 });
    expect(actions.slice(1).every((a) => a.action === 'coalesce')).toBe(true);
    expect(actions.filter((a) => a.action === 'open-window')).toHaveLength(1);

    const first = c.next();
    expect(await settled(first)).toBe(false); // nothing wakes before the window closes
    c.closeWindow();
    expect(await settled(first)).toBe(true);

    // ONE wake for the whole burst — the next sleep is not woken again.
    expect(await settled(c.next())).toBe(false);
  });

  it('is FIXED, never sliding: a hint arriving inside an open window does not re-open it', () => {
    const c = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
    c.accept(taskChange());
    expect(c.windowOpen()).toBe(true);
    for (let i = 0; i < 50; i++) expect(c.accept(taskChange()).action).toBe('coalesce');
    c.closeWindow();
    expect(c.windowOpen()).toBe(false);
    // The window re-opens only for the NEXT first hint — a fresh window, not an extended one.
    expect(c.accept(taskChange())).toEqual({ action: 'open-window', debounceMs: 1_000 });
  });

  it('a hint arriving MID-PASS sets the sticky flag and is consumed at the NEXT sleep (no wake lost, no overlap)', async () => {
    const c = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
    // No one is awaiting: the loop is inside a pass.
    c.accept(taskChange());
    c.closeWindow();
    expect(c.pendingWake()).toBe(true);

    // The pass ends and the loop reaches its sleep: the latched wake is there, already owed.
    expect(await settled(c.next())).toBe(true);
    expect(c.pendingWake()).toBe(false);
    // Consumed exactly once — the sleep AFTER that one is not short-circuited, so two passes can
    // never overlap on one hint.
    expect(await settled(c.next())).toBe(false);
  });

  it('a SELF-hint is discarded and can never satisfy a wake', async () => {
    const c = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
    const waiting = c.next();
    expect(
      c.accept({ event: 'conduction_change', payload: { record: { lease_holder: ME } } }),
    ).toEqual({ action: 'drop', reason: 'self-lease' });
    expect(c.windowOpen()).toBe(false); // no window was even opened
    expect(await settled(waiting)).toBe(false);

    // A hint from ANOTHER holder on the same channel still wakes it.
    c.accept({ event: 'conduction_change', payload: { record: { lease_holder: 'other:9:xx' } } });
    c.closeWindow();
    expect(await settled(waiting)).toBe(true);
  });

  it('a dropped heartbeat-only hint opens no window and wakes nobody', async () => {
    const c = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
    const waiting = c.next();
    expect(
      c.accept({
        event: 'conduction_change',
        payload: {
          record: { id: 'c-1', last_heartbeat_at: 't2' },
          old_record: { id: 'c-1', last_heartbeat_at: 't1' },
        },
      }),
    ).toEqual({ action: 'drop', reason: 'heartbeat-only' });
    expect(c.windowOpen()).toBe(false);
    expect(await settled(waiting)).toBe(false);
  });

  it('THE STALE-WAITER HAZARD: a wake arriving after the racer abandoned its promise is LATCHED, not lost', async () => {
    const c = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
    // The loop asks for a wake, then loses the race to its own pollMs sleep and goes off to run a
    // pass. It says so: `abandon()`. Everything after that is "mid-pass".
    const abandoned = c.next();
    c.abandon();

    c.accept(taskChange());
    c.closeWindow();
    expect(c.pendingWake()).toBe(true); // latched — NOT handed to the dead promise
    expect(await settled(abandoned)).toBe(false);

    // The pass ends; the loop reaches its sleep and collects the wake it would otherwise have lost.
    expect(await settled(c.next())).toBe(true);
  });

  it('abandon() after a hint-WON race is a no-op (the wake was consumed by its resolution)', async () => {
    const c = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
    const woken = c.next();
    c.accept(taskChange());
    c.closeWindow();
    expect(await settled(woken)).toBe(true);
    c.abandon();
    expect(c.pendingWake()).toBe(false); // nothing left over to fire a second, spurious pass
    expect(await settled(c.next())).toBe(false);
  });

  it('serves successive windows one wake each', async () => {
    const c = createHintCoalescer({ leaseHolder: ME, debounceMs: 1_000 });
    for (let i = 0; i < 3; i++) {
      const w = c.next();
      c.accept(taskChange());
      c.accept(taskChange());
      c.closeWindow();
      expect(await settled(w)).toBe(true);
    }
    expect(await settled(c.next())).toBe(false);
  });
});

describe('createHintLifecycle — the latched everSubscribed discriminator', () => {
  const topic = 'workspace:ws-uuid';

  it('(C) SUBSCRIBED is the steady state: one log line, messages accepted', () => {
    const l = createHintLifecycle({ topic });
    expect(l.acceptsMessages()).toBe(false); // nothing flows before the first SUBSCRIBED
    const a = l.onStatus('SUBSCRIBED');
    expect(a.kind).toBe('log');
    expect(a.kind === 'log' && a.line).toContain(topic);
    expect(l.acceptsMessages()).toBe(true);
    expect(l.everSubscribed()).toBe(true);
    expect(l.isDead()).toBe(false);
  });

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', 'SETUP_FAILED'] as const)(
    '(A) %s BEFORE any SUBSCRIBED tears the channel down ONCE and stays dead for the process lifetime',
    (status) => {
      const l = createHintLifecycle({ topic });
      const a = l.onStatus(status, new Error('rls denied'));
      expect(a.kind).toBe('log-and-teardown');
      expect(a.kind === 'log-and-teardown' && a.line).toContain('rls denied');
      expect(l.isDead()).toBe(true);
      expect(l.acceptsMessages()).toBe(false);
      // Not retried in-process: every later status — including a SUBSCRIBED that cannot happen —
      // is silent and inert.
      expect(l.onStatus(status).kind).toBe('none');
      expect(l.onStatus('SUBSCRIBED').kind).toBe('none');
      expect(l.acceptsMessages()).toBe(false);
      expect(l.isDead()).toBe(true);
    },
  );

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const)(
    '(B) %s AFTER a first SUBSCRIBED is a LOG ONLY — never a teardown (the earlier draft’s defect)',
    (status) => {
      const l = createHintLifecycle({ topic });
      l.onStatus('SUBSCRIBED');
      const a = l.onStatus(status);
      expect(a.kind).toBe('log'); // NOT 'log-and-teardown' — the library's rejoin must survive
      expect(l.isDead()).toBe(false);
      expect(l.acceptsMessages()).toBe(false); // no messages while down...

      const back = l.onStatus('SUBSCRIBED');
      expect(back.kind).toBe('log');
      expect(back.kind === 'log' && back.line).toContain('re-subscribed');
      expect(l.acceptsMessages()).toBe(true); // ...and hints resume on re-SUBSCRIBED
    },
  );

  it('logs AT MOST ONE line per transition — a repeated status is silent', () => {
    const l = createHintLifecycle({ topic });
    l.onStatus('SUBSCRIBED');
    expect(l.onStatus('SUBSCRIBED').kind).toBe('none');
    expect(l.onStatus('CHANNEL_ERROR').kind).toBe('log');
    expect(l.onStatus('CHANNEL_ERROR').kind).toBe('none');
    expect(l.onStatus('CHANNEL_ERROR').kind).toBe('none');
    expect(l.onStatus('TIMED_OUT').kind).toBe('log'); // a genuine transition speaks again
  });

  it('survives a full drop-and-recover cycle without ever tearing down', () => {
    const l = createHintLifecycle({ topic });
    const kinds = (['SUBSCRIBED', 'CHANNEL_ERROR', 'CLOSED', 'SUBSCRIBED'] as const).map(
      (s) => l.onStatus(s).kind,
    );
    expect(kinds).toEqual(['log', 'log', 'log', 'log']);
    expect(kinds).not.toContain('log-and-teardown');
    expect(l.isDead()).toBe(false);
    expect(l.acceptsMessages()).toBe(true);
  });
});
