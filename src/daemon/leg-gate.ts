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

/** B-1073: resolve the gate THIS leg is running, with the fast-track branch applied first. `task`
 *  takes the same minimal shape `resolveGatePhase` itself accepts (`workflow_state` +
 *  `workflow_activity`) — callers that already have a `DaemonTask`-shaped value (or `null`) can pass
 *  it (or `{}`) directly; this function never throws on a missing/null field. */
export function resolveLegGate(
  runConfig: RunConfig,
  task: { workflow_state?: string | null; workflow_activity?: string | null },
): Gate | null {
  if (
    isFastTrackEnabled(runConfig) &&
    (task.workflow_state === 'Captured' || task.workflow_state === 'Proposed')
  ) {
    return 'build';
  }
  return resolveGatePhase(task.workflow_state, task.workflow_activity);
}
