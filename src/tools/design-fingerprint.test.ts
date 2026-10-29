import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fingerprintFrames, takeFingerprint, compareFingerprint, FINGERPRINT_ALGORITHM,
  type FingerprintFetch,
} from './design-fingerprint.js';

// REAL nodes response for frame 25:205 (file cE0x2i7UkD7X73p8WwnCzy), captured 2026-10-29. Three reads taken
// ~100 s apart were byte-identical (sha256 c349e903ba5b1e68024003f79d17c0c718bac33f6c5ff9ae33d9fd3670804e37).
const raw = readFileSync(fileURLToPath(new URL('./__fixtures__/design-fingerprint.live-2026-10-29.json', import.meta.url)), 'utf8');
type N = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const load = (): N => JSON.parse(raw) as N;
const FRAME = '25:205';
const walk = (n: N, fn: (n: N) => void) => { fn(n); for (const c of n.children ?? []) walk(c, fn); };
const frameOf = (r: N): N => r.nodes[FRAME].document;
const find = (r: N, pred: (n: N) => boolean): N => { let hit: N | undefined; walk(frameOf(r), (n) => { if (!hit && n.id !== FRAME && pred(n)) hit = n; }); if (!hit) throw new Error('fixture lacks node'); return hit; };
const digest = (r: N, ids = [FRAME]) => { const f = fingerprintFrames(r, ids); if (!f.ok) throw new Error('fp'); return f; };
const base = digest(load());

