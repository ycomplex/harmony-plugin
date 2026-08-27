// B-772: the shared workflow_state -> gate projection.
//
// The daemon needs to know WHICH GATE a leg is running as of the moment it fires (to resolve a
// per-gate model override — see src/config/run-config.ts's getModelForGate), independent of the
// gate-owning skill's own routing. `skills/harmony-shared/gate-routing.md`'s canonical gate table
// is the source of truth this file MIRRORS in code (never hand-copied elsewhere — B-526 drift
// hazard) — a NEW gate row added there must be reflected here too.
//
// Deliberately lives here (src/daemon/), NOT in src/config/, even though src/config/run-config.ts's
// getModelForGate accepts a `Gate` value: a design remark proposed moving `Gate` into src/config/ to
// avoid src/config/ importing from src/daemon/, but that remark was explicitly NOT ratified — the
// accepted design keeps `Gate` + `resolveGatePhase` together here. B-773: run-config.ts now imports the
// `GATES` runtime array from this file too (not just the `Gate` TYPE) — zod needs a runtime value to
// build its `auto_approve_gates` enum from, a type alone erases at compile time. This is a genuine
// runtime import from src/config/ to src/daemon/, and that is intentional and accepted: gate-phase.ts
// has zero dependencies of its own, so importing its tiny const array pulls in nothing else — no bundle
// contamination results.

/** The seven forward-path gates a conducted ticket walks, in order. Mirrors the `gate` column of
 *  `skills/harmony-shared/gate-routing.md`'s canonical table exactly (release/verify are the two
 *  hard-floor, always-human gates; the other five may be delegated under harmony-conduct's
 *  --unattended/--escalate/--pause-at modes — irrelevant to gate IDENTITY, which is all this type
 *  captures). A runtime array, not just a type: B-773's `auto_approve_gates` schema (see
 *  src/config/run-config.ts) needs a real value to build a zod enum from, so this list is the ONE
 *  runtime source both `Gate` (`typeof GATES[number]`) and that schema derive from — never redeclare
 *  the gate set as an independent literal elsewhere. */
export const GATES = ['clarify', 'decompose', 'design', 'plan', 'build', 'release', 'verify'] as const;

/** The `Gate` type, derived from `GATES` (never hand-declared as its own literal union — see GATES'
 *  own doc comment). */
export type Gate = (typeof GATES)[number];

/** `workflow_state -> gate` — mirrors gate-routing.md's table's `from workflow_state` column.
 *  `Captured` is included alongside `Proposed` even though gate-routing.md's table itself only
 *  lists `Proposed`: `Captured` is a brief-less plumbing pre-state that auto-advances to `Proposed`
 *  (`harmony-conduct`'s own `Captured` -> `proposing` auto-advance, see gate-routing.md's own
 *  `Captured -> proposing` row) — a leg observed AT `Captured` is, for gate-selection purposes,
 *  already on the clarify gate's approach. Every state absent from this map (the three terminal
 *  states `Verified`/`Parked`/`Cancelled`, plus any state this map simply doesn't recognize) reads
 *  as "no gate" — see resolveGatePhase's `?? null` fallback below. */
const GATE_BY_WORKFLOW_STATE: Record<string, Gate> = {
  Captured: 'clarify',
  Proposed: 'clarify',
  Clarified: 'decompose',
  Decomposed: 'design',
  Designed: 'plan',
  Planned: 'build',
  Built: 'release',
  Deployed: 'verify',
};

/** Resolve the gate a leg is running, from the ticket's `workflow_state` (+ `workflow_activity`,
 *  accepted for forward-compatibility and because the daemon already has it on hand at every call
 *  site — see src/daemon/scheduler.ts's `templateVars`). `workflow_activity` does NOT currently
 *  discriminate the result: every `workflow_state` in `GATE_BY_WORKFLOW_STATE` maps to exactly ONE
 *  gate regardless of activity — most notably `Decomposed`, whose `designing` activity covers all
 *  THREE design sub-tracks (product/technical/ux-ui — see `skills/harmony-design-decide/SKILL.md`),
 *  which this function deliberately collapses onto the single `'design'` gate key (a per-gate model
 *  override is a per-GATE choice, not a per-sub-track one — B-772's accepted design is explicit
 *  about this collapse). Returns `null` for the three terminal states (`Verified`/`Parked`/
 *  `Cancelled`), for a null/undefined/absent `workflow_state` (a task read that hasn't loaded meta
 *  yet), and for any state this map doesn't recognize (never throws — this is a best-effort
 *  projection feeding a model-selection FALLBACK chain, not a hard requirement). */
export function resolveGatePhase(
  workflow_state?: string | null,
  workflow_activity?: string | null,
): Gate | null {
  void workflow_activity; // see the doc comment above — accepted, not (yet) discriminating.
  if (!workflow_state) return null;
  return GATE_BY_WORKFLOW_STATE[workflow_state] ?? null;
}
