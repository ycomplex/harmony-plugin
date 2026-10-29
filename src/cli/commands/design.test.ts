import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fingerprintTake, fingerprintCompare, readFigmaToken, FIGMA_PAT_FILE, type FingerprintDeps } from './design.js';
import { fingerprintFrames, type FingerprintFetch } from '../../tools/design-fingerprint.js';

type N = Record<string, any>;
const nodes = (): N => JSON.parse(readFileSync(fileURLToPath(new URL('../../tools/__fixtures__/design-fingerprint.live-2026-10-29.json', import.meta.url)), 'utf8'));
const FRAME = '25:205';
const artefact = (over: N = {}) => ({
  schema_version: 1, tool: 'figma', composed_at: '2026-10-29T00:00:00Z', provenance_notes: '', mcp_call_count: 1,
  file_key: 'cE0x2i7UkD7X73p8WwnCzy', file_url: 'https://www.figma.com/design/cE0x2i7UkD7X73p8WwnCzy',
  nodes: [{ id: FRAME, name: 'Modal', caption: 'c', preview_attachment_id: 'a', preview_filename: 'm.png' }], ...over,
});
const fvWith = (extra: N = {}, slot: N = {}, a = artefact()) => ({ other: 'kept', gate_slots: { design: { design_artefact: a, ...slot } }, ...extra });
const ok = (body: unknown): FingerprintFetch => async () => ({ ok: true, status: 200, json: async () => body });
const now = () => new Date('2026-10-29T12:00:00Z');

function harness(fv: N, over: Partial<FingerprintDeps> = {}) {
  const writes: N[] = [];
  const deps: FingerprintDeps = {
    readFieldValues: async () => fv, writeFingerprint: async (_t, r) => { writes.push(r); },
    token: 'tok', fetcher: ok(nodes()), now, ...over,
  };
  return { deps, writes };
}

describe('harmony design fingerprint take', () => {
  it('takes and writes the record, accepted_at from the design slot ratified_at', async () => {
    const h = harness(fvWith({}, { ratified_at: '2026-10-29T11:00:00Z' }));
    const out = await fingerprintTake('B-1', h.deps);
    expect(out).toMatchObject({ status: 'taken', frames: 1, wrote: true });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ status: 'taken', accepted_at: '2026-10-29T11:00:00Z', taken_at: '2026-10-29T12:00:00.000Z' });
    expect((h.writes[0].frames as N[])[0]).toEqual({ id: FRAME, digest: (fingerprintFrames(nodes(), [FRAME]) as N).frames[0].digest });
  });
  it('falls back to now when the slot has no ratified_at', async () => {
    const h = harness(fvWith());
    await fingerprintTake('B-1', h.deps);
    expect(h.writes[0].accepted_at).toBe('2026-10-29T12:00:00.000Z');
  });
  it('a failure is written as not-taken (exit 0 state), never thrown', async () => {
    const h = harness(fvWith(), { token: undefined });
    expect(await fingerprintTake('B-1', h.deps)).toMatchObject({ status: 'not-taken', reason: 'no-token', wrote: true });
    expect(h.writes[0]).toMatchObject({ status: 'not-taken', reason: 'no-token' });
  });
  it.each([
    ['no design', { other: 1 }, 'no-accepted-design'],
    ['html design', fvWith({}, {}, { schema_version: 1, tool: 'html', composed_at: 'x', provenance_notes: '', mcp_call_count: 0, surface_attachment_id: 'a', surface_filename: 'x.html' } as never), 'not-figma'],
    ['figma without nodes', fvWith({}, {}, artefact({ nodes: [] })), 'no-nodes'],
  ])('skips with no write: %s', async (_n, fv, reason) => {
    const h = harness(fv as N);
    expect(await fingerprintTake('B-1', h.deps)).toEqual({ command: 'take', status: 'skipped', reason, wrote: false });
    expect(h.writes).toEqual([]);
  });
});

