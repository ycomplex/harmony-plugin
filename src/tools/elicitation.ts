// B-645 Phase 2: the elicitation exchange tools (elicitation-first discovery, B-550).
//
// Four tools over the `elicitation_exchanges` substrate (harmony-web Phase-1 migration
// 20260702142754_b645_elicitation_exchange_substrate.sql):
//   start_elicitation      — open (or return) the one active exchange for a task
//   file_elicitation_round — lint + append a round, hand the ball to the human
//   get_elicitation        — read the active (or most recent) exchange
//   conclude_elicitation   — close the exchange (converged | force-quit | abandoned)
//
// Division of labour (technical commitment 370c1c10 §3): the web is mechanical-only — it captures
// answers into `rounds[].answers`, stamps `answers_submitted_at` / `force_quit_requested_at`, and
// clears the task's awaiting flag; the AGENT decides the next question and convergence. These tools
// are the agent's write surface. The behavioural contract the calling skills follow is
// skills/harmony-shared/elicitation-engine.md; the pure lints live in src/elicitation/engine.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import {
  validateRound,
  nextRoundNumber,
  currentRoundNumber,
  appendRound,
  echoPriorAnswers,
  MAX_QUESTIONS_PER_ROUND,
  type ElicitationAnswer,
  type ElicitationQuestion,
  type ElicitationRound,
} from '../elicitation/engine.js';

const EXCHANGE_COLS =
  'id, task_id, trigger, gate, brief_id, status, rounds, answers_submitted_at, force_quit_requested_at, created_by, created_at, updated_at';

// The DB column is free text (documented values); the plugin validates the known triggers at
// point-of-use so a typo'd trigger fails loudly here rather than silently minting a novel kind.
// A new trigger class ships with the skill that uses it, so extending this list is a plugin change.
const VALID_TRIGGERS = ['pre-draft-clarify', 'discuss', 'phase-split-probe'];

const VALID_OUTCOMES = ['converged', 'force-quit', 'abandoned'];

interface ExchangeRow {
  id: string;
  task_id: string;
  gate: string | null;
  brief_id: string | null;
  status: string;
  rounds: ElicitationRound[];
  answers_submitted_at: string | null;
  force_quit_requested_at: string | null;
  [key: string]: unknown;
}

/** B-461: the typed no-op both write tools return when a mechanical cancel landed first — the exchange
 *  is 'abandoned'. Never a silent success, never a generic throw: the CALLER must see the cancel (and
 *  archive any claims it minted in that same turn — the mint→conclude window can race a cancel). */
export interface ExchangeCancelledNoop {
  noop: true;
  cause: 'exchange-cancelled';
  exchange: ExchangeRow;
}

/** B-461: mirrors briefs.ts's guarded-fallback matcher — `pending_resolution` is added by harmony-web's
 *  Phase-1 migration, so on an older DB the column is absent and the clear is a faithful no-op. */
const isMissingPendingResolutionColumn = (msg: string | undefined): boolean =>
  !!msg && /pending_resolution/.test(msg) && /(does not exist|could not find|schema cache|column)/i.test(msg);

/** Look up the (unique — partial unique index) active exchange for a task, or null. Throws on error. */
async function findActiveExchange(client: SupabaseClient, taskId: string): Promise<ExchangeRow | null> {
  const { data, error } = await client
    .from('elicitation_exchanges')
    .select(EXCHANGE_COLS)
    .eq('task_id', taskId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as ExchangeRow) ?? null;
}

/** Resolve the target exchange from exchange_id OR task_id (task_id ⇒ the active exchange). */
async function resolveExchange(
  client: SupabaseClient,
  projectId: string,
  args: { exchange_id?: string; task_id?: string },
): Promise<ExchangeRow> {
  if (args.exchange_id) {
    const { data, error } = await client
      .from('elicitation_exchanges')
      .select(EXCHANGE_COLS)
      .eq('id', args.exchange_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`elicitation exchange ${args.exchange_id} not found`);
    return data as unknown as ExchangeRow;
  }
  if (!args.task_id) throw new Error('either exchange_id or task_id is required');
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  const active = await findActiveExchange(client, taskId);
  if (!active) throw new Error(`no active elicitation exchange for task ${args.task_id}`);
  return active;
}

// ---------------------------------------------------------------------------
// start_elicitation
// ---------------------------------------------------------------------------

export interface StartElicitationArgs {
  task_id: string;
  trigger: string;
  gate?: string;
  brief_id?: string;
}

