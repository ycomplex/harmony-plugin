import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DesignArtefactSchema, observeDesignDrift, prepareVersionedPreviews, validateDesignAttachments, renderDesignArtefact, VersionOptionalUnsupportedError } from './design-artefact.js';
import { renderSlot, withDerivedGateSlot, type BriefDoc } from './briefs.js';
const artefact = { schema_version: 1 as const, tool: 'figma' as const, file_key: 'Abc123', file_url: 'https://www.figma.com/design/Abc123', version_id: 'X', composed_at: '2026-10-27T12:00:00Z', provenance_notes: 'versioned REST render', mcp_call_count: 0, nodes: [{ id: '1:2', name: 'Overview', caption: 'Overview caption', preview_attachment_id: '10000000-0000-4000-8000-000000000001', preview_filename: 'overview.png' }] };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-27T12:00:00Z'); });
afterEach(() => vi.useRealTimers());
describe('design artefacts', () => {
  it('rejects transient URLs, malformed versions, and unsafe Figma links', () => {
    expect(DesignArtefactSchema.safeParse({ ...artefact, version_id: '' }).success).toBe(false);
    expect(DesignArtefactSchema.safeParse({ ...artefact, file_url: 'javascript:alert(1)' }).success).toBe(false);
    expect(DesignArtefactSchema.safeParse({ ...artefact, screenshot_url: 'https://temporary.invalid' }).success).toBe(false);
  });
  it('derives a design write only for an artefact and renders filenames/version', () => {
    const doc = { decide: 'Review', items: [], frame: { kind: 'design', track: 'ux-ui-design', tracks: [], reach: [], design_artefact: artefact } } as BriefDoc;
    expect(renderSlot(doc, 'design')).toEqual({ design_artefact: artefact });
    expect(withDerivedGateSlot(doc, 'design-decision-draft').payload).toContainEqual(expect.objectContaining({ gate: 'design', ref: 'slot-design' }));
    expect(renderSlot({ ...doc, frame: { ...doc.frame!, design_artefact: undefined } } as BriefDoc, 'design')).toBeNull();
    expect(renderDesignArtefact(artefact).join('\n')).toContain('overview.png');
  });
  it('B-1324: a product-track design frame without design_artefact returns track info instead of null', () => {
    const productDoc = { decide: 'Review', items: [], frame: { kind: 'design', track: 'product-design', tracks: [], reach: [] } } as BriefDoc;
    expect(renderSlot(productDoc, 'design')).toEqual({ track: 'product-design', tracks: [], reach: [] });
    // ux-ui track without artefact STILL returns null
    const uxDoc = { decide: 'Review', items: [], frame: { kind: 'design', track: 'ux-ui-design', tracks: [], reach: [] } } as BriefDoc;
    expect(renderSlot(uxDoc, 'design')).toBeNull();
    // technical-design track without artefact also returns track info
    const techDoc = { decide: 'Review', items: [], frame: { kind: 'design', track: 'technical-design', tracks: [], reach: [] } } as BriefDoc;
    expect(renderSlot(techDoc, 'design')).toEqual({ track: 'technical-design', tracks: [], reach: [] });
  });
  it('requires production capability and finalized same-ticket media', async () => {
    const inQuery = vi.fn().mockResolvedValue({ data: [] });
    const chain = { select: () => chain, eq: () => chain, in: inQuery };
    const client = { rpc: vi.fn().mockResolvedValue({ data: { schema_version: 1 } }), from: () => chain };
    await expect(validateDesignAttachments(client as never, 'task', artefact)).rejects.toThrow('same-ticket');
    inQuery.mockResolvedValue({ data: [{ id: artefact.nodes[0].preview_attachment_id, filename: 'overview.png', content_type: 'image/png' }] });
    await expect(validateDesignAttachments(client as never, 'task', artefact)).resolves.toEqual(artefact);
    client.rpc.mockResolvedValue({ data: null });
    await expect(validateDesignAttachments(client as never, 'task', artefact)).rejects.toThrow('promote web');
  });
  it('B-1203: version_id is optional; a versionless record needs version_optional===true', async () => {
    const { version_id: _v, ...versionless } = artefact; void _v;
    expect(DesignArtefactSchema.safeParse(versionless).success).toBe(true);
    expect(DesignArtefactSchema.safeParse({ ...versionless, extra: 1 }).success).toBe(false);
    expect(DesignArtefactSchema.safeParse({ ...versionless, version_id: '' }).success).toBe(false);
    expect(renderDesignArtefact(versionless as never)[0]).toBe('**Design previews:** [Open Figma file](https://www.figma.com/design/Abc123)');
    expect(renderDesignArtefact(artefact)[0]).toContain('version X');
    const inQuery = vi.fn().mockResolvedValue({ data: [{ id: artefact.nodes[0].preview_attachment_id, filename: 'overview.png', content_type: 'image/png' }] });
    const chain = { select: () => chain, eq: () => chain, in: inQuery };
    const client = { rpc: vi.fn().mockResolvedValue({ data: { schema_version: 1 } }), from: () => chain };
    await expect(validateDesignAttachments(client as never, 'task', versionless)).rejects.toBeInstanceOf(VersionOptionalUnsupportedError);
    await expect(validateDesignAttachments(client as never, 'task', versionless)).rejects.toThrow('not been promoted');
    client.rpc.mockResolvedValue({ data: { schema_version: 1, version_optional: false } });
    await expect(validateDesignAttachments(client as never, 'task', versionless)).rejects.toBeInstanceOf(VersionOptionalUnsupportedError);
    client.rpc.mockResolvedValue({ data: { schema_version: 1, version_optional: true } });
    await expect(validateDesignAttachments(client as never, 'task', versionless)).resolves.toEqual(versionless);
    // a record WITH a version_id never needs the capability flag
    client.rpc.mockResolvedValue({ data: { schema_version: 1 } });
    await expect(validateDesignAttachments(client as never, 'task', artefact)).resolves.toEqual(artefact);
  });
  it('B-1203: drift on a versionless record is unchecked and makes no request', async () => {
    const { version_id: _v, ...versionless } = artefact; void _v;
    const fetcher = vi.fn();
    expect(await observeDesignDrift(versionless as never, 'token', fetcher)).toMatchObject({ status: 'unchecked' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps X authoritative for changed, failed and missing-credential drift reads', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ version: 'Y' }));
    expect(await observeDesignDrift(artefact, 'token', fetcher)).toMatchObject({ status: 'changed', latest_version_id: 'Y' });
    fetcher.mockResolvedValue(reply({}, 404));
    expect(await observeDesignDrift(artefact, 'token', fetcher)).toMatchObject({ status: 'unchecked' });
    expect(await observeDesignDrift(artefact, undefined, fetcher)).toMatchObject({ status: 'unchecked' });
    expect(artefact.version_id).toBe('X');
  });
  it('waits for frame presence, rejects 200/null images and renders at an explicit version', async () => {
    const f = vi.fn().mockResolvedValueOnce(reply({ version: 'old' })).mockResolvedValueOnce(reply({ nodes: {} }))
      .mockResolvedValueOnce(reply({ version: 'X' })).mockResolvedValueOnce(reply({ nodes: { '1:2': {} } })).mockResolvedValueOnce(reply({ images: { '1:2': null }, err: null }))
      .mockResolvedValueOnce(reply({ version: 'X' })).mockResolvedValueOnce(reply({ nodes: { '1:2': {} } })).mockResolvedValueOnce(reply({ images: { '1:2': 'https://images.example/preview' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([137,80,78,71,13,10,26,10])));
    const pause = vi.fn().mockResolvedValue(undefined);
    const result = await prepareVersionedPreviews('Abc123', ['1:2'], 'token', f, pause);
    expect(result.version_id).toBe('X'); expect(pause).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[4][0]).toContain('version=X');
    expect(result).not.toHaveProperty('signed_url');
  });
  it('bounds autosave misses and refuses unavailable versions', async () => {
    const f = vi.fn().mockImplementation((url: string) => Promise.resolve(reply(url.includes('version=') ? { nodes: {} } : { version: 'X' })));
    await expect(prepareVersionedPreviews('Abc123', ['1:2'], 'token', f, async () => {})).rejects.toThrow('12 attempts');
    expect(f).toHaveBeenCalledTimes(24);
    await expect(prepareVersionedPreviews('Abc123', ['1:2'], 'token', vi.fn().mockResolvedValue(reply({},404)))).rejects.toThrow('404');
  });
});
