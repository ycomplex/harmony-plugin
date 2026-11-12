import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import { assertKnownArguments } from './known-arguments.js';

// ===========================================================================
// B-1410 — settle an unticked acceptance criterion at the verify gate.
//
// At the verify gate of a build-carrying ticket each UNTICKED criterion is settled by one of three
// actions, each applied on its own and never inside the verify accept:
//   - mark satisfied — the existing tick through manage_acceptance_criteria (not this module);
//   - CARRY — move it to an open ticket in the same project (an existing one, or one minted here),
//     leaving a trace on the source ticket;
//   - DROP — remove it with a required reason, leaving a trace.
//
// The database owns every rule (`settle_acceptance_criterion`, harmony-web): the last remaining
// criterion can never be carried or dropped, a ticked one cannot be settled, the destination must be
// an open ticket in the same project. This module maps arguments, resolves ticket ids, and turns the
// function's refusal into a structured answer a caller can relay.
//
// TOLERANCE: staging workers run this plugin code against the PROD board before the web migration is
// promoted, so an absent function must degrade, not crash. Absent = SQLSTATE 42883 (undefined
// function) or PostgREST's PGRST202 ("could not find the function in the schema cache"), which is how
// supabase-js reports a function PostgREST has never seen (same pair as knowledge-search.ts). Every
// other error propagates.
//
// The settlement table (`acceptance_criterion_settlements`) is never selected directly: settled rows
// are read only through `task_verify_readiness`.
// ===========================================================================

export const SETTLE_UNAVAILABLE_MESSAGE = 'carry and drop are not available on this environment yet';
export const READINESS_UNAVAILABLE_MESSAGE = 'verify readiness is not available on this environment yet';

/** The refusal codes `settle_acceptance_criterion` raises (`settle refused: <code>: <sentence>`). */
export const SETTLE_REFUSAL_CODES = [
  'criterion-not-found',
  'criterion-ticked',
  'last-criterion',
  'invalid-action',
  'destination-required',
  'destination-is-source',
  'destination-other-project',
  'destination-not-open',
  'reason-required',
  'invalid-milestone',
] as const;

export interface SettleRpcResult {
  settlement_id: string;
  action: 'carried' | 'dropped';
  source_task_id: string;
  destination_task_id: string | null;
  destination_minted: boolean;
  destination_criterion_id: string | null;
  already_settled: boolean;
}

export type SettleResult =
  | ({ status: 'settled' } & SettleRpcResult)
  | { status: 'refused'; code: string; message: string }
  | { status: 'unavailable'; message: string };

export interface VerifyReadinessSettledRow {
  criterion_id: string;
  criterion_text: string;
  action: 'carried' | 'dropped';
  destination_task_id: string | null;
  destination_visual_id: string | null;
  destination_minted: boolean | null;
  milestone_landing: string | null;
  landing_reason: string | null;
  drop_reason: string | null;
  settled_by: string | null;
  settled_at: string | null;
}

export interface VerifyReadiness {
  build_carrying: boolean;
  is_exempt: boolean;
  exempt_reason: string | null;
  has_test_cases: boolean;
  criteria_count: number;
  unchecked: Array<{ id: string; content: string }>;
  settled: VerifyReadinessSettledRow[];
  blocked: boolean;
  missing: string[];
}

export type VerifyReadinessResult =
  | ({ status: 'ok' } & VerifyReadiness)
  | { status: 'unavailable'; message: string };

/** The function is absent on this database (pre-migration). */
export function isMissingFunction(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42883' || code === 'PGRST202';
}

const REFUSAL_RE = /settle refused:\s*([a-z][a-z-]*):\s*([\s\S]*)$/;

/** Parse `settle refused: <code>: <sentence>` out of a raised error's message, or null. */
export function parseSettleRefusal(error: unknown): { code: string; message: string } | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  const match = REFUSAL_RE.exec(message);
  if (!match) return null;
  return { code: match[1], message: match[2].trim() };
}

export const settleAcceptanceCriterionTool = {
  name: 'settle_acceptance_criterion',
  description:
    "B-1410 — settle ONE unticked acceptance criterion at the verify gate, applied immediately and on its own (never inside the verify accept). action 'carry' moves the criterion to an open ticket in the same project — an existing one (`destination_task_id`) or one minted here (`mint`: { title, milestone: 'source' | 'none', landing_reason }) — and leaves a trace on this ticket; action 'drop' removes it with a required `drop_reason` and leaves a trace. To mark a criterion satisfied, tick it with manage_acceptance_criteria instead. The database refuses a ticked criterion, the last remaining criterion, a destination that is this ticket, another project's ticket or a closed ticket, and a missing reason; a refusal returns { status: 'refused', code, message } (relay the message), success returns { status: 'settled', settlement_id, action, source_task_id, destination_task_id, destination_minted, destination_criterion_id, already_settled }. On a database that predates the function it returns { status: 'unavailable', message } — say so and offer a tick or reopening the build instead.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description:
          'Optional context: the ticket the criterion is on (UUID, task number, or visual ID like B-43). When given, a criterion that is not on this ticket is refused before anything is written.',
      },
      criterion_id: { type: 'string', description: 'The acceptance criterion UUID to settle.' },
      action: { type: 'string', enum: ['carry', 'drop'], description: "'carry' or 'drop'." },
      destination_task_id: {
        type: 'string',
        description:
          "carry only: an existing open ticket in this project to carry the criterion to (UUID, task number, or visual ID like B-12). Omit when minting with `mint`.",
      },
      mint: {
        type: 'object',
        description: 'carry only: mint a new ticket to carry the criterion to, instead of naming an existing one.',
        properties: {
          title: { type: 'string', description: 'Title of the new ticket.' },
          milestone: {
            type: 'string',
            enum: ['source', 'none'],
            description:
              "'source' lands it in this ticket's milestone (the original title would be false without the criterion); 'none' leaves it unscheduled.",
          },
          landing_reason: { type: 'string', description: 'Why it lands where it does.' },
        },
        required: ['title', 'milestone'],
      },
      drop_reason: { type: 'string', description: 'drop only: why the criterion is dropped. Required.' },
    },
    required: ['criterion_id', 'action'],
  },
};

