import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DesignArtefactSchema } from './design-artefact.js';
import {
  readAcceptedDesign, checkDrift, describeDrift, assertBuildMayStart, resolveComponent, planDesignRead,
  type DesignVersionPort,
} from './design-read.js';

const artefact = (over: Record<string, unknown> = {}) => ({
  schema_version: 1, tool: 'figma', composed_at: '2026-10-01T00:00:00Z', provenance_notes: '', mcp_call_count: 3,
  file_key: 'FK', file_url: 'https://figma.com/file/FK', version_id: 'V1',
  nodes: [
    { id: '1:1', name: 'Login', caption: 'Sign in', preview_attachment_id: 'a1', preview_filename: 'login.png' },
    { id: '1:2', name: 'Home', caption: 'Landing', preview_attachment_id: 'a2', preview_filename: 'home.png' },
  ],
  ...over,
});
const nested = (a = artefact()) => ({ gate_slots: { design: { design_artefact: a, source_brief_id: 'br-1', drift: { observation: 'unchanged' } } } });
const flat = (a = artefact()) => ({ gate_slots: { design: a } });

describe('readAcceptedDesign', () => {
  it.each([
    ['null', null], ['no slots', {}], ['no design', { gate_slots: {} }], ['string slot', { gate_slots: { design: 'x' } }],
    ['no nodes', { gate_slots: { design: { design_artefact: { tool: 'figma' } } } }],
    ['nodes not array', { gate_slots: { design: { design_artefact: { nodes: 3 } } } }],
  ])('absent for %s', (_n, fv) => {
    expect(readAcceptedDesign(fv)).toEqual({ status: 'absent' });
  });

  it('reads the nested envelope with brief and drift evidence', () => {
    const d = readAcceptedDesign(nested());
    expect(d).toMatchObject({ status: 'present', tool: 'figma', versionId: 'V1', fileKey: 'FK', sourceBriefId: 'br-1', acceptedDrift: 'unchanged' });
  });
  it('reads the flat envelope', () => {
    const d = readAcceptedDesign(flat());
    expect(d).toMatchObject({ status: 'present', versionId: 'V1', sourceBriefId: null, acceptedDrift: null });
  });
  it('preserves node order and counts skipped nodes', () => {
    const a = artefact({ nodes: [
      { id: '2', name: 'B', preview_attachment_id: 'p', preview_filename: 'b.png' },
      { name: 'no id' }, { id: '3' }, null,
      { id: '1', name: 'A', preview_attachment_id: 'q', preview_filename: 'a.png' },
    ] });
    const d = readAcceptedDesign(nested(a));
    if (d.status !== 'present') throw new Error('expected present');
    expect(d.screens.map((s) => s.name)).toEqual(['B', 'A']);
    expect(d.skippedNodes).toBe(3);
  });
});

// B-1327: a design slot copied from B-1312's real field_values (gate_slots.design). The writer (gate-slots.ts)
// stores everything under `content`; ratified_at and ratified_by sit at the top of the slot.
const realSlot = (): Record<string, unknown> => JSON.parse(readFileSync(fileURLToPath(new URL('./__fixtures__/design-slot.b1312-2026-10-28.json', import.meta.url)), 'utf8'));
const realFieldValues = () => ({ implements_entities: ['Knowledge'], gate_slots: { design: realSlot() } });