export async function startElicitation(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: StartElicitationArgs,
): Promise<unknown> {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.trigger || !VALID_TRIGGERS.includes(args.trigger)) {
    throw new Error(`trigger must be one of: ${VALID_TRIGGERS.join(', ')}`);
  }
  const taskId = await resolveTaskId(client, projectId, args.task_id);

  // Idempotent-on-active: the partial unique index allows ONE active exchange per task, so if one
  // exists, return it rather than erroring — a re-entering skill resumes the exchange it left.
  const existing = await findActiveExchange(client, taskId);
  if (existing) return existing;

  const { data, error } = await client
    .from('elicitation_exchanges')
    .insert({
      task_id: taskId,
      trigger: args.trigger,
      gate: args.gate ?? null,
      brief_id: args.brief_id ?? null,
      created_by: userId,
    })
    .select(EXCHANGE_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export const startElicitationTool = {
  name: 'start_elicitation',
  description:
    "Open an elicitation exchange for a task (elicitation-first discovery, B-550) — the round-based question/answer record a gate skill interrogates the human's intent through BEFORE drafting. Idempotent-on-active: at most one active exchange exists per task, and calling this when one exists RETURNS it (resume, not error). Elicit only when intent is opaque relative to the knowledge base — always try KB inference first and interrogate the residual; see skills/harmony-shared/elicitation-engine.md for the behavioural contract.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The task the exchange belongs to — UUID, task number, or visual ID (e.g., B-43)' },
      trigger: { type: 'string', description: "What started the exchange: 'pre-draft-clarify' (questions before a clarification draft exists) | 'discuss' (attached to an active brief under discussion) | 'phase-split-probe' (probing whether/where to split phases)" },
      gate: { type: 'string', description: "The workflow activity the exchange serves (e.g. 'clarifying'). Optional." },
      brief_id: { type: 'string', description: "The active brief a 'discuss' exchange attaches to. Omit for pre-draft triggers." },
    },
    required: ['task_id', 'trigger'],
  },
};

// ---------------------------------------------------------------------------
// file_elicitation_round
// ---------------------------------------------------------------------------

export interface FileElicitationRoundArgs {
  exchange_id?: string;
  task_id?: string;
  context_line: string;
  questions: ElicitationQuestion[];
  /** Terminal-given answers to the PREVIOUS round, echoed in the same write that consumes it (B-462). */
  prior_answers?: Record<string, ElicitationAnswer>;
}

