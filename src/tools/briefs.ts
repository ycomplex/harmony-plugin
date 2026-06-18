// P3: Brief substrate + command set (gate-ui-conductor §3, §4). The structured doc is canonical; the
// Markdown blob is DERIVED by renderBrief(). The §3.2 disciplines are a mechanical lint over the same
// canonical doc — so what's checked is exactly what's rendered.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export interface BriefItem {
  /** §3.2 sort: a decision (always recommended), a content-input (only the human can supply it),
   *  or a derived-constraint (already fixed elsewhere — belongs in Context, never an ask). */
  kind: 'decision' | 'content-input' | 'derived-constraint';
  text: string;
  recommendation?: string;
  /** true when the decision is deferred behind research (the load-bearing-gap path). */
  deferred?: boolean;
}

export interface BriefAlternative {
  option: string;
  rejection: string;
}

/** The canonical structured brief (the BLUF skeleton as data). renderBrief() is its only renderer. */
export interface BriefDoc {
  decide: string;
  recommend?: { text: string; confidence?: 'low'; cede?: boolean };
  why?: string[];
  alternatives?: BriefAlternative[];
  context?: string[];
  items: BriefItem[];
  research?: string[];
  load_bearing_gap?: boolean;
  tail?: string;
}

export interface BriefLintResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const WORD_BUDGET = 300; // §3.2 soft budget (~250–300)
const DEFAULT_TAIL = 'Type `accept`, `edit`, `iterate <feedback>`, or `defer`.';

/** Render the canonical doc to the §3.1 BLUF Markdown blob, deterministically. */
export function renderBrief(doc: BriefDoc): string {
  const out: string[] = [];
  out.push(`## DECIDE: ${doc.decide}`, '');

  if (doc.load_bearing_gap) {
    // Research-first (§3.2): open with the research, defer the substantive recommendation — never buried.
    out.push("**Recommend:** I don't know enough yet — run the research below before deciding.", '');
    out.push('**Research first:**');
    (doc.research ?? []).forEach((p, i) => out.push(`${i + 1}. ${p}`));
    out.push('');
  } else if (doc.recommend) {
    let suffix = '';
    if (doc.recommend.cede) suffix = ' (low confidence — this is a values call you should own)';
    else if (doc.recommend.confidence === 'low') suffix = ' (low confidence — see below)';
    out.push(`**Recommend${suffix}:** ${doc.recommend.text}`, '');
  }

  if (doc.why?.length) {
    out.push('**Why:**', ...doc.why.map((w) => `- ${w}`), '');
  }
  if (doc.alternatives?.length) {
    out.push('**Alternatives:**', ...doc.alternatives.map((a) => `- ${a.option} — ${a.rejection}`), '');
  }
  if (doc.context?.length) {
    out.push('**Context:**', ...doc.context.map((c) => `- ${c}`), '');
  }

  if (doc.items.length) {
    out.push('**You need to:**');
    for (const item of doc.items) {
      if (item.kind === 'content-input') {
        out.push(`- [ ] ${item.text} *(your input needed)*`);
      } else if (item.kind === 'decision') {
        const rec = !item.deferred && item.recommendation ? ` — *recommend: ${item.recommendation}*` : '';
        out.push(`- [ ] ${item.text}${rec}`);
      }
      // derived-constraint items never render — the lint rejects them before this point.
    }
    out.push('');
  }

  out.push(`> ${doc.tail ?? DEFAULT_TAIL}`);
  return out.join('\n');
}