describe('harmony design fingerprint compare', () => {
  const stored = async () => {
    const h = harness(fvWith());
    await fingerprintTake('B-1', h.deps);
    return h.writes[0];
  };
  it('unchanged: records drift unchanged and preserves the stored digests', async () => {
    const fp = await stored();
    const h = harness(fvWith({ design_fingerprint: fp }));
    expect(await fingerprintCompare('B-1', 'plan', h.deps)).toMatchObject({ status: 'unchanged', wrote: true });
    expect(h.writes[0]).toMatchObject({ digest: fp.digest, frames: fp.frames, drift: { status: 'unchanged', checked_by: 'plan', checked_at: '2026-10-29T12:00:00.000Z' } });
  });
  it('changed: names the changed frame', async () => {
    const fp = await stored();
    const live = nodes();
    live.nodes[FRAME].document.children[0].name += ' edited';
    const h = harness(fvWith({ design_fingerprint: fp }), { fetcher: ok(live) });
    expect(await fingerprintCompare('B-1', 'build', h.deps)).toMatchObject({ status: 'changed', changed_frame_ids: [FRAME] });
    expect(h.writes[0].drift).toMatchObject({ status: 'changed', checked_by: 'build', changed_frame_ids: [FRAME] });
  });
  it('a frame gone from the file is changed', async () => {
    const fp = await stored();
    const h = harness(fvWith({ design_fingerprint: fp }), { fetcher: ok({ nodes: { [FRAME]: null } }) });
    expect(await fingerprintCompare('B-1', 'plan', h.deps)).toMatchObject({ status: 'changed', changed_frame_ids: [FRAME] });
  });
  it.each([
    ['429', async () => ({ ok: false, status: 429, json: async () => ({}) }), 'rate-limited'],
    ['network', async () => { throw new Error('down'); }, 'figma-unreachable'],
  ])('%s: not-checked, digests and earlier drift kept', async (_n, fetcher, reason) => {
    const fp = { ...(await stored()), drift: { status: 'changed', checked_at: 'earlier', checked_by: 'plan', changed_frame_ids: ['x'] } };
    const h = harness(fvWith({ design_fingerprint: fp }), { fetcher: fetcher as FingerprintFetch });
    expect(await fingerprintCompare('B-1', 'build', h.deps)).toEqual({ command: 'compare', status: 'not-checked', reason, wrote: true });
    expect(h.writes[0]).toMatchObject({ digest: fp.digest, frames: fp.frames, drift: { status: 'not-checked', reason, checked_by: 'build', changed_frame_ids: ['x'] } });
  });
  it('no token: not-checked', async () => {
    const fp = await stored();
    const h = harness(fvWith({ design_fingerprint: fp }), { token: undefined });
    expect(await fingerprintCompare('B-1', 'plan', h.deps)).toMatchObject({ status: 'not-checked', reason: 'no-token' });
  });
  it('no fingerprint / not-taken: unchecked and nothing written', async () => {
    for (const fv of [fvWith(), fvWith({ design_fingerprint: { status: 'not-taken', reason: 'no-token' } })]) {
      const h = harness(fv);
      expect((await fingerprintCompare('B-1', 'plan', h.deps)).status).toBe('unchecked');
      expect(h.writes).toEqual([]);
    }
  });
});

describe('readFigmaToken', () => {
  it('env first, then the secrets file, else undefined; never reads the file when the env is set', () => {
    const read = vi.fn(() => ' filetoken \n');
    expect(readFigmaToken({ HARMONY_FIGMA_TOKEN: ' envtoken ' }, read)).toBe('envtoken');
    expect(read).not.toHaveBeenCalled();
    expect(readFigmaToken({}, read)).toBe('filetoken');
    expect(read).toHaveBeenCalledWith(FIGMA_PAT_FILE);
    expect(readFigmaToken({}, () => { throw new Error('ENOENT'); })).toBeUndefined();
  });
});
