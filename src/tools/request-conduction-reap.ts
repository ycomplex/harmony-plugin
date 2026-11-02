// B-740: `request_conduction_reap` — CLI/agent parity with the web Conductors view's "Reap now"
// button, for a hung active conduction with no recovery lever otherwise.
//
// Modeled on release-approval.ts (flag_release_approval_pending): this tool, exactly like the web
// mutation it mirrors, NEVER performs the kill itself. The daemon remains the SOLE process that
// reaps a worker. Both surfaces only ever set `conductions.reap_requested_at` to now() — a flag the
// daemon's own scheduler pass notices on a FRESH read of the row it already re-reads every pass for
// a tracked (in-flight) launch (handleHeldConduction, scheduler.ts), and acts on by invoking the
// SAME reap-escalation machinery the per-launch deadline already uses (beginReapEscalation) —
// classified afterward as `last_worker_exit_class: 'operator-reap'` (classify.ts), never a new write
// site or a new kill path.
//
// B-1243: paused launch-less runs now settle through conductor maintenance.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getConduction, updateConduction, type ConductionRecord } from './conduction-record.js';

export interface RequestConductionReapArgs {
  conduction_id: string;
}

export interface RequestConductionReapResult {
  conduction: ConductionRecord;
  message: string;
}

export async function requestConductionReap(
  client: SupabaseClient,
  args: RequestConductionReapArgs,
): Promise<RequestConductionReapResult> {
  if (!args.conduction_id) throw new Error('conduction_id is required');

  const existing = await getConduction(client, args.conduction_id);
  if (!existing) throw new Error(`Not found: no conduction with id ${args.conduction_id}`);

  if (existing.status === 'completed' || existing.status === 'cancelled' || existing.reap_requested_at) {
    return { conduction: existing, message: `Conduction ${existing.id}: already settled or reap already requested; no new request.` };
  }

  // Atomic signal after promotion; old boards retain their ordinary live-worker request path.
  const { data, error } = await client.rpc('request_conduction_cleanup', { p_id: args.conduction_id });
  const missing = error && ['42883', 'PGRST202'].includes(error.code ?? '') &&
    /request_conduction_cleanup/.test(error.message ?? '');
  if (error && !missing) throw error;
  const conduction = missing
    ? await updateConduction(client, args.conduction_id, { reap_requested_at: new Date().toISOString() })
    : data?.[0] as ConductionRecord | undefined;
  if (!conduction) throw new Error('Conduction not writable or no longer visible');

  return {
    conduction,
    message:
      `Reap requested for conduction ${conduction.id}. The conductor will notice on its ` +
      "next pass: stop tracked work through the existing sequence, or settle a paused run with no worker. " +
      'This call never kills the worker directly.',
  };
}

export const requestConductionReapTool = {
  name: 'request_conduction_reap',
  description:
    'Request conductor cleanup: reap a tracked worker or settle a paused run with no worker. ' +
    'This call only signals the conductor; it never kills workers or bypasses a live lease. ' +
    'Already completed/cancelled runs and repeated requests are no-ops.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      conduction_id: {
        type: 'string',
        description: 'The conduction record id (UUID) whose current leg should be reaped early.',
      },
    },
    required: ['conduction_id'],
  },
};
