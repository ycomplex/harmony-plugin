import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createLogShipper, type LogEntry, type LogLevel } from './log-shipper.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const entry = (n: number, extra: Partial<LogEntry> = {}): LogEntry => ({ ts: new Date(1_000_000 + n).toISOString(), level: 'info', event: 'e', message: `m${n}`, ...extra });

function harness(over: { project?: string | undefined; shipping?: boolean | undefined } = { project: 'proj-1' }) {
  const state = { project: 'project' in over ? over.project : 'proj-1', shipping: over.shipping, t: 1_000_000 };
  const local: Array<{ level: LogLevel; event: string; message: string }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
  const fetchToken = vi.fn(async () => 'tok-abc');
  const shipper = createLogShipper({
    getProject: () => state.project,
    getLogShipping: () => state.shipping,
    getProjectKey: () => 'B',
    logLocal: (level, event, message) => local.push({ level, event, message }),
    fetchImpl,
    fetchToken,
    now: () => state.t,
    setIntervalImpl: () => 1,
    queueCap: 5,
    flushBatch: 3,
  });
  return { state, local, fetchImpl, fetchToken, shipper };
}

const bodyOf = (f: ReturnType<typeof vi.fn<typeof fetch>>, i = 0) => JSON.parse(String(f.mock.calls[i][1]?.body));

describe('log shipper', () => {
  it('ships to entries:write for the named project, labelled, with level+event and ids', async () => {
    const h = harness();
    h.shipper.enqueue(entry(1, { level: 'warn', event: 'leg.exit', ticket: 'B-9', conduction: 'c-1', leg: 'leg-2' }));
    await h.shipper.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl.mock.calls[0][0]).toBe('https://logging.googleapis.com/v2/entries:write');
    const b = bodyOf(h.fetchImpl);
    expect(b.logName).toBe('projects/proj-1/logs/harmony-conductor');
    expect(b.labels).toEqual({ harmony_project: 'B' });
    expect(b.entries[0].severity).toBe('WARNING');
    expect(b.entries[0].jsonPayload).toEqual({ event: 'leg.exit', message: 'm1', ticket: 'B-9', conduction: 'c-1', leg: 'leg-2' });
    expect(h.shipper.stats().queued).toBe(0);
  });

  it('caches the access token across flushes', async () => {
    const h = harness();
    h.shipper.enqueue(entry(1));
    await h.shipper.flush();
    h.shipper.enqueue(entry(2));
    await h.shipper.flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    h.state.t += 51 * 60_000;
    h.shipper.enqueue(entry(3));
    await h.shipper.flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no gcp.project', { project: undefined, shipping: undefined }],
    ['log_shipping=false', { project: 'proj-1', shipping: false }],
  ])('is FULLY OFF with %s: no token fetch, no gcloud spawn, no fetch, nothing queued', async (_n, cfg) => {
    const h = harness(cfg);
    for (let i = 0; i < 20; i++) h.shipper.enqueue(entry(i));
    await h.shipper.flush();
    expect(h.fetchToken).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.shipper.stats()).toEqual({ queued: 0, dropped: 0 });
  });

  it('never spawns gcloud when off (default token fetcher path)', async () => {
    const spy = vi.mocked(execFile);
    const fetchImpl = vi.fn<typeof fetch>();
    const s = createLogShipper({ getProject: () => undefined, getLogShipping: () => undefined, logLocal: () => {}, fetchImpl });
    s.enqueue(entry(1));
    await s.flush();
    expect(spy).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('hot toggle: stops when log_shipping flips false, resumes when true, with no restart', async () => {
    const h = harness();
    h.shipper.enqueue(entry(1));
    await h.shipper.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.state.shipping = false;
    h.shipper.enqueue(entry(2));
    await h.shipper.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.state.shipping = undefined;
    h.shipper.enqueue(entry(3));
    await h.shipper.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(h.fetchImpl, 1).entries.map((e: { jsonPayload: { message: string } }) => e.jsonPayload.message)).toEqual(['m3']);
  });

  it('a project named hot (undefined -> set) starts shipping', async () => {
    const h = harness({ project: undefined });
    h.shipper.enqueue(entry(1));
    await h.shipper.flush();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    h.state.project = 'late-proj';
    h.shipper.enqueue(entry(2));
    await h.shipper.flush();
    expect(bodyOf(h.fetchImpl).logName).toBe('projects/late-proj/logs/harmony-conductor');
  });

  it('network cut: enqueue never throws or blocks; oldest dropped and counted; ONE warning after recovery', async () => {
    const h = harness();
    h.fetchImpl.mockRejectedValue(new Error('ENETUNREACH'));
    for (let i = 0; i < 8; i++) h.shipper.enqueue(entry(i)); // cap 5 -> 3 dropped
    h.state.t += 1000;
    await h.shipper.flush();
    expect(h.shipper.stats()).toEqual({ queued: 5, dropped: 3 });
    expect(h.local).toHaveLength(0);
    h.fetchImpl.mockResolvedValue(new Response('{}', { status: 200 }));
    const before = h.fetchImpl.mock.calls.length;
    await h.shipper.flush();
    const warns = h.local.filter((l) => l.event === 'log_shipping.dropped');
    expect(warns).toHaveLength(1);
    expect(warns[0].level).toBe('warn');
    expect(warns[0].message).toMatch(/dropped 3 entries between 1970-01-01T00:16:40\.000Z and 1970-01-01T00:16:40\.000Z/);
    await h.shipper.flush();
    expect(h.local.filter((l) => l.event === 'log_shipping.dropped')).toHaveLength(1);
    // the oldest were the ones dropped
    const delivered = h.fetchImpl.mock.calls.slice(before).flatMap((_c, i) => bodyOf(h.fetchImpl, before + i).entries.map((e: { jsonPayload: { message: string } }) => e.jsonPayload.message));
    expect(delivered).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('permission error is logged ONCE naming roles/logging.logWriter, retried every 5 minutes', async () => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }));
    h.shipper.enqueue(entry(1));
    await h.shipper.flush();
    expect(h.local).toHaveLength(1);
    expect(h.local[0].message).toContain('roles/logging.logWriter');
    for (let i = 0; i < 5; i++) {
      h.state.t += 10_000;
      h.shipper.enqueue(entry(10 + i));
      await h.shipper.flush();
    }
    expect(h.fetchImpl).toHaveBeenCalledTimes(1); // not retried per line / per flush
    h.state.t += 5 * 60_000;
    await h.shipper.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.local).toHaveLength(1); // still ONE log line
    h.fetchImpl.mockResolvedValue(new Response('{}', { status: 200 }));
    h.state.t += 5 * 60_000;
    await h.shipper.flush();
    expect(h.shipper.stats().queued).toBeLessThan(5);
  });

  it('an unrecoverable 400 batch is dropped and counted, not wedged', async () => {
    const h = harness();
    h.fetchImpl.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    h.shipper.enqueue(entry(1));
    await h.shipper.flush();
    expect(h.shipper.stats()).toEqual({ queued: 0, dropped: 1 });
  });
});
