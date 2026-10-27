import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createFigmaRestClient, FigmaRestError, chooseFreshVersion, buildSnapshot, diffSnapshots, interpret,
  changedElementIds, markHumanInTool, assemblePendingArtefact, SAVE_VERSION_QUESTION, CAPABILITY_PREREQUISITE_MESSAGE,
  type FetchLike, type FigmaNodesResponse,
} from './figma-reconcile.js';
import { FRESHNESS_WAIT, type ProvenanceNote } from './figma-composition.js';

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

describe('assemblePendingArtefact (compose rule)', () => {
  const frames = [
    { id: '1:1', name: 'B-1 · Option A', caption: 'A' },
    { id: '1:2', name: 'B-1 · Option B', caption: 'B' },
  ];
  const doc = fx<FigmaNodesResponse>('base').nodes['0:1']!.document;
  const nodes: FigmaNodesResponse['nodes'] = Object.fromEntries(doc.children!.map((c) => [c.id, { document: c }]));
  const img = { bytes: new Uint8Array([1]) };
  const attachments = { '1:1': { attachment_id: 'att-1', filename: 'a.png' }, '1:2': { attachment_id: 'att-2', filename: 'b.png' } };
  const ok = {
    capabilityPresent: true, fileKey: 'KEY', fileUrl: 'https://www.figma.com/design/KEY/x', versionId: '900', frames,
    nodesAtVersion: nodes, images: { '1:1': img, '1:2': img }, attachments, composedAt: '2026-10-27T10:05:00Z',
    provenanceNotes: [] as ProvenanceNote[],
  };

  it('builds the schema_version 1 Figma artefact in frame order, mcp_call_count 0', () => {
    expect(assemblePendingArtefact(ok)).toEqual({
      ok: true,
      artefact: {
        schema_version: 1, tool: 'figma', composed_at: '2026-10-27T10:05:00Z', provenance_notes: [], mcp_call_count: 0,
        nodes: [
          { id: '1:1', name: 'B-1 · Option A', caption: 'A', preview_attachment_id: 'att-1', preview_filename: 'a.png' },
          { id: '1:2', name: 'B-1 · Option B', caption: 'B', preview_attachment_id: 'att-2', preview_filename: 'b.png' },
        ],
        file_key: 'KEY', file_url: 'https://www.figma.com/design/KEY/x', version_id: '900',
      },
    });
  });
  it('capabilityPresent false is a refusal with the prerequisite message, checked first', () => {
    const r = assemblePendingArtefact({ ...ok, capabilityPresent: false, nodesAtVersion: {} });
    expect(r).toEqual({ ok: false, code: 'capability-absent', message: CAPABILITY_PREREQUISITE_MESSAGE, ids: [] });
    expect(CAPABILITY_PREREQUISITE_MESSAGE).toMatch(/B-1202/);
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
