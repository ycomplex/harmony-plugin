// B-1423: the seat hooks' decisions (src/hooks/seat-hook.ts), with injected reads, clock and pid check.
// Real seat files are exercised too, through B-1422's own writers into a temp HARMONY home (never the
// real ~/.harmony).

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  readHeartbeat,
  readLock,
  readSeatProfile,
  writeHeartbeat,
  writeSeatProfile,
  type Heartbeat,
  type ReadResult,
  type SeatProfile,
  type WatchLock,
} from '../watch/seat-files.js';
import {
  UNWATCHED_RULE,
  buildSeatStartContext,
  decideSeatStop,
  rearmCommand,
  runSeatStart,
  runSeatStop,
  seatNameFromProfilePath,
  watchOnceArgs,
  type SeatStopDeps,
  type WatchRunResult,
} from './seat-hook.js';

const SID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const NOW = Date.parse('2026-11-07T10:20:00.000Z');
const HOST = 'test-host';

const PROFILE: SeatProfile = {
  session_id: SID,
  project: 'B',
  milestone: 'v1.13',
  anchor: 'B-1422',
  owns: ['plan'],
  held_for_founder: ['verify'],
  remind: '20m',
};

function hb(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    schema: 1,
    pid: 48211,
    seat: 'orch',
    scope: 'milestone-v1-13',
    mode: 'until-event',
    poll_interval_s: 30,
    started_at: '2026-11-07T10:00:00.000Z',
    last_fetch_at: '2026-11-07T10:19:30.000Z',
    last_ok_at: '2026-11-07T10:19:30.000Z',
    health: 'ok',
    seq: 3,
    ...over,
  };
}

function lock(over: Partial<WatchLock> = {}): WatchLock {
  return { schema: 1, pid: 48211, hostname: HOST, scope: 'milestone-v1-13', mode: 'until-event', started_at: '2026-11-07T10:00:00.000Z', ...over };
}

const ok = <T>(value: T): ReadResult<T> => ({ status: 'ok', value, path: '/x' });
const absent = <T>(): ReadResult<T> => ({ status: 'absent', path: '/x' });
const malformed = <T>(): ReadResult<T> => ({ status: 'malformed', path: '/x', error: 'bad' });

function deps(over: Partial<SeatStopDeps> = {}): SeatStopDeps {
  return {
    seat: 'orch',
    readProfile: () => ok(PROFILE),
    readHeartbeat: () => ok(hb()),
    readLock: () => ok(lock()),
    now: () => NOW,
    isPidAlive: () => true,
    hostname: HOST,
    ...over,
  };
}

const stopInput = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false, ...over });