describe('fingerprintFrames: stability', () => {
  it('two parses of the recorded response give equal digests, 16 hex chars', () => {
    expect(digest(load()).digest).toBe(base.digest);
    expect(base.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(base.frames).toEqual([{ id: FRAME, digest: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
  });

  it('volatile fields do not move the digest (version, lastModified, thumbnail, render bounds, canvas drag, prototype, exports)', () => {
    const r = load();
    r.version = '999'; r.lastModified = '2030-01-01T00:00:00Z'; r.thumbnailUrl = 'https://x.invalid/t'; r.name = 'renamed file';
    r.role = 'viewer'; r.editorType = 'figjam'; r.linkAccess = 'none';
    walk(frameOf(r), (n) => {
      if (n.absoluteRenderBounds) n.absoluteRenderBounds = { x: 1, y: 2, width: 3, height: 4 };
      if (n.absoluteBoundingBox) { n.absoluteBoundingBox.x += 500; n.absoluteBoundingBox.y += 500; }
      n.interactions = [{ trigger: { type: 'ON_CLICK' } }]; n.transitionDuration = 9; n.transitionEasing = 'x'; n.transitionNodeID = '1:1';
      n.exportSettings = [{ suffix: '@2x' }]; n.pluginData = { a: 1 }; n.sharedPluginData = { b: 2 };
    });
    expect(digest(r).digest).toBe(base.digest);
  });

  it('rounds numbers to 2 decimals', () => {
    const r = load();
    const n = find(r, (x) => !!x.absoluteBoundingBox);
    n.absoluteBoundingBox.width += 0.001;
    expect(digest(r).digest).toBe(base.digest);
  });
});

describe('fingerprintFrames: real changes', () => {
  it('a changed text', () => {
    const r = load();
    const t = find(r, (n) => n.type === 'TEXT' && typeof n.characters === 'string');
    t.characters += '!';
    expect(digest(r).digest).not.toBe(base.digest);
  });
  it('a swapped instance (componentId)', () => {
    const r = load();
    find(r, (n) => n.type === 'INSTANCE' && n.componentId).componentId = '999:999';
    expect(digest(r).digest).not.toBe(base.digest);
  });
  it('a fill colour changed beyond 4 decimals, but not within', () => {
    const within = load();
    const fill = (r: N) => find(r, (n) => Array.isArray(n.fills) && n.fills.some((f: N) => f.type === 'SOLID' && f.color)).fills.find((f: N) => f.type === 'SOLID' && f.color);
    fill(within).color.r += 0.00001;
    expect(digest(within).digest).toBe(base.digest);
    const beyond = load();
    fill(beyond).color.r += 0.001;
    expect(digest(beyond).digest).not.toBe(base.digest);
  });
  it('a child moved inside the frame', () => {
    const r = load();
    const n = find(r, (x) => !!x.absoluteBoundingBox);
    n.absoluteBoundingBox.x += 12;
    expect(digest(r).digest).not.toBe(base.digest);
  });
  it('a resized child, a hidden child and a changed auto-layout field', () => {
    for (const edit of [
      (r: N) => { find(r, (x) => !!x.absoluteBoundingBox).absoluteBoundingBox.height += 5; },
      (r: N) => { find(r, (x) => true).visible = false; },
      (r: N) => { find(r, (x) => typeof x.itemSpacing === 'number').itemSpacing += 4; },
    ]) { const r = load(); edit(r); expect(digest(r).digest).not.toBe(base.digest); }
  });

  it('a reordered frame pair changes the overall digest, not the per-frame digests', () => {
    const r = load();
    const clone = JSON.parse(JSON.stringify(frameOf(r))) as N;
    walk(clone, (n) => { n.id = `c${n.id}`; });
    const shifted = JSON.parse(JSON.stringify(clone)) as N;
    r.nodes['26:1'] = { document: shifted };
    shifted.id = '26:1';
    const ab = digest(r, [FRAME, '26:1']);
    const ba = digest(r, ['26:1', FRAME]);
    expect(ab.digest).not.toBe(ba.digest);
    expect([...ab.frames].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...ba.frames].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('reports a missing frame without throwing', () => {
    expect(fingerprintFrames(load(), ['99:99'])).toEqual({ ok: false, reason: 'frame-missing', missing: ['99:99'] });
    expect(fingerprintFrames(null, [FRAME]).ok).toBe(false);
    expect(fingerprintFrames(load(), []).ok).toBe(false);
  });
});

describe('takeFingerprint', () => {
  const now = () => new Date('2026-10-29T12:00:00Z');
  const common = { fileKey: 'cE0x2i7UkD7X73p8WwnCzy', frameIds: [FRAME], acceptedAt: '2026-10-29T11:00:00Z', now };
  const ok = (body: unknown): FingerprintFetch => async () => ({ ok: true, status: 200, json: async () => body });
  const status = (s: number): FingerprintFetch => async () => ({ ok: false, status: s, json: async () => ({ secret: 'BODY' }) });

  it('takes: one GET with the token header and a timeout signal', async () => {
    const f = vi.fn(ok(load()));
    const r = await takeFingerprint({ ...common, token: 'tok', fetcher: f });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.figma.com/v1/files/cE0x2i7UkD7X73p8WwnCzy/nodes?ids=${encodeURIComponent(FRAME)}`);
    expect(init.headers).toEqual({ 'X-Figma-Token': 'tok' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(r).toEqual({ status: 'taken', record: {
      schema_version: 1, algorithm: FINGERPRINT_ALGORITHM, digest: base.digest, frames: base.frames,
      accepted_at: common.acceptedAt, taken_at: '2026-10-29T12:00:00.000Z', status: 'taken',
    } });
  });

  it.each([
    ['401', status(401), 'unauthorized'],
    ['403', status(403), 'unauthorized'],
    ['404', status(404), 'frame-missing'],
    ['429', status(429), 'rate-limited'],
    ['500', status(500), 'http-error'],
    ['network error', (async () => { throw new Error('ECONNRESET tok'); }) as FingerprintFetch, 'figma-unreachable'],
    ['frame absent from a 200', ok({ nodes: { [FRAME]: null } }), 'frame-missing'],
    ['unparseable body', (async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } })) as FingerprintFetch, 'http-error'],
  ])('not-taken on %s', async (_n, fetcher, reason) => {
    const r = await takeFingerprint({ ...common, token: 'tok', fetcher });
    expect(r).toEqual({ status: 'not-taken', record: {
      schema_version: 1, algorithm: FINGERPRINT_ALGORITHM, accepted_at: common.acceptedAt, taken_at: '2026-10-29T12:00:00.000Z',
      status: 'not-taken', reason,
    } });
    expect(JSON.stringify(r)).not.toMatch(/tok|BODY|ECONN/);
  });

  it('not-taken without a token, making no request', async () => {
    const f = vi.fn();
    for (const token of [undefined, null, '']) {
      const r = await takeFingerprint({ ...common, token, fetcher: f });
      expect(r.status).toBe('not-taken');
      expect(r.record).toMatchObject({ reason: 'no-token' });
    }
    expect(f).not.toHaveBeenCalled();
  });
});

describe('compareFingerprint', () => {
  const fr = (...p: Array<[string, string]>) => ({ frames: p.map(([id, digest]) => ({ id, digest })) });
  it('unchanged', () => {
    expect(compareFingerprint(fr(['a', '1'], ['b', '2']), fr(['a', '1'], ['b', '2']))).toEqual({
      status: 'unchanged', changed_frame_ids: [], added_frame_ids: [], removed_frame_ids: [], reordered: false });
  });
  it('a changed frame', () => {
    expect(compareFingerprint(fr(['a', '1'], ['b', '2']), fr(['a', '1'], ['b', '3']))).toMatchObject({ status: 'changed', changed_frame_ids: ['b'] });
  });
  it('an added and a removed frame', () => {
    expect(compareFingerprint(fr(['a', '1']), fr(['a', '1'], ['c', '9']))).toMatchObject({ status: 'changed', added_frame_ids: ['c'] });
    expect(compareFingerprint(fr(['a', '1'], ['b', '2']), fr(['a', '1']))).toMatchObject({ status: 'changed', removed_frame_ids: ['b'] });
  });
  it('a reorder alone is a change', () => {
    expect(compareFingerprint(fr(['a', '1'], ['b', '2']), fr(['b', '2'], ['a', '1']))).toEqual({
      status: 'changed', changed_frame_ids: [], added_frame_ids: [], removed_frame_ids: [], reordered: true });
  });
});
