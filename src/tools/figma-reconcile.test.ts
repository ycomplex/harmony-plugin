import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createFigmaRestClient, FigmaRestError, chooseFreshVersion, buildSnapshot, diffSnapshots, interpret,
  changedElementIds, markHumanInTool, assemblePendingArtefact, serializeProvenanceNotes, reconcileDesign, SAVE_VERSION_QUESTION,
  NO_PROVENANCE_NOTES, ADDED_FRAME_CAPTION, type FetchLike, type FigmaNodesResponse, type PrepareFn,
} from './figma-reconcile.js';
import { FRESHNESS_WAIT, type ProvenanceNote } from './figma-composition.js';
import { DesignArtefactSchema, type DesignArtefact } from './design-artefact.js';

// Fixtures are HAND-AUTHORED from Figma's documented REST shapes (each carries a _fixture note); NOT live-captured.
const fx = <T = any>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/figma-reconcile/${name}.json`, import.meta.url)), 'utf8'));
const snap = (name: string, v = 'v') => buildSnapshot(fx<FigmaNodesResponse>(name), '0:1', v);
const base = snap('base', '800');
const diff = (name: string) => diffSnapshots(base, snap(name, '900'));

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  };
}

describe('REST client', () => {
  it('sends the token header, GET only, explicit version on nodes and images', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetch: FetchLike = async (url, init) => { calls.push({ url, init }); return res(200, { nodes: {}, images: {}, versions: [] }); };
    const c = createFigmaRestClient({ token: 'tok', fetch, fileKey: 'KEY' });
    await c.fileMeta(); await c.listVersions(); await c.getNodesAtVersion(['1:1', '1:2'], '900'); await c.renderImagesAtVersion(['1:1'], '900');
    expect(calls.map((x) => x.url)).toEqual([
      'https://api.figma.com/v1/files/KEY?depth=1',
      'https://api.figma.com/v1/files/KEY/versions',
      'https://api.figma.com/v1/files/KEY/nodes?ids=1%3A1%2C1%3A2&version=900',
      'https://api.figma.com/v1/images/KEY?ids=1%3A1&version=900&format=png',
    ]);
    for (const x of calls) { expect(x.init.method).toBe('GET'); expect(x.init.headers['X-Figma-Token']).toBe('tok'); }
  });

  it('maps file meta and versions from the documented shapes', async () => {
    const fetch: FetchLike = async (url) => res(200, url.includes('/versions') ? fx('versions') : fx('file-meta'));
    const c = createFigmaRestClient({ token: 't', fetch, fileKey: 'K' });
    expect(await c.fileMeta()).toEqual({ lastModified: '2026-10-27T10:00:00Z', version: '900', name: 'Design options' });
    expect((await c.listVersions()).map((v) => v.id)).toEqual(['900', '800']);
  });

  it('404 at a version is a typed version-not-found, never an empty/no-change result', async () => {
    const c = createFigmaRestClient({ token: 't', fetch: async () => res(404), fileKey: 'K' });
    const e = await c.getNodesAtVersion(['1:1'], '999').catch((x) => x);
    expect(e).toBeInstanceOf(FigmaRestError);
    expect(e.code).toBe('version-not-found');
    expect(e.status).toBe(404);
    expect((await c.renderImagesAtVersion(['1:1'], '999').catch((x) => x)).code).toBe('version-not-found');
  });

  it('429 is a typed rate-limited error with retry-after, with NO retry (one fetch call)', async () => {
    const fetch = vi.fn(async () => res(429, {}, { 'retry-after': '42' }));
    const c = createFigmaRestClient({ token: 't', fetch, fileKey: 'K' });
    const e = await c.listVersions().catch((x) => x);
    expect(e.code).toBe('rate-limited');
    expect(e.retryAfterSeconds).toBe(42);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('429 without a Retry-After header carries null', async () => {
    const c = createFigmaRestClient({ token: 't', fetch: async () => res(429), fileKey: 'K' });
    expect((await c.fileMeta().catch((x) => x)).retryAfterSeconds).toBeNull();
  });

  it('images: nulls from a 200 pass through; downloads with a null URL or non-2xx are null bytes', async () => {
    const fetch: FetchLike = async (url) => (url.includes('render.example/a') ? res(200) : url.includes('/v1/images') ? res(200, fx('images')) : res(403));
    const c = createFigmaRestClient({ token: 't', fetch, fileKey: 'K' });
    const urls = await c.renderImagesAtVersion(['1:1', '1:2', '1:3'], '900');
    expect(urls['1:3']).toBeNull();
    const dl = await c.downloadImages(urls);
    expect(dl['1:1'].bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(dl['1:2'].bytes).toBeNull();
    expect(dl['1:3'].bytes).toBeNull();
  });
});

describe('chooseFreshVersion', () => {
  const clientFor = (meta: any, versionLists: any[]) => {
    let i = 0;
    return {
      fileMeta: async () => meta,
      listVersions: async () => versionLists[Math.min(i++, versionLists.length - 1)],
    };
  };
  const v800 = { id: '800', created_at: '2026-10-27T09:00:00Z' };
  const v900 = { id: '900', created_at: '2026-10-27T10:00:30Z' };

  it('ready at once: a version after the FILE last-modified (not the press time) is used', async () => {
    const sleep = vi.fn(async () => {});
    const r = await chooseFreshVersion({
      client: clientFor({ lastModified: '2026-10-27T10:00:00Z', version: '900', name: 'n' }, [[v900, v800]]),
      pinnedVersionId: '800', sleep,
    });
    expect(r).toMatchObject({ ok: true, via: 'last-modified', version: { id: '900' } });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits (injected sleep) until the autosave appears', async () => {
    const sleep = vi.fn(async () => {});
    const r = await chooseFreshVersion({
      client: clientFor({ lastModified: '2026-10-27T10:00:00Z', version: null, name: null }, [[v800], [v800], [v900, v800]]),
      pinnedVersionId: '800', sleep,
    });
    expect(r.ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(FRESHNESS_WAIT.intervalMs);
  });

  it('times out into the save-a-version question', async () => {
    const sleep = vi.fn(async () => {});
    const r = await chooseFreshVersion({
      client: clientFor({ lastModified: '2026-10-27T10:00:00Z', version: null, name: null }, [[v800]]),
      pinnedVersionId: '800', sleep,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.becomesQuestion).toBe(true);
      expect(r.message).toContain('File > Save to version history');
      expect(r.message).toContain('press');
    }
    expect(sleep).toHaveBeenCalledTimes(FRESHNESS_WAIT.maxAttempts - 1);
  });

  it('last-modified unavailable: newest version differing from the pinned one is used', async () => {
    const r = await chooseFreshVersion({ client: clientFor({ lastModified: null, version: null, name: null }, [[v900, v800]]), pinnedVersionId: '800' });
    expect(r).toMatchObject({ ok: true, via: 'newest-differs-from-pinned', version: { id: '900' } });
  });

  it('last-modified unavailable and nothing newer than pinned: the save-a-version question, no waiting', async () => {
    const sleep = vi.fn(async () => {});
    const r = await chooseFreshVersion({ client: clientFor({ lastModified: null, version: null, name: null }, [[v800]]), pinnedVersionId: '800', sleep });
    expect(r).toEqual({ ok: false, becomesQuestion: true, message: SAVE_VERSION_QUESTION });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('diffSnapshots + interpret (hand-authored fixtures)', () => {
  it('no change: no changes, no lines, no questions', () => {
    expect(diff('base')).toEqual([]);
    expect(interpret([])).toEqual({ lines: [], questions: [] });
  });

  it('frame added: a line and a question', () => {
    const ch = diff('frame-added');
    expect(ch.map((c) => c.kind)).toEqual(['frame-added']);
    const i = interpret(ch);
    expect(i.lines).toEqual(['Frame added: "B-1 · Option D"']);
    expect(i.questions).toHaveLength(1);
    expect(i.questions[0].text).toMatch(/method.*illustrative only/);
  });

  it('frame removed: a line and a question', () => {
    const ch = diff('frame-removed');
    expect(ch.map((c) => [c.kind, c.frameId])).toEqual([['frame-removed', '1:3']]);
    expect(interpret(ch).questions).toHaveLength(1);
  });

  it('reorder: change lines only, no question', () => {
    const ch = diff('reordered');
    expect(ch.every((c) => c.kind === 'frame-reordered')).toBe(true);
    expect(ch.length).toBeGreaterThan(0);
    const i = interpret(ch);
    expect(i.lines.length).toBe(ch.length);
    expect(i.questions).toEqual([]);
  });

  it('text changed on 7 rows collapses to ONE question (7 lines)', () => {
    const ch = diff('text-changed-7');
    expect(ch).toHaveLength(7);
    expect(ch.every((c) => c.kind === 'text-changed' && c.frameId === '1:2')).toBe(true);
    const i = interpret(ch);
    expect(i.lines).toHaveLength(7);
    expect(i.questions).toHaveLength(1);
    expect(i.questions[0]).toMatchObject({ kind: 'text-changed', count: 7 });
    expect(i.questions[0].text).toContain('7 places');
  });

  it('instance swapped: a line and a question', () => {
    const ch = diff('instance-swapped');
    expect(ch.map((c) => c.kind)).toEqual(['instance-swapped']);
    expect(interpret(ch).questions).toHaveLength(1);
  });

  it('geometry-only and style-only changes: lines, NO question', () => {
    const ch = diff('geometry-style-only');
    expect(new Set(ch.map((c) => c.kind))).toEqual(new Set(['geometry-changed', 'style-changed']));
    const i = interpret(ch);
    expect(i.lines.length).toBe(ch.length);
    expect(i.questions).toEqual([]);
  });

  it('a layer added inside a frame is unclassified: a line AND a question, never dropped', () => {
    const ch = diff('layer-added');
    expect(ch.map((c) => c.kind)).toEqual(['unclassified']);
    const i = interpret(ch);
    expect(i.lines).toHaveLength(1);
    expect(i.questions).toHaveLength(1);
    expect(i.questions[0].kind).toBe('unclassified');
  });

  it('different kinds do not merge into one question', () => {
    const i = interpret([...diff('text-changed-7'), ...diff('frame-added'), ...diff('layer-added')]);
    expect(i.questions.map((q) => q.kind).sort()).toEqual(['frame-added', 'text-changed', 'unclassified']);
  });

  it('diffing does not mutate the snapshots', () => {
    const before = JSON.stringify(base);
    diff('text-changed-7');
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('human-in-tool provenance', () => {
  const agent: ProvenanceNote[] = [
    { element: '3:2', provenance: 'invented', note: 'agent made this up' },
    { element: '9:9', provenance: 'real' },
  ];
  it('appends one human-in-tool note per changed element; agent lines are untouched', () => {
    const out = markHumanInTool(agent, ['2:1', '2:2'], { '2:1': 'Row 1' });
    expect(out.slice(0, 2)).toEqual(agent);
    expect(out.slice(2)).toEqual([
      { element: '2:1', provenance: 'human-in-tool', note: 'Changed by the designer in Figma: Row 1' },
      { element: '2:2', provenance: 'human-in-tool', note: 'Changed by the designer in Figma' },
    ]);
  });
  it('does not mutate its input and is idempotent', () => {
    const copy = JSON.parse(JSON.stringify(agent));
    const once = markHumanInTool(agent, ['2:1']);
    expect(agent).toEqual(copy);
    expect(markHumanInTool(once, ['2:1'])).toEqual(once);
  });
  it('an element that already carried an agent line keeps it and gains a human-in-tool line', () => {
    const out = markHumanInTool(agent, ['3:2']);
    expect(out[0]).toEqual(agent[0]);
    expect(out.filter((n) => n.element === '3:2').map((n) => n.provenance)).toEqual(['invented', 'human-in-tool']);
  });
  it('changedElementIds prefers the node id and dedupes', () => {
    expect(changedElementIds(diff('text-changed-7'))).toEqual(['2:1', '2:2', '2:3', '2:4', '2:5', '2:6', '2:7']);
    expect(changedElementIds(diff('frame-added'))).toEqual(['1:4']);
  });
});

describe('serializeProvenanceNotes', () => {
  it('one stable line per note: <provenance> | <element> | <note>, "-" for no note, newlines flattened', () => {
    expect(serializeProvenanceNotes([
      { element: '3:2', provenance: 'invented', note: 'agent made\nthis up' },
      { element: '9:9', provenance: 'real' },
      { element: '2:1', provenance: 'human-in-tool', note: 'Changed by the designer in Figma' },
    ])).toBe('invented | 3:2 | agent made this up\nreal | 9:9 | -\nhuman-in-tool | 2:1 | Changed by the designer in Figma');
  });
  it('an empty list is an honest sentence, not an empty string', () => {
    expect(serializeProvenanceNotes([])).toBe(NO_PROVENANCE_NOTES);
    expect(NO_PROVENANCE_NOTES.length).toBeGreaterThan(0);
  });
  it('marking then serializing is idempotent across a second marking', () => {
    const once = markHumanInTool([{ element: '3:2', provenance: 'invented', note: 'x' }], ['2:1']);
    expect(serializeProvenanceNotes(markHumanInTool(once, ['2:1']))).toBe(serializeProvenanceNotes(once));
  });
});

// UUIDs are hand-authored; the artefact is checked with B-1202's real schema.
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';

describe('assemblePendingArtefact (compose rule)', () => {
  const frames = [
    { id: '1:1', name: 'B-1 · Option A', caption: 'A' },
    { id: '1:2', name: 'B-1 · Option B', caption: 'B' },
  ];
  const doc = fx<FigmaNodesResponse>('base').nodes['0:1']!.document;
  const nodes: FigmaNodesResponse['nodes'] = Object.fromEntries(doc.children!.map((c) => [c.id, { document: c }]));
  const img = { bytes: new Uint8Array([1]) };
  const attachments = { '1:1': { attachment_id: A1, filename: 'a.png' }, '1:2': { attachment_id: A2, filename: 'b.png' } };
  const ok = {
    fileKey: 'KEY', fileUrl: 'https://www.figma.com/design/KEY/x', versionId: '900', frames,
    nodesAtVersion: nodes, images: { '1:1': img, '1:2': img }, attachments, composedAt: '2026-10-27T10:05:00Z',
    provenanceNotes: [] as ProvenanceNote[],
  };

  it('builds a record that PASSES DesignArtefactSchema, in frame order, mcp_call_count 0', () => {
    const r = assemblePendingArtefact(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(() => DesignArtefactSchema.parse(r.artefact)).not.toThrow();
    expect(r.artefact).toEqual({
      schema_version: 1, tool: 'figma', composed_at: '2026-10-27T10:05:00Z', provenance_notes: NO_PROVENANCE_NOTES, mcp_call_count: 0,
      nodes: [
        { id: '1:1', name: 'B-1 · Option A', caption: 'A', preview_attachment_id: A1, preview_filename: 'a.png' },
        { id: '1:2', name: 'B-1 · Option B', caption: 'B', preview_attachment_id: A2, preview_filename: 'b.png' },
      ],
      file_key: 'KEY', file_url: 'https://www.figma.com/design/KEY/x', version_id: '900',
    });
  });
  it('carries the serialized provenance notes, human-in-tool marks included', () => {
    const r = assemblePendingArtefact({ ...ok, provenanceNotes: markHumanInTool([{ element: '9:9', provenance: 'real' }], ['2:1']), mcpCallCount: 2 });
    expect(r.ok && r.artefact.provenance_notes).toBe('real | 9:9 | -\nhuman-in-tool | 2:1 | Changed by the designer in Figma');
    expect(r.ok && r.artefact.mcp_call_count).toBe(2);
  });
  it('a frame absent at the version is a typed failure (never latest)', () => {
    const r = assemblePendingArtefact({ ...ok, nodesAtVersion: { '1:1': nodes['1:1'], '1:2': null } });
    expect(r).toMatchObject({ ok: false, code: 'frame-missing', ids: ['1:2'] });
  });
  it('a null image (a 200 can carry one) is a typed failure', () => {
    expect(assemblePendingArtefact({ ...ok, images: { '1:1': img, '1:2': { bytes: null } } })).toMatchObject({ ok: false, code: 'image-missing', ids: ['1:2'] });
    expect(assemblePendingArtefact({ ...ok, images: { '1:1': img } })).toMatchObject({ ok: false, code: 'image-missing', ids: ['1:2'] });
    expect(assemblePendingArtefact({ ...ok, images: { '1:1': img, '1:2': { bytes: new Uint8Array() } } })).toMatchObject({ code: 'image-missing' });
  });
  it('a missing attachment is a typed failure', () => {
    expect(assemblePendingArtefact({ ...ok, attachments: { '1:1': attachments['1:1'] } })).toMatchObject({ ok: false, code: 'attachment-missing', ids: ['1:2'] });
  });
  it('refuses a file_url carrying a token or signature', () => {
    expect(assemblePendingArtefact({ ...ok, fileUrl: 'https://x/y?token=abc' })).toMatchObject({ ok: false, code: 'unsafe-url' });
  });
  it('a record the schema would refuse (non-uuid attachment id) is a typed invalid-artefact failure', () => {
    const r = assemblePendingArtefact({ ...ok, attachments: { ...attachments, '1:1': { attachment_id: 'att-1', filename: 'a.png' } } });
    expect(r).toMatchObject({ ok: false, code: 'invalid-artefact' });
  });
  it('no capability argument exists: the refusal is compose_brief\'s (validateDesignAttachments)', () => {
    expect(readFileSync(fileURLToPath(new URL('./figma-reconcile.ts', import.meta.url)), 'utf8')).not.toMatch(/capabilityPresent|capability-absent/);
  });
});

describe('reconcileDesign (hand-authored fixtures, fake client, fake prepare)', () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const baseline: DesignArtefact = {
    schema_version: 1, tool: 'figma', composed_at: '2026-10-27T09:00:00.000Z', provenance_notes: 'real | 1:1 | -', mcp_call_count: 1,
    file_key: 'KEY', file_url: 'https://www.figma.com/design/KEY/x', version_id: '800',
    nodes: [
      { id: '1:1', name: 'B-1 · Option A', caption: 'Caption A', preview_attachment_id: A1, preview_filename: 'a.png' },
      { id: '1:2', name: 'B-1 · Option B', caption: 'Caption B', preview_attachment_id: A2, preview_filename: 'b.png' },
    ],
  };
  const meta = { lastModified: '2026-10-27T10:00:00Z', version: '900', name: 'n' };
  const v900 = { id: '900', created_at: '2026-10-27T10:00:30Z' };
  const v950 = { id: '950', created_at: '2026-10-27T10:05:30Z' };
  // The fake serves a fixture per version id.
  const clientFor = (byVersion: Record<string, string>, over: Record<string, unknown> = {}) => ({
    fileMeta: async () => meta,
    listVersions: async () => [v900],
    getNodesAtVersion: vi.fn(async (_ids: string[], v: string) => {
      if (!byVersion[v]) throw new FigmaRestError('version-not-found', `404 at ${v}`, 404);
      return fx<FigmaNodesResponse>(byVersion[v]);
    }),
    ...over,
  });
  const prepareFor = (version: string, ids?: string[]): PrepareFn =>
    (async (_k, nodeIds) => ({ version_id: version, previews: (ids ?? nodeIds).map((id) => ({ id, bytes: PNG })) })) as PrepareFn;
  const common = { baseline, containerId: '0:1', token: 't', sleep: async () => {}, now: () => new Date('2026-10-27T10:06:00Z') };

  it('happy path: diffs baseline vs fresh, prepares in fresh frame order, captions from baseline / default for added', async () => {
    const client = clientFor({ '800': 'base', '900': 'frame-added' });
    const prepare = vi.fn(prepareFor('900'));
    const r = await reconcileDesign({ ...common, client, prepare });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(client.getNodesAtVersion.mock.calls.map((c) => c[1])).toEqual(['800', '900']);
    expect(prepare.mock.calls[0][0]).toBe('KEY');
    expect(prepare.mock.calls[0][1]).toEqual(['1:1', '1:2', '1:3', '1:4']);
    expect(r.versionId).toBe('900');
    expect(r.baselineVersionId).toBe('800');
    expect(r.lines).toContain('Frame added: "B-1 · Option D"');
    expect(r.questions.map((q) => q.kind)).toContain('frame-added');
    expect(r.changedElementIds).toContain('1:4');
    expect(r.frames.map((f) => f.caption)).toEqual(['Caption A', 'Caption B', ADDED_FRAME_CAPTION, ADDED_FRAME_CAPTION]);
    expect(r.previews.map((p) => p.id)).toEqual(['1:1', '1:2', '1:3', '1:4']);
    expect(r.composedAt).toBe('2026-10-27T10:06:00.000Z');
  });

  it('re-diffs once at the version prepare returned when it differs from the one first diffed', async () => {
    const client = clientFor({ '800': 'base', '900': 'base', '950': 'text-changed-7' });
    const r = await reconcileDesign({ ...common, client, prepare: prepareFor('950', ['1:1', '1:2', '1:3']) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(client.getNodesAtVersion.mock.calls.map((c) => c[1])).toEqual(['800', '900', '950']);
    expect(r.versionId).toBe('950');
    expect(r.lines).toHaveLength(7);
    expect(r.questions).toHaveLength(1);
  });

  it('refuses when the version prepare returned has frames that were never previewed', async () => {
    const client = clientFor({ '800': 'base', '900': 'base', '950': 'frame-added' });
    const r = await reconcileDesign({ ...common, client, prepare: prepareFor('950', ['1:1', '1:2', '1:3']) });
    expect(r).toMatchObject({ ok: false, code: 'frames-changed' });
  });

  it('no saved version after the last edit: the save-a-version question, nothing read or rendered', async () => {
    const client = clientFor({ '800': 'base' }, { listVersions: async () => [{ id: '800', created_at: '2026-10-27T09:00:00Z' }] });
    const prepare = vi.fn(prepareFor('900'));
    const r = await reconcileDesign({ ...common, client, prepare });
    expect(r).toMatchObject({ ok: false, code: 'save-a-version', becomesQuestion: true });
    if (!r.ok) expect(r.message).toContain('File > Save to version history');
    expect(prepare).not.toHaveBeenCalled();
    expect(client.getNodesAtVersion).not.toHaveBeenCalled();
  });

  it('404 at a version is version-not-found, never "no change"', async () => {
    const client = clientFor({ '800': 'base' }); // 900 missing -> 404
    const r = await reconcileDesign({ ...common, client, prepare: prepareFor('900') });
    expect(r).toMatchObject({ ok: false, code: 'version-not-found' });
  });

  it('429 from the REST read carries retry-after and does not retry', async () => {
    const getNodesAtVersion = vi.fn(async () => { throw new FigmaRestError('rate-limited', '429', 429, 42); });
    const r = await reconcileDesign({ ...common, client: clientFor({}, { getNodesAtVersion }), prepare: prepareFor('900') });
    expect(r).toMatchObject({ ok: false, code: 'rate-limited', retryAfterSeconds: 42 });
    expect(getNodesAtVersion).toHaveBeenCalledTimes(1);
  });

  it('429 surfaced by prepare is rate-limited too', async () => {
    const prepare = (async () => { throw new Error('Pinned Figma images: HTTP 429'); }) as PrepareFn;
    const r = await reconcileDesign({ ...common, client: clientFor({ '800': 'base', '900': 'base' }), prepare });
    expect(r).toMatchObject({ ok: false, code: 'rate-limited', retryAfterSeconds: null });
  });

  it('frames that never appear (prepare timeout) are frames-missing, with its actionable message', async () => {
    const prepare = (async () => { throw new Error('Figma autosave did not capture every frame within 12 attempts; save the file and retry. No latest screenshots were substituted.'); }) as PrepareFn;
    const r = await reconcileDesign({ ...common, client: clientFor({ '800': 'base', '900': 'base' }), prepare });
    expect(r).toMatchObject({ ok: false, code: 'frames-missing' });
    if (!r.ok) expect(r.message).toMatch(/No latest screenshots were substituted/);
  });

  it('an unrelated prepare failure is previews-failed, message kept', async () => {
    const prepare = (async () => { throw new Error('Figma preview is not a PNG'); }) as PrepareFn;
    const r = await reconcileDesign({ ...common, client: clientFor({ '800': 'base', '900': 'base' }), prepare });
    expect(r).toMatchObject({ ok: false, code: 'previews-failed', message: 'Figma preview is not a PNG' });
  });

  it('a container absent at a version is container-missing', async () => {
    const client = clientFor({ '800': 'base', '900': 'base' });
    const r = await reconcileDesign({ ...common, client, containerId: '9:9', prepare: prepareFor('900') });
    expect(r).toMatchObject({ ok: false, code: 'container-missing' });
  });

  it('an html baseline is a typed refusal before any read', async () => {
    const html: DesignArtefact = { schema_version: 1, tool: 'html', composed_at: '2026-10-27T09:00:00.000Z', provenance_notes: 'x', mcp_call_count: 0, surface_attachment_id: A1, surface_filename: 's.html' };
    const client = clientFor({});
    const r = await reconcileDesign({ ...common, baseline: html, client, prepare: prepareFor('900') });
    expect(r).toMatchObject({ ok: false, code: 'baseline-not-figma' });
    expect(client.getNodesAtVersion).not.toHaveBeenCalled();
  });

  it('an invalid baseline is baseline-invalid', async () => {
    const r = await reconcileDesign({ ...common, baseline: { tool: 'figma' } as unknown as DesignArtefact, client: clientFor({}), prepare: prepareFor('900') });
    expect(r).toMatchObject({ ok: false, code: 'baseline-invalid' });
  });

  it('builds its own REST client from token + fetch when none is injected (GET only, token header)', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url.includes('?depth=1')) return res(200, fx('file-meta'));
      if (url.endsWith('/versions')) return res(200, fx('versions'));
      return res(200, fx(url.includes('version=800') ? 'base' : 'frame-added'));
    };
    const r = await reconcileDesign({ ...common, fetch, prepare: prepareFor('900') });
    expect(r.ok).toBe(true);
    expect(seen.every((x) => x.init.method === 'GET' && x.init.headers['X-Figma-Token'] === 't')).toBe(true);
  });

  it('never silently falls back to the latest version: every nodes read names an explicit version', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes('?depth=1')) return res(200, fx('file-meta'));
      if (url.endsWith('/versions')) return res(200, fx('versions'));
      return res(200, fx('base'));
    };
    await reconcileDesign({ ...common, fetch, prepare: prepareFor('900') });
    for (const u of urls.filter((x) => x.includes('/nodes'))) expect(u).toMatch(/version=\d+/);
  });
});

describe('module hygiene', () => {
  const src = readFileSync(fileURLToPath(new URL('./figma-reconcile.ts', import.meta.url)), 'utf8');
  it("the file text has no 'mcp' at all besides the artefact field mcp_call_count / mcpCallCount (no MCP client, no MCP read)", () => {
    expect(src.replace(/mcp_call_count|mcpCallCount/g, '').toLowerCase()).not.toContain('mcp');
    expect(src).not.toMatch(/modelcontextprotocol/i);
  });
  it('every request is a GET (the module never edits the Figma file)', () => {
    expect(src).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
  });
});
