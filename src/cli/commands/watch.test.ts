import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenExchangeError } from '../../auth.js';
import {
  acquireLock,
  cursorPath,
  heartbeatPath,
  readCursor,
  readHeartbeat,
  readLock,
  writeCursor,
  writeHeartbeat,
  writeSeatProfile,
  type Heartbeat,
} from '../../watch/seat-files.js';
import { conduction, FakeBoard, FakeClock, fakeSupabase, paused, T0, ticket } from '../../watch/test-fakes.js';
import { createBoardReader } from '../../watch/board-read.js';
import { isWake } from '../../watch/loop.js';
import { parseWatchArgs, registerWatchCommands, resolveBoardTarget, runWatchCommand, runWatchStatus, UsageError, type WatchCliDeps } from './watch.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'watch-cli-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
});

interface Fake {
  deps: WatchCliDeps;
  out: string[];
  err: string[];
  clock: FakeClock;
  board: FakeBoard;
  stop(): void;
}

function fake(over: Partial<WatchCliDeps> = {}): Fake {
  const clock = new FakeClock();
  const board = new FakeBoard(clock);
  const out: string[] = [];
  const err: string[] = [];
  let handler: ((sig: string) => void) | null = null;
  const deps: WatchCliDeps = {
    makeAuth: () => ({
      getAccessToken: async () => 'tok',
      getSupabaseUrl: () => 'http://127.0.0.1:1',
      getSupabaseAnonKey: () => 'anon',
      getProjectId: () => 'p1',
      forceRefresh: async () => {},
    }),
    makeClient: () => ({}) as never,
    makeReader: () => board,
    startHints: () => null,
    installGuards: () => () => {},
    resolveTarget: async () => 'prod',
    activeProjectName: () => 'backlogs',
    now: clock.now,
    sleep: clock.sleep,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    home,
    onSignal: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    ...over,
  };
  return { deps, out, err, clock, board, stop: () => handler?.('SIGINT') };
}

const jsonLines = (out: string[]) => out.map((l) => JSON.parse(l));

describe('parseWatchArgs', () => {
  it('needs exactly one scope', () => {
    expect(() => parseWatchArgs([], {}, false)).toThrow(UsageError);
    expect(() => parseWatchArgs(['B-1'], { milestone: 'm' }, false)).toThrow(/exactly one scope/);
    expect(() => parseWatchArgs([], { milestone: 'm', conductions: true }, false)).toThrow(/exactly one scope/);
  });
  it('at most one mode; none means --once', () => {
    expect(parseWatchArgs(['B-1'], {}, false).mode).toBe('once');
    expect(() => parseWatchArgs(['B-1'], { once: true, follow: true, seat: 's' }, false)).toThrow(/at most one/);
  });
  it('--until-event and --follow need --seat', () => {
    expect(() => parseWatchArgs(['B-1'], { untilEvent: true }, false)).toThrow(/needs --seat/);
    expect(() => parseWatchArgs(['B-1'], { follow: true }, false)).toThrow(/needs --seat/);
    expect(parseWatchArgs(['B-1'], { follow: true, seat: 'orch' }, false).seat).toBe('orch');
  });
  it('validates durations, keys and seat names', () => {
    expect(() => parseWatchArgs(['B-1'], { remind: '20' }, false)).toThrow(/--remind/);
    expect(() => parseWatchArgs(['B-1'], { maxWait: '5m', seat: 's', follow: true }, false)).toThrow(/--max-wait only/);
    expect(parseWatchArgs(['B-1'], { maxWait: '5m', seat: 's', untilEvent: true }, false).maxWaitMs).toBe(300_000);
    expect(() => parseWatchArgs(['nope'], {}, false)).toThrow(/not a ticket key/);
    expect(() => parseWatchArgs(['B-1'], { seat: '../x' }, false)).toThrow(/invalid seat/);
  });
  it('bad args through the registered command exit 2', async () => {
    const f = fake();
    const program = new Command().option('--json');
    registerWatchCommands(program, f.deps);
    await program.parseAsync(['watch', 'B-1', '--milestone', 'm'], { from: 'user' });
    expect(process.exitCode).toBe(2);
    expect(f.err.join('\n')).toMatch(/exactly one scope/);
  });
});

