// B-894: `list_conductions` — the missing agent-reachable conduction READ.
//
// `request_conduction_reap` (B-740) takes a `conduction_id`, but until this tool NO MCP tool ever
// returned one: `create_conduction` returns the id only for the run it just created, and every
// other conduction accessor is in-process daemon core (conduction-record.ts, barrel-only). An agent
// session that wanted to reap a hung run had no way to name it. This closes that: it makes
// `request_conduction_reap`'s `conduction_id` addressable from a session.
//
// A LEAN read, deliberately: it projects a fixed ten-field row (see CONDUCTION_SUMMARY_FIELDS) out
// of the full conduction record — the operator-legible triage fields (is it running? when did it
// last heartbeat? was a reap already requested? how did the last leg exit?) and nothing else. The
// lease/CAS internals (lease_holder, lease_acquired_at, clean_shutdown_at, leg_started_at),
// worker plumbing (worker_kind, last_worker_exit_code), current_pr_ref, run_config, created_by and
// the echoed task_id are all excluded on purpose — they are daemon mechanism, not a session's
// business, and a wide row would bury the id the caller actually came for.
//
// No new read path: this delegates to the shared-core `listConductions` primitive with its B-894
// `task_id` filter and `order: 'desc'`, then projects. The daemon's own call (no filter, default
// ascending) is untouched.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import { listConductions as listConductionRecords, type ConductionRecord } from './conduction-record.js';

export interface ListConductionsArgs {
  task_id: string;
}

/** The EXACT ten fields of a lean conduction row — no more, no fewer. A colocated test asserts the
 *  key set exactly, so both an accidental addition and an accidental removal fail loudly. */
export const CONDUCTION_SUMMARY_FIELDS = [
  'id',
  'status',
  'mode',
  'started_at',
  'last_heartbeat_at',
  'reap_requested_at',
  'last_worker_exit_class',
  'updated_at',
  'worker_ref',
  'retry_count',
] as const;

export interface ConductionSummary {
  /** The conduction record id — this is what `request_conduction_reap` takes. */
  id: string;
  status: string;
  mode: string;
  started_at: string;
  last_heartbeat_at: string | null;
  reap_requested_at: string | null;
  last_worker_exit_class: string | null;
  updated_at: string;
  worker_ref: string | null;
  retry_count: number;
}

export interface ListConductionsResult {
  conductions: ConductionSummary[];
}

const toSummary = (row: ConductionRecord): ConductionSummary => ({
  id: row.id,
  status: row.status,
  mode: row.mode,
  started_at: row.started_at,
  last_heartbeat_at: row.last_heartbeat_at,
  reap_requested_at: row.reap_requested_at,
  last_worker_exit_class: row.last_worker_exit_class,
  updated_at: row.updated_at,
  worker_ref: row.worker_ref,
  retry_count: row.retry_count,
});

export async function listConductions(
  client: SupabaseClient,
  projectId: string,
  args: ListConductionsArgs,
): Promise<ListConductionsResult> {
  if (!args.task_id) throw new Error('task_id is required');
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  // Newest first — a session triaging a run wants the current/most recent conduction at the top.
  const rows = await listConductionRecords(client, { task_id: taskId, order: 'desc' });
  // A ticket that was never conducted is an EMPTY LIST, never an error — "no conductions" is a
  // perfectly ordinary answer to this question, and making it throw would force every caller to
  // wrap the call in a try/catch to learn nothing.
  return { conductions: rows.map(toSummary) };
}

export const listConductionsTool = {
  name: 'list_conductions',
  description:
    "B-894: list one ticket's conduction records — the durable per-run rows the conductor daemon " +
    'drives — newest first. This is the ONLY way to obtain a `conduction_id`, so call it first ' +
    'whenever you need to pass one to `request_conduction_reap` (the early-reap request for a hung ' +
    "run). Use it to answer: is this ticket being conducted right now, and by which conduction? " +
    'When did the run last heartbeat (a long-stale `last_heartbeat_at` on an `active` row is the ' +
    'signature of a hung leg)? Has a reap already been requested (`reap_requested_at` non-null — ' +
    'do not request another)? How did the last leg exit (`last_worker_exit_class`) and how many ' +
    'retries has it taken (`retry_count`)? Returns a lean ten-field row per conduction (id, status, ' +
    'mode, started_at, last_heartbeat_at, reap_requested_at, last_worker_exit_class, updated_at, ' +
    'worker_ref, retry_count) — daemon lease/CAS internals are deliberately not exposed. A ticket ' +
    'that has never been conducted returns an empty list, not an error.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43).',
      },
    },
    required: ['task_id'],
  },
};