describe('B-1327: readAcceptedDesign on the real stored slot shape', () => {
  it('finds the accepted design under slot.content.design_artefact', () => {
    const d = readAcceptedDesign(realFieldValues());
    expect(d).toMatchObject({
      status: 'present', tool: 'figma', versionId: '2415453148397313316', fileKey: 'cE0x2i7UkD7X73p8WwnCzy',
      fileUrl: 'https://www.figma.com/design/cE0x2i7UkD7X73p8WwnCzy', skippedNodes: 0,
    });
    if (d.status !== 'present') throw new Error('expected present');
    expect(d.screens.map((s) => s.nodeId)).toEqual(['10:74', '10:143', '10:188']);
    expect(d.screens[0]).toMatchObject({ name: 'B-1312 · 1. Decisions tab', previewFilename: 'B-1312-design-10-74-v2415453148397313316.png' });
  });
  it('reads the accept-time drift word and source brief from content', () => {
    expect(readAcceptedDesign(realFieldValues())).toMatchObject({
      acceptedDrift: 'unchecked', sourceBriefId: '5a3c02f3-c865-4ee4-bfb7-53dcb9fa58ea',
    });
  });
  it('plans one checklist step per real screen', () => {
    const plan = planDesignRead(realFieldValues(), { drift: 'unchecked', source: 'version', acceptedVersionId: null, liveVersionId: null, note: 'n' } as never);
    expect(plan?.design_read.screens).toEqual(['B-1312 · 1. Decisions tab', 'B-1312 · 2. Terms tab', 'B-1312 · 3. Feature accounts tab']);
    expect(plan?.checklist).toHaveLength(3);
  });
  it('an html design stored under content is still present with no screens', () => {
    const slot = realSlot() as { content: { design_artefact: Record<string, unknown> } };
    slot.content.design_artefact = { tool: 'html', schema_version: 1, composed_at: 'x', provenance_notes: '', mcp_call_count: 0, surface_attachment_id: 'a', surface_filename: 's.html' };
    expect(readAcceptedDesign({ gate_slots: { design: slot } })).toMatchObject({ status: 'present', tool: 'html', screens: [] });
  });
  it('a content that holds no design is absent, and so is a content that is not an object', () => {
    const slot = realSlot() as { content: Record<string, unknown> };
    delete slot.content.design_artefact;
    expect(readAcceptedDesign({ gate_slots: { design: slot } })).toEqual({ status: 'absent' });
    expect(readAcceptedDesign({ gate_slots: { design: { content: 'x' } } })).toEqual({ status: 'absent' });
  });
  it('the content shape wins over a stale top-level shape on the same slot', () => {
    const slot = { ...realSlot(), design_artefact: artefact({ file_key: 'OLD' }) };
    expect(readAcceptedDesign({ gate_slots: { design: slot } })).toMatchObject({ fileKey: 'cE0x2i7UkD7X73p8WwnCzy' });
  });
  it('the two older shapes still read', () => {
    expect(readAcceptedDesign(nested())).toMatchObject({ status: 'present', fileKey: 'FK', sourceBriefId: 'br-1', acceptedDrift: 'unchanged' });
    expect(readAcceptedDesign(flat())).toMatchObject({ status: 'present', fileKey: 'FK' });
  });
});

const present = () => readAcceptedDesign(nested());
const port = (fn: () => Promise<string | null>): DesignVersionPort => ({ latestVersionId: fn });

describe('checkDrift', () => {
  it('unchanged / changed from the port', async () => {
    expect(await checkDrift(present(), port(async () => 'V1'))).toMatchObject({ drift: 'unchanged', liveVersionId: 'V1' });
    expect(await checkDrift(present(), port(async () => 'V2'))).toMatchObject({ drift: 'changed', acceptedVersionId: 'V1', liveVersionId: 'V2' });
  });
  it.each([
    ['no port', undefined], ['null port', null],
    ['port throws', port(async () => { throw new Error('boom'); })],
    ['port returns null', port(async () => null)],
  ])('unchecked: %s', async (_n, p) => {
    const r = await checkDrift(present(), p);
    expect(r.drift).toBe('unchecked');
    expect(r.liveVersionId).toBeNull();
  });
  it('html design is unchecked with a nothing-to-compare note, even with a port', async () => {
    const html = readAcceptedDesign(nested(artefact({ tool: 'html', file_key: undefined, version_id: undefined, surface_attachment_id: 's', surface_filename: 's.html' })));
    const r = await checkDrift(html, port(async () => 'V9'));
    expect(r.drift).toBe('unchecked');
    expect(r.note).toContain('nothing to compare');
  });
  it('absent design is unchecked', async () => {
    expect((await checkDrift({ status: 'absent' }, port(async () => 'V1'))).drift).toBe('unchecked');
  });
});

describe('describeDrift', () => {
  it.each([
    [{ drift: 'unchecked', acceptedVersionId: 'V1', liveVersionId: null, note: 'no Figma token available' }, 'Drift check: unchecked (no Figma token available).'],
    [{ drift: 'changed', acceptedVersionId: 'V1', liveVersionId: 'V2', note: '' }, 'Drift check: changed (accepted version V1, live version V2).'],
    [{ drift: 'unchanged', acceptedVersionId: 'V1', liveVersionId: 'V1', note: '' }, 'Drift check: unchanged (version V1).'],
  ] as const)('%#', (r, line) => {
    expect(describeDrift({ ...r })).toBe(line);
    expect(line.match(/\b(changed|unchanged|unchecked)\b/g)).toHaveLength(1);
  });
});

