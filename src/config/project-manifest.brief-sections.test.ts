// B-1305: `brief_sections` in `.harmony/project.yml` — recognised by the strict top-level schema,
// validated separately so a malformed block never stops another gate step.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIEF_SECTION_GATE_FOR_REASON,
  BRIEF_SECTION_GATES,
  loadProjectManifest,
  parseBriefSections,
  resolveExtensionPoint,
} from './project-manifest.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sec = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Title ${id}`, instruction: `Do ${id}.`, ...extra });

describe('parseBriefSections', () => {
  it('parses a valid declaration per gate, in order', () => {
    const r = parseBriefSections({ clarify: [sec('ears')], verify: [sec('e2e-tests'), sec('a1')] });
    expect(r).toEqual({ ok: true, byGate: { clarify: [sec('ears')], verify: [sec('e2e-tests'), sec('a1')] } });
  });

  it('treats an absent block as no declarations, and drops an empty gate list', () => {
    expect(parseBriefSections(undefined)).toEqual({ ok: true, byGate: {} });
    expect(parseBriefSections({ plan: [] })).toEqual({ ok: true, byGate: {} });
  });

  it('maps the six gate reasons and no others', () => {
    expect(Object.values(BRIEF_SECTION_GATE_FOR_REASON).sort()).toEqual([...BRIEF_SECTION_GATES].sort());
    expect(BRIEF_SECTION_GATE_FOR_REASON['stale-patch-review']).toBeUndefined();
    expect(BRIEF_SECTION_GATE_FOR_REASON['revise-scope-review']).toBeUndefined();
  });

  const bad: Array<[string, unknown, RegExp]> = [
    ['an unknown gate', { build: [sec('x')] }, /unknown gate 'build'/],
    ['more than three sections', { plan: [sec('a'), sec('b'), sec('c'), sec('d')] }, /4 sections — at most 3/],
    ['a bad id', { plan: [sec('Bad_Id')] }, /id 'Bad_Id' must be/],
    ['an id over 40 characters', { plan: [sec('a'.repeat(41))] }, /must be/],
    ['a duplicate id', { plan: [sec('a'), sec('a')] }, /declares the id 'a' twice/],
    ['an over-long title', { plan: [sec('a', { title: 't'.repeat(81) })] }, /title longer than 80/],
    ['an over-long instruction', { plan: [sec('a', { instruction: 'i'.repeat(601) })] }, /instruction longer than 600/],
    ['a missing field', { plan: [{ id: 'a', title: 'T' }] }, /instruction/],
    ['an extra field', { plan: [sec('a', { owner: 'x' })] }, /unrecognised key\(s\) owner/],
    ['a non-list gate', { plan: 'nope' }, /must be a list/],
    ['a non-mapping block', ['clarify'], /must be a mapping/],
  ];
  it.each(bad)('refuses %s with a readable problem', (_label, raw, re) => {
    const r = parseBriefSections(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toMatch(re);
  });

  it('accepts exactly the limits', () => {
    const r = parseBriefSections({
      design: [sec('a'.repeat(40), { title: 't'.repeat(80), instruction: 'i'.repeat(600) }), sec('b'), sec('c')],
    });
    expect(r.ok).toBe(true);
  });
});

describe('loadProjectManifest with brief_sections', () => {
  function root(contents: string): string {
    const d = mkdtempSync(join(tmpdir(), 'b1305-manifest-'));
    dirs.push(d);
    mkdirSync(join(d, '.harmony'), { recursive: true });
    writeFileSync(join(d, '.harmony', 'project.yml'), contents, 'utf8');
    return d;
  }

  it('recognises the key (not an unknown top-level key)', () => {
    const r = loadProjectManifest(root(['version: 1', 'brief_sections:', '  clarify:', '    - id: ears', '      title: EARS', '      instruction: Restate.'].join('\n')));
    expect(r.kind).toBe('ok');
  });

  it('a file with a broken brief_sections still runs its build.before_pr steps', () => {
    const r = loadProjectManifest(
      root(
        [
          'version: 1',
          'build:',
          '  before_pr:',
          '    - run: npm test',
          'brief_sections:',
          '  nonsense-gate:',
          '    - id: BAD ID',
          '      colour: blue',
        ].join('\n'),
      ),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(resolveExtensionPoint(r, 'build.before_pr')).toEqual({ outcome: 'steps', steps: [{ run: 'npm test' }] });
    expect(parseBriefSections(r.manifest.brief_sections).ok).toBe(false);
  });
});