export interface SettleArgs {
  task_id?: string;
  criterion_id: string;
  action: string;
  destination_task_id?: string;
  mint?: { title?: string; milestone?: string; landing_reason?: string };
  drop_reason?: string;
}

export async function settleAcceptanceCriterion(
  client: SupabaseClient,
  projectId: string,
  args: SettleArgs,
): Promise<SettleResult> {
  assertKnownArguments(settleAcceptanceCriterionTool, args);
  if (args.mint !== undefined && args.mint !== null && typeof args.mint === 'object') {
    const allowed = Object.keys(settleAcceptanceCriterionTool.inputSchema.properties.mint.properties);
    const unknown = Object.keys(args.mint).filter((k) => !allowed.includes(k));
    if (unknown.length) {
      throw new Error(
        `settle_acceptance_criterion does not accept: ${unknown.map((k) => `mint.${k}`).join(', ')}. ` +
          `mint accepts: ${allowed.join(', ')}.`,
      );
    }
  }

  if (args.action !== 'carry' && args.action !== 'drop') {
    return {
      status: 'refused',
      code: 'invalid-action',
      message: `action must be 'carry' or 'drop', not '${String(args.action)}'.`,
    };
  }
  if (args.action === 'carry' && args.destination_task_id && args.mint) {
    return {
      status: 'refused',
      code: 'destination-required',
      message: 'Carry to an existing ticket or mint a new one, not both.',
    };
  }

  if (args.task_id) {
    const sourceId = await resolveTaskId(client, projectId, args.task_id);
    const { data, error } = await client
      .from('acceptance_criteria')
      .select('id')
      .eq('id', args.criterion_id)
      .eq('task_id', sourceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return {
        status: 'refused',
        code: 'criterion-not-found',
        message: `Criterion ${args.criterion_id} is not an acceptance criterion of ${args.task_id}.`,
      };
    }
  }

  const destination =
    args.action === 'carry' && args.destination_task_id
      ? await resolveTaskId(client, projectId, args.destination_task_id)
      : null;

  const params = {
    p_criterion_id: args.criterion_id,
    p_action: args.action,
    p_destination_task_id: destination,
    p_mint_title: args.action === 'carry' ? (args.mint?.title ?? null) : null,
    p_mint_milestone: args.action === 'carry' ? (args.mint?.milestone ?? null) : null,
    p_landing_reason: args.action === 'carry' ? (args.mint?.landing_reason ?? null) : null,
    p_drop_reason: args.action === 'drop' ? (args.drop_reason ?? null) : null,
  };

  const { data, error } = await client.rpc('settle_acceptance_criterion', params);
  if (error) {
    if (isMissingFunction(error)) return { status: 'unavailable', message: SETTLE_UNAVAILABLE_MESSAGE };
    const refusal = parseSettleRefusal(error);
    if (refusal) return { status: 'refused', ...refusal };
    throw error;
  }
  return { status: 'settled', ...(data as SettleRpcResult) };
}

export const getVerifyReadinessTool = {
  name: 'get_verify_readiness',
  description:
    "B-1410 — read-only. Whether a ticket can cross Deployed → Verified, from the database's own `task_verify_readiness`: build_carrying, is_exempt / exempt_reason (umbrella, decision-only), has_test_cases, criteria_count, `unchecked` [{ id, content }] (each one must be ticked, carried or dropped before the verify accept), `settled` [{ criterion_text, action: 'carried' | 'dropped', destination_visual_id, destination_minted, milestone_landing, landing_reason, drop_reason, settled_by, settled_at, … }] (render these on the verify frame's `settled`), `blocked` and `missing`. Returns { status: 'ok', … }; on a database that predates the function, { status: 'unavailable', message }.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
    },
    required: ['task_id'],
  },
};

export async function getVerifyReadiness(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string },
): Promise<VerifyReadinessResult> {
  assertKnownArguments(getVerifyReadinessTool, args);
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  const { data, error } = await client.rpc('task_verify_readiness', { p_task_id: taskId });
  if (error) {
    if (isMissingFunction(error)) return { status: 'unavailable', message: READINESS_UNAVAILABLE_MESSAGE };
    throw error;
  }
  return { status: 'ok', ...(data as VerifyReadiness) };
}
