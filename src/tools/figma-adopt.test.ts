import { describe, it, expect, vi } from 'vitest';
import {
  findFigmaLinks, collectInstances, checkLibraryMembership, classifyFrames, assembleAdoptedArtefact,
  createComponentLookup, DEFAULT_LOOKUP_CAP,
} from './figma-adopt.js';
import { FigmaRestError, type FigmaNode, type FigmaNodesResponse, type FigmaComponentMeta } from './figma-reconcile.js';
import { DesignArtefactSchema } from './design-artefact.js';

const LIB = 'LIBFILE';
const noSleep = async () => {};

describe('findFigmaLinks', () => {
  it('reads design, file and branch links; branch key is the file key; node ids normalised', () => {
    const links = findFigmaLinks([
      'See https://www.figma.com/design/AAA111/Name?node-id=1-2&t=x.',
      '(https://www.figma.com/file/BBB222/Old?node-id=3%3A4)',
      'https://www.figma.com/design/CCC333/branch/DDD444/Feat?node-id=5-6',
    ]);
    expect(links.map((l) => [l.fileKey, l.nodeId])).toEqual([['AAA111', '1:2'], ['BBB222', '3:4'], ['DDD444', '5:6']]);
  });
  it('ignores board, slides and make links', () => {
    expect(findFigmaLinks(['https://www.figma.com/board/X1/n?node-id=1-2 https://www.figma.com/slides/X2/n https://www.figma.com/make/X3/n'])).toEqual([]);
  });
  it('returns a link without a node id with nodeId null, never guessing', () => {
    expect(findFigmaLinks(['https://www.figma.com/design/AAA/Name'])).toEqual([{ fileKey: 'AAA', nodeId: null, url: 'https://www.figma.com/design/AAA/Name' }]);
  });
  it('de-duplicates on (file,node) keeping first appearance order', () => {
    const l = findFigmaLinks(['https://www.figma.com/design/A/n?node-id=1-2', 'https://www.figma.com/design/B/n?node-id=1-2', 'https://www.figma.com/design/A/other?node-id=1-2']);
    expect(l.map((x) => x.fileKey)).toEqual(['A', 'B']);
  });
});

const inst = (id: string, componentId: string, children: FigmaNode[] = []): FigmaNode => ({ id, name: `inst ${id}`, type: 'INSTANCE', componentId, children });
const frame = (id: string, children: FigmaNode[]): FigmaNode => ({ id, name: `Frame ${id}`, type: 'FRAME', children });

describe('collectInstances', () => {
  it('finds nested instances and the root when it is one', () => {
    const tree = inst('1:1', 'c1', [frame('1:2', [inst('1:3', 'c2')])]);
    expect(collectInstances(tree).map((i) => i.componentId)).toEqual(['c1', 'c2']);
    expect(collectInstances(frame('9:9', [])).length).toBe(0);
  });
});

const comps = (m: Record<string, string>, extra: Record<string, FigmaComponentMeta> = {}): Record<string, FigmaComponentMeta> => ({
  ...Object.fromEntries(Object.entries(m).map(([id, key]) => [id, { key, name: id, remote: true }])), ...extra,
});

function lookupFor(files: Record<string, string>) {
  return vi.fn(async (key: string) => {
    if (!files[key]) throw new FigmaRestError('file-not-found', 'nf', 404);
    return { fileKey: files[key] };
  });
}

