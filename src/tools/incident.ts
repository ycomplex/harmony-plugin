// B-1452: raise an incident — the ONE command a worker leg runs when it discovers it has exposed a
// credential outside the worker (pushed, posted or sent it where it can be read).
//
// Shared core for the MCP tool `raise_incident` and the CLI `harmony incident raise`. It files a
// dedicated elicitation round (trigger 'incident') on the ticket:
//   - the round sets awaiting_human_input (reason 'elicitation-round'), so the conductor already treats
//     the ticket as a clean pause and launches nothing;
//   - `awaiting_human_ref.incident = 'credential-exposure'` rides in the SAME task write as the flag, so
//     `harmony watch` reports it first as an `incident` event and the queue lists it first;
//   - a human releases it by answering the round: "resume" or "stop" (harmony-conduct step 1a).
//
// Every caller-supplied text is scrubbed of token shapes (src/tools/token-shapes.ts) BEFORE anything is
// written or returned. Scrubbing never makes the raise fail.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import { addComment } from './comments.js';
import {
  concludeElicitation,
  fileElicitationRound,
  startElicitation,
  INCIDENT_KIND_CREDENTIAL_EXPOSURE,
  INCIDENT_TRIGGER,
} from './elicitation.js';
import { scrubTokenShapes } from './token-shapes.js';
import { resolveGatePhase } from '../daemon/gate-phase.js';

export const INCIDENT_KINDS = [INCIDENT_KIND_CREDENTIAL_EXPOSURE] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** The question id the release round always uses (the resume handling keys on it). */
export const INCIDENT_RELEASE_QUESTION_ID = 'release';

export interface RaiseIncidentArgs {
  task_id: string;
  kind: string;
  what: string;
  where: string;
  human_steps: string;
}

export interface RaiseIncidentResult {
  task_id: string;
  kind: IncidentKind;
  exchange_id: string;
  round: number;
  /** The exchange this incident concluded 'abandoned' to take precedence, if one was active. */
  superseded_exchange_id: string | null;
  /** A live model-handoff wait was cleared so the conductor cannot relaunch past the incident. */
  cleared_model_handoff: boolean;
  /** The scrubbed text, exactly as written. */
  what: string;
  where: string;
  human_steps: string;
  /** True when scrubbing changed any of the three texts. */
  scrubbed: boolean;
  comment_id: string | null;
  /** Set when the round landed but the INCIDENT-RAISED comment did not (the round is what matters). */
  comment_error?: string;
}

/** Gate activity names, keyed by the gate `resolveGatePhase` derives from workflow_state. */
const GATE_ACTIVITY: Record<string, string> = {
  clarify: 'clarifying',
  decompose: 'decomposing',
  design: 'designing',
  plan: 'planning',
  build: 'building',
  release: 'releasing',
  verify: 'verifying',
};

export function incidentGateFor(workflowState: string | null | undefined): string | null {
  const gate = resolveGatePhase(workflowState ?? null);
  return gate ? (GATE_ACTIVITY[gate] ?? null) : null;
}

/** Apply the write-layer newline fix addComment applies, then scrub — so the text written is a fixed
 *  point (no later transform can re-join a split token). Never throws. */
function clean(s: unknown): string {
  try {
    const text = typeof s === 'string' ? s.replace(/\\n/g, '\n').trim() : '';
    return scrubTokenShapes(text);
  } catch {
    return '[redacted]';
  }
}

export function incidentContextLine(what: string, where: string): string {
  return `Incident — credential exposure: ${what} was exposed at ${where.replace(/[.\s]+$/, '')}.`;
}

export function incidentReleaseQuestion(humanSteps: string) {
  return {
    id: INCIDENT_RELEASE_QUESTION_ID,
    stakes: 'load-bearing' as const,
    kind: 'open' as const,
    text:
      `Only a human can do this: ${humanSteps.replace(/[.\s]+$/, '')}. When it is done, answer "resume" to let the ` +
      'ticket continue, or "stop" to park it with this incident as the reason.',
  };
}

interface ActiveExchangeLite {
  id: string;
  trigger: string | null;
  rounds: unknown;
}

async function readActiveExchange(client: SupabaseClient, taskId: string): Promise<ActiveExchangeLite | null> {
  const { data, error } = await client
    .from('elicitation_exchanges')
    .select('id, trigger, rounds')
    .eq('task_id', taskId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ActiveExchangeLite | null) ?? null;
}