export async function fileElicitationRound(
  client: SupabaseClient,
  projectId: string,
  args: FileElicitationRoundArgs,
): Promise<unknown> {
  if (!args.context_line?.trim()) throw new Error('context_line is required — one plain-prose line framing the round');

  // Engine lints FIRST (pure, no I/O) — a violating round is rejected before any read or write.
  const violations = validateRound(args.questions ?? []);
  if (violations.length > 0) {
    throw new Error(`Round failed the elicitation lints:\n- ${violations.join('\n- ')}`);
  }

  const exchange = await resolveExchange(client, projectId, args);
  if (exchange.status !== 'active') {
    // B-461 amendment #3: 'abandoned' means a mechanical cancel landed (the human said "never mind —
    // keep the brief as it was"). Return the typed no-op instead of a generic throw so the calling
    // agent can stand down cleanly (and archive any claims it minted this turn). Every OTHER
    // non-active status keeps the loud error.
    if (exchange.status === 'abandoned') {
      return { noop: true, cause: 'exchange-cancelled', exchange } satisfies ExchangeCancelledNoop;
    }
    throw new Error(`exchange ${exchange.id} is '${exchange.status}' — rounds can only be filed on an active exchange`);
  }

  let rounds = Array.isArray(exchange.rounds) ? exchange.rounds : [];

  // Terminal answering (B-462): echo the human's terminal-given answers into the round being
  // consumed, in the same write that appends the next round — the exchange record stays complete
  // regardless of which surface the human answered on. The engine guards (last round only,
  // no overwrites, verb/kind fit) throw before any write.
  if (args.prior_answers) {
    const echoed = echoPriorAnswers(rounds, args.prior_answers, new Date().toISOString());
    if (echoed.errors.length > 0) {
      throw new Error(`prior_answers failed the echo guards:\n- ${echoed.errors.join('\n- ')}`);
    }
    rounds = echoed.rounds!;
  }

  const n = nextRoundNumber(rounds);

  // B-461 amendment #1: for a brief-attached exchange (trigger='discuss'), filing ROUND 1 IS the
  // consume of the brief's `pending_resolution = { command: 'discuss', detail }` marker the web
  // captured — the same logical write clears it so the marker is never re-consumable. Cleared BEFORE
  // the round is appended so a loud failure below leaves the whole filing cleanly retryable (a retry
  // still sees n === 1 and re-runs the clear; clearing an already-null marker is a no-op). Guarded
  // like briefs.ts's compose fallback (the B-383 schema-drift class): ONLY a missing-column error is
  // tolerated — the marker can't exist on a schema that lacks the column, so skipping is a faithful
  // no-op. Any OTHER failure (e.g. permission) rethrows: it must never silently skip the clear.
  if (exchange.brief_id != null && n === 1) {
    const { error: clearErr } = await client
      .from('briefs')
      .update({ pending_resolution: null })
      .eq('id', exchange.brief_id);
    if (clearErr && !isMissingPendingResolutionColumn(clearErr.message)) {
      throw new Error(clearErr.message);
    }
  }

  const round: ElicitationRound = {
    n,
    context_line: args.context_line.trim(),
    questions: args.questions,
    answers: {},
    // House idiom (milestones.ts shipped_at / knowledge.ts valid_to): timestamps are stamped
    // client-side; the row's updated_at trigger carries the authoritative DB clock for the write.
    filed_at: new Date().toISOString(),
  };

  // Filing the next round IS the consume of any prior answers marker: the previous round's answers
  // were read by the agent to draft this round, so clear answers_submitted_at in the same write.
  const { data, error } = await client
    .from('elicitation_exchanges')
    .update({ rounds: appendRound(rounds, round), answers_submitted_at: null })
    .eq('id', exchange.id)
    .select(EXCHANGE_COLS)
    .single();
  if (error) throw new Error(error.message);

  // Hand the ball to the human (state-machine §6.5): the task flags awaiting with a typed reason so
  // the queue/web surfaces the round. NEVER touches workflow_state — an exchange is an interaction
  // model within a gate (B-550 scope ruling), not a state transition.
  const { error: taskErr } = await client
    .from('tasks')
    .update({
      awaiting_human_input: true,
      awaiting_human_reason: 'elicitation-round',
      // `gate` rides along (B-462) so surfaces can group/label the round by the lifecycle gate the
      // exchange serves without re-fetching the exchange (the Queue card's gate pill reads it).
      awaiting_human_ref: { kind: 'elicitation', exchange_id: exchange.id, round: n, gate: exchange.gate ?? null },
    })
    .eq('id', exchange.task_id);
  if (taskErr) throw new Error(taskErr.message);

  return data;
}

export const fileElicitationRoundTool = {
  name: 'file_elicitation_round',
  description:
    `File one round of questions on an active elicitation exchange and hand the ball to the human (sets awaiting_human_input with reason 'elicitation-round'; never touches workflow_state). Lints enforced before any write: at most ${MAX_QUESTIONS_PER_ROUND} questions per round; a load-bearing question MUST be kind='open' (open question first, candidate withheld — load-bearing must never render as a one-click confirm); kind='validate' requires a statement to confirm/correct. One plain-prose context_line frames the round. Filing also CONSUMES any prior answers marker (clears answers_submitted_at) — read the previous round's answers via get_elicitation before filing the next. For a brief-attached ('discuss') exchange, filing ROUND 1 also clears the attached brief's pending_resolution discuss marker (B-461 — the filing IS the consume). If the exchange was mechanically cancelled ('abandoned'), returns the typed no-op { noop: true, cause: 'exchange-cancelled', exchange } instead of throwing — the CALLING AGENT must then archive any claims it minted in that same turn (claims are minted before conclude; the mint→conclude window can race a cancel).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      exchange_id: { type: 'string', description: 'The exchange to file on. Or pass task_id to target its active exchange.' },
      task_id: { type: 'string', description: 'Alternative to exchange_id — the task whose ACTIVE exchange to file on (UUID, task number, or visual ID).' },
      context_line: { type: 'string', description: 'ONE plain-prose line framing the round (what this round is settling and why).' },
      questions: {
        type: 'array',
        description: `The round's questions (max ${MAX_QUESTIONS_PER_ROUND}).`,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: "Round-unique id the answer keys on (e.g. 'q1')." },
            stakes: { type: 'string', description: "'low' | 'load-bearing' — how much a wrong answer steers the work. Load-bearing ⇒ kind must be 'open'." },
            kind: { type: 'string', description: "'validate' (confirm/correct an inference — requires statement) | 'open' (open text)." },
            statement: { type: 'string', description: "The agent's inference the human confirms or corrects. Required for kind='validate'." },
            text: { type: 'string', description: 'The question text.' },
            why: { type: 'string', description: 'Optional "why I\'m asking" expander.' },
          },
          required: ['id', 'stakes', 'kind', 'text'],
        },
      },
      prior_answers: {
        type: 'object',
        description:
          "Terminal-given answers to the PREVIOUS round, echoed into the exchange record in the same write (B-462 — the human answered in the terminal, not the web). Keyed by question id: { <qid>: { verb, text? } } with verb confirm|correct|skip for a 'validate' question and answer|skip for an 'open' one (correct/answer require text). Only the LAST filed round's unanswered questions may be echoed; each echo is stamped via:'terminal'. Omit entirely for web-submitted answers — the web writes those itself.",
      },
    },
    required: ['context_line', 'questions'],
  },
};

