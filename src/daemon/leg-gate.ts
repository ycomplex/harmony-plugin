// B-1073 — the fast-track leg-gate routing wrapper.
//
// `resolveGatePhase` (gate-phase.ts) is the shared, dependency-free `workflow_state -> gate`
// projection every existing caller (the daemon's own model-selection, `harmony model`,
// `harmony leg-cost`) already uses. This file does NOT modify it — gate-phase.ts is deliberately
// dependency-free (see its own header), and `resolveLegGate` below is a separate, NEWER wrapper
// that imports run-config.ts's types (the other direction: gate-phase.ts never imports from here).
//
// WHAT THIS ADDS: when a run's `run_config.fast_track` flag is set (a human-invoked
// `harmony conduct <ticket> --fast-track` run — see `skills/harmony-conduct/SKILL.md`'s fast-track
// paragraph) AND the ticket sits at `Captured`/`Proposed` (the clarify-gate approach — the same two
// states gate-phase.ts's own `GATE_BY_WORKFLOW_STATE` collapses onto 'clarify'), the leg routes
// straight to the **build** gate instead of clarify — skipping the discovery legs (decompose,
// design, plan) for a ticket whose work is already understood well enough to fast-track. Every
// OTHER state, and every non-fast-track run, delegates to `resolveGatePhase` unchanged — this
// wrapper changes NOTHING about today's routing except the one new branch.
//
// The hard floor is untouched by this ticket: release and verify are not represented in the
// Captured/Proposed branch above (`resolveGatePhase` already returns 'release'/'verify' only from
// `Built`/`Deployed`, never from `Captured`/`Proposed`), so a fast-track run still walks through the
// SAME always-human release/verify gates as any other run — this wrapper only ever shortens the
// discovery approach, never the floor.

import { resolveGatePhase, type Gate } from './gate-phase.js';
import { isFastTrackEnabled, type RunConfig } from '../config/run-config.js';
import {
  evaluateEligibility,
  admissibleForFastTrack,
  type EligibilityEvidenceLink,
  type EligibilityReport,
} from '../tools/record-eligibility.js';

/** B-1073: is THIS leg the fast-track branch's own skip-straight-to-build leg — i.e. the one
 *  `resolveLegGate` below routes to `'build'` early, before `resolveGatePhase` ever runs? Pulled out
 *  of `resolveLegGate` so the daemon's admission check (scheduler.ts's `fireLaunch`) can ask the
 *  EXACT same question `resolveLegGate` answers internally, without re-deriving (and risking
 *  drifting from) the Captured/Proposed + fast_track condition in two places. */
export function isFastTrackBuildLeg(
  runConfig: RunConfig,
  task: { workflow_state?: string | null },
): boolean {
  return (
    isFastTrackEnabled(runConfig) &&
    (task.workflow_state === 'Captured' || task.workflow_state === 'Proposed')
  );
}

/** B-1073: resolve the gate THIS leg is running, with the fast-track branch applied first. `task`
 *  takes the same minimal shape `resolveGatePhase` itself accepts (`workflow_state` +
 *  `workflow_activity`) — callers that already have a `DaemonTask`-shaped value (or `null`) can pass
 *  it (or `{}`) directly; this function never throws on a missing/null field. */
export function resolveLegGate(
  runConfig: RunConfig,
  task: { workflow_state?: string | null; workflow_activity?: string | null },
): Gate | null {
  if (isFastTrackBuildLeg(runConfig, task)) {
    return 'build';
  }
  return resolveGatePhase(task.workflow_state, task.workflow_activity);
}

/** B-1073 (post-review wiring) — the daemon's OWN admission check, run at the fire path
 *  (`scheduler.ts`'s `fireLaunch`) immediately before a fast-track build leg's worker ever launches.
 *  Builds ONE `{ repo }` evidence entry per declared repo (`declaredRepos` — the deployment's
 *  configured repo set, e.g. `deploymentConfig.repos` resolved to `owner/repo` strings; no `paths`,
 *  since nothing has been built yet at admission time) and runs it through the SAME
 *  `evaluateEligibility` / `admissibleForFastTrack` pair step 4/5 above already use — never a second,
 *  re-derived admission rule. Pure: no I/O, so the daemon test suite can exercise both branches
 *  (admissible/inadmissible) without touching a real Supabase client. */
export function evaluateFastTrackAdmission(
  summary: string,
  declaredRepos: readonly string[],
): { admissible: boolean; report: EligibilityReport } {
  const evidence: EligibilityEvidenceLink[] = declaredRepos.map((repo) => ({ url: '', repo }));
  const report = evaluateEligibility({ summary, evidence });
  const { admissible } = admissibleForFastTrack(report);
  return { admissible, report };
}