/** Enforce the §3.2 disciplines on the canonical doc. `content` is the rendered blob (for the word budget). */
export function lintBrief(doc: BriefDoc, content: string): BriefLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const research = doc.research ?? [];

  for (const item of doc.items) {
    // Rule 2 (the single most-repeated failure, B-320/B-327): a derived constraint already fixed
    // elsewhere is Context, never a "confirm" — forcing the human to confirm it wastes a decision.
    if (item.kind === 'derived-constraint') {
      errors.push(
        `Item "${item.text}" is a derived constraint already fixed elsewhere — move it to Context, do not ask the human to confirm it.`,
      );
      continue;
    }
    // Rule 1 (no naked forks): every decision carries a recommendation, unless deferred behind research.
    if (item.kind === 'decision' && !item.deferred && !item.recommendation?.trim()) {
      errors.push(
        `Decision "${item.text}" has no recommendation (naked fork). Recommend a default (mark it cede-able if it's a values call), or defer it behind research.`,
      );
    }
  }

  // Rule 3 (research-first when load-bearing, B-327): lead with the research, never bury it; and don't
  // ask a substantive decision the agent is out of depth on — defer it until research returns.
  if (doc.load_bearing_gap) {
    if (research.length === 0) {
      errors.push('Load-bearing knowledge gap declared but no research supplied — lead with the research, do not guess.');
    }
    if (doc.items.some((i) => i.kind === 'decision' && !i.deferred)) {
      errors.push('Load-bearing gap declared but a substantive decision is still being asked — defer the recommendation until research returns.');
    }
  }

  // Soft: word budget (§3.2 — soft, not enforced: trim noise, don't amputate reasoning).
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  if (words > WORD_BUDGET) {
    warnings.push(
      `Brief renders to ${words} words (soft budget ${WORD_BUDGET}). Trim noise — but don't amputate reasoning; expose detail via expand instead.`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

const BRIEF_COLS =
  'id, task_id, reason, doc, content, expand_sections, related, pending_activity, decision_ref, status, iteration, resolved_command, resolved_detail, resolved_at, created_by, created_at, updated_at';

const VALID_REASONS = [
  'clarification-draft', 'decomposition-proposal', 'design-decision-draft',
  'plan-draft', 'release-decision-pending', 'verification-ack-pending', 'stale-patch-review',
];

export interface DecisionRef { type: string; id: string; }

export interface ComposeBriefArgs {
  task_id: string;
  reason: string;
  doc: BriefDoc;
  expand_sections?: Record<string, string>;
  related?: unknown[];
  pending_activity?: string;
  decision_ref?: DecisionRef;
}

export async function composeBrief(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: ComposeBriefArgs,
): Promise<{ brief: unknown; lint: BriefLintResult }> {
  if (!args.task_id) throw new Error('task_id is required');
  if (!VALID_REASONS.includes(args.reason)) {
    throw new Error(`reason must be one of: ${VALID_REASONS.join(', ')}`);
  }
  if (!args.doc?.decide?.trim()) throw new Error('doc.decide is required');

  // Render the canonical doc to the blob, then lint the doc (what's checked is what's rendered).
  const content = renderBrief(args.doc);
  const lint = lintBrief(args.doc, content);
  if (!lint.ok) {
    throw new Error(`Brief failed the §3.2 pre-send lint:\n- ${lint.errors.join('\n- ')}`);
  }

  // Resolve the task identifier (UUID / task number / visual ID), matching the sibling task tools.
  const taskId = await resolveTaskId(client, projectId, args.task_id);

  // Compose-time guard (fail-fast): a pending_activity must yield a real transition from the current state.
  // Invariant: P1's seed has (from_state, activity) unique, so maybeSingle is exact; if a future seed adds
  // a second to_state for the same (from_state, activity), maybeSingle errors loudly (a safe fail).
  if (args.pending_activity) {
    const { data: task, error: tErr } = await client
      .from('tasks').select('workflow_state').eq('id', taskId).single();
    if (tErr) throw new Error(tErr.message);
    const fromState = (task as { workflow_state: string | null } | null)?.workflow_state ?? null;
    let q = client.from('workflow_transitions').select('to_state').eq('activity', args.pending_activity);
    q = fromState === null ? q.is('from_state', null) : q.eq('from_state', fromState);
    const { data: tr, error: trErr } = await q.maybeSingle();
    if (trErr) throw new Error(trErr.message);
    if (!tr) {
      throw new Error(`pending_activity '${args.pending_activity}' has no valid transition from state '${fromState ?? 'NULL'}'`);
    }
  }

  const payload = {
    reason: args.reason,
    doc: args.doc,
    content,
    expand_sections: args.expand_sections ?? {},
    related: args.related ?? [],
    pending_activity: args.pending_activity ?? null,
    decision_ref: args.decision_ref ?? null,
  };

  // Upsert: update the active brief in place (edit/iterate — §3.2) or insert a new one (compose).
  const { data: existing, error: lookupErr } = await client
    .from('briefs').select('id, iteration')
    .eq('task_id', taskId).eq('status', 'active').maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);

  let brief: unknown;
  if (existing) {
    const { data, error } = await client
      .from('briefs')
      .update({ ...payload, iteration: ((existing as { iteration: number }).iteration ?? 1) + 1 })
      .eq('id', (existing as { id: string }).id)
      .select(BRIEF_COLS).single();
    if (error) throw new Error(error.message);
    brief = data;
  } else {
    const { data, error } = await client
      .from('briefs')
      .insert({ task_id: taskId, created_by: userId, ...payload })
      .select(BRIEF_COLS).single();
    if (error) throw new Error(error.message);
    brief = data;
  }

  // Set the P1 awaiting_human_input context (state-machine §6.5) so the queue/load views surface it.
  const { error: taskErr } = await client
    .from('tasks')
    .update({
      awaiting_human_input: true,
      awaiting_human_reason: args.reason,
      awaiting_human_ref: { type: 'brief', id: (brief as { id: string }).id },
    })
    .eq('id', taskId);
  if (taskErr) throw new Error(taskErr.message);

  return { brief, lint };
}

// NOTE: compose_brief is skill-only (§4.3 — the web never composes; it does mechanical accept/defer only),
// so the two writes above (briefs upsert, then the tasks flag) need no cross-surface transaction. On a
// flag-set failure the function throws; the composing skill re-calls compose_brief and the in-place upsert
// safely re-attempts (retry-safe, no duplicate brief). The atomic+idempotent path is resolve_brief, which
// BOTH surfaces call. A compose_brief RPC is a noted fast-follow, not v1 (finding F4).

export const composeBriefTool = {
  name: 'compose_brief',
  description:
    "Compose (or iterate, in place) the BLUF decision brief for a task and flag it awaiting human input. Pass the STRUCTURED doc (decide / recommend / why / alternatives / context / items / research); the Markdown blob is rendered from it. Runs the §3.2 pre-send lint (rejects naked forks; enforces research-first when load-bearing; rejects items labelled `derived-constraint` among the asks) and validates pending_activity against the transition table. pending_activity = the workflow activity `accept` will apply; decision_ref = the Asserted knowledge entry `accept` will promote. Calling again for the same task updates the active brief in place (edit/iterate).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The task this brief decides on — UUID, task number (e.g., 43), or visual ID (e.g., B-43)' },
      reason: { type: 'string', description: 'Gate reason (§6.5): clarification-draft | decomposition-proposal | design-decision-draft | plan-draft | release-decision-pending | verification-ack-pending | stale-patch-review' },
      doc: {
        type: 'object',
        description: 'The canonical structured BLUF brief. The rendered Markdown blob is derived from this.',
        properties: {
          decide: { type: 'string', description: 'One-line statement of the decision needed' },
          recommend: { type: 'object', description: '{ text, confidence?: "low", cede?: boolean } — omit when load_bearing_gap (research-first)' },
          why: { type: 'array', items: { type: 'string' }, description: '2–3 bullets of reasoning' },
          alternatives: { type: 'array', items: { type: 'object' }, description: '[{ option, rejection }]' },
          context: { type: 'array', items: { type: 'string' }, description: 'Peer decisions / scope / known patterns' },
          items: {
            type: 'array',
            description: 'The "You need to" items, each sorted into exactly one kind (§3.2).',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', description: "'decision' (always recommended) | 'content-input' (only the human can supply) | 'derived-constraint' (already fixed — belongs in Context, NOT an ask)" },
                text: { type: 'string' },
                recommendation: { type: 'string', description: 'Required for a decision unless deferred behind research' },
                deferred: { type: 'boolean', description: 'true when the decision is deferred behind research' },
              },
              required: ['kind', 'text'],
            },
          },
          research: { type: 'array', items: { type: 'string' }, description: 'Research prompts — required + surfaced up front when load_bearing_gap, never buried' },
          load_bearing_gap: { type: 'boolean', description: 'true when a load-bearing knowledge gap blocks a substantive decision (forces research-first)' },
          tail: { type: 'string', description: 'Optional custom command tail line; defaults to the standard one' },
        },
        required: ['decide', 'items'],
      },
      expand_sections: { type: 'object', description: 'Pre-generated expand content keyed by section: reasoning/alternatives/history' },
      related: { type: 'array', description: 'Pre-generated related decisions/tickets/knowledge' },
      pending_activity: { type: 'string', description: 'The workflow activity `accept` applies (e.g. clarifying, decomposing, releasing, verifying). Validated against the transition table. Omit if accept advances no state.' },
      decision_ref: { type: 'object', description: 'The Asserted knowledge entry to promote on accept: { type: "decision", id: "<uuid>" }' },
    },
    required: ['task_id', 'reason', 'doc'],
  },
};