export async function raiseIncident(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: RaiseIncidentArgs,
): Promise<RaiseIncidentResult> {
  if (!args || !args.task_id) throw new Error('task_id is required');
  if (args.kind !== INCIDENT_KIND_CREDENTIAL_EXPOSURE) {
    // Name the refused kind (scrubbed: it is caller text too) and the one accepted kind.
    throw new Error(
      `incident kind '${clean(args.kind)}' is not accepted — the only incident kind is '${INCIDENT_KIND_CREDENTIAL_EXPOSURE}'. Nothing was written.`,
    );
  }

  // Scrub FIRST: nothing below ever sees the raw text.
  const what = clean(args.what);
  const where = clean(args.where);
  const humanSteps = clean(args.human_steps);
  const missing = [
    ['what', what],
    ['where', where],
    ['human_steps', humanSteps],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required (never the secret itself). Nothing was written.`);
  }
  const scrubbed =
    what !== String(args.what ?? '').replace(/\\n/g, '\n').trim() ||
    where !== String(args.where ?? '').replace(/\\n/g, '\n').trim() ||
    humanSteps !== String(args.human_steps ?? '').replace(/\\n/g, '\n').trim();

  const taskId = await resolveTaskId(client, projectId, args.task_id);

  // Best-effort read: the gate label and any live model-handoff wait. A failed read only loses the
  // label (gate null) — it never stops the raise.
  let workflowState: string | null = null;
  let fieldValues: Record<string, unknown> | null = null;
  try {
    const { data } = await client.from('tasks').select('id, workflow_state, field_values').eq('id', taskId).maybeSingle();
    const row = data as { workflow_state?: string | null; field_values?: Record<string, unknown> | null } | null;
    workflowState = row?.workflow_state ?? null;
    fieldValues = row?.field_values ?? null;
  } catch {
    // keep nulls
  }

  // The incident takes precedence over any other open exchange on the ticket.
  let supersededExchangeId: string | null = null;
  let active = await readActiveExchange(client, taskId);
  if (active && active.trigger !== INCIDENT_TRIGGER) {
    await concludeElicitation(client, projectId, { exchange_id: active.id, outcome: 'abandoned' });
    supersededExchangeId = active.id;
    active = null;
  }
  let exchangeId: string;
  if (active) {
    exchangeId = active.id;
  } else {
    const gate = incidentGateFor(workflowState);
    const opened = (await startElicitation(client, projectId, userId, {
      task_id: taskId,
      trigger: INCIDENT_TRIGGER,
      ...(gate ? { gate } : {}),
    })) as { id: string; trigger?: string };
    if (opened.trigger !== undefined && opened.trigger !== INCIDENT_TRIGGER) {
      // A different exchange became active between the read and the open (a race): never file the
      // incident round onto it.
      throw new Error(
        `another elicitation exchange (${opened.id}) became active on this ticket while the incident was being raised — raise it again. The incident round was not filed.`,
      );
    }
    exchangeId = opened.id;
  }

  const filed = (await fileElicitationRound(
    client,
    projectId,
    {
      exchange_id: exchangeId,
      context_line: incidentContextLine(what, where),
      questions: [incidentReleaseQuestion(humanSteps)],
    },
    { refExtra: { incident: INCIDENT_KIND_CREDENTIAL_EXPOSURE } },
  )) as { noop?: boolean; rounds?: Array<{ n: number }> };
  if (filed && filed.noop === true) {
    throw new Error(
      `the incident exchange ${exchangeId} was cancelled before the round landed — raise the incident again. The incident round was not filed.`,
    );
  }
  const rounds = Array.isArray(filed?.rounds) ? filed.rounds : [];
  const round = rounds.length > 0 ? rounds[rounds.length - 1].n : 1;

  // A live model-handoff wait is the one waiting_on kind the conductor relaunches on WITHOUT checking
  // whose ball it is (scheduler.ts: a model-handoff wakes 'agent-ball'). Clear it so nothing launches
  // past the open incident; the resumed leg re-requests any model switch it still needs (conduct 1d).
  let clearedModelHandoff = false;
  const waitingOn = fieldValues?.waiting_on as { kind?: unknown } | null | undefined;
  if (waitingOn && waitingOn.kind === 'model-handoff') {
    try {
      const { error } = await client
        .from('tasks')
        .update({ field_values: { ...fieldValues, waiting_on: null } })
        .eq('id', taskId);
      clearedModelHandoff = !error;
    } catch {
      clearedModelHandoff = false;
    }
  }

  const lines = [
    `INCIDENT-RAISED kind=${INCIDENT_KIND_CREDENTIAL_EXPOSURE} exchange_id=${exchangeId}`,
    '',
    `What was exposed: ${what}`,
    `Where: ${where}`,
    `Only a human can do this: ${humanSteps}`,
    '',
    'The leg stopped and made no further change. Answer the incident round "resume" to let the ticket continue, or "stop" to park it with this incident as the reason.',
  ];
  if (supersededExchangeId) {
    lines.push(
      '',
      `The incident takes precedence: the open elicitation exchange ${supersededExchangeId} was concluded 'abandoned'.`,
    );
  }
  let commentId: string | null = null;
  let commentError: string | undefined;
  try {
    const comment = (await addComment(client, projectId, userId, { task_id: taskId, content: lines.join('\n') })) as { id?: string } | null;
    commentId = comment?.id ?? null;
  } catch (err) {
    commentError = scrubTokenShapes(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
  }

  return {
    task_id: taskId,
    kind: INCIDENT_KIND_CREDENTIAL_EXPOSURE,
    exchange_id: exchangeId,
    round,
    superseded_exchange_id: supersededExchangeId,
    cleared_model_handoff: clearedModelHandoff,
    what,
    where,
    human_steps: humanSteps,
    scrubbed,
    comment_id: commentId,
    ...(commentError !== undefined ? { comment_error: commentError } : {}),
  };
}

/** True when the exchange's latest round carries at least one answer. */
function latestRoundAnswered(rounds: unknown): boolean {
  if (!Array.isArray(rounds) || rounds.length === 0) return false;
  const last = rounds[rounds.length - 1] as { answers?: Record<string, unknown> } | null;
  return !!last && !!last.answers && typeof last.answers === 'object' && Object.keys(last.answers).length > 0;
}

export class IncidentOpenError extends Error {}

/**
 * B-1452 launch-path guard: refuse a new conduction while the ticket has an UNANSWERED incident round.
 * Fails open on a read error or an older schema (a missing table must never block create_conduction);
 * throws only on a positive finding.
 */
export async function assertNoOpenIncident(client: SupabaseClient, taskId: string, label: string = taskId): Promise<void> {
  let active: ActiveExchangeLite | null;
  try {
    active = await readActiveExchange(client, taskId);
  } catch {
    return;
  }
  if (!active || active.trigger !== INCIDENT_TRIGGER || latestRoundAnswered(active.rounds)) return;
  throw new IncidentOpenError(
    `${label} has an open incident (credential exposure) waiting on a human — answer its incident round ` +
      `first ("resume" to continue, or "stop" to park). No conduction was created.`,
  );
}

export const raiseIncidentTool = {
  name: 'raise_incident',
  description:
    'Raise an incident on a ticket (B-1452). Use ONLY when you discovered that you exposed a credential outside the worker — pushed, posted or sent it somewhere it can be read. ' +
    "Files one incident question round (trigger 'incident'): the ticket pauses for a human (awaiting_human_input, reason 'elicitation-round', awaiting_human_ref.incident = 'credential-exposure'), the conductor launches nothing, and the seat's watch and the queue show it first. " +
    'An open exchange of any other trigger is concluded \'abandoned\' — the incident takes precedence. Posts an INCIDENT-RAISED comment. ' +
    'NEVER put the secret in any argument: describe it (e.g. "the GitHub token of the build app"), never quote it. Token-shaped text is scrubbed to [redacted] before anything is written, and a run of 32+ letters/digits is scrubbed too, so name a commit by a short SHA. ' +
    'After calling it, make NO further change (no commit, push, revert or cleanup) and END YOUR TURN — the open round is the clean pause. A human releases it by answering "resume" or "stop".',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The ticket the leg is working — UUID, task number, or visual ID (e.g., B-43).' },
      kind: { type: 'string', enum: [...INCIDENT_KINDS], description: "The incident kind. Only 'credential-exposure' exists." },
      what: { type: 'string', description: 'What was exposed, described — never the value (e.g. "a GitHub installation token").' },
      where: { type: 'string', description: 'Where it was exposed (e.g. "commit 1a2b3c4 on branch feat/x of org/repo", "a comment on PR #12").' },
      human_steps: {
        type: 'string',
        description: 'Exactly what only a human can do (e.g. "revoke and rotate the token, then rewrite the branch history to drop commit 1a2b3c4").',
      },
    },
    required: ['task_id', 'kind', 'what', 'where', 'human_steps'],
  },
};