// ---------------------------------------------------------------------------
// get_elicitation
// ---------------------------------------------------------------------------

export interface GetElicitationArgs {
  task_id: string;
}

export async function getElicitation(
  client: SupabaseClient,
  projectId: string,
  args: GetElicitationArgs,
): Promise<unknown> {
  if (!args.task_id) throw new Error('task_id is required');
  const taskId = await resolveTaskId(client, projectId, args.task_id);

  const active = await findActiveExchange(client, taskId);
  if (active) return active;

  // No active exchange → the most recent one (resolved exchanges accumulate as history), or null.
  const { data, error } = await client
    .from('elicitation_exchanges')
    .select(EXCHANGE_COLS)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export const getElicitationTool = {
  name: 'get_elicitation',
  description:
    "Get a task's elicitation exchange — the active one, or the most recent if none is active (null when the task has never had one). `rounds` carries every filed round with its questions and any answers keyed by question id; a non-null `answers_submitted_at` means the human submitted answers the agent has NOT yet consumed (filing the next round, or concluding, consumes it); a non-null `force_quit_requested_at` means the human asked to force-quit ('best efforts, proceed').",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The task whose exchange to fetch — UUID, task number, or visual ID (e.g., B-43)' },
    },
    required: ['task_id'],
  },
};

// ---------------------------------------------------------------------------
// conclude_elicitation
// ---------------------------------------------------------------------------

export interface ConcludeElicitationArgs {
  exchange_id?: string;
  task_id?: string;
  outcome: 'converged' | 'force-quit' | 'abandoned';
  /** Terminal-given answers to the final round, echoed in the same concluding write (B-462). */
  prior_answers?: Record<string, ElicitationAnswer>;
}