describe('checkLibraryMembership', () => {
  const mk = (id: string, ids: string[], components: Record<string, FigmaComponentMeta>) => ({
    id, instances: ids.map((c, i) => ({ nodeId: `${id}/${i}`, name: c, componentId: c })), components,
  });

  it('all-library frame is library; each distinct key looked up once across frames', async () => {
    const lookup = lookupFor({ k1: LIB, k2: LIB });
    const c = comps({ a: 'k1', b: 'k2' });
    const r = await checkLibraryMembership({ frames: [mk('f1', ['a', 'b', 'a'], c), mk('f2', ['a'], c)], libraryFileKey: LIB, lookupComponentFile: lookup, sleep: noSleep });
    expect(r.frames.map((f) => f.verdict)).toEqual(['library', 'library']);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.lookupsUsed).toBe(2);
  });
  it('one off-library instance makes the frame off-library and names it', async () => {
    const r = await checkLibraryMembership({ frames: [mk('f', ['a', 'b'], comps({ a: 'k1', b: 'k2' }))], libraryFileKey: LIB, lookupComponentFile: lookupFor({ k1: LIB, k2: 'OTHER' }), sleep: noSleep });
    expect(r.frames[0].verdict).toBe('off-library');
    expect(r.frames[0].reason).toMatch(/another file \(OTHER\)/);
  });
  it('a local component (remote:false) is off-library without a lookup', async () => {
    const lookup = lookupFor({});
    const r = await checkLibraryMembership({ frames: [mk('f', ['a'], { a: { key: 'k', name: 'Local', remote: false } })], libraryFileKey: LIB, lookupComponentFile: lookup, sleep: noSleep });
    expect(r.frames[0].verdict).toBe('off-library');
    expect(r.frames[0].reason).toMatch(/local component/);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('a component missing from the map, and a frame with no instances, are off-library', async () => {
    const r = await checkLibraryMembership({ frames: [mk('f', ['zz'], {}), { id: 'g', instances: [], components: {} }], libraryFileKey: LIB, lookupComponentFile: lookupFor({}), sleep: noSleep });
    expect(r.frames.map((f) => f.verdict)).toEqual(['off-library', 'off-library']);
  });
  it('cap reached leaves the unchecked frames not-checked, never library', async () => {
    const c = comps({ a: 'k1', b: 'k2', c: 'k3' });
    const lookup = lookupFor({ k1: LIB, k2: LIB, k3: LIB });
    const r = await checkLibraryMembership({ frames: [mk('f1', ['a', 'b'], c), mk('f2', ['c'], c)], libraryFileKey: LIB, lookupComponentFile: lookup, cap: 2, sleep: noSleep });
    expect(r.frames.map((f) => f.verdict)).toEqual(['library', 'not-checked']);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.lookupCap).toBe(2);
  });
  it('partial evidence never adopts: one key unresolved out of two in a frame', async () => {
    const lookup = vi.fn(async (key: string) => { if (key === 'k2') throw new FigmaRestError('http-error', 'boom', 500); return { fileKey: LIB }; });
    const r = await checkLibraryMembership({ frames: [mk('f', ['a', 'b'], comps({ a: 'k1', b: 'k2' }))], libraryFileKey: LIB, lookupComponentFile: lookup, sleep: noSleep });
    expect(r.frames[0].verdict).toBe('not-checked');
  });
  it('definite off-library wins over an unchecked sibling', async () => {
    const lookup = vi.fn(async (key: string) => { if (key === 'k1') throw new FigmaRestError('http-error', 'boom', 500); return { fileKey: 'OTHER' }; });
    const r = await checkLibraryMembership({ frames: [mk('f', ['a', 'b'], comps({ a: 'k1', b: 'k2' }))], libraryFileKey: LIB, lookupComponentFile: lookup, sleep: noSleep });
    expect(r.frames[0].verdict).toBe('off-library');
  });
  it('429 is retried with backoff and then succeeds', async () => {
    let n = 0;
    const sleep = vi.fn(noSleep);
    const lookup = vi.fn(async () => { if (n++ < 2) throw new FigmaRestError('rate-limited', 'rl', 429, 3); return { fileKey: LIB }; });
    const r = await checkLibraryMembership({ frames: [mk('f', ['a'], comps({ a: 'k1' }))], libraryFileKey: LIB, lookupComponentFile: lookup, sleep });
    expect(r.frames[0].verdict).toBe('library');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(r.lookupsUsed).toBe(3);
  });
  it('429 backoff exhausted => not-checked, and later keys are not attempted', async () => {
    const lookup = vi.fn(async () => { throw new FigmaRestError('rate-limited', 'rl', 429); });
    const c = comps({ a: 'k1', b: 'k2' });
    const r = await checkLibraryMembership({ frames: [mk('f1', ['a'], c), mk('f2', ['b'], c)], libraryFileKey: LIB, lookupComponentFile: lookup, sleep: noSleep });
    expect(r.frames.map((f) => f.verdict)).toEqual(['not-checked', 'not-checked']);
    expect(lookup).toHaveBeenCalledTimes(5);
  });
  it('default cap is 40', () => expect(DEFAULT_LOOKUP_CAP).toBe(40));
});

describe('createComponentLookup', () => {
  const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({
    ok: status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0),
  });
  it('reads meta.file_key with the token header', async () => {
    const f = vi.fn(async () => res(200, { meta: { file_key: 'LIBFILE' } }));
    expect(await createComponentLookup({ token: 't', fetch: f })('abc')).toEqual({ fileKey: 'LIBFILE' });
    expect(f).toHaveBeenCalledWith('https://api.figma.com/v1/components/abc', { method: 'GET', headers: { 'X-Figma-Token': 't' } });
  });
  it('maps 429 with Retry-After and 404', async () => {
    await expect(createComponentLookup({ token: 't', fetch: async () => res(429, {}, { 'retry-after': '7' }) })('k')).rejects.toMatchObject({ code: 'rate-limited', retryAfterSeconds: 7 });
    await expect(createComponentLookup({ token: 't', fetch: async () => res(404) })('k')).rejects.toMatchObject({ code: 'file-not-found' });
  });
});

