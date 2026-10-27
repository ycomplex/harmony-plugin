import { describe, it, expect } from 'vitest';
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