describe('assertBuildMayStart', () => {
  const changed = { drift: 'changed', acceptedVersionId: 'V1', liveVersionId: 'V2', note: '' } as const;
  it('refuses changed, naming both versions', () => {
    const r = assertBuildMayStart({ ...changed }, []);
    expect(r.allowed).toBe(false);
    if (!r.allowed) { expect(r.reason).toContain('V1'); expect(r.reason).toContain('V2'); }
  });
  it('allows changed when a difference is named', () => {
    expect(assertBuildMayStart({ ...changed }, ['header colour moved'])).toEqual({ allowed: true });
  });
  it('does not accept a blank named difference', () => {
    expect(assertBuildMayStart({ ...changed }, ['  ']).allowed).toBe(false);
  });
  it.each(['unchanged', 'unchecked'] as const)('allows %s', (drift) => {
    expect(assertBuildMayStart({ drift, acceptedVersionId: 'V1', liveVersionId: null, note: '' }, [])).toEqual({ allowed: true });
  });
});

describe('resolveComponent', () => {
  // Fixtures are hand-authored pending capture from a real Code Connect / workspace-map run.
  const node = { nodeId: '1:1', name: 'LoginForm' };
  const codeConnectMap = { 'LoginForm': 'src/components/auth/LoginForm.tsx' };
  const workspaceMap = { 'LoginForm': 'src/components/LegacyLogin.tsx', 'Card': 'src/components/ui/card.tsx' };

  it('prefers Code Connect when present', () => {
    expect(resolveComponent(node, { codeConnectMap, workspaceMap })).toEqual({ source: 'code-connect', repoComponent: 'src/components/auth/LoginForm.tsx' });
  });
  it('falls back to the workspace map', () => {
    expect(resolveComponent(node, { workspaceMap })).toEqual({ source: 'workspace-map', repoComponent: 'src/components/LegacyLogin.tsx' });
    expect(resolveComponent({ name: 'Card' }, { codeConnectMap, workspaceMap }).source).toBe('workspace-map');
  });
  it('is unmapped with neither', () => {
    expect(resolveComponent(node, {})).toEqual({ source: 'unmapped', repoComponent: null });
    expect(resolveComponent(node, { codeConnectMap: null, workspaceMap: null }).source).toBe('unmapped');
  });
  it('matches by node id and carries no generated-code field', () => {
    const r = resolveComponent(node, { codeConnectMap: { '1:1': 'X.tsx' } });
    expect(r.repoComponent).toBe('X.tsx');
    expect(Object.keys(r).sort()).toEqual(['repoComponent', 'source']);
    expect(Object.keys(r).some((k) => /code|react|tailwind/i.test(k))).toBe(false);
  });
});

describe('planDesignRead', () => {
  const drift = { drift: 'unchecked', acceptedVersionId: 'V1', liveVersionId: null, note: 'x' } as const;
  it('null when absent', () => {
    expect(planDesignRead({}, { ...drift })).toBeNull();
  });
  it('attests and gives one checklist step per screen', () => {
    const p = planDesignRead(nested(), { ...drift })!;
    expect(p.design_read).toEqual({ version_id: 'V1', screens: ['Login', 'Home'], drift: 'unchecked' });
    expect(p.checklist).toEqual([
      "Build screen 'Login' from the accepted design (compare with 'login.png')",
      "Build screen 'Home' from the accepted design (compare with 'home.png')",
    ]);
  });
});

describe('contract with B-1202\'s accepted design record', () => {
  // A slot shaped exactly as B-1202's writer stores it: the artefact validated by its own schema, plus the drift observation.
  const real = DesignArtefactSchema.parse({
    schema_version: 1, tool: 'figma', composed_at: '2026-10-27T10:00:00.000Z', provenance_notes: 'real: Button; invented: none', mcp_call_count: 2,
    file_key: 'AbC123', file_url: 'https://www.figma.com/design/AbC123/Epics', version_id: '2001',
    nodes: [
      { id: '1:1', name: 'Epics page', caption: 'List with retired section', preview_attachment_id: '3b7e2c1a-0d4f-4a8e-9c11-5e6f7a8b9c0d', preview_filename: 'epics-page.png' },
    ],
  });
  const slot = (drift: unknown) => ({ gate_slots: { design: { design_artefact: real, drift, ratified_by: 'design', ratified_at: '2026-10-27T11:00:00.000Z' } } });

  it('reads a slot the real schema accepts, with the recorded drift observation', () => {
    const d = readAcceptedDesign(slot({ status: 'changed', checked_at: '2026-10-27T11:00:01.000Z', latest_version_id: '2002' }));
    expect(d).toMatchObject({ status: 'present', tool: 'figma', versionId: '2001', fileKey: 'AbC123', acceptedDrift: 'changed' });
    if (d.status === 'present') expect(d.screens).toEqual([{ nodeId: '1:1', name: 'Epics page', caption: 'List with retired section', previewAttachmentId: '3b7e2c1a-0d4f-4a8e-9c11-5e6f7a8b9c0d', previewFilename: 'epics-page.png' }]);
  });
  it('reads unchecked and unchanged observations', () => {
    expect(readAcceptedDesign(slot({ status: 'unchecked', checked_at: 'x' }))).toMatchObject({ acceptedDrift: 'unchecked' });
    expect(readAcceptedDesign(slot({ status: 'unchanged', checked_at: 'x', latest_version_id: '2001' }))).toMatchObject({ acceptedDrift: 'unchanged' });
  });
  it('reads an html design as present with no screens', () => {
    const html = DesignArtefactSchema.parse({ schema_version: 1, tool: 'html', composed_at: '2026-10-27T10:00:00.000Z', provenance_notes: '', mcp_call_count: 0, surface_attachment_id: '3b7e2c1a-0d4f-4a8e-9c11-5e6f7a8b9c0d', surface_filename: 'surface.html' });
    expect(readAcceptedDesign({ gate_slots: { design: { design_artefact: html } } })).toMatchObject({ status: 'present', tool: 'html', screens: [] });
  });
});

