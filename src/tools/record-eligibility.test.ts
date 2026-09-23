import { describe, it, expect } from 'vitest';
import {
  evaluateEligibility,
  gatherOneEvidenceLink,
  gatherEvidenceSignals,
  type EligibilityEvidenceLink,
} from './record-eligibility.js';

const CLEAN_SUMMARY = 'Fix the flaky retry timer in the poller.';

function ev(overrides: Partial<EligibilityEvidenceLink> = {}): EligibilityEvidenceLink {
  return { url: 'https://github.com/ycomplex/harmony-plugin/pull/1', repo: 'ycomplex/harmony-plugin', paths: [], ...overrides };
}

describe('evaluateEligibility (B-1062)', () => {
  it('reports all five items, in order, each pass on a clean input with an attestation', () => {
    const report = evaluateEligibility({
      summary: CLEAN_SUMMARY,
      evidence: [ev()],
      attestWalk: 'walked the poller locally for 8 minutes, confirmed the retry timer no longer flakes',
    });
    expect(report.items.map((i) => i.item)).toEqual([
      'multi_repo', 'migration', 'risk_class', 'single_sentence_change', 'verify_walk_attestation',
    ]);
    expect(report.items.every((i) => i.verdict === 'pass')).toBe(true);
    expect(report.eligible).toBe(true);
    // Every item names the value it read from.
    for (const item of report.items) expect(item.value.length).toBeGreaterThan(0);
  });

  // ——— tier behavior: a ticket failing / passing / leaving-unattested each item ———————————————————

  it('multi-repo: fails when evidence spans more than one repo', () => {
    const report = evaluateEligibility({
      summary: CLEAN_SUMMARY,
      evidence: [ev({ repo: 'ycomplex/harmony-plugin' }), ev({ repo: 'ycomplex/harmony-web', url: 'https://github.com/ycomplex/harmony-web/pull/2' })],
      attestWalk: 'walked it',
    });
    const item = report.items.find((i) => i.item === 'multi_repo')!;
    expect(item.verdict).toBe('fail');
    expect(item.value).toContain('repos: 2');
    expect(report.eligible).toBe(false);
  });

  it('multi-repo: passes on a single repo, and an evidence link with no derivable repo does not count', () => {
    const report = evaluateEligibility({
      summary: CLEAN_SUMMARY,
      evidence: [ev({ repo: 'ycomplex/harmony-plugin' }), { url: 'https://example.com/some-doc' }],
      attestWalk: 'walked it',
    });
    const item = report.items.find((i) => i.item === 'multi_repo')!;
    expect(item.verdict).toBe('pass');
    expect(item.value).toContain('repos: 1');
  });

  it('migration: fails when evidence touches a migration path', () => {
    const report = evaluateEligibility({
      summary: CLEAN_SUMMARY,
      evidence: [ev({ paths: ['web/supabase/migrations/20260101000000_add_column.sql'] })],
      attestWalk: 'walked it',
    });
    const item = report.items.find((i) => i.item === 'migration')!;
    expect(item.verdict).toBe('fail');
    expect(item.value).toContain('migration paths: 1');
    expect(report.eligible).toBe(false);
  });

  it('migration: passes when no evidence path matches a migration glob', () => {
    const report = evaluateEligibility({
      summary: CLEAN_SUMMARY,
      evidence: [ev({ paths: ['src/tools/foo.ts'] })],
      attestWalk: 'walked it',
    });
    expect(report.items.find((i) => i.item === 'migration')!.verdict).toBe('pass');
  });

  it('risk class: fails on an auth-shaped summary', () => {
    const report = evaluateEligibility({
      summary: 'Add a new OAuth login flow for the admin console.',
      evidence: [ev()],
      attestWalk: 'walked it',
    });
    const item = report.items.find((i) => i.item === 'risk_class')!;
    expect(item.verdict).toBe('fail');
    expect(item.detail).toContain('auth');
  });

  it('risk class: data-migration alone does NOT trip this item (item (b) covers migration separately)', () => {
    const report = evaluateEligibility({
      summary: 'Backfill the legacy migration records for reporting.',
      evidence: [ev()],
      attestWalk: 'walked it',
    });
    const item = report.items.find((i) => i.item === 'risk_class')!;
    // data-migration may appear in risk_classes, but is not one of the three GATED classes here.
    expect(item.verdict).toBe('pass');
  });

  it('single-sentence: fails on a multi-sentence summary', () => {
    const report = evaluateEligibility({
      summary: 'Fixed the poller. It was flaky before.',
      evidence: [ev()],
      attestWalk: 'walked it',
    });
    expect(report.items.find((i) => i.item === 'single_sentence_change')!.verdict).toBe('fail');
  });

  it('single-sentence: fails on an over-long summary', () => {
    const longSummary = 'Fix ' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '.';
    const report = evaluateEligibility({ summary: longSummary, evidence: [ev()], attestWalk: 'walked it' });
    expect(report.items.find((i) => i.item === 'single_sentence_change')!.verdict).toBe('fail');
  });

  it('single-sentence: passes on a clean one-sentence summary', () => {
    const report = evaluateEligibility({ summary: CLEAN_SUMMARY, evidence: [ev()], attestWalk: 'walked it' });
    expect(report.items.find((i) => i.item === 'single_sentence_change')!.verdict).toBe('pass');
  });

  // ——— unattested-refuses: verify-walk is NEVER auto-passed, and never 'fail' either ———————————————

  it('verify-walk attestation: UNATTESTED (never fail, never pass) when no --attest-walk is given', () => {
    const report = evaluateEligibility({ summary: CLEAN_SUMMARY, evidence: [ev()] });
    const item = report.items.find((i) => i.item === 'verify_walk_attestation')!;
    expect(item.verdict).toBe('unattested');
    expect(item.value).toContain('UNATTESTED');
    expect(report.eligible).toBe(false);
  });

  it('verify-walk attestation: blank/whitespace-only --attest-walk also reads as unattested', () => {
    const report = evaluateEligibility({ summary: CLEAN_SUMMARY, evidence: [ev()], attestWalk: '   ' });
    expect(report.items.find((i) => i.item === 'verify_walk_attestation')!.verdict).toBe('unattested');
  });

  it('verify-walk attestation: pass when a non-blank attestation is supplied', () => {
    const report = evaluateEligibility({ summary: CLEAN_SUMMARY, evidence: [ev()], attestWalk: 'walked the happy path for 6 minutes' });
    expect(report.items.find((i) => i.item === 'verify_walk_attestation')!.verdict).toBe('pass');
  });

  it('eligible is false when ANY item fails or is unattested, even if the rest pass', () => {
    const report = evaluateEligibility({ summary: CLEAN_SUMMARY, evidence: [ev()] }); // no attestation
    expect(report.items.filter((i) => i.verdict === 'pass').length).toBe(4);
    expect(report.eligible).toBe(false);
  });
});

