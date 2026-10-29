import { describe, it, expect, vi } from 'vitest';
import {
  findFigmaLinks, collectInstances, checkLibraryMembership, classifyFrames, assembleAdoptedArtefact,
  buildLibraryIndex, type LibraryIndex,
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

const CTX = {
  state: 'connected', library_file_key: LIB, library_map_version: 2, library_map_error: null,
  library_refreshed_at: '2026-10-28T09:00:00.000Z',
  library_components: { 'Button :: Primary': 'k1', 'Button :: Secondary': 'k2', Card: 'k3' },
};
const okLib = (over: Record<string, unknown> = {}): LibraryIndex => buildLibraryIndex({ ...CTX, ...over });
const noCandidates = vi.fn(async () => [] as string[]);

describe('buildLibraryIndex', () => {
  it('indexes the map values as keys and the entries as names', () => {
    const l = okLib();
    expect(l.status).toBe('ok');
    if (l.status !== 'ok') return;
    expect([...l.keys].sort()).toEqual(['k1', 'k2', 'k3']);
    expect(l.names.get('Button :: Primary')).toBe('k1');
    expect(l.fileKey).toBe(LIB);
  });
  it.each([
    ['disconnected', { state: 'disconnected' }, /not connected/],
    ['no library file', { library_file_key: null }, /not connected/],
    ['missing map', { library_components: null }, /map is missing; refresh the map/],
    ['empty map', { library_components: {} }, /map is empty; refresh the map/],
    ['version 1', { library_map_version: 1 }, /out of date \(map version 1\); refresh the map and run again/],
    ['no version', { library_map_version: undefined }, /out of date \(map version unknown\)/],
    ['errored', { library_map_error: 'Figma 500' }, /failed its last refresh \(Figma 500\)/],
  ])('%s => unavailable, reason says which', (_n, over, re) => {
    const l = okLib(over);
    expect(l.status).toBe('unavailable');
    if (l.status === 'unavailable') expect(l.reason).toMatch(re);
  });
});

describe('checkLibraryMembership', () => {
  const mk = (id: string, ids: string[], components: Record<string, FigmaComponentMeta>, componentSets: Record<string, { name: string }> = {}) => ({
    id, instances: ids.map((c, i) => ({ nodeId: `${id}/${i}`, name: c, componentId: c })), components, componentSets,
  });
  const setComps: Record<string, FigmaComponentMeta> = {
    p: { key: 'k1', name: 'Primary', remote: true, componentSetId: 'S' },
    s: { key: 'k2', name: 'Secondary', remote: true, componentSetId: 'S' },
  };
  const sets = { S: { name: 'Button' } };

  it('every key in the map => library, with per-instance verdicts', async () => {
    const r = await checkLibraryMembership({ frames: [mk('f', ['p', 's', 'p'], setComps, sets)], library: okLib(), candidates: noCandidates });
    expect(r.frames[0].verdict).toBe('library');
    expect(r.frames[0].instance_count).toBe(3);
    expect(r.frames[0].instances.map((i) => [i.component, i.verdict])).toEqual([
      ['Button :: Primary', 'library'], ['Button :: Secondary', 'library'], ['Button :: Primary', 'library'],
    ]);
    expect(r.candidateReads).toBe(0);
  });
  it('a nested icon not in the map resolves through its bare-name candidates => library; reads cached per name', async () => {
    const candidates = vi.fn(async (name: string) => (name === 'Star' ? ['kStar16', 'kStar24'] : []));
    const c = { ...setComps, i: { key: 'kStar24', name: 'Star', remote: true } };
    const r = await checkLibraryMembership({ frames: [mk('f', ['p', 'i', 'i'], c, sets), mk('g', ['i'], c, sets)], library: okLib(), candidates });
    expect(r.frames.map((f) => f.verdict)).toEqual(['library', 'library']);
    expect(candidates).toHaveBeenCalledTimes(1);
    expect(r.candidateReads).toBe(1);
  });
  it('name-only match (another copy of the kit) => off-library naming the component', async () => {
    const c: Record<string, FigmaComponentMeta> = { p: { key: 'OTHER1', name: 'Primary', remote: true, componentSetId: 'S' } };
    const r = await checkLibraryMembership({ frames: [mk('f', ['p'], c, sets)], library: okLib(), candidates: noCandidates });
    expect(r.frames[0].verdict).toBe('off-library');
    expect(r.frames[0].reason).toBe("Off-library: drawn from another copy of the library: 'Button :: Primary' matches the workspace library by name but not by component key");
    expect(r.frames[0].instances[0]).toMatchObject({ component: 'Button :: Primary', verdict: 'off-library' });
  });
  it('a standalone whose bare name has candidates but not this key => another copy', async () => {
    const c: Record<string, FigmaComponentMeta> = { i: { key: 'kX', name: 'Star', remote: true } };
    const r = await checkLibraryMembership({ frames: [mk('f', ['i'], c)], library: okLib(), candidates: async () => ['kStar16'] });
    expect(r.frames[0].reason).toMatch(/another copy of the library: 'Star'/);
  });
  it('key not in the map and the name unknown => off-library naming it, with the refresh hint', async () => {
    const c: Record<string, FigmaComponentMeta> = { z: { key: 'kZ', name: 'Banner', remote: true } };
    const r = await checkLibraryMembership({ frames: [mk('f', ['z'], c)], library: okLib(), candidates: noCandidates });
    expect(r.frames[0].verdict).toBe('off-library');
    expect(r.frames[0].reason).toBe("Off-library: 'Banner' is not in the workspace's saved library map (refreshed 2026-10-28); if it was added to the library since, refresh the map");
  });
  it('one off-library instance makes the frame off-library; the reason names the first one', async () => {
    const c = { ...setComps, z: { key: 'kZ', name: 'Banner', remote: true }, y: { key: 'kY', name: 'Toast', remote: true } };
    const r = await checkLibraryMembership({ frames: [mk('f', ['p', 'z', 'y'], c, sets)], library: okLib(), candidates: noCandidates });
    expect(r.frames[0].reason).toMatch(/'Banner'/);
    expect(r.frames[0].instances.map((i) => i.verdict)).toEqual(['library', 'off-library', 'off-library']);
  });
  it('a local component (remote:false) is off-library even when its key is in the map', async () => {
    const r = await checkLibraryMembership({ frames: [mk('f', ['a'], { a: { key: 'k3', name: 'Card', remote: false } })], library: okLib(), candidates: noCandidates });
    expect(r.frames[0].verdict).toBe('off-library');
    expect(r.frames[0].reason).toMatch(/local component/);
  });
  it('a component missing from the file map, and a frame with no instances, are off-library', async () => {
    const r = await checkLibraryMembership({ frames: [mk('f', ['zz'], {}), { id: 'g', instances: [], components: {} }], library: okLib(), candidates: noCandidates });
    expect(r.frames.map((f) => f.verdict)).toEqual(['off-library', 'off-library']);
    expect(r.frames[0].reason).toMatch(/not a published component/);
  });
  it.each([
    ['version 1', { library_map_version: 1 }],
    ['empty', { library_components: {} }],
    ['errored', { library_map_error: 'boom' }],
    ['disconnected', { state: 'disconnected' }],
  ])('map %s => every frame not-checked, nothing adopted, no candidate reads', async (_n, over) => {
    const candidates = vi.fn(async () => ['k1']);
    const r = await checkLibraryMembership({ frames: [mk('f', ['p'], setComps, sets)], library: okLib(over), candidates });
    expect(r.frames[0].verdict).toBe('not-checked');
    expect(r.frames[0].reason).toMatch(/^Not checked: /);
    expect(candidates).not.toHaveBeenCalled();
  });
  it('unreadable candidates => not-checked; a definite off-library sibling still wins', async () => {
    const boom = async () => { throw new Error('candidates unavailable'); };
    const c: Record<string, FigmaComponentMeta> = { i: { key: 'kX', name: 'Star', remote: true }, z: { key: 'kZ', name: 'Banner', remote: true, componentSetId: 'T' } };
    const a = await checkLibraryMembership({ frames: [mk('f', ['i'], c)], library: okLib(), candidates: boom });
    expect(a.frames[0].verdict).toBe('not-checked');
    expect(a.frames[0].reason).toMatch(/candidates for 'Star' could not be read/);
    const b = await checkLibraryMembership({ frames: [mk('f', ['i', 'z'], c, { T: { name: 'Banner set' } })], library: okLib(), candidates: boom });
    expect(b.frames[0].verdict).toBe('off-library');
  });
  it('a set variant never consults the candidates', async () => {
    const candidates = vi.fn(async () => ['OTHER1']);
    const c: Record<string, FigmaComponentMeta> = { p: { key: 'OTHER1', name: 'Primary', remote: true, componentSetId: 'S' } };
    const r = await checkLibraryMembership({ frames: [mk('f', ['p'], c, sets)], library: okLib(), candidates });
    expect(r.frames[0].verdict).toBe('off-library');
    expect(candidates).not.toHaveBeenCalled();
  });
});

describe('classifyFrames', () => {
  const page: FigmaNode = { id: '0:1', name: 'Page', type: 'CANVAS', children: [
    frame('1:1', [inst('1:2', 'a')]), { id: '1:9', name: 'note', type: 'TEXT' }, frame('1:3', [inst('1:4', 'a')]),
  ] };
  const resp = (nodes: FigmaNodesResponse['nodes']): FigmaNodesResponse => ({ nodes });
  const components = comps({ a: 'k3' });

  it('expands a page link to its top-level frames in order and adopts library-built ones', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '0:1', url: 'u' }], library: okLib(),
      readNodes: async () => resp({ '0:1': { document: page, components } }), candidates: noCandidates, sleep: noSleep,
    });
    expect(r.frames.map((f) => [f.id, f.verdict])).toEqual([['1:1', 'adopted'], ['1:3', 'adopted']]);
    expect(r.frames[0].instances).toHaveLength(1);
  });
  it('reads set names from the node response componentSets', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '1:1', url: 'u' }], library: okLib(), candidates: noCandidates, sleep: noSleep,
      readNodes: async () => resp({ '1:1': {
        document: frame('1:1', [inst('1:2', 'c')]),
        components: { c: { key: 'k2', name: 'Secondary', remote: true, componentSetId: 'S' } },
        componentSets: { S: { key: 'sk', name: 'Button' } },
      } }),
    });
    expect(r.frames[0].verdict).toBe('adopted');
    expect(r.frames[0].instances[0].component).toBe('Button :: Secondary');
  });
  it('treats a FRAME link as itself and dedupes a frame reached by page and frame link', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '0:1', url: 'u' }, { fileKey: 'F', nodeId: '1:3', url: 'v' }], library: okLib(),
      readNodes: async () => resp({ '0:1': { document: page, components }, '1:3': { document: page.children![2], components } }),
      candidates: noCandidates, sleep: noSleep,
    });
    expect(r.frames.map((f) => f.id)).toEqual(['1:1', '1:3']);
  });
  it('unreadable: no node id, absent node, 403, 404', async () => {
    const links = [{ fileKey: 'F', nodeId: null, url: 'u' }, { fileKey: 'F', nodeId: '7:7', url: 'v' }];
    const r = await classifyFrames({ links, library: okLib(), readNodes: async () => resp({ '7:7': null }), candidates: noCandidates, sleep: noSleep });
    expect(r.frames.map((f) => f.verdict)).toEqual(['unreadable', 'unreadable']);
    expect(r.frames[0].reason).toMatch(/names no frame/);
    for (const [status, code] of [[403, 'unauthorized'], [404, 'file-not-found']] as const) {
      const x = await classifyFrames({
        links: [{ fileKey: 'F', nodeId: '1:1', url: 'u' }], library: okLib(), candidates: noCandidates, sleep: noSleep,
        readNodes: async () => { throw new FigmaRestError(code, 'x', status); },
      });
      expect(x.frames[0].verdict).toBe('unreadable');
    }
  });
  it('a read 429 is retried with backoff and then succeeds', async () => {
    let n = 0;
    const sleep = vi.fn(noSleep);
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '0:1', url: 'u' }], library: okLib(), candidates: noCandidates, sleep,
      readNodes: async () => { if (n++ < 2) throw new FigmaRestError('rate-limited', 'rl', 429, 3); return resp({ '0:1': { document: page, components } }); },
    });
    expect(r.frames[0].verdict).toBe('adopted');
    expect(sleep).toHaveBeenCalledWith(3000);
  });
  it('a read that stays rate-limited is not-checked', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '1:1', url: 'u' }], library: okLib(), candidates: noCandidates, sleep: noSleep,
      readNodes: async () => { throw new FigmaRestError('rate-limited', 'rl', 429); },
    });
    expect(r.frames[0].verdict).toBe('not-checked');
  });
  it('an unavailable map leaves read frames not-checked, never adopted', async () => {
    const r = await classifyFrames({
      links: [{ fileKey: 'F', nodeId: '0:1', url: 'u' }], library: okLib({ library_map_version: 1 }),
      readNodes: async () => resp({ '0:1': { document: page, components } }), candidates: noCandidates, sleep: noSleep,
    });
    expect(r.frames.every((f) => f.verdict === 'not-checked')).toBe(true);
    expect(r.frames.map((f) => f.name)).toEqual(['Frame 1:1', 'Frame 1:3']);
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