// B-485 Phase 2: `briefs.pending_resolution` is a browser-submitted reshape request the running
// conductor consumes on auto-pickup — shape `{ command: 'iterate', detail: <feedback> }`, or NULL/none.
// It is added by harmony-web's Phase-1 migration (`20260618…_briefs_pending_resolution.sql`). Until that
// migration is live on the DB this MCP server talks to, the column does not exist — so we read it on a
// SEPARATE, defensive select and SWALLOW the error rather than inline it into BRIEF_COLS. Inlining would
// 400 the whole core read on a DB that lacks the column (the B-383 schema-drift class of break the
// prod-gate guards against); a separate guarded read degrades to `pending_resolution: null` instead.
// Promotion is still lockstep (web migration first, then plugin) per the prod-gate.
export interface PendingResolution {
  command: string; // 'iterate' in v1 (the browser-submitted reshape)
  detail?: string | null; // the human's feedback text
}

/** Fetch the active brief's `pending_resolution` defensively. Returns null on absent column / no brief /
 *  any error — never throws, so it can never regress get_brief/get_task on a DB without the column. */
export async function fetchPendingResolution(
  client: SupabaseClient,
  taskId: string,
): Promise<PendingResolution | null> {
  try {
    const { data, error } = await client
      .from('briefs')
      .select('pending_resolution')
      .eq('task_id', taskId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) return null;
    // Cast: the column may be absent from generated types / the deployed schema. Guard for null.
    const pr = (data as unknown as { pending_resolution?: unknown } | null)?.pending_resolution;
    return (pr ?? null) as PendingResolution | null;
  } catch {
    return null;
  }
}