describe('gatherOneEvidenceLink / gatherEvidenceSignals (B-1062)', () => {
  it('parses a GitHub PR URL and calls gh pr diff for changed paths', async () => {
    const calls: string[][] = [];
    const fakeGh = async (args: string[]) => {
      calls.push(args);
      return 'src/tools/foo.ts\nsrc/tools/foo.test.ts\n';
    };
    const link = await gatherOneEvidenceLink('https://github.com/ycomplex/harmony-plugin/pull/42', fakeGh);
    expect(link.repo).toBe('ycomplex/harmony-plugin');
    expect(link.paths).toEqual(['src/tools/foo.ts', 'src/tools/foo.test.ts']);
    expect(calls[0]).toEqual(['pr', 'diff', 'https://github.com/ycomplex/harmony-plugin/pull/42', '--name-only']);
  });

  it('degrades to url-only for a non-PR URL, without calling gh', async () => {
    let called = false;
    const fakeGh = async () => { called = true; return ''; };
    const link = await gatherOneEvidenceLink('https://example.com/some-doc', fakeGh);
    expect(link).toEqual({ url: 'https://example.com/some-doc' });
    expect(called).toBe(false);
  });

  it('degrades to repo-known/paths-unknown when gh itself fails', async () => {
    const fakeGh = async () => { throw new Error('gh: not authenticated'); };
    const link = await gatherOneEvidenceLink('https://github.com/ycomplex/harmony-plugin/pull/42', fakeGh);
    expect(link).toEqual({ url: 'https://github.com/ycomplex/harmony-plugin/pull/42', repo: 'ycomplex/harmony-plugin' });
  });

  it('gatherEvidenceSignals gathers every link in order', async () => {
    const fakeGh = async () => 'a.ts\n';
    const links = await gatherEvidenceSignals([
      'https://github.com/ycomplex/harmony-plugin/pull/1',
      'https://github.com/ycomplex/harmony-web/pull/2',
    ], fakeGh);
    expect(links.map((l) => l.repo)).toEqual(['ycomplex/harmony-plugin', 'ycomplex/harmony-web']);
  });
});
