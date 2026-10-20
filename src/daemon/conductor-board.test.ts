import { describe, it, expect } from 'vitest';
import { adoptionState, classifyLeases, heldBy, holderPrefix, type BoardRow } from './conductor-board.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const row = (id: string, holder: string | null, hb: string | null, status = 'active'): BoardRow => ({ id, ticket: `B-${id}`, status, lease_holder: holder, last_heartbeat_at: hb });
const FRESH = '2026-10-20T11:59:30Z';
const OLD = '2026-10-20T10:00:00Z';

describe('B-1171: heldBy', () => {
  it('returns active rows whose holder starts with host:pid:', () => {
    const rows = [row('1', 'h:10:aaaa', FRESH), row('2', 'h:100:bbbb', FRESH), row('3', 'h:10:cccc', FRESH, 'parked'), row('4', null, null)];
    expect(heldBy(rows, holderPrefix('h', 10)).map((r) => r.id)).toEqual(['1']);
  });
});

describe('B-1171: adoptionState (the board decides, never a log line)', () => {
  const rows = [row('a', 'h:20:x', FRESH), row('b', 'h:10:x', FRESH), row('c', 'h:20:x', OLD), row('d', 'h:20:x', FRESH, 'done')];
  const st = (id: string) => adoptionState(rows, id, 'h:20:', 120_000, NOW);
  it('ok: held by the new process with a fresh heartbeat', () => expect(st('a')).toEqual({ state: 'ok' }));
  it('wait: still held by another process', () => expect(st('b')).toMatchObject({ state: 'wait', why: 'lease holder is h:10:x' }));
  it('wait: adopted but the heartbeat is stale', () => expect(st('c')).toMatchObject({ state: 'wait', why: expect.stringContaining('not fresh') }));
  it('gone: no longer active, or absent', () => {
    expect(st('d')).toEqual({ state: 'gone' });
    expect(st('zzz')).toEqual({ state: 'gone' });
  });
});

describe('B-1171: classifyLeases', () => {
  it('splits this conductor / an earlier process on this host / another host', () => {
    const rows = [row('1', 'h:20:x', FRESH), row('2', 'h:10:x', FRESH), row('3', 'other:20:x', FRESH), row('4', 'h:20:x', OLD), row('5', 'h:20:x', FRESH, 'done')];
    const v = classifyLeases(rows, 'h', 20, 120_000, NOW);
    expect(v.map((l) => [l.id, l.owner, l.fresh])).toEqual([
      ['1', 'this-conductor', true],
      ['2', 'previous-process', true],
      ['3', 'other-host', true],
      ['4', 'this-conductor', false],
    ]);
  });
  it('with no conductor running, every lease on this host is an earlier process\'s', () => {
    const v = classifyLeases([row('1', 'h:20:x', FRESH)], 'h', null, 120_000, NOW);
    expect(v[0].owner).toBe('previous-process');
  });
});
