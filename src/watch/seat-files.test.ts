import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  cursorPath,
  formatSeatProfile,
  harmonyHome,
  heartbeatPath,
  isHeartbeatStale,
  isLockHeld,
  lockPath,
  parseDuration,
  readCursor,
  readHeartbeat,
  readLock,
  readSeatProfile,
  releaseLock,
  scopeSlug,
  seatProfilePath,
  writeCursor,
  writeHeartbeat,
  writeJsonAtomic,
  writeSeatProfile,
  type Heartbeat,
  type SeatProfile,
  type WatchCursor,
  type WatchLock,
} from './seat-files.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'seat-files-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const T0 = '2026-11-07T10:00:00.000Z';
const T0_MS = Date.parse(T0);

function hb(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    schema: 1,
    pid: 4242,
    seat: 'orch',
    scope: 'milestone-v1-13',
    mode: 'follow',
    poll_interval_s: 30,
    started_at: T0,
    last_fetch_at: null,
    last_ok_at: null,
    health: 'ok',
    seq: 0,
    ...over,
  };
}

function cursor(): WatchCursor {
  return {
    schema: 1,
    project: 'B',
    seat: 'orch',
    seq: 3,
    updated_at: T0,
    tickets: {
      '7b0c6a8e-0000-4000-8000-000000000001': {
        key: 'B-1422',
        state: 'In Progress',
        awaiting: true,
        reason: 'plan-draft',
        ref_id: 'abc',
        iteration: 1,
        conduction_status: 'running',
        leg_ended_at: null,
        waiting_on: { kind: 'human' },
        first_seen: T0,
        last_reported: null,
        reminders: 0,
      },
    },
  };
}

const profile: SeatProfile = {
  session_id: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
  project: 'B',
  milestone: 'v1.13',
  anchor: 'B-1422',
  owns: ['plan', 'release', 'ready'],
  held_for_founder: ['verify'],
  remind: '20m',
};

describe('home and path helpers', () => {
  it('resolves HARMONY_HOME, then ~/.harmony, and honours the override', () => {
    const saved = process.env.HARMONY_HOME;
    try {
      process.env.HARMONY_HOME = '/x/hh';
      expect(harmonyHome()).toBe('/x/hh');
      expect(harmonyHome('/override')).toBe('/override');
      delete process.env.HARMONY_HOME;
      expect(harmonyHome()).toMatch(/\.harmony$/);
    } finally {
      if (saved === undefined) delete process.env.HARMONY_HOME;
      else process.env.HARMONY_HOME = saved;
    }
  });

  it('builds the four paths under home', () => {
    expect(seatProfilePath('orch', { home })).toBe(join(home, 'seats', 'orch.yml'));
    expect(cursorPath('B', 'orch', { home })).toBe(join(home, 'watch', 'B', 'orch.json'));
    expect(heartbeatPath('B', 'orch', { home })).toBe(join(home, 'watch', 'B', 'orch.heartbeat.json'));
    expect(lockPath('B', 'orch', { kind: 'conductions' }, { home })).toBe(
      join(home, 'watch', 'B', 'orch.conductions.lock'),
    );
  });

  it('rejects path traversal in seat names and project keys', () => {
    for (const bad of ['../x', 'a/b', '..', '.', '', 'a b', 'x\\y']) {
      expect(() => seatProfilePath(bad, { home })).toThrow(/invalid seat name/);
      expect(() => cursorPath(bad, 'orch', { home })).toThrow(/invalid project key/);
      expect(() => heartbeatPath('B', bad, { home })).toThrow(/invalid seat name/);
      expect(() => lockPath('B', bad, { kind: 'conductions' }, { home })).toThrow(/invalid seat name/);
    }
  });
});