describe('classifyFrames', () => {
  const page: FigmaNode = { id: '0:1', name: 'Page', type: 'CANVAS', children: [
    frame('1:1', [inst('1:2', 'a')]), { id: '1:9', name: 'note', type: 'TEXT' }, frame('1:3', [inst('1:4', 'a')]),
  ] };
  const resp = (nodes: FigmaNodesResponse['nodes']): FigmaNodesResponse => ({ nodes });
  const components = comps({ a: 'k1' });

  it('expands a page link to its top-level frames in order and adopts library-built ones', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '0:1', url: 'u' }], libraryFileKey: LIB,
      readNodes: async () => resp({ '0:1': { document: page, components } }), lookupComponentFile: lookupFor({ k1: LIB }), sleep: noSleep,
    });
    expect(r.frames.map((f) => [f.id, f.verdict])).toEqual([['1:1', 'adopted'], ['1:3', 'adopted']]);
    expect(r.lookupsUsed).toBe(1);
  });
  it('treats a FRAME link as itself and dedupes a frame reached by page and frame link', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '0:1', url: 'u' }, { fileKey: 'F', nodeId: '1:3', url: 'v' }], libraryFileKey: LIB,
      readNodes: async () => resp({ '0:1': { document: page, components }, '1:3': { document: page.children![2], components } }),
      lookupComponentFile: lookupFor({ k1: LIB }), sleep: noSleep,
    });
    expect(r.frames.map((f) => f.id)).toEqual(['1:1', '1:3']);
  });
  it('unreadable: no node id, absent node, 403, 404', async () => {
    const links = [{ fileKey: 'F', nodeId: null, url: 'u' }, { fileKey: 'F', nodeId: '7:7', url: 'v' }];
    const r = await classifyFrames({ links, libraryFileKey: LIB, readNodes: async () => resp({ '7:7': null }), lookupComponentFile: lookupFor({}), sleep: noSleep });
    expect(r.frames.map((f) => f.verdict)).toEqual(['unreadable', 'unreadable']);
    expect(r.frames[0].reason).toMatch(/names no frame/);
    for (const [status, code] of [[403, 'unauthorized'], [404, 'file-not-found']] as const) {
      const x = await classifyFrames({
        links: [{ fileKey: 'F', nodeId: '1:1', url: 'u' }], libraryFileKey: LIB, lookupComponentFile: lookupFor({}), sleep: noSleep,
        readNodes: async () => { throw new FigmaRestError(code, 'x', status); },
      });
      expect(x.frames[0].verdict).toBe('unreadable');
    }
  });
  it('a read that stays rate-limited is not-checked', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '1:1', url: 'u' }], libraryFileKey: LIB, lookupComponentFile: lookupFor({}), sleep: noSleep,
      readNodes: async () => { throw new FigmaRestError('rate-limited', 'rl', 429); },
    });
    expect(r.frames[0].verdict).toBe('not-checked');
  });
  it('partial evidence: cap reached => not-checked, never adopted', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '0:1', url: 'u' }], libraryFileKey: LIB, cap: 0,
      readNodes: async () => resp({ '0:1': { document: page, components } }), lookupComponentFile: lookupFor({ k1: LIB }), sleep: noSleep,
    });
    expect(r.frames.every((f) => f.verdict === 'not-checked')).toBe(true);
  });
});

describe('assembleAdoptedArtefact', () => {
  const nodes = { '1:1': { document: frame('1:1', []) }, '1:3': { document: frame('1:3', []) } };
  const png = new Uint8Array([137, 80, 78, 71]);
  const out = assembleAdoptedArtefact({
    fileKey: 'AAA111', frames: [{ id: '1:1', name: 'One', caption: 'c1' }, { id: '1:3', name: 'Three', caption: 'c3' }], nodes,
    images: { '1:1': { bytes: png }, '1:3': { bytes: png } },
    attachments: { '1:1': { attachment_id: '11111111-1111-4111-8111-111111111111', filename: 'one.png' }, '1:3': { attachment_id: '22222222-2222-4222-8222-222222222222', filename: 'three.png' } },
    composedAt: '2026-10-29T10:00:00.000Z',
  });
  it('validates against the schema, in order, versionless, 0 MCP calls, all human-in-tool', () => {
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(DesignArtefactSchema.safeParse(out.artefact).success).toBe(true);
    expect(out.artefact.nodes.map((n) => n.id)).toEqual(['1:1', '1:3']);
    expect(out.artefact.mcp_call_count).toBe(0);
    expect(out.artefact.version_id).toBeUndefined();
    const lines = out.artefact.provenance_notes.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith('human-in-tool | '))).toBe(true);
  });
});