describe('decideSeatStop', () => {
  it('fresh heartbeat + held lock -> allow', () => {
    expect(decideSeatStop(stopInput(), deps()).action).toBe('allow');
  });

  it('a follow watch with a held lock -> allow', () => {
    expect(decideSeatStop(stopInput(), deps({ readHeartbeat: () => ok(hb({ mode: 'follow' })) })).action).toBe('allow');
  });

  it('stale heartbeat -> block, naming its age', () => {
    const d = decideSeatStop(stopInput(), deps({ readHeartbeat: () => ok(hb({ last_fetch_at: '2026-11-07T10:06:00.000Z' })) }));
    expect(d.action).toBe('block');
    if (d.action === 'block') expect(d.reason).toContain('heartbeat 14m old');
  });

  it('dead lock holder -> block, naming the pid', () => {
    const d = decideSeatStop(stopInput(), deps({ isPidAlive: () => false }));
    expect(d.action).toBe('block');
    if (d.action === 'block') expect(d.reason).toContain('lock holder pid 48211 is dead');
  });

  it('absent lock -> block', () => {
    const d = decideSeatStop(stopInput(), deps({ readLock: () => absent() }));
    expect(d.action).toBe('block');
    if (d.action === 'block') expect(d.reason).toContain('no lock for scope milestone-v1-13');
  });

  it('absent heartbeat -> block', () => {
    const d = decideSeatStop(stopInput(), deps({ readHeartbeat: () => absent() }));
    expect(d.action).toBe('block');
    if (d.action === 'block') expect(d.reason).toContain('no heartbeat');
  });

  it.each([undefined, 'stale'])('allows stop within 1s of a live lock with %s heartbeat', (kind) => {
    const d = deps({
      readHeartbeat: () => kind ? ok(hb({ last_fetch_at: '2026-11-07T09:00:00.000Z' })) : absent(),
      readLock: () => ok(lock({ started_at: new Date(NOW - 1000).toISOString() })),
    });
    expect(decideSeatStop(stopInput(), d).action).toBe('allow');
    expect(decideSeatStop(stopInput(), { ...d, isPidAlive: () => false }).action).toBe('block');
  });

  it.each([30_000, 30_001, -1000])('no startup grace for lock age %sms', (age) => {
    expect(decideSeatStop(stopInput(), deps({
      readHeartbeat: () => absent(),
      readLock: () => ok(lock({ started_at: new Date(NOW - age).toISOString() })),
    })).action).toBe('block');
  });

  it('a --once heartbeat -> block', () => {
    const d = decideSeatStop(stopInput(), deps({ readHeartbeat: () => ok(hb({ mode: 'once' })) }));
    expect(d.action).toBe('block');
    if (d.action === 'block') expect(d.reason).toContain('--once');
  });

  it('the heartbeat runs another scope: the heartbeat pid stands in for the lock', () => {
    const other = () => ok(hb({ scope: 'keys-b-1' }));
    let lockRead = false;
    const readLockSpy = () => {
      lockRead = true;
      return ok(lock());
    };
    expect(decideSeatStop(stopInput(), deps({ readHeartbeat: other, readLock: readLockSpy })).action).toBe('allow');
    expect(lockRead).toBe(true); // startup grace checks the profile lock first
    const d = decideSeatStop(stopInput(), deps({ readHeartbeat: other, isPidAlive: () => false }));
    expect(d.action).toBe('block');
    if (d.action === 'block') expect(d.reason).toContain('watch pid 48211 is dead');
  });

  it('a malformed lock falls back to the heartbeat pid', () => {
    expect(decideSeatStop(stopInput(), deps({ readLock: () => malformed() })).action).toBe('allow');
    expect(decideSeatStop(stopInput(), deps({ readLock: () => malformed(), isPidAlive: () => false })).action).toBe('block');
  });

  it('stop_hook_active: true -> allow (blocks at most once per stop)', () => {
    expect(decideSeatStop(stopInput({ stop_hook_active: true }), deps({ readHeartbeat: () => absent() })).action).toBe('allow');
  });

  it('malformed profile -> allow', () => {
    expect(decideSeatStop(stopInput(), deps({ readProfile: () => malformed(), readHeartbeat: () => absent() })).action).toBe('allow');
  });

  it('absent profile -> allow', () => {
    expect(decideSeatStop(stopInput(), deps({ readProfile: () => absent(), readHeartbeat: () => absent() })).action).toBe('allow');
  });

  it('profile without project -> allow', () => {
    expect(decideSeatStop(stopInput(), deps({ readProfile: () => ok({ ...PROFILE, project: null }), readHeartbeat: () => absent() })).action).toBe('allow');
  });

  it('a profile rewritten for another session -> allow', () => {
    expect(decideSeatStop(stopInput(), deps({ readProfile: () => ok({ ...PROFILE, session_id: 'other' }), readHeartbeat: () => absent() })).action).toBe('allow');
  });

  it('malformed heartbeat, unparseable payload, a throwing read -> allow (fail open)', () => {
    expect(decideSeatStop(stopInput(), deps({ readHeartbeat: () => malformed() })).action).toBe('allow');
    expect(decideSeatStop('not json', deps({ readHeartbeat: () => absent() })).action).toBe('allow');
    expect(
      decideSeatStop(stopInput(), deps({ readHeartbeat: () => { throw new Error('boom'); } })).action,
    ).toBe('allow');
  });

  it('the reason carries the exact re-arm command, the background instruction and the unwatched rule', () => {
    const d = decideSeatStop(stopInput(), deps({ readHeartbeat: () => absent() }));
    expect(d.action).toBe('block');
    if (d.action !== 'block') return;
    expect(d.reason).toContain('harmony watch --seat orch --milestone v1.13 --until-event');
    expect(d.reason).toContain('in the background');
    expect(d.reason).toContain('If you end the turn anyway, your last line must say this seat is unwatched.');
    expect(UNWATCHED_RULE).toBe('If you end the turn anyway, your last line must say this seat is unwatched.');
  });

  it('a follow watch is re-armed with --follow; no milestone means --conductions', () => {
    const d = decideSeatStop(stopInput(), deps({ readHeartbeat: () => ok(hb({ mode: 'follow', last_fetch_at: '2026-11-07T09:00:00.000Z' })) }));
    if (d.action === 'block') expect(d.reason).toContain('--milestone v1.13 --follow');
    else throw new Error('expected a block');
    expect(rearmCommand('orch', { milestone: null })).toBe('harmony watch --seat orch --conductions --until-event');
  });

  it('runSeatStop: exit 2 with the reason logged on a block, exit 0 on allow', () => {
    const logged: string[] = [];
    expect(runSeatStop(stopInput(), deps({ readHeartbeat: () => absent() }), (t) => logged.push(t))).toBe(2);
    expect(logged.join('')).toContain('no heartbeat');
    expect(runSeatStop(stopInput(), deps(), (t) => logged.push(t))).toBe(0);
    expect(logged).toHaveLength(1);
  });

  it('against real seat files written by B-1422\'s writers', () => {
    const home = mkdtempSync(join(tmpdir(), 'b1423-seat-'));
    writeSeatProfile('orch', PROFILE, { home });
    const real = (): SeatStopDeps => ({
      seat: 'orch',
      readProfile: () => readSeatProfile('orch', { home }),
      readHeartbeat: (p, s) => readHeartbeat(p, s, { home }),
      readLock: (p, s, scope) => readLock(p, s, scope, { home }),
      now: () => NOW,
      isPidAlive: (pid) => pid === 48211,
      hostname: HOST,
    });
    expect(decideSeatStop(stopInput(), real()).action).toBe('block'); // no heartbeat yet
    writeHeartbeat('B', 'orch', hb(), { home });
    expect(decideSeatStop(stopInput(), real()).action).toBe('block'); // no lock yet
    acquireLock('B', 'orch', { kind: 'milestone', id: 'v1.13' }, 'until-event', { home, pid: 48211, hostname: HOST, isPidAlive: () => true });
    expect(decideSeatStop(stopInput(), real()).action).toBe('allow');
    expect(decideSeatStop(stopInput(), { ...real(), isPidAlive: () => false }).action).toBe('block');
  });
});

