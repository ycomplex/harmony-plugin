// B-1009: unit coverage for the notify subscription sync's pure core.
//
// The two properties that keep AC6 cheap are pinned here: the HASH GATE (an unchanged declaration
// makes ZERO board calls and writes nothing) and the UNDECLARED FLOOR (a manifest with no `notify`
// makes zero board calls at all). gates.test.ts pins the other half — that every failure mode leaves
// a gate run's stdout and exit code byte-identical, through the REAL runner.

import { describe, it, expect, vi } from 'vitest';
import {
  syncNotifySubscriptions,
  normalizeNotifyDeclaration,
  hashNotifyDeclaration,
  notifySyncCachePath,
  NOTIFY_SYNC_CACHE_RELATIVE_PATH,
  type NotifySubscriptionDeclaration,
  type NotifySyncIO,
} from './notify-sync.js';
import type { NotifyEntry } from './project-manifest.js';

const ENTRIES: NotifyEntry[] = [
  { on: 'reaching Built', endpoint: 'https://hooks.example.test/built' },
  { on: 'reaching Verified', endpoint: 'https://hooks.example.test/built' },
  { on: 'reaching Verified', endpoint: 'https://hooks.example.test/verified' },
];

function harness(overrides: Partial<NotifySyncIO> = {}) {
  const calls: NotifySubscriptionDeclaration[][] = [];
  const writes: { path: string; contents: string }[] = [];
  const warnings: string[] = [];
  const io: NotifySyncIO = {
    callSyncRpc: async (subscriptions) => {
      calls.push(subscriptions);
      return { upserted: subscriptions.length, removed: 0 };
    },
    readCache: () => null,
    writeCache: (path, contents) => {
      writes.push({ path, contents });
    },
    timeoutMs: 50,
    now: () => new Date('2026-09-11T00:00:00.000Z'),
    ...overrides,
  };
  return { io, calls, writes, warnings };
}

describe('normalizeNotifyDeclaration', () => {
  it('groups by endpoint, strips the "reaching " prefix, and sorts deterministically', () => {
    expect(normalizeNotifyDeclaration(ENTRIES)).toEqual([
      { endpoint_url: 'https://hooks.example.test/built', transitions: ['Built', 'Verified'] },
      { endpoint_url: 'https://hooks.example.test/verified', transitions: ['Verified'] },
    ]);
  });

  it('is order-insensitive — reordering the YAML lines does not change the hash', () => {
    const reversed = [...ENTRIES].reverse();
    expect(hashNotifyDeclaration(normalizeNotifyDeclaration(reversed))).toBe(
      hashNotifyDeclaration(normalizeNotifyDeclaration(ENTRIES)),
    );
  });
});

describe('syncNotifySubscriptions — the declaration gate', () => {
  it('makes ZERO board calls when `notify` is undeclared', async () => {
    const { io, calls, writes } = harness();
    const readCache = vi.fn();
    const outcome = await syncNotifySubscriptions({
      projectRoot: '/fake/project',
      entries: [],
      io: { ...io, readCache },
      warn: () => expect.unreachable('no warning on the undeclared floor'),
    });
    expect(outcome).toEqual({ kind: 'undeclared' });
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(readCache).not.toHaveBeenCalled();
  });
});