export async function concludeElicitation(
  client: SupabaseClient,
  projectId: string,
  args: ConcludeElicitationArgs,
): Promise<unknown> {
  if (!args.outcome || !VALID_OUTCOMES.includes(args.outcome)) {
    throw new Error(`outcome must be one of: ${VALID_OUTCOMES.join(', ')}`);
  }

  const exchange = await resolveExchange(client, projectId, args);
  if (exchange.status !== 'active') {
    // Idempotent re-issue of the same conclusion is safe (mirrors resolve_brief §4.5). A re-issue
    // never re-echoes prior_answers — the first conclusion already recorded them (or the exchange
    // was concluded elsewhere and the echo window is closed).
    if (exchange.status === args.outcome) return exchange;
    // B-461 amendment #3: 'abandoned' means a mechanical cancel landed first (the mint→conclude
    // window can race a cancel). Return the typed no-op — never a silent success, never a generic
    // throw — so the calling agent stands down and archives any claims it minted this turn. Every
    // OTHER conflicting conclusion keeps the loud error.
    if (exchange.status === 'abandoned') {
      return { noop: true, cause: 'exchange-cancelled', exchange } satisfies ExchangeCancelledNoop;
    }
    throw new Error(`exchange ${exchange.id} is already '${exchange.status}' — cannot conclude it '${args.outcome}'`);
  }

  // Terminal answering (B-462): the final round's terminal-given answers are echoed in the same
  // write that concludes — usually a convergence consuming the answers that produced it.
  let roundsUpdate: { rounds: ElicitationRound[] } | Record<string, never> = {};
  if (args.prior_answers) {
    const echoed = echoPriorAnswers(
      Array.isArray(exchange.rounds) ? exchange.rounds : [],
      args.prior_answers,
      new Date().toISOString(),
    );
    if (echoed.errors.length > 0) {
      throw new Error(`prior_answers failed the echo guards:\n- ${echoed.errors.join('\n- ')}`);
    }
    roundsUpdate = { rounds: echoed.rounds! };
  }

  // ONLY the exchange row is written: status + clear both consumable markers (+ the terminal echo
  // above, when given). Deliberately does NOT touch the attached brief or the task's awaiting flag —
  // see the tool description for why.
  const { data, error } = await client
    .from('elicitation_exchanges')
    .update({ status: args.outcome, answers_submitted_at: null, force_quit_requested_at: null, ...roundsUpdate })
    .eq('id', exchange.id)
    .select(EXCHANGE_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export const concludeElicitationTool = {
  name: 'conclude_elicitation',
  description:
    "Conclude an elicitation exchange: 'converged' (the agent can now confidently draft a brief that represents the user's intent), 'force-quit' (the human said \"best efforts, proceed\" — draft from what you have; mint any claims with provenance 'force-quit'), or 'abandoned'. Sets the exchange status and clears both consumable markers. Writes NOTHING else: it does not touch the attached brief and does not re-set the task's awaiting flag — for 'abandoned' on a brief-attached exchange the brief row deliberately stays ACTIVE with the flag down, so the owning gate's \"brief already active\" path re-surfaces it in place on re-entry. If the exchange is already 'abandoned' (a mechanical cancel landed first) and a DIFFERENT outcome is requested, returns the typed no-op { noop: true, cause: 'exchange-cancelled', exchange } instead of throwing (B-461) — the CALLING AGENT must then archive any claims it minted in that same turn (claims are minted before conclude; the mint→conclude window can race a cancel). Re-issuing the SAME outcome stays idempotent and returns the row.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      exchange_id: { type: 'string', description: 'The exchange to conclude. Or pass task_id to target its active exchange.' },
      task_id: { type: 'string', description: 'Alternative to exchange_id — the task whose ACTIVE exchange to conclude (UUID, task number, or visual ID).' },
      outcome: { type: 'string', description: "'converged' | 'force-quit' | 'abandoned'" },
      prior_answers: {
        type: 'object',
        description:
          "Terminal-given answers to the FINAL round, echoed into the exchange record in the same concluding write (B-462) — use when the answers that produced this conclusion arrived in the terminal, not the web. Same shape and guards as file_elicitation_round's prior_answers; each echo is stamped via:'terminal'.",
      },
    },
    required: ['outcome'],
  },
};

// ---------------------------------------------------------------------------
// fetchActiveExchange — get_task's guarded projection (B-383-safe)
// ---------------------------------------------------------------------------

/** The compact active-exchange projection get_task surfaces (and the poll watch classifies on). */
export interface ActiveExchangeSummary {
  exchange_id: string;
  status: string;
  /** The current (= last filed) round's n; 0 when the exchange has no rounds yet. */
  round: number;
  answers_submitted_at: string | null;
  force_quit_requested_at: string | null;
}

/** Fetch the task's active exchange defensively (mirrors fetchPendingResolution). Returns null on an
 *  absent table/column (older DB — the B-383 schema-drift class), no active row, or any error —
 *  never throws, so it can never regress get_task on a DB without the Phase-1 migration. */
export async function fetchActiveExchange(
  client: SupabaseClient,
  taskId: string,
): Promise<ActiveExchangeSummary | null> {
  try {
    const { data, error } = await client
      .from('elicitation_exchanges')
      .select('id, status, rounds, answers_submitted_at, force_quit_requested_at')
      .eq('task_id', taskId)
      .eq('status', 'active')
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as {
      id: string;
      status: string;
      rounds?: unknown;
      answers_submitted_at?: string | null;
      force_quit_requested_at?: string | null;
    };
    const rounds = Array.isArray(row.rounds) ? (row.rounds as ElicitationRound[]) : [];
    return {
      exchange_id: row.id,
      status: row.status,
      round: currentRoundNumber(rounds),
      answers_submitted_at: row.answers_submitted_at ?? null,
      force_quit_requested_at: row.force_quit_requested_at ?? null,
    };
  } catch {
    return null;
  }
}
