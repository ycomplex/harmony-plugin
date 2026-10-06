// B-1073 (post-review wiring) — the CONTRACT test for `checkPrePrOpenEligibility`
// (src/tools/record-eligibility.ts). Mirrors the house convention (see
// src/daemon/recorded-walk-drain-contract.test.ts): pins a function's behavior against
// representative cases so a FUTURE wiring-in of this function into a real build-gate call site has
// a concrete contract to build against, and so skill prose (skills/start-work/SKILL.md's O3
// sub-step 2a, skills/harmony-conduct/SKILL.md's fast-track paragraph) that names this function by
// name cannot silently drift from what it actually does.
//
// checkPrePrOpenEligibility has NO call site in this repository's own TypeScript today (see its own
// doc comment for the honest scoping) — this file is what makes "named in skill prose" and "does
// something real and tested" the same claim rather than two independently-drifting ones.

import { describe, it, expect } from 'vitest';
import { checkPrePrOpenEligibility } from './record-eligibility.js';

const SUMMARY = 'Fix the flaky retry timer in the poller.';

describe('checkPrePrOpenEligibility — contract (B-1073 post-review wiring)', () => {
  it('clean diff, clean summary: allowed, and the verdict carries all five items', () => {
    const { allowed, verdict } = checkPrePrOpenEligibility(SUMMARY, ['src/tools/poller.ts', 'src/tools/poller.test.ts']);
    expect(allowed).toBe(true);
    expect(verdict.items.map((i) => i.item)).toEqual([
      'multi_repo',
      'migration',
      'risk_class',
      'single_sentence_change',
      'verify_walk_attestation',
    ]);
    // Every item but verify_walk_attestation passes; that one is UNATTESTED (never auto-passed) and
    // does not block (admissibleForFastTrack's own carve-out) — see the dedicated test below.
    for (const item of verdict.items) {
      if (item.item === 'verify_walk_attestation') {
        expect(item.verdict).toBe('unattested');
      } else {
        expect(item.verdict).toBe('pass');
      }
    }
  });

  it('a migration-path diff: refused, migration item fails', () => {
    const { allowed, verdict } = checkPrePrOpenEligibility(SUMMARY, [
      'web/supabase/migrations/20260215_add_widget.sql',
    ]);
    expect(allowed).toBe(false);
    const migration = verdict.items.find((i) => i.item === 'migration')!;
    expect(migration.verdict).toBe('fail');
    expect(migration.value).toContain('migrations/20260215_add_widget.sql');
  });

  it('a gated-risk-class diff (shared-core path): refused, risk_class item fails', () => {
    const { allowed, verdict } = checkPrePrOpenEligibility(SUMMARY, ['src/supabase.ts']);
    expect(allowed).toBe(false);
    const riskClass = verdict.items.find((i) => i.item === 'risk_class')!;
    expect(riskClass.verdict).toBe('fail');
    expect(riskClass.value).toContain('shared-core');
  });

  it(
    'KNOWN LIMITATION, pinned deliberately: a multi-repo-SHAPED diff (paths under two different ' +
      "top-level dirs) does NOT fail the multi_repo item — re-check evidence carries no `repo` " +
      'attribution at all (reEvaluateEligibilityAgainstDiff builds ONE evidence entry with `paths` ' +
      'only, no `repo`), unlike the Check-phase PR-link evidence gatherEvidenceSignals resolves via ' +
      '`gh`. Multi-repo detection at the pre-PR-open re-check point is simply not implemented — ' +
      'pinned here so a future reader does not assume path-shape alone trips it.',
    () => {
      const { allowed, verdict } = checkPrePrOpenEligibility(SUMMARY, [
        'web/src/components/Widget.tsx',
        'plugin/src/tools/widget.ts',
      ]);
      expect(allowed).toBe(true);
      const multiRepo = verdict.items.find((i) => i.item === 'multi_repo')!;
      expect(multiRepo.verdict).toBe('pass');
      expect(multiRepo.value).toContain('repos: 0');
    },
  );

  it('an unattested verify-walk item alone never blocks — the same carve-out admissibleForFastTrack applies at admission time', () => {
    const { allowed, verdict } = checkPrePrOpenEligibility(SUMMARY, ['src/tools/poller.ts']);
    expect(verdict.items.find((i) => i.item === 'verify_walk_attestation')!.verdict).toBe('unattested');
    expect(allowed).toBe(true);
  });
});