describe('B-1203: drift from the content fingerprint', () => {
  const versionless = () => { const { version_id: _v, ...rest } = artefact(); void _v; return rest; };
  const withFp = (fp: unknown, a: Record<string, unknown> = artefact()) => ({ ...nested(a as never), design_fingerprint: fp });
  const taken = { schema_version: 1, status: 'taken', digest: 'd', frames: [] };
  const never = port(async () => { throw new Error('the version port must not be called'); });

  it('reads the fingerprint off the ticket', () => {
    expect(readAcceptedDesign(withFp({ ...taken, drift: { status: 'changed', checked_by: 'plan', changed_frame_ids: ['1:1', 7] } }))).toMatchObject({
      fingerprint: { status: 'taken', drift: { status: 'changed', checkedBy: 'plan', changedFrameIds: ['1:1'] } },
    });
    expect(readAcceptedDesign(nested())).toMatchObject({ fingerprint: null });
    expect(readAcceptedDesign(withFp('junk'))).toMatchObject({ fingerprint: null });
  });

  it('changed stops the build (even with a version_id present), unless a plan step names the difference', async () => {
    const d = readAcceptedDesign(withFp({ ...taken, drift: { status: 'changed', changed_frame_ids: ['1:2'] } }));
    const r = await checkDrift(d, never);
    expect(r).toMatchObject({ drift: 'changed', source: 'fingerprint', changedFrameIds: ['1:2'] });
    expect(describeDrift(r)).toContain('changed');
    const stop = assertBuildMayStart(r, []);
    expect(stop.allowed).toBe(false);
    if (!stop.allowed) expect(stop.reason).toContain('1:2');
    expect(assertBuildMayStart(r, ['header moved'])).toEqual({ allowed: true });
  });

  it('unchanged is allowed', async () => {
    const r = await checkDrift(readAcceptedDesign(withFp({ ...taken, drift: { status: 'unchanged' } }, versionless())));
    expect(r).toMatchObject({ drift: 'unchanged', source: 'fingerprint' });
    expect(assertBuildMayStart(r, [])).toEqual({ allowed: true });
  });

  it.each([
    ['no fingerprint on a versionless design', nested(versionless() as never), /no design fingerprint/],
    ['not-taken', withFp({ status: 'not-taken', reason: 'no-token' }), /not taken \(no-token\)/],
    ['malformed', withFp({ status: 'weird' }), /malformed/],
    ['taken, never compared', withFp(taken), /not been compared/],
    ['drift not-checked', withFp({ ...taken, drift: { status: 'not-checked', reason: 'rate-limited' } }), /rate-limited/],
  ])('unchecked and not blocking: %s', async (_n, fv, note) => {
    const r = await checkDrift(readAcceptedDesign(fv), never);
    expect(r.drift).toBe('unchecked');
    expect(r.note).toMatch(note);
    expect(assertBuildMayStart(r, [])).toEqual({ allowed: true });
  });

  it('a record WITH a version_id and no fingerprint keeps the version path', async () => {
    expect(await checkDrift(present(), port(async () => 'V2'))).toMatchObject({ drift: 'changed', liveVersionId: 'V2' });
    expect((await checkDrift(present(), port(async () => 'V2'))).source).toBeUndefined();
  });

  it('the plan read carries the fingerprint drift word', async () => {
    const fv = withFp({ ...taken, drift: { status: 'changed' } }, versionless());
    const p = planDesignRead(fv, await checkDrift(readAcceptedDesign(fv)))!;
    expect(p.design_read).toMatchObject({ version_id: null, drift: 'changed' });
  });
});
