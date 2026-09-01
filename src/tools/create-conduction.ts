// B-758: `create_conduction` — the MCP-surface trigger onto the SAME createConduction primitive
// already exposed to the daemon (in-process) and the CLI's `harmony conduct` command (B-696). This
// is the THIRD trigger, letting a terminal session (or, via the shared handler, the web UI) hand a
// ticket to the conductor daemon from ANY stage (Proposed through Deployed) — not just Proposed.
//
// No new write path: this file resolves the task id, runs the B-758 excluded-ticket guard
// (assertNotExcluded — a ticket a human took away from the conductor via the web's "Take away from
// conductor" action must refuse a handoff here too, checked BEFORE the duplicate-conduction guard),
// then calls createConduction({ mode: 'controlled' }) verbatim — exactly what conduct.ts does.
//
// All three typed refusals (ConductorExcludedError, ActiveConductionExistsError and — B-894 —
// ConductionInsertDeniedError) are caught here and turned into a clean message that names its cause
// — never a raw error, never a raw postgres 23505 or 42501 — mirroring the CLI's refusal rendering.
//
// B-894 also threads the acting `userId` into the insert as `created_by`: the `conductions` INSERT
// policy is `created_by = auth.uid()`, so a dispatch that drops it is refused by RLS at runtime.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import {
  createConduction as insertConduction,
  assertNotExcluded,
  ActiveConductionExistsError,
  ConductionInsertDeniedError,
  ConductorExcludedError,
  type ConductionRecord,
} from './conduction-record.js';
import { RunConfigSchema, type RunConfig } from '../config/run-config.js';

export interface CreateConductionArgs {
  task_id: string;
  /** B-743: the per-run operator choices seam (e.g. `{ note: '...' }`) — an optional structured
   *  object validated against RunConfigSchema before it ever reaches the insert (see
   *  createConduction below). Omitted entirely -> the DB column's own default applies, unchanged
   *  from every pre-B-743 handoff. */
  run_config?: RunConfig;
}

export interface CreateConductionResult {
  conduction: ConductionRecord;
  message: string;
}

// The B-758 operator-contract sentence — NON-OPTIONAL, must appear verbatim (in substance) in both
// this tool's success response and the CLI's (conduct.ts): the duplicate-guard can only ever see an
// ACTIVE CONDUCTION ROW, never an in-progress terminal session, so a session handing a ticket off
// must itself confirm the coast is clear first.
const HANDOFF_CONTRACT_NOTE =
  "the duplicate-guard can only detect an active conduction record — it can't see an in-progress " +
  'terminal session, so make sure any in-session work on this ticket has stopped before handing it off.';

export async function createConduction(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: CreateConductionArgs,
): Promise<CreateConductionResult> {
  if (!args.task_id) throw new Error('task_id is required');
  // B-743: validate run_config BEFORE the task-id resolution round-trip — a malformed payload is a
  // caller bug that should fail fast, not after an otherwise-wasted network call.
  const runConfig =
    args.run_config !== undefined ? RunConfigSchema.parse(args.run_config) : undefined;
  const taskId = await resolveTaskId(client, projectId, args.task_id);

  try {
    await assertNotExcluded(client, taskId);
    const conduction = await insertConduction(client, {
      task_id: taskId,
      mode: 'controlled',
      // B-894: the `conductions` INSERT policy is `created_by = auth.uid()`, so the acting user's
      // id is NOT optional bookkeeping — omitting it is an RLS refusal at runtime. The web and the
      // CLI both send it; this dispatch used to drop it, which is the defect B-894 closes. userId
      // is threaded in from handleToolCall exactly as ~19 sibling write tools already do.
      created_by: userId,
      ...(runConfig !== undefined ? { run_config: runConfig } : {}),
    });
    return {
      conduction,
      message:
        `Conduction ${conduction.id} created for ${args.task_id} (${conduction.status}, mode: ` +
        `${conduction.mode}). The conductor daemon will pick it up on its next pass. Note: ${HANDOFF_CONTRACT_NOTE}`,
    };
  } catch (err) {
    if (err instanceof ConductorExcludedError) {
      throw new Error(
        `${args.task_id} is taken away from the conductor — Return it first (the "Return to ` +
          `conductor" action) before handing it off`,
        { cause: err },
      );
    }
    if (err instanceof ActiveConductionExistsError) {
      throw new Error(
        `${args.task_id} is already being conducted — a ticket has at most one active conduction; ` +
          `park or complete the existing run first`,
        { cause: err },
      );
    }
    // B-894: an RLS refusal of the insert is a THIRD documented refusal, rendered in the same clean
    // style and NAMING ITS CAUSE — this ticket exists because such a denial surfaced as a raw
    // database error that was "not among" the refusals this tool documents.
    if (err instanceof ConductionInsertDeniedError) {
      throw new Error(
        `${args.task_id} could not be handed off — the conductions INSERT policy refused the ` +
          `record because it requires created_by = auth.uid(); this session's user id did not ` +
          `reach the insert, so re-authenticate (or report this — the tool must send created_by)`,
        { cause: err },
      );
    }
    throw err;
  }
}

export const createConductionTool = {
  name: 'create_conduction',
  description:
    'B-758: hand a ticket to the conductor daemon from ANY stage (Proposed through Deployed) — not just Proposed. Creates the durable conduction record (status \'active\', mode \'controlled\'); the conductor daemon notices it on its next pass and drives the run. Refuses cleanly (never a raw error) when the ticket is already being conducted (at most one active conduction per ticket) or when a human has explicitly taken this ticket away from the conductor (the web\'s "Take away from conductor" action) — in that case, Return it to the conductor first. Refuses cleanly, naming the cause, when the database\'s row-level security policy rejects the record (that policy requires the acting user\'s id on the insert). IMPORTANT: the duplicate-guard can only detect an active conduction record — it cannot see an in-progress terminal session, so confirm any in-session work on this ticket has stopped before handing it off.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43).',
      },
      run_config: {
        type: 'object',
        description:
          "B-743: optional per-run operator choices for this conduction (e.g. { \"note\": \"...\" } — " +
          'a free-text steering note delivered to the worker and posted back as a scoped ticket ' +
          'comment at each new gate). Omit entirely for the default run behavior.',
      },
    },
    required: ['task_id'],
  },
};
