// B-925: a project remembers how you like to run things — conduction defaults set once in
// settings (`projects.conduction_defaults jsonb`, harmony-web's own migration; the settings UI is
// the separate web-side half). This module is the PLUGIN-side fill: the two conduction-CREATION
// entry points (create_conduction MCP tool, and `harmony conduct` CLI) each resolve this project's
// stored defaults and fill in whichever `run_config` field the caller left absent, field-by-field,
// BEFORE the conduction row is ever written. Nothing here changes how a `RunConfig` is READ once it
// exists on a conduction row (src/config/run-config.ts's accessors are untouched) — the fill happens
// exactly once, at creation time, one level up from those accessors.
//
// Tolerant, like every other B-383 prod-before-promote reader in this codebase (see
// conduction-record.ts's isMissingLastLegEndedAtColumn / briefs.ts's isMissingBriefHistorySubstrate):
// plugin `staging` code runs against the `prod` board until the next `./promote-prod.sh` promotes
// the web-side migration, so a SELECT of `projects.conduction_defaults` on a board that hasn't run
// that migration yet must degrade to "no defaults" rather than break every conduction creation.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutoApproveGate, RunConfig } from './run-config.js';

/** Mirrors harmony-web's `projects.conduction_defaults` shape exactly — a plain string model alias,
 *  never `{ default, per_gate }`: a per-gate model as a project DEFAULT is this ticket's own named
 *  non-goal (only a per-RUN `run_config.model.per_gate` override exists, and it is untouched here). */
export interface ConductionDefaults {
  model?: string;
  session_resume?: { enabled: boolean };
  auto_approve_gates?: string[];
}

/** "This DB does not have the `projects.conduction_defaults` column (yet)". Same idiom as
 *  conduction-record.ts's `isMissingLastLegEndedAtColumn` / briefs.ts's
 *  `isMissingBriefHistorySubstrate`: 42703 = undefined_column, 42P01 = undefined_table,
 *  PGRST204/PGRST205 = PostgREST "column/table not found in schema cache". It NEVER matches a
 *  permission error, a transient network failure, or any other error class — those must propagate,
 *  never be silently read as "substrate absent". */
export const isMissingConductionDefaultsColumn = (
  err: { code?: string; message?: string } | null | undefined,
): boolean => {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === '42703' || code === '42P01' || code === 'PGRST204' || code === 'PGRST205') return true;
  const msg = err.message ?? '';
  if (/conduction_defaults/.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg)) {
    return true;
  }
  return false;
};

/** This project's stored conduction defaults, or `{}` when the column doesn't exist yet on this
 *  board (logs exactly one warning line — the same B-383 degrade-and-log convention
 *  fetchModelCatalog (run-config.ts) uses for the sibling `model_catalog` table-absent case). A
 *  DELIBERATELY narrow, SEPARATE select — never folded into project.ts's PROJECT_COLS, which is a
 *  hard `if (error) throw error` read at every gate boundary of every conductor leg (get_project);
 *  adding this column there would throw on every such call on a pre-migration board. Any OTHER
 *  error (permission, network) propagates — never silently swallowed. */
export async function getProjectConductionDefaults(
  client: SupabaseClient,
  projectId: string,
): Promise<ConductionDefaults> {
  const { data, error } = await client
    .from('projects')
    .select('conduction_defaults')
    .eq('id', projectId)
    .single();
  if (error) {
    if (isMissingConductionDefaultsColumn(error as { code?: string; message?: string })) {
      console.warn(
        'harmony conduction_defaults: WARNING — the projects.conduction_defaults column is absent ' +
          '(pre-promote — B-383) — degrading to no project conduction defaults for this run.',
      );
      return {};
    }
    throw new Error(error.message);
  }
  const row = data as { conduction_defaults?: ConductionDefaults | null } | null;
  return row?.conduction_defaults ?? {};
}

/** The shared field-by-field merge: for EACH of the three `ConductionDefaults` fields
 *  independently, an explicitly-present caller key (checked via `in` on the KEY, never truthiness
 *  on the value — an explicit `session_resume: { enabled: false }` or an explicit
 *  `auto_approve_gates: []` is a deliberate operator choice and must NEVER be overridden by a
 *  project default, per this ticket's ratified product decision) wins; an ABSENT caller key
 *  inherits the project default when one exists. `model` fills into
 *  `merged.model = { ...callerRunConfig?.model, default: defaults.model }` — never touching
 *  `per_gate` (a project-level per-gate model default is out of scope for this ticket).
 *
 *  Returns the caller's OWN `run_config` value, completely unchanged (same reference), whenever no
 *  field was actually filled — this is what keeps the "absence, not an empty object" convention
 *  true by construction (mirrors the web's own `buildRunConfig`): an `undefined` caller value with
 *  no applicable defaults stays `undefined`, never becomes `{}`, and a caller-supplied `{}` (or any
 *  other already-complete value) is returned byte-for-byte identical when nothing needed filling. */
export function fillRunConfigDefaults(
  callerRunConfig: RunConfig | undefined,
  defaults: ConductionDefaults,
): RunConfig | undefined {
  const merged: RunConfig = { ...callerRunConfig };
  let changed = false;

  if (!('model' in merged) && defaults.model !== undefined) {
    merged.model = { ...callerRunConfig?.model, default: defaults.model };
    changed = true;
  }
  if (!('session_resume' in merged) && defaults.session_resume !== undefined) {
    merged.session_resume = defaults.session_resume;
    changed = true;
  }
  if (!('auto_approve_gates' in merged) && defaults.auto_approve_gates !== undefined) {
    // Cast: ConductionDefaults.auto_approve_gates is a plain string[] (mirroring the web's
    // own untyped-at-rest jsonb column), while RunConfig.auto_approve_gates is the narrower
    // AutoApproveGate[] zod-inferred type. This value is NOT re-validated through
    // RunConfigSchema before use (see this function's own callers), so an unrecognized gate
    // name here is passed through unchanged rather than rejected — the same forward-compat
    // posture RunConfigSchema.passthrough() already takes for other axes.
    merged.auto_approve_gates = [...defaults.auto_approve_gates] as AutoApproveGate[];
    changed = true;
  }

  return changed ? merged : callerRunConfig;
}
