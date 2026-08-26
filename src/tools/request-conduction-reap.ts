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
// A request against a conduction the daemon is NOT currently tracking (already settled, parked,
// completed, or never actually running) is harmless: the write lands, but nothing ever reads
// `reap_requested_at` for a row with no tracked in-flight launch, so it is simply inert.

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

  const conduction = await updateConduction(client, args.conduction_id, {
    reap_requested_at: new Date().toISOString(),
  });

  return {
    conduction,
    message:
      `Reap requested for conduction ${conduction.id}. The conductor daemon will notice on its ` +
      "next pass (only while a launch is genuinely tracked and unsettled) and escalate the SAME " +
      'reap sequence its own per-launch deadline uses — this call never kills the worker directly.',
  };
}

export const requestConductionReapTool = {
  name: 'request_conduction_reap',
  description:
    "B-740: request an early reap of a hung active conduction's currently-running leg — CLI/agent " +
    "parity with the web Conductors view's \"Reap now\" button. Sets `conductions.reap_requested_at` " +
    'to now(); this tool NEVER performs the kill itself — the conductor daemon remains the sole ' +
    'process that reaps a worker, and only notices/acts on this flag while it is actively tracking ' +
    "an in-flight launch for the conduction (a request against an already-settled/parked/completed " +
    "conduction is harmless but inert). The eventual park is recorded as " +
    "`last_worker_exit_class: 'operator-reap'`.",
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
