import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitBlobSha, fetchProjectFile, readSnapshot, refreshProjectFile, writeSnapshot } from './conductor-project-source.js';

const GOOD = JSON.stringify({ version: 1, channel: 'staging', profile: 'cloud', gcp: { project: 'p' } });
const GOOD2 = JSON.stringify({ version: 1, channel: 'prod', profile: 'cloud', gcp: { project: 'p' } });
const token = async () => 'tok';

const res = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : body, { status, headers });

let dir: string;
let snapPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-src-'));
  snapPath = join(dir, 'snap.json');
});

const snap = (content: string, over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  source: { repo: 'o/r', ref: 'main', path: '.harmony/conductor.json' },
  etag: 'W/"old"',
  sha: gitBlobSha(content),
  fetched_at: '2026-01-01T00:00:00.000Z',
  content,
  ...over,
});

describe('fetchProjectFile', () => {
  it('GETs the contents API with the raw accept header, bearer token and etag', async () => {
    const fetchImpl = vi.fn(async () => res(200, GOOD, { etag: 'W/"1"' }));
    const r = await fetchProjectFile({ repo: 'o/r', etag: 'W/"0"', tokenProvider: token, fetchImpl: fetchImpl as any });
    expect(r).toEqual({ status: 'ok', text: GOOD, etag: 'W/"1"', sha: gitBlobSha(GOOD) });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/o/r/contents/.harmony/conductor.json?ref=main');
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'If-None-Match': 'W/"0"',
    });
    expect(init.signal).toBeDefined();
  });

  it('gitBlobSha matches git hash-object', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('304 -> not-modified', async () => {
    expect(await fetchProjectFile({ repo: 'o/r', tokenProvider: token, fetchImpl: (async () => res(304)) as any })).toEqual({ status: 'not-modified' });
  });

  it('404 -> not-found naming repo/path/ref and the installation hint', async () => {
    const r = await fetchProjectFile({ repo: 'o/r', ref: 'dev', tokenProvider: token, fetchImpl: (async () => res(404)) as any });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.code).toBe('not-found');
      expect(r.message).toContain('o/r');
      expect(r.message).toContain('.harmony/conductor.json');
      expect(r.message).toContain('dev');
      expect(r.message).toContain('installation may not include');
    }
  });

  it('403 carries the hint too; 401/500/network/no-token never throw', async () => {
    const f = (fetchImpl: any, tp = token) => fetchProjectFile({ repo: 'o/r', tokenProvider: tp, fetchImpl });
    const forbidden = await f(async () => res(403));
    expect(forbidden).toMatchObject({ status: 'error', code: 'forbidden' });
    expect(await f(async () => res(401))).toMatchObject({ code: 'unauthorized' });
    expect(await f(async () => res(500))).toMatchObject({ code: 'http-500' });
    expect(await f(async () => { throw new Error('ECONNRESET'); })).toMatchObject({ code: 'network' });
    expect(await f(async () => res(200), async () => null)).toMatchObject({ code: 'no-token' });
    expect(await f(async () => res(200), async () => { throw new Error('key'); })).toMatchObject({ code: 'no-token' });
  });
});