export interface GetBriefArgs { task_id: string; }

export async function getBrief(
  client: SupabaseClient,
  projectId: string,
  args: GetBriefArgs,
): Promise<unknown> {
  if (!args.task_id) throw new Error('task_id is required');
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  // Unique-lookup guard: the partial unique index guarantees ≤1 active brief, so maybeSingle is exact.
  const { data, error } = await client
    .from('briefs').select(BRIEF_COLS)
    .eq('task_id', taskId).eq('status', 'active').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null; // null when no active brief
  // B-485: surface the browser-submitted reshape marker so a running conductor can detect+consume it.
  // Defensive (separate guarded read) so an older DB without the column returns null, not a 400.
  const pending_resolution = await fetchPendingResolution(client, taskId);
  return { ...(data as Record<string, unknown>), pending_resolution };
}

export interface ResolveBriefArgs { task_id: string; command: string; detail?: string; }

export async function resolveBrief(
  client: SupabaseClient,
  projectId: string,
  args: ResolveBriefArgs,
): Promise<unknown> {
  if (!args.task_id) throw new Error('task_id is required');
  if (args.command !== 'accept' && args.command !== 'defer') {
    throw new Error('resolve_brief handles only accept/defer; edit/iterate are skill-side, expand/related are reads on get_brief');
  }
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  // Unique-lookup guard (partial unique index): exactly one active brief, or none.
  const { data: active, error: lookupErr } = await client
    .from('briefs').select('id')
    .eq('task_id', taskId).eq('status', 'active').maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);
  if (!active) throw new Error(`no active brief for task ${args.task_id}`);

  const { data, error } = await client.rpc('resolve_brief', {
    _brief_id: (active as { id: string }).id,
    _command: args.command,
    _detail: args.detail ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}

export const getBriefTool = {
  name: 'get_brief',
  description: "Get the active brief for a task (its rendered content blob + canonical doc + pre-generated expand sections + related), plus `pending_resolution` — a browser-submitted reshape request ({command:'iterate', detail:<feedback>}) the running conductor consumes on pickup, or null if none. Returns null if no brief is awaiting input.",
  inputSchema: {
    type: 'object' as const,
    properties: { task_id: { type: 'string', description: 'The task whose active brief to fetch — UUID, task number, or visual ID (e.g., B-43)' } },
    required: ['task_id'],
  },
};

export const resolveBriefTool = {
  name: 'resolve_brief',
  description: "Resolve the active brief on a task. accept = promote the Asserted knowledge entry to Accepted, advance the state machine, clear the flag. defer = park the ticket. Idempotent (re-issuing the same command is safe). (edit/iterate are skill-side LLM work via compose_brief; expand/related are reads via get_brief.)",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The task whose active brief to resolve — UUID, task number, or visual ID (e.g., B-43)' },
      command: { type: 'string', description: "'accept' | 'defer'" },
      detail: { type: 'string', description: 'Optional note (e.g. the defer reason)' },
    },
    required: ['task_id', 'command'],
  },
};