describe('syncNotifySubscriptions — the hash gate', () => {
  it('unchanged hash ⇒ ZERO calls, zero writes, zero warnings', async () => {
    const hash = hashNotifyDeclaration(normalizeNotifyDeclaration(ENTRIES));
    const warnings: string[] = [];
    const { io, calls, writes } = harness({
      readCache: () => JSON.stringify({ version: 1, hash, synced_at: '2026-09-10T00:00:00.000Z' }),
    });
    const outcome = await syncNotifySubscriptions({
      projectRoot: '/fake/project',
      entries: ENTRIES,
      io,
      warn: (line) => warnings.push(line),
    });
    expect(outcome).toEqual({ kind: 'unchanged', hash });
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('changed hash ⇒ EXACTLY ONE call, in the RPC\'s parameter shape, then the cache is written', async () => {
    const warnings: string[] = [];
    const { io, calls, writes } = harness({
      readCache: () => JSON.stringify({ version: 1, hash: 'some-older-hash', synced_at: 'x' }),
    });
    const outcome = await syncNotifySubscriptions({
      projectRoot: '/fake/project',
      entries: ENTRIES,
      io,
      warn: (line) => warnings.push(line),
    });
    expect(outcome.kind).toBe('synced');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { endpoint_url: 'https://hooks.example.test/built', transitions: ['Built', 'Verified'] },
      { endpoint_url: 'https://hooks.example.test/verified', transitions: ['Verified'] },
    ]);
    expect(warnings).toHaveLength(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`/fake/project/${NOTIFY_SYNC_CACHE_RELATIVE_PATH}`);
    expect(JSON.parse(writes[0].contents)).toEqual({
      version: 1,
      hash: hashNotifyDeclaration(normalizeNotifyDeclaration(ENTRIES)),
      synced_at: '2026-09-11T00:00:00.000Z',
    });
  });

  it('an absent cache is a MISS, not a failure — it syncs and writes, silently', async () => {
    const warnings: string[] = [];
    const { io, calls, writes } = harness({ readCache: () => null });
    const outcome = await syncNotifySubscriptions({
      projectRoot: '/fake/project',
      entries: ENTRIES,
      io,
      warn: (line) => warnings.push(line),
    });
    expect(outcome.kind).toBe('synced');
    expect(calls).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it('a corrupt cache is a MISS, not a warning', async () => {
    const warnings: string[] = [];
    const { io, calls } = harness({
      readCache: () => '{ not json at all',
    });
    const outcome = await syncNotifySubscriptions({
      projectRoot: '/fake/project',
      entries: ENTRIES,
      io,
      warn: (line) => warnings.push(line),
    });
    expect(outcome.kind).toBe('synced');
    expect(calls).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it('a FAILED sync does NOT write the cache — the next run retries (the absent-RPC case)', async () => {
    const warnings: string[] = [];
    const { io, writes } = harness({
      callSyncRpc: async () => {
        throw Object.assign(new Error('Could not find the function public.notify_sync_subscriptions'), {
          code: 'PGRST202',
        });
      },
    });
    const outcome = await syncNotifySubscriptions({
      projectRoot: '/fake/project',
      entries: ENTRIES,
      io,
      warn: (line) => warnings.push(line),
    });
    expect(outcome).toEqual({ kind: 'warned', reason: 'absent-rpc' });
    expect(writes).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});

describe('syncNotifySubscriptions — failure modes each cost EXACTLY ONE warning and never throw', () => {
  const cases: { name: string; io: Partial<NotifySyncIO>; reason: string }[] = [
    {
      name: 'unreachable board',
      io: {
        callSyncRpc: async () => {
          throw new Error('fetch failed');
        },
      },
      reason: 'unreachable',
    },
    {
      name: 'absent RPC (42883)',
      io: {
        callSyncRpc: async () => {
          throw Object.assign(new Error('function does not exist'), { code: '42883' });
        },
      },
      reason: 'absent-rpc',
    },
    {
      name: 'malformed result',
      io: { callSyncRpc: async () => 'not an object' },
      reason: 'malformed',
    },
    {
      name: 'unwritable cache',
      io: {
        writeCache: () => {
          throw new Error('EACCES');
        },
      },
      reason: 'cache-write',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} ⇒ one warning, no throw`, async () => {
      const warnings: string[] = [];
      const { io } = harness(testCase.io);
      const outcome = await syncNotifySubscriptions({
        projectRoot: '/fake/project',
        entries: ENTRIES,
        io,
        warn: (line) => warnings.push(line),
      });
      expect(outcome).toEqual({ kind: 'warned', reason: testCase.reason });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('harmony notify sync: WARNING');
    });
  }

  it('a SLOW board is ABANDONED at the hard timeout — the signal is aborted and the sync returns', async () => {
    const warnings: string[] = [];
    let aborted = false;
    const { io, writes } = harness({
      timeoutMs: 20,
      callSyncRpc: (_subscriptions, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          // Ten seconds — far beyond the timeout. If the timeout were advisory rather than hard,
          // this test would hang instead of returning.
          const timer = setTimeout(() => resolve({ upserted: 1 }), 10_000);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
    });
    const startedAt = Date.now();
    const outcome = await syncNotifySubscriptions({
      projectRoot: '/fake/project',
      entries: ENTRIES,
      io,
      warn: (line) => warnings.push(line),
    });
    expect(outcome).toEqual({ kind: 'warned', reason: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(aborted).toBe(true);
    expect(writes).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('abandoned');
  });
});

describe('notifySyncCachePath', () => {
  it('sits beside B-992\'s gate-evidence markers under .harmony/', () => {
    expect(notifySyncCachePath('/repo')).toBe('/repo/.harmony/.notify-sync.json');
  });
});