describe('scopeSlug', () => {
  it('slugs each scope kind deterministically', () => {
    expect(scopeSlug({ kind: 'milestone', id: 'V1.13' })).toBe('milestone-v1-13');
    expect(scopeSlug({ kind: 'conductions' })).toBe('conductions');
    expect(scopeSlug({ kind: 'keys', keys: ['B-20', 'B-3', 'b-1'] })).toBe('keys-b-1-b-20-b-3');
    expect(scopeSlug({ kind: 'keys', keys: ['B-3', 'B-20', 'B-1'] })).toBe(
      scopeSlug({ kind: 'keys', keys: ['B-1', 'B-20', 'B-3'] }),
    );
    expect(scopeSlug({ kind: 'milestone', id: '../../etc' })).toMatch(/^[a-z0-9-]+$/);
  });

  it('truncates past 80 chars with a sha256 suffix that keeps slugs unique', () => {
    const keys = Array.from({ length: 30 }, (_, i) => `B-${1000 + i}`);
    const a = scopeSlug({ kind: 'keys', keys });
    const b = scopeSlug({ kind: 'keys', keys: [...keys.slice(0, 29), 'B-9999'] });
    expect(a.length).toBeLessThanOrEqual(80);
    expect(a).toMatch(/^keys-b-1000-[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(a).toBe(scopeSlug({ kind: 'keys', keys: [...keys].reverse() }));
  });

  it('rejects empty scopes', () => {
    expect(() => scopeSlug({ kind: 'keys', keys: [] })).toThrow();
    expect(() => scopeSlug({ kind: 'milestone', id: '' })).toThrow();
  });
});

describe('parseDuration', () => {
  it('parses durations to ms', () => {
    expect(parseDuration('20m')).toBe(20 * 60_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
  });
  it('returns null for anything else', () => {
    for (const bad of ['', '20', 'm', '20x', '-5m', '0m', '1.5h', 'soon']) expect(parseDuration(bad)).toBeNull();
  });
});

describe('readSeatProfile', () => {
  it('reads a written profile with a greppable session_id line', () => {
    const path = writeSeatProfile('orch', profile, { home });
    const text = readFileSync(path, 'utf8');
    expect(text.split('\n')[0]).toBe(`session_id: ${profile.session_id}`);
    const grep = execFileSync('grep', ['-l', `session_id: ${profile.session_id}`, path], { encoding: 'utf8' });
    expect(grep.trim()).toBe(path);
    const r = readSeatProfile('orch', { home });
    expect(r).toEqual({ status: 'ok', value: profile, path });
  });

  it('ignores unknown keys and defaults missing fields', () => {
    mkdirSync(join(home, 'seats'), { recursive: true });
    writeFileSync(join(home, 'seats', 'min.yml'), 'session_id: abc\nfuture_key: 1\n');
    const r = readSeatProfile('min', { home });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.value).toEqual({
        session_id: 'abc',
        project: null,
        milestone: null,
        anchor: null,
        owns: [],
        held_for_founder: [],
        remind: null,
      });
    }
  });

  it('absent / malformed (bad YAML, bad shape, bad remind, traversal)', () => {
    expect(readSeatProfile('nobody', { home }).status).toBe('absent');
    mkdirSync(join(home, 'seats'), { recursive: true });
    writeFileSync(join(home, 'seats', 'bad.yml'), 'owns: [unclosed\n  : :\n');
    const bad = readSeatProfile('bad', { home });
    expect(bad.status).toBe('malformed');
    if (bad.status === 'malformed') expect(bad.error).toMatch(/YAML/);
    writeFileSync(join(home, 'seats', 'list.yml'), '- a\n- b\n');
    expect(readSeatProfile('list', { home }).status).toBe('malformed');
    writeFileSync(join(home, 'seats', 'shape.yml'), 'owns: 5\n');
    expect(readSeatProfile('shape', { home }).status).toBe('malformed');
    writeFileSync(join(home, 'seats', 'rem.yml'), 'remind: soon\n');
    expect(readSeatProfile('rem', { home }).status).toBe('malformed');
    expect(readSeatProfile('../etc/passwd', { home })).toMatchObject({ status: 'malformed', error: 'invalid seat name' });
  });

  it('formatSeatProfile refuses an unsafe session id', () => {
    expect(() => formatSeatProfile({ ...profile, session_id: 'a\nb: c' })).toThrow();
  });
});

describe('heartbeat and cursor readers', () => {
  it('round-trips heartbeat and cursor', () => {
    const hp = writeHeartbeat('B', 'orch', hb({ seq: 2 }), { home });
    expect(readHeartbeat('B', 'orch', { home })).toEqual({ status: 'ok', value: hb({ seq: 2 }), path: hp });
    const cp = writeCursor('B', 'orch', cursor(), { home });
    expect(readCursor('B', 'orch', { home })).toEqual({ status: 'ok', value: cursor(), path: cp });
  });

  it('absent when missing', () => {
    expect(readHeartbeat('B', 'orch', { home }).status).toBe('absent');
    expect(readCursor('B', 'orch', { home }).status).toBe('absent');
    expect(readLock('B', 'orch', { kind: 'conductions' }, { home }).status).toBe('absent');
  });

  it('malformed on bad JSON, wrong schema, bad shape, traversal', () => {
    const hp = heartbeatPath('B', 'orch', { home });
    const cp = cursorPath('B', 'orch', { home });
    const lp = lockPath('B', 'orch', { kind: 'conductions' }, { home });
    mkdirSync(join(home, 'watch', 'B'), { recursive: true });

    writeFileSync(hp, '{not json');
    expect(readHeartbeat('B', 'orch', { home })).toMatchObject({ status: 'malformed', error: expect.stringMatching(/JSON/) });
    writeFileSync(hp, JSON.stringify({ ...hb(), schema: 2 }));
    expect(readHeartbeat('B', 'orch', { home })).toMatchObject({ status: 'malformed', error: expect.stringMatching(/schema/) });
    writeFileSync(hp, JSON.stringify({ ...hb(), health: 'great' }));
    expect(readHeartbeat('B', 'orch', { home }).status).toBe('malformed');

    writeFileSync(cp, '[]');
    expect(readCursor('B', 'orch', { home }).status).toBe('malformed');
    writeFileSync(cp, JSON.stringify({ ...cursor(), schema: undefined }));
    expect(readCursor('B', 'orch', { home }).status).toBe('malformed');

    writeFileSync(lp, '');
    expect(readLock('B', 'orch', { kind: 'conductions' }, { home }).status).toBe('malformed');
    writeFileSync(lp, JSON.stringify({ schema: 1, pid: 1, hostname: 'h', scope: 'conductions', mode: 'once', started_at: T0 }));
    expect(readLock('B', 'orch', { kind: 'conductions' }, { home }).status).toBe('malformed');

    expect(readHeartbeat('../x', 'orch', { home })).toMatchObject({ status: 'malformed', error: 'invalid project key' });
    expect(readCursor('B', 'a/b', { home })).toMatchObject({ status: 'malformed', error: 'invalid seat name' });
    expect(readLock('B', '..', { kind: 'conductions' }, { home }).status).toBe('malformed');
  });

  it('malformed (not a throw) on an unreadable path', () => {
    mkdirSync(heartbeatPath('B', 'orch', { home }), { recursive: true }); // a directory, EISDIR
    expect(readHeartbeat('B', 'orch', { home })).toMatchObject({ status: 'malformed', error: expect.stringMatching(/unreadable/) });
  });
});

describe('isHeartbeatStale', () => {
  it('uses the five-minute minimum for short intervals', () => {
    const h = hb({ poll_interval_s: 30, last_fetch_at: T0 });
    expect(isHeartbeatStale(h, T0_MS + 5 * 60_000)).toBe(false);
    expect(isHeartbeatStale(h, T0_MS + 5 * 60_000 + 1)).toBe(true);
  });
  it('uses three intervals when that is longer', () => {
    const h = hb({ poll_interval_s: 200, last_fetch_at: T0 });
    expect(isHeartbeatStale(h, T0_MS + 600_000)).toBe(false);
    expect(isHeartbeatStale(h, T0_MS + 600_001)).toBe(true);
  });
  it('falls back to started_at when there was no fetch yet', () => {
    const h = hb({ started_at: T0, last_fetch_at: null });
    expect(isHeartbeatStale(h, T0_MS + 60_000)).toBe(false);
    expect(isHeartbeatStale(h, T0_MS + 10 * 60_000)).toBe(true);
  });
});

describe('isLockHeld', () => {
  const lock: WatchLock = { schema: 1, pid: 99, hostname: 'here', scope: 'conductions', mode: 'follow', started_at: T0 };
  it('same host: follows the pid check', () => {
    expect(isLockHeld(lock, { hostname: 'here', isPidAlive: () => true })).toBe(true);
    expect(isLockHeld(lock, { hostname: 'here', isPidAlive: () => false })).toBe(false);
  });
  it('another host: always held', () => {
    expect(isLockHeld(lock, { hostname: 'elsewhere', isPidAlive: () => false })).toBe(true);
  });
  it('default pid check sees this process alive', () => {
    expect(isLockHeld({ pid: process.pid, hostname: hostname() })).toBe(true);
  });
});

describe('acquireLock / releaseLock', () => {
  const scope = { kind: 'milestone', id: 'v1.13' } as const;

  it('acquires, then reports the holder to a second watch', () => {
    const a = acquireLock('B', 'orch', scope, 'follow', { home, pid: 111, isPidAlive: () => true });
    expect(a.status).toBe('acquired');
    if (a.status === 'acquired') {
      expect(a.lock).toMatchObject({ schema: 1, pid: 111, hostname: hostname(), scope: 'milestone-v1-13', mode: 'follow' });
    }
    const b = acquireLock('B', 'orch', scope, 'until-event', { home, pid: 222, isPidAlive: () => true });
    expect(b).toMatchObject({ status: 'held', holder: { pid: 111 } });
    expect(readdirSync(join(home, 'watch', 'B'))).toEqual(['orch.milestone-v1-13.lock']);
  });

  it('takes over a dead-pid lock', () => {
    acquireLock('B', 'orch', scope, 'follow', { home, pid: 111 });
    const b = acquireLock('B', 'orch', scope, 'follow', { home, pid: 222, isPidAlive: (p) => p !== 111 });
    expect(b.status).toBe('acquired');
    const r = readLock('B', 'orch', scope, { home });
    expect(r).toMatchObject({ status: 'ok', value: { pid: 222 } });
  });

  it('takes over a malformed lock', () => {
    const lp = lockPath('B', 'orch', scope, { home });
    mkdirSync(join(home, 'watch', 'B'), { recursive: true });
    writeFileSync(lp, 'garbage');
    expect(acquireLock('B', 'orch', scope, 'follow', { home, pid: 333 }).status).toBe('acquired');
  });

  it('does not take over a lock from another host', () => {
    acquireLock('B', 'orch', scope, 'follow', { home, pid: 111, hostname: 'other-host' });
    const b = acquireLock('B', 'orch', scope, 'follow', { home, pid: 222, isPidAlive: () => false });
    expect(b).toMatchObject({ status: 'held', holder: { hostname: 'other-host' } });
  });

  it('releaseLock removes only a lock with a matching pid', () => {
    acquireLock('B', 'orch', scope, 'follow', { home, pid: 111 });
    expect(releaseLock('B', 'orch', scope, { home, pid: 222 })).toBe(false);
    expect(existsSync(lockPath('B', 'orch', scope, { home }))).toBe(true);
    expect(releaseLock('B', 'orch', scope, { home, pid: 111 })).toBe(true);
    expect(existsSync(lockPath('B', 'orch', scope, { home }))).toBe(false);
    expect(releaseLock('B', 'orch', scope, { home, pid: 111 })).toBe(false);
  });
});

describe('writeJsonAtomic', () => {
  it('creates parents, writes the value, leaves no tmp file', () => {
    const p = join(home, 'deep', 'er', 'f.json');
    writeJsonAtomic(p, { a: 1 });
    writeJsonAtomic(p, { a: 2 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 2 });
    expect(readdirSync(join(home, 'deep', 'er'))).toEqual(['f.json']);
  });
});
