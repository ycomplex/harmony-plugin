// B-974 (B-936 Class C) — unit coverage for the ONE pure module both `compose_brief` and
// `get_build_evidence_status` resolve declared verify evidence through. Every test here runs the
// module as a pure function over synthetic inputs: no database, no brief, no gate.
//
// The fixture is the ticket's ratified two-entry shape, and it deliberately exercises BOTH
// `applies_to` matchers — `paths` AND `labels` — because those are exactly the two the clarification
// ratified, and a fixture covering one of them would leave the other unproven.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveManifestEvidence,
  parseAttestedKeys,
  readDeclaredEvidence,
  attestationHint,
  malformedEvidenceClause,
  malformedEvidenceWarning,
  MANIFEST_EVIDENCE_AC_PREFIX,
} from './manifest-evidence.js';
import type { EvidenceEntry } from './project-manifest.js';

const tempDirs: string[] = [];

function makeProjectRoot(manifest?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'b974-evidence-'));
  tempDirs.push(dir);
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harmony'), { recursive: true });
    writeFileSync(join(dir, '.harmony', 'project.yml'), manifest, 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** THE fixture: one un-narrowed entry, one narrowed by BOTH `paths` and `labels`. */
const TWO_ENTRY_FIXTURE = `version: 1
verify:
  evidence:
    - key: founder-clickthrough
      prompt: "Click through the deployed flow and confirm it does what the ticket says."
    - key: ui-screenshot
      prompt: "Attach a screenshot of the changed screen."
      applies_to:
        paths:
          - "src/components/**"
        labels:
          - ux
`;

const entries = (): EvidenceEntry[] => {
  const read = readDeclaredEvidence(makeProjectRoot(TWO_ENTRY_FIXTURE));
  if (read.kind !== 'entries') throw new Error(`fixture did not parse: ${JSON.stringify(read)}`);
  return read.entries;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('readDeclaredEvidence — the three floor cases and the fixture', () => {
  it('no manifest root supplied ⇒ { kind: "none" } — nothing is read, nothing is overlaid', () => {
    expect(readDeclaredEvidence(undefined)).toEqual({ kind: 'none' });
    expect(readDeclaredEvidence('')).toEqual({ kind: 'none' });
    expect(readDeclaredEvidence('   ')).toEqual({ kind: 'none' });
  });

  it('a root with NO manifest file ⇒ { kind: "none" }', () => {
    expect(readDeclaredEvidence(makeProjectRoot())).toEqual({ kind: 'none' });
  });

  it('a manifest declaring NO verify.evidence ⇒ { kind: "none" } (same floor as no manifest)', () => {
    const root = makeProjectRoot('version: 1\nverify:\n  before_ack:\n    - run: npm test\n');
    expect(readDeclaredEvidence(root)).toEqual({ kind: 'none' });
  });

  it('reads the two-entry fixture in MANIFEST ORDER, with both applies_to matchers intact', () => {
    const read = readDeclaredEvidence(makeProjectRoot(TWO_ENTRY_FIXTURE));
    expect(read.kind).toBe('entries');
    if (read.kind !== 'entries') return;
    expect(read.entries.map((e) => e.key)).toEqual(['founder-clickthrough', 'ui-screenshot']);
    expect(read.entries[1].applies_to).toEqual({ paths: ['src/components/**'], labels: ['ux'] });
    expect(read.file).toMatch(/\.harmony[\\/]project\.yml$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('resolveManifestEvidence — applicability (AC3)', () => {
  it('an UN-NARROWED entry applies to every ticket; a narrowed one only where it matches', () => {
    // A ticket the narrowed entry matches on NEITHER matcher.
    const miss = resolveManifestEvidence(entries(), { changedPaths: ['src/server/db.ts'], labels: ['backend'] });
    expect(miss.rows.map((r) => r.ac_id)).toEqual([`${MANIFEST_EVIDENCE_AC_PREFIX}founder-clickthrough`]);
    expect(miss.outstanding).toEqual(['founder-clickthrough']);
    // A clean, fully-evaluated non-match is SILENT — it is not named as "not evaluated".
    expect(miss.not_evaluated).toEqual([]);
    expect(miss.entries[1]).toEqual({
      key: 'ui-screenshot',
      prompt: 'Attach a screenshot of the changed screen.',
      state: 'not-applicable',
      not_applicable_reason: 'no-match',
    });
  });

  it('the PATHS matcher alone brings the narrowed entry in', () => {
    const hit = resolveManifestEvidence(entries(), {
      changedPaths: ['src/components/Sidebar.tsx'],
      labels: ['backend'],
    });
    expect(hit.outstanding).toEqual(['founder-clickthrough', 'ui-screenshot']);
    expect(hit.rows).toHaveLength(2);
  });

  it('the LABELS matcher alone brings the narrowed entry in — case-insensitively', () => {
    const hit = resolveManifestEvidence(entries(), { changedPaths: ['src/server/db.ts'], labels: ['UX'] });
    expect(hit.outstanding).toEqual(['founder-clickthrough', 'ui-screenshot']);
  });

  it('labels match WHOLE names, never prefixes — `ux-debt` does not satisfy `ux`', () => {
    const miss = resolveManifestEvidence(entries(), { changedPaths: [], labels: ['ux-debt'] });
    expect(miss.outstanding).toEqual(['founder-clickthrough']);
  });

  it('an explicitly EMPTY diff ([]) is a clean non-match, not an unevaluable one', () => {
    const r = resolveManifestEvidence(entries(), { changedPaths: [], labels: [] });
    expect(r.not_evaluated).toEqual([]);
    expect(r.entries[1].not_applicable_reason).toBe('no-match');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('resolveManifestEvidence — the unevaluable paths case is SKIPPED BUT NAMED', () => {
  it('no diff at all ⇒ the path-narrowed entry renders no row, is not counted, and IS named', () => {
    const r = resolveManifestEvidence(entries(), { labels: [] }); // changedPaths deliberately omitted
    expect(r.rows.map((row) => row.ac_id)).toEqual([`${MANIFEST_EVIDENCE_AC_PREFIX}founder-clickthrough`]);
    expect(r.outstanding).toEqual(['founder-clickthrough']);
    expect(r.not_evaluated).toEqual(['ui-screenshot']);
    expect(r.entries[1].not_applicable_reason).toBe('unevaluable-paths');
    expect(r.clause).toContain('1 path-narrowed entry not evaluated — no diff available: ui-screenshot');
  });

  it('a LABEL hit wins even with no diff — the entry applies and is never reported unevaluated', () => {
    const r = resolveManifestEvidence(entries(), { labels: ['ux'] });
    expect(r.outstanding).toEqual(['founder-clickthrough', 'ui-screenshot']);
    expect(r.not_evaluated).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('resolveManifestEvidence — rows, dispositions and the evidence clause (AC1/AC2)', () => {
  it('an unattested entry becomes a manifest-declared row carrying the exact string to type', () => {
    const r = resolveManifestEvidence(entries(), { changedPaths: ['README.md'] });
    expect(r.rows[0]).toEqual({
      ac_id: 'manifest:founder-clickthrough',
      text: 'Click through the deployed flow and confirm it does what the ticket says.',
      checked: false,
      disposition: 'manifest-declared',
      backed_by: attestationHint('founder-clickthrough'),
    });
    expect(r.rows[0].backed_by).toBe(
      'type ATTESTED: founder-clickthrough in the accept remark box or resolve_brief detail',
    );
    expect(r.clause).toBe('Declared evidence — 1 outstanding: founder-clickthrough');
  });

  it('an attested entry becomes a manifest-attested row and leaves the outstanding set (AC4)', () => {
    const r = resolveManifestEvidence(entries(), {
      changedPaths: ['src/components/Sidebar.tsx'],
      attestedKeys: ['founder-clickthrough'],
    });
    expect(r.attested).toEqual(['founder-clickthrough']);
    expect(r.outstanding).toEqual(['ui-screenshot']);
    expect(r.rows[0]).toMatchObject({ disposition: 'manifest-attested', checked: true, backed_by: 'ATTESTED: founder-clickthrough' });
    expect(r.rows[1]).toMatchObject({ disposition: 'manifest-declared', checked: false });
    expect(r.clause).toBe('Declared evidence — 1 outstanding: ui-screenshot · 1 attested: founder-clickthrough');
  });

  it('an ATTESTED key naming no declared entry is REPORTED on the clause, never silently dropped', () => {
    const r = resolveManifestEvidence(entries(), { changedPaths: [], attestedKeys: ['typo-key'] });
    expect(r.unknown_attested_keys).toEqual(['typo-key']);
    expect(r.clause).toContain('⚠️ ATTESTED: names no declared entry: typo-key — nothing was attested by it');
  });

  it('no declared entries at all ⇒ no rows and a NULL clause (the caller then changes nothing)', () => {
    const r = resolveManifestEvidence([], { changedPaths: ['x.ts'] });
    expect(r.rows).toEqual([]);
    expect(r.clause).toBeNull();
  });

  it('every declared entry cleanly not applying ⇒ no rows and a NULL clause', () => {
    const narrowedOnly: EvidenceEntry[] = [
      { key: 'only-ui', prompt: 'p', applies_to: { paths: ['src/components/**'] } },
    ];
    const r = resolveManifestEvidence(narrowedOnly, { changedPaths: ['src/server/db.ts'] });
    expect(r.rows).toEqual([]);
    expect(r.clause).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('parseAttestedKeys — the attestation marker, as a pure function over lineage rows (AC4)', () => {
  it('parses a single key off a bare marker line', () => {
    expect(parseAttestedKeys(['ATTESTED: founder-clickthrough'])).toEqual(['founder-clickthrough']);
  });

  it('parses a comma-separated list and trims every key', () => {
    expect(parseAttestedKeys(['ATTESTED: a ,  b,c'])).toEqual(['a', 'b', 'c']);
  });

  it('finds the marker on ANY line of a longer human remark, case-insensitively', () => {
    const detail = 'Looks good — clicked through on staging.\n  attested: founder-clickthrough\nShipping it.';
    expect(parseAttestedKeys([detail])).toEqual(['founder-clickthrough']);
  });

  it('collects across MULTIPLE lineage rows and de-duplicates, preserving first-seen order', () => {
    expect(
      parseAttestedKeys(['ATTESTED: b', null, undefined, 'ATTESTED: a\nATTESTED: b', '']),
    ).toEqual(['b', 'a']);
  });

  it('ignores text that merely mentions the word, with no marker line', () => {
    expect(parseAttestedKeys(['the founder attested this verbally', 'nothing here'])).toEqual([]);
  });

  it('never throws on non-string lineage values', () => {
    expect(parseAttestedKeys([null, undefined])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the MALFORMED manifest path — loud, and never a refusal', () => {
  it('a duplicate evidence key is malformed, and the clause names the file and the problem', () => {
    const root = makeProjectRoot(`version: 1
verify:
  evidence:
    - key: dup
      prompt: "first"
    - key: dup
      prompt: "second"
`);
    const read = readDeclaredEvidence(root);
    expect(read.kind).toBe('malformed');
    if (read.kind !== 'malformed') return;
    expect(read.problem.reason).toBe('duplicate-evidence-key');
    const clause = malformedEvidenceClause(read.problem);
    expect(clause).toContain('⚠️ Declared verify evidence NOT read (duplicate-evidence-key)');
    expect(clause).toContain('project.yml');
    expect(clause).toContain('dup');
    expect(malformedEvidenceWarning(read.problem)).toContain('No declared-evidence rows were overlaid');
  });

  it('an evidence entry missing its `prompt` is malformed (invalid-shape), not silently dropped', () => {
    const read = readDeclaredEvidence(makeProjectRoot('version: 1\nverify:\n  evidence:\n    - key: k\n'));
    expect(read.kind).toBe('malformed');
    if (read.kind !== 'malformed') return;
    expect(read.problem.reason).toBe('invalid-shape');
  });

  it('an unrecognized key inside an evidence entry is malformed — the .strict() posture holds', () => {
    const read = readDeclaredEvidence(
      makeProjectRoot('version: 1\nverify:\n  evidence:\n    - key: k\n      prompt: p\n      applies_two: x\n'),
    );
    expect(read.kind).toBe('malformed');
  });

  it('an unrecognized key inside applies_to is malformed — a `path:` typo cannot narrow to nothing', () => {
    const read = readDeclaredEvidence(
      makeProjectRoot('version: 1\nverify:\n  evidence:\n    - key: k\n      prompt: p\n      applies_to:\n        path:\n          - "x/**"\n'),
    );
    expect(read.kind).toBe('malformed');
  });
});
