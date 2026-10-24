// B-1274: an unpark keeps the previous run's settings.
//
// `create_conduction({ unpark: true })` and `harmony conduct --unpark` used to build the new
// conduction's run_config only from the caller's own arguments plus the project defaults, so the
// parked run's adapter, model, auto_approve_gates, release_delegate, fast_track and note were dropped
// and the relaunched leg ran controlled on the default model. The web's Resume already seeds its run
// options from the previous conduction; this is the same behaviour for the bare command.
//
// Read-only: the helper runs BEFORE the revive, so the ticket is still Parked when it reads and a
// bad merged config can still fail fast without leaving a ticket unparked and conduction-less.

import type { SupabaseClient } from '@supabase/supabase-js';
import { listConductions } from './conduction-record.js';
import { RunConfigSchema, type RunConfig } from '../config/run-config.js';

/** The passthrough run_config key naming the conduction this one inherited its settings from. */
export const INHERITED_FROM_KEY = 'inherited_from';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `override` over `base`: plain objects merge key by key, everything else (scalars,
 *  arrays — so a caller can drop a gate by passing a shorter list) is replaced. `undefined` in the
 *  override never clobbers the base. */
export function mergeRunConfig(base: RunConfig, override: RunConfig | undefined): RunConfig {
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...a };
    for (const [key, value] of Object.entries(b)) {
      if (value === undefined) continue;
      out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key] as Record<string, unknown>, value) : value;
    }
    return out;
  };
  return RunConfigSchema.parse(merge(base as Record<string, unknown>, (override ?? {}) as Record<string, unknown>));
}

/** For an explicit unpark of a Parked ticket, the run_config the new conduction should carry: the
 *  ticket's newest conduction's run_config with the caller's `explicit` one merged over it and
 *  `inherited_from` stamped. Returns `explicit` untouched when this is not an unpark of a Parked
 *  ticket, or when the ticket has no previous conduction with a run_config to inherit. */
export async function resolveUnparkRunConfig(
  client: SupabaseClient,
  taskId: string,
  args: { unpark?: boolean; explicit?: RunConfig },
): Promise<RunConfig | undefined> {
  if (!args.unpark) return args.explicit;
  const { data, error } = await client.from('tasks').select('workflow_state').eq('id', taskId).single();
  if (error) throw new Error(error.message);
  if ((data as { workflow_state: string | null } | null)?.workflow_state !== 'Parked') return args.explicit;

  const [previous] = await listConductions(client, { task_id: taskId, order: 'desc' });
  if (!previous) return args.explicit;

  // The previous row's own inherited_from names ITS source, not this one's: drop it before merging.
  const { [INHERITED_FROM_KEY]: _dropped, ...inherited } = (previous.run_config ?? {}) as Record<string, unknown>;
  void _dropped;
  const merged = mergeRunConfig(RunConfigSchema.parse(inherited), args.explicit);
  return { ...merged, [INHERITED_FROM_KEY]: previous.id };
}