describe('snapshot read/write', () => {
  it('writes atomically at mode 0600, leaves no temp file, and round-trips', () => {
    const s = snap(GOOD);
    writeSnapshot(join(dir, 'sub', 'snap.json'), s);
    expect(readSnapshot(join(dir, 'sub', 'snap.json'))).toEqual(s);
    expect(statSync(join(dir, 'sub', 'snap.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'sub'))).toEqual(['snap.json']);
  });

  it('a failed write leaves the existing snapshot intact and cleans up its temp file', () => {
    writeSnapshot(snapPath, snap(GOOD));
    mkdirSync(join(dir, 'blocker'));
    // rename onto a directory fails: the original at snapPath must be untouched elsewhere.
    expect(() => writeSnapshot(join(dir, 'blocker'), snap(GOOD2))).toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readSnapshot(snapPath)?.content).toBe(GOOD);
  });

  it('readSnapshot is null for absent or malformed files', () => {
    expect(readSnapshot(join(dir, 'nope.json'))).toBeNull();
    writeFileSync(snapPath, '{"version":1}');
    expect(readSnapshot(snapPath)).toBeNull();
  });
});

describe('refreshProjectFile', () => {
  const run = (fetchImpl: any, warn?: (m: string) => void) =>
    refreshProjectFile({ repo: 'o/r', snapshotPath: snapPath, tokenProvider: token, fetchImpl, now: () => Date.parse('2026-02-02T00:00:00Z'), warn });

  it('first fetch writes the snapshot (updated)', async () => {
    const r = await run(async () => res(200, GOOD, { etag: 'W/"1"' }));
    expect(r).toEqual({ outcome: 'updated', warnings: [] });
    const s = readSnapshot(snapPath)!;
    expect(s).toMatchObject({ etag: 'W/"1"', sha: gitBlobSha(GOOD), content: GOOD, fetched_at: '2026-02-02T00:00:00.000Z', source: { repo: 'o/r', ref: 'main' } });
  });

  it('sends the snapshot etag; 304 -> unchanged without rewriting', async () => {
    writeSnapshot(snapPath, snap(GOOD));
    const fetchImpl = vi.fn(async () => res(304));
    expect((await run(fetchImpl)).outcome).toBe('unchanged');
    expect(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['If-None-Match']).toBe('W/"old"');
    expect(readSnapshot(snapPath)?.etag).toBe('W/"old"');
  });

  it('same sha with a new etag -> unchanged; changed content -> updated', async () => {
    writeSnapshot(snapPath, snap(GOOD));
    expect((await run(async () => res(200, GOOD, { etag: 'W/"2"' }))).outcome).toBe('unchanged');
    expect((await run(async () => res(200, GOOD2, { etag: 'W/"3"' }))).outcome).toBe('updated');
    expect(readSnapshot(snapPath)?.content).toBe(GOOD2);
  });

  it('keeps the last-good snapshot on an invalid fetch, with ONE warning in the error format', async () => {
    writeSnapshot(snapPath, snap(GOOD));
    const before = readFileSync(snapPath, 'utf8');
    const warn = vi.fn();
    const r = await run(async () => res(200, JSON.stringify({ version: 1, channel: 'dev', profile: 'cloud', bogus: 1 })), warn);
    expect(r.outcome).toBe('kept-last-good');
    expect(r.warnings).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(r.warnings[0]).toContain('conductor.json (main) › bogus: unknown key. Fix:');
    expect(r.warnings[0]).toContain('conductor.json (main) › channel');
    expect(readFileSync(snapPath, 'utf8')).toBe(before);
  });

  it('invalid JSON text is also kept-last-good', async () => {
    writeSnapshot(snapPath, snap(GOOD));
    expect((await run(async () => res(200, '{ nope'))).outcome).toBe('kept-last-good');
    expect(readSnapshot(snapPath)?.content).toBe(GOOD);
  });

  it('keeps the snapshot on a network error and on 404, warns once, never throws', async () => {
    writeSnapshot(snapPath, snap(GOOD));
    const net = await run(async () => { throw new Error('offline'); });
    expect(net.outcome).toBe('unreachable');
    expect(net.warnings).toHaveLength(1);
    expect(net.warnings[0]).toContain('keeping the last-good snapshot');
    const nf = await run(async () => res(404));
    expect(nf.outcome).toBe('unreachable');
    expect(nf.warnings[0]).toContain('installation may not include');
    expect(readSnapshot(snapPath)?.content).toBe(GOOD);
  });

  it('an unwritable snapshot path does not throw and reports', async () => {
    const r = await refreshProjectFile({ repo: 'o/r', snapshotPath: join(dir, 'blocker', 'x', 'snap.json'), tokenProvider: token, fetchImpl: (async () => res(200, GOOD)) as any });
    expect(['unreachable', 'updated']).toContain(r.outcome);
  });

  it('a snapshot from another repo does not donate its etag', async () => {
    writeSnapshot(snapPath, snap(GOOD, { source: { repo: 'x/y', ref: 'main', path: '.harmony/conductor.json' } }));
    const fetchImpl = vi.fn(async () => res(200, GOOD));
    await run(fetchImpl);
    expect(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['If-None-Match']).toBeUndefined();
  });
});