describe('the start hook', () => {
  const okRun = (stdout: string): WatchRunResult => ({ status: 0, stdout, stderr: '', timedOut: false });

  it('runs `harmony watch --once --seat <name> --milestone <m>`', () => {
    expect(watchOnceArgs('orch', PROFILE)).toEqual(['watch', '--once', '--seat', 'orch', '--milestone', 'v1.13']);
    expect(watchOnceArgs('orch', { milestone: null })).toEqual(['watch', '--once', '--seat', 'orch']);
  });

  it('success: the header, the watch output and the re-arm reminder are in the context', () => {
    let ran: string[] = [];
    const out = runSeatStart({
      input: JSON.stringify({ session_id: SID, source: 'resume' }),
      seat: 'orch',
      profile: ok(PROFILE),
      runWatch: (args) => {
        ran = args;
        return okRun('B-1422 plan-draft waiting 12m\n');
      },
    });
    expect(ran).toEqual(watchOnceArgs('orch', PROFILE));
    const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Harmony seat orch (milestone v1.13): board check at session start');
    expect(ctx).toContain('B-1422 plan-draft waiting 12m');
    expect(ctx).toContain('Your watch is not armed by this check; re-arm with: harmony watch --seat orch --milestone v1.13 --until-event');
  });

  it('long output is truncated', () => {
    const ctx = buildSeatStartContext('orch', PROFILE, okRun('x'.repeat(10_000)));
    expect(ctx.length).toBeLessThan(6500);
    expect(ctx).toContain('truncated');
  });

  it('a failed watch (e.g. unknown command) names the exit code, the first stderr line and the hand command', () => {
    const ctx = buildSeatStartContext('orch', PROFILE, { status: 1, stdout: '', stderr: "\nerror: unknown command 'watch'\nmore\n", timedOut: false });
    expect(ctx).toContain('exit code 1');
    expect(ctx).toContain("error: unknown command 'watch'");
    expect(ctx).not.toContain('more');
    expect(ctx).toContain('Run it by hand: `harmony watch --once --seat orch --milestone v1.13`');
    expect(ctx).toContain('re-arm with:');
  });

  it('a timed-out watch says so and names the hand command', () => {
    const ctx = buildSeatStartContext('orch', PROFILE, { status: null, stdout: '', stderr: '', timedOut: true }, 20_000);
    expect(ctx).toContain('timed out after 20s');
    expect(ctx).toContain('Run it by hand: `harmony watch --once --seat orch --milestone v1.13`');
  });

  it('a watch that could not start says so', () => {
    const ctx = buildSeatStartContext('orch', PROFILE, { status: null, stdout: '', stderr: '', timedOut: false, error: 'spawn ENOENT' });
    expect(ctx).toContain('could not run (spawn ENOENT)');
  });

  it('malformed or absent profile, no seat name, another session, a throwing run -> `{}`', () => {
    const never = () => {
      throw new Error('must not run');
    };
    const input = JSON.stringify({ session_id: SID });
    expect(runSeatStart({ input, seat: 'orch', profile: malformed(), runWatch: never })).toBe('{}');
    expect(runSeatStart({ input, seat: 'orch', profile: absent(), runWatch: never })).toBe('{}');
    expect(runSeatStart({ input, seat: null, profile: ok(PROFILE), runWatch: never })).toBe('{}');
    expect(runSeatStart({ input, seat: 'orch', profile: ok({ ...PROFILE, session_id: 'other' }), runWatch: never })).toBe('{}');
    expect(runSeatStart({ input, seat: 'orch', profile: ok(PROFILE), runWatch: never })).toBe('{}');
  });

  it('seat name is the profile basename without .yml, and must be safe', () => {
    expect(seatNameFromProfilePath('/h/seats/orch.yml')).toBe('orch');
    expect(seatNameFromProfilePath('/h/seats/orch.yaml')).toBeNull();
    expect(seatNameFromProfilePath('/h/seats/a b.yml')).toBeNull();
    expect(seatNameFromProfilePath('/h/seats/..yml')).toBeNull();
  });
});
