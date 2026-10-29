import { describe, it, expect, vi } from 'vitest';
import { adoptCheck, candidateKeysFrom, type AdoptCheckDeps } from './design.js';
import { FigmaRestError } from '../../tools/figma-reconcile.js';

const TOKEN = 'secret-token-123';
const frameNode = { id: '1:2', name: 'Home', type: 'FRAME', children: [{ id: '1:3', name: 'Btn', type: 'INSTANCE', componentId: 'c1' }] };
function deps(over: Partial<AdoptCheckDeps> = {}): AdoptCheckDeps {
  return {
    token: TOKEN,
    readTexts: async () => ['Design: https://www.figma.com/design/AAA/n?node-id=1-2', 'dup https://www.figma.com/design/AAA/n?node-id=1-2'],
    readLibraryContext: async () => ({
      state: 'connected', library_file_key: 'LIB', library_map_version: 2, library_map_error: null,
      library_refreshed_at: '2026-10-28T00:00:00Z', library_components: { Btn: 'k1' },
    }),
    readCandidates: async () => [],
    readNodes: async () => ({ nodes: { '1:2': { document: frameNode, components: { c1: { key: 'k1', name: 'Btn', remote: true } } } } }),
    sleep: async () => {},
    ...over,
  };
}

describe('design adopt-check', () => {
  it('no links', async () => {
    const r = await adoptCheck('B-1', {}, deps({ readTexts: async () => ['nothing'] }));
    expect(r).toMatchObject({ command: 'adopt-check', status: 'no-links', links: [] });
  });
  it('no token', async () => {
    const r = await adoptCheck('B-1', {}, deps({ token: undefined }));
    expect(r.status).toBe('no-token');
  });
  it('not connected', async () => {
    const r = await adoptCheck('B-1', {}, deps({ readLibraryContext: async () => null }));
    expect(r.status).toBe('not-connected');
    const d = await adoptCheck('B-1', {}, deps({ readLibraryContext: async () => ({ state: 'disconnected', library_file_key: 'LIB' }) }));
    expect(d.status).toBe('not-connected');
  });
  it('adopted frame, one JSON-able line, no token in output', async () => {
    const r = await adoptCheck('B-1', {}, deps());
    expect(r).toMatchObject({ status: 'ok', source: 'ticket', candidate_reads: 0, library: { status: 'ok', file_key: 'LIB', components: 1 } });
    expect(r).not.toHaveProperty('lookup_cap');
    expect((r.frames as Array<{ verdict: string; id: string }>)[0]).toMatchObject({
      id: '1:2', verdict: 'adopted', instance_count: 1,
      instances: [{ nodeId: '1:3', name: 'Btn', component: 'Btn', verdict: 'library' }],
    });
    expect((r.links as unknown[]).length).toBe(1);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it('links-only reports readability and reads neither the map nor the candidates', async () => {
    const ctx = vi.fn(async () => null);
    const cand = vi.fn(async () => []);
    const r = await adoptCheck('B-1', { linksOnly: true }, deps({ readLibraryContext: ctx, readCandidates: cand }));
    expect((r.links as Array<{ readable: boolean }>)[0].readable).toBe(true);
    expect(ctx).not.toHaveBeenCalled();
    expect(cand).not.toHaveBeenCalled();
  });
  it('--url links override the ticket links (the ticket texts are not read)', async () => {
    const readTexts = vi.fn(async () => ['https://www.figma.com/design/ZZZ/n?node-id=9-9']);
    const readNodes = vi.fn(async () => ({ nodes: { '1:2': { document: frameNode, components: { c1: { key: 'k1', name: 'Btn', remote: true } } } } }));
    const r = await adoptCheck('B-1', { urls: ['https://www.figma.com/design/AAA/x?node-id=1-2'] }, deps({ readTexts, readNodes }));
    expect(readTexts).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'ok', source: 'url' });
    expect((r.links as Array<{ fileKey: string }>).map((l) => l.fileKey)).toEqual(['AAA']);
    expect(readNodes).toHaveBeenCalledWith('AAA', ['1:2']);
  });
  it('a nested icon resolved through the candidates is adopted; a name-only match is off-library', async () => {
    const node = { ...frameNode, children: [...frameNode.children, { id: '1:4', name: 'Star', type: 'INSTANCE', componentId: 'c2' }] };
    const readNodes = async (_f: string, _ids: string[]) => ({ nodes: { '1:2': { document: node, components: {
      c1: { key: 'k1', name: 'Btn', remote: true }, c2: { key: 'kStar', name: 'Star', remote: true },
    } } } });
    const ok = await adoptCheck('B-1', {}, deps({ readNodes, readCandidates: async (n) => (n === 'Star' ? ['kStar'] : []) }));
    expect((ok.frames as Array<{ verdict: string }>)[0].verdict).toBe('adopted');
    expect(ok.candidate_reads).toBe(1);
    const off = await adoptCheck('B-1', {}, deps({ readNodes, readCandidates: async (n) => (n === 'Star' ? ['kStarElsewhere'] : []) }));
    expect((off.frames as Array<{ verdict: string; reason: string }>)[0]).toMatchObject({ verdict: 'off-library' });
    expect((off.frames as Array<{ reason: string }>)[0].reason).toMatch(/another copy of the library: 'Star'/);
  });
  it('an out-of-date map gives not-checked frames and says why', async () => {
    const r = await adoptCheck('B-1', {}, deps({ readLibraryContext: async () => ({ state: 'connected', library_file_key: 'LIB', library_map_version: 1, library_components: { Btn: 'k1' } }) }));
    expect(r.library).toMatchObject({ status: 'unavailable' });
    expect((r.frames as Array<{ verdict: string; reason: string }>)[0]).toMatchObject({ verdict: 'not-checked' });
    expect((r.frames as Array<{ reason: string }>)[0].reason).toMatch(/map version 1/);
  });
  it('links-only: unreadable on 403 and on a link with no node id', async () => {
    const r = await adoptCheck('B-1', { linksOnly: true }, deps({
      readTexts: async () => ['https://www.figma.com/design/AAA/n?node-id=1-2 https://www.figma.com/design/BBB/n'],
      readNodes: async () => { throw new FigmaRestError('unauthorized', 'no', 403); },
    }));
    expect((r.links as Array<{ readable: boolean }>).map((l) => l.readable)).toEqual([false, false]);
  });
  it('candidates RPC: rows -> keys; an absent RPC is no candidates; any other error throws', () => {
    expect(candidateKeysFrom({ data: [{ key: 'a', frame: 'F', page: 'P' }, { key: 'b' }, { nope: 1 }], error: null })).toEqual(['a', 'b']);
    expect(candidateKeysFrom({ data: null, error: { code: 'PGRST202' } })).toEqual([]);
    expect(candidateKeysFrom({ data: null, error: { code: '42883' } })).toEqual([]);
    expect(() => candidateKeysFrom({ data: null, error: { code: '500' } })).toThrow(/figma_library_candidates failed/);
  });
});