describe('runWatchCommand', () => {
  it('AC7: a second watch for the same seat+scope exits 2 naming the holder pid', async () => {
    const holderPid = process.ppid; // alive, on this host
    const first = acquireLock('B', 'orch', { kind: 'milestone', id: 'm1' }, 'follow', { home, pid: holderPid });
    expect(first.status).toBe('acquired');
    const f = fake();
    const code = await runWatchCommand(parseWatchArgs([], { milestone: 'm1', seat: 'orch', untilEvent: true }, true), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toContain(`pid ${holderPid}`);
    // the holder's lock is untouched
    const lock = readLock('B', 'orch', { kind: 'milestone', id: 'm1' }, { home });
    expect(lock.status === 'ok' && lock.value.pid).toBe(holderPid);
  });

  it('a token rejected at startup is fatal (exit 2)', async () => {
    const f = fake({
      makeAuth: () => ({
        getAccessToken: async () => {
          throw new TokenExchangeError('/functions/v1/auth-token', 401, { echoed: 'SECRET-API-TOKEN' });
        },
        getSupabaseUrl: () => '',
        getSupabaseAnonKey: () => '',
        getProjectId: () => 'p1',
        forceRefresh: async () => {},
      }),
    });
    const code = await runWatchCommand(parseWatchArgs(['B-1'], { seat: 'orch', follow: true }, true), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/token rejected/);
    expect(f.err.join('\n')).not.toContain('SECRET-API-TOKEN');
  });

  it('a network failure at startup is not fatal: offline, then recovered, then the watch runs', async () => {
    let n = 0;
    const f = fake({
      makeAuth: () => ({
        getAccessToken: async () => {
          if (++n <= 2) throw new TypeError('fetch failed');
          return 'tok';
        },
        getSupabaseUrl: () => '',
        getSupabaseAnonKey: () => '',
        getProjectId: () => 'p1',
        forceRefresh: async () => {},
      }),
    });
    f.board.put(paused(1));
    const code = await runWatchCommand(parseWatchArgs(['B-1'], { seat: 'orch' }, true), f.deps);
    expect(code).toBe(0);
    const lines = jsonLines(f.out);
    expect(lines.slice(0, 5).map((l) => (l.event === 'health' ? `health:${l.status}` : l.event))).toEqual([
      'health:warning', // no seat profile
      'health:offline',
      'health:recovered',
      'start',
      'ready',
    ]);
    expect(f.clock.sleeps).toEqual([5000, 15000]);
  });

  it('--once prints events and the current state, and writes neither cursor nor heartbeat', async () => {
    const f = fake();
    writeSeatProfile('orch', { session_id: 's1', project: 'B', milestone: null, anchor: null, owns: [], held_for_founder: ['verify'], remind: null }, { home });
    f.board.put(paused(1));
    f.board.put(paused(2, 'verification-ack-pending', { updated_at: new Date(T0 - 3 * 3600_000).toISOString() }));
    const code = await runWatchCommand(parseWatchArgs(['B-1', 'B-2'], { seat: 'orch', once: true }, false), f.deps);
    expect(code).toBe(0);
    expect(f.out.some((l) => /ready \[seat\] B-1/.test(l))).toBe(true);
    expect(f.out).toContain('B-2 In Progress: ready (verification-ack-pending) on founder for 3h — Ticket 2');
    expect(existsSync(cursorPath('B', 'orch', { home }))).toBe(false);
    expect(existsSync(heartbeatPath('B', 'orch', { home }))).toBe(false);
  });

  it('--follow writes cursor and heartbeat, and releases its lock on SIGINT', async () => {
    const f = fake();
    f.board.put(ticket(1, { conduction: conduction() }));
    f.clock.onTick((t) => {
      if (t >= T0 + 60_000) f.stop();
    });
    const scope = { kind: 'keys' as const, keys: ['B-1'] };
    const code = await runWatchCommand(parseWatchArgs(['B-1'], { seat: 'orch', follow: true }, true), f.deps);
    expect(code).toBe(130);
    expect(readCursor('B', 'orch', { home }).status).toBe('ok');
    const hb = readHeartbeat('B', 'orch', { home });
    expect(hb.status === 'ok' && hb.value).toMatchObject({ pid: process.pid, mode: 'follow', scope: 'keys-b-1', health: 'ok', poll_interval_s: 30 });
    expect(readLock('B', 'orch', scope, { home }).status).toBe('absent');
  });

  it('an absent seat profile: all events seat-owned, plus one health warning', async () => {
    const f = fake();
    f.board.put(paused(1, 'verification-ack-pending'));
    await runWatchCommand(parseWatchArgs(['B-1'], { seat: 'orch' }, true), f.deps);
    const lines = jsonLines(f.out);
    expect(lines.filter((l) => l.event === 'health')).toHaveLength(1);
    expect(lines.find((l) => l.event === 'ready').owner).toBe('seat');
  });
});

describe('scope and board checks (release-gate finding on 7cd36ba)', () => {
  const MS = 'c5a35a47-0000-4000-8000-000000000001';
  const FOREIGN = 'f0000000-0000-4000-8000-000000000002';
  const profileFor = (project: string) =>
    writeSeatProfile('orch', { session_id: 's1', project, milestone: null, anchor: null, owns: [], held_for_founder: [], remind: null }, { home });

  it('an unknown milestone uuid exits 2 naming the milestone, the active project and its target', async () => {
    const f = fake({ resolveTarget: async () => 'staging' });
    f.board.key = 'BVS';
    f.board.name = 'Backlogs Staging';
    f.board.milestones = new Map([[MS, { id: MS, name: 'v1.14' }]]);
    const zero = '00000000-0000-0000-0000-000000000000';
    for (const json of [true, false]) {
      f.err.length = 0;
      f.out.length = 0;
      const code = await runWatchCommand(parseWatchArgs([], { milestone: zero, once: true }, json), f.deps);
      expect(code).toBe(2);
      const msg = f.err.join('\n');
      expect(msg).toContain(zero);
      expect(msg).toContain('Backlogs Staging (BVS) on staging');
      expect(f.out.some((l) => /start/.test(l))).toBe(false);
    }
  });

  it('a milestone of another project exits 2 (the real reader refuses the foreign row)', async () => {
    const { client } = fakeSupabase((q) => {
      if (q.table === 'projects') return { data: { key: 'BVS', name: 'Backlogs Staging' }, error: null };
      if (q.table === 'milestones') return { data: [{ id: FOREIGN, name: 'v1.14', project_id: 'p-other' }], error: null };
      return { data: [], error: null };
    });
    const f = fake({ makeReader: (_c, projectId) => createBoardReader(client as never, projectId), resolveTarget: async () => 'staging' });
    const code = await runWatchCommand(parseWatchArgs([], { milestone: FOREIGN, once: true }, true), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(new RegExp(`milestone ${FOREIGN} is not in project BVS; the CLI's active project is Backlogs Staging \\(BVS\\) on staging`));
  });

  it('a real milestone with no tickets is not fatal: it starts, counts 0 and says nothing is waiting', async () => {
    const f = fake();
    f.board.milestones = new Map([[MS, { id: MS, name: 'v1.14' }]]);
    const code = await runWatchCommand(parseWatchArgs([], { milestone: 'v1.14', once: true }, false), f.deps);
    expect(code).toBe(0);
    expect(f.out).toEqual([
      `${new Date(T0).toISOString()} start watching milestone v1.14 (c5a35a47…) in project Backlogs (B) on prod — 0 tickets`,
      'nothing waiting (0 tickets watched in B on prod)',
    ]);
  });

  it('--json: the start event names project, key, target, scope and count, owner info', async () => {
    const f = fake();
    f.board.milestones = new Map([[MS, { id: MS, name: 'v1.14' }]]);
    f.board.put(ticket(1, { milestone_id: MS }));
    f.board.put(paused(2, 'plan-draft', { milestone_id: MS }));
    const code = await runWatchCommand(parseWatchArgs([], { milestone: MS, once: true }, true), f.deps);
    expect(code).toBe(0);
    const lines = jsonLines(f.out);
    expect(lines[0]).toMatchObject({
      event: 'start',
      owner: 'info',
      project: { name: 'Backlogs', key: 'B' },
      target: 'prod',
      scope: { kind: 'milestone', id: MS, name: 'v1.14' },
      tickets: 2,
      detail: 'watching milestone v1.14 (c5a35a47…) in project Backlogs (B) on prod — 2 tickets',
    });
    // --json never prints the human "nothing waiting" line
    expect(f.out.some((l) => l.startsWith('nothing waiting'))).toBe(false);
  });

  it('human --once with tickets but nothing waiting prints the summary line after the rows', async () => {
    const f = fake({ resolveTarget: async () => 'custom' });
    f.board.put(ticket(1));
    f.board.put(ticket(2));
    const code = await runWatchCommand(parseWatchArgs(['B-1', 'B-2'], { once: true }, false), f.deps);
    expect(code).toBe(0);
    expect(f.out[0]).toMatch(/ start watching tickets B-1, B-2 in project Backlogs \(B\) on custom — 2 tickets$/);
    expect(f.out.at(-1)).toBe('nothing waiting (2 tickets watched in B on custom)');
  });

  it('start never ends --until-event: a quiet board with only the start line runs to --max-wait (exit 3)', async () => {
    const f = fake();
    f.board.put(ticket(1));
    const code = await runWatchCommand(parseWatchArgs(['B-1'], { seat: 'orch', untilEvent: true, maxWait: '2m' }, true), f.deps);
    expect(code).toBe(3);
    const lines = jsonLines(f.out);
    expect(lines.filter((l) => l.event === 'start')).toHaveLength(1);
    expect(lines.find((l) => l.event === 'start').owner).toBe('info');
    expect(isWake(lines.find((l) => l.event === 'start'))).toBe(false);
  });

  it('a profile naming project B while the CLI points at BVS exits 2 naming both and the target, in every mode', async () => {
    profileFor('B');
    for (const opts of [{ once: true }, { untilEvent: true }, { follow: true }]) {
      const f = fake({ resolveTarget: async () => 'staging' });
      f.board.key = 'BVS';
      f.board.name = 'Backlogs Staging';
      f.board.put(ticket(1));
      const code = await runWatchCommand(parseWatchArgs(['1'], { seat: 'orch', ...opts }, true), f.deps);
      expect(code).toBe(2);
      const msg = f.err.join('\n');
      expect(msg).toContain('names project B');
      expect(msg).toContain('Backlogs Staging (BVS) on staging');
      expect(f.out.some((l) => l.includes('"event":"start"'))).toBe(false);
      expect(readLock('BVS', 'orch', { kind: 'keys', keys: ['1'] }, { home }).status).toBe('absent');
    }
  });

  it('a profile naming the active project passes', async () => {
    profileFor('B');
    const f = fake();
    f.board.put(ticket(1));
    expect(await runWatchCommand(parseWatchArgs(['B-1'], { seat: 'orch', once: true }, true), f.deps)).toBe(0);
  });

  it('the default target is get_project\'s resolver over the Supabase URL', async () => {
    expect(await resolveBoardTarget('https://eioxsunvhakmelhanmnn.supabase.co')).toBe('prod');
    expect(await resolveBoardTarget('https://meqkdgncdzromunylyxf.supabase.co')).toBe('staging');
    expect(await resolveBoardTarget('http://127.0.0.1:54321')).toBe('custom');
  });

  it('status with a profile project cannot check it offline: it says so on stderr and keeps its exit code', () => {
    profileFor('B');
    const f = fake({ activeProjectName: () => 'staging' });
    expect(runWatchStatus('orch', false, f.deps)).toBe(1);
    expect(f.out).toEqual(['watch orch: none (no heartbeat)']);
    expect(f.err.join('\n')).toMatch(/not checking the profile's project B against the CLI's active project "staging"/);
  });
});

describe('runWatchStatus', () => {
  const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
    schema: 1,
    pid: 4242,
    seat: 'orch',
    scope: 'milestone-m1',
    mode: 'follow',
    poll_interval_s: 30,
    started_at: new Date(T0 - 3600_000).toISOString(),
    last_fetch_at: new Date(T0 - 20_000).toISOString(),
    last_ok_at: new Date(T0 - 20_000).toISOString(),
    health: 'ok',
    seq: 9,
    ...over,
  });

  it('none → exit 1', () => {
    const f = fake();
    expect(runWatchStatus('nobody', false, f.deps)).toBe(1);
    expect(f.out).toEqual(['watch nobody: none (no heartbeat)']);
  });

  it('alive → exit 0; stale → exit 1 (found without a profile by scanning project dirs)', () => {
    const f = fake();
    writeHeartbeat('B', 'orch', hb(), { home });
    expect(runWatchStatus('orch', false, f.deps)).toBe(0);
    expect(f.out[0]).toMatch(/^watch orch \(B\): alive, health ok, last fetch 20s ago/);
    writeHeartbeat('B', 'orch', hb({ last_fetch_at: new Date(T0 - 10 * 60_000).toISOString() }), { home });
    expect(runWatchStatus('orch', true, f.deps)).toBe(1);
    expect(JSON.parse(f.out[1])).toMatchObject({ status: 'stale', last_fetch_age_s: 600 });
  });

  it('lists waiting items with owner and age from the cursor, founder-held included (AC5)', () => {
    const f = fake();
    writeHeartbeat('B', 'orch', hb(), { home });
    writeSeatProfile('orch', { session_id: 's1', project: 'B', milestone: 'm1', anchor: 'B-1', owns: [], held_for_founder: ['verify'], remind: '20m' }, { home });
    const base = { state: 'Built', ref_id: 'r', iteration: 1, conduction_status: 'active', leg_ended_at: null, waiting_on: null, last_reported: null, reminders: 0 };
    writeCursor('B', 'orch', {
      schema: 1, project: 'B', seat: 'orch', seq: 3, updated_at: new Date(T0).toISOString(),
      tickets: {
        t1: { ...base, key: 'B-1', awaiting: true, reason: 'verification-ack-pending', first_seen: new Date(T0 - 7200_000).toISOString() },
        t2: { ...base, key: 'B-2', awaiting: true, reason: 'plan-draft', first_seen: new Date(T0 - 600_000).toISOString() },
        t3: { ...base, key: 'B-3', awaiting: false, reason: null, first_seen: new Date(T0).toISOString() },
      },
    }, { home });
    expect(runWatchStatus('orch', true, f.deps)).toBe(0);
    expect(JSON.parse(f.out[0]).waiting).toEqual([
      { key: 'B-1', reason: 'verification-ack-pending', on: 'founder', since: new Date(T0 - 7200_000).toISOString(), age_s: 7200 },
      { key: 'B-2', reason: 'plan-draft', on: 'seat', since: new Date(T0 - 600_000).toISOString(), age_s: 600 },
    ]);
    expect(runWatchStatus('orch', false, f.deps)).toBe(0);
    expect(f.out.slice(2)).toEqual([expect.stringMatching(/^ {2}waiting on founder: B-1 verification-ack-pending for /), expect.stringMatching(/^ {2}waiting on seat: B-2 plan-draft for /)]);
  });

  it('missing --seat → exit 2', () => {
    const f = fake();
    expect(runWatchStatus(null, false, f.deps)).toBe(2);
  });

  it('registered `watch status --seat` reaches the status action', async () => {
    const f = fake();
    const program = new Command().option('--json');
    registerWatchCommands(program, f.deps);
    await program.parseAsync(['watch', 'status', '--seat', 'nobody'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(f.out).toEqual(['watch nobody: none (no heartbeat)']);
  });
});
