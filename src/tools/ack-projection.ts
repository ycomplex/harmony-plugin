// B-683: boundary-only mutation-ack projection.
//
// MCP write tools were echoing the caller-sent record back into the session (title/description/
// content/doc bodies the agent JUST sent), and every such echo persists in context to session end —
// the 2026-07-08 footprint audit measured mutation echoes at ~40% of all Harmony result chars.
//
// THE RULE: an ack returns the server-COMPUTED fields the caller didn't send — ids, task_number on
// create, status + workflow_state after transitions, updated_at, plus a boundary-computed
// `changed_fields` (derived from the args keys, minus identifier params) — and NEVER the body the
// caller sent. A result that is entirely server-computed (e.g. ship_milestone's summary) may
// legitimately keep most of itself.
//
// SCOPE: applied ONLY in handleToolCall (src/tools/index.ts), between the dispatch switch and the
// JSON serialization. handleToolCall is MCP-only — the CLI (src/cli) and in-process consumers
// (src/bin/poll.ts) call the handler functions directly and keep full-fidelity returns. Tools
// WITHOUT an entry here pass through unchanged (all reads).
//
// Every WRITE tool in the dispatch must appear in exactly one of:
//   - `ackProjections`   — a projection stripping the caller echo, or
//   - `ACK_PASS_THROUGH` — an explicit annotated pass-through (already compact / server-computed).
// The regression pin test (ack-projection.test.ts) enumerates the dispatch's case labels and fails
// on any tool that is neither classified as a read nor decided here — a future write tool cannot
// ship without a decided ack.

/** A per-tool ack projection: (full handler result, original call args) -> the compact ack. */
export type AckProjection = (result: unknown, args: Record<string, unknown>) => unknown;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keep only `keys` that are actually present (missing/undefined keys are omitted, so a projection
 *  never invents fields a degraded/older-schema result didn't carry). Non-object inputs pass
 *  through unchanged — a projection must never crash the boundary on a degenerate result. */
function pick(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (value[k] !== undefined) out[k] = value[k];
  }
  return out;
}

/** Map an array of rows to their `id`s (non-arrays pass through; rows without an id are kept as-is
 *  defensively rather than silently dropped). */
function ids(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => (isRecord(r) && r.id !== undefined ? r.id : r));
}

/** Boundary-computed record of WHAT the caller changed (arg keys minus identifier params) — the
 *  ack's replacement for echoing the changed values themselves. */
function changedFields(args: Record<string, unknown>, identifierKeys: string[]): string[] {
  return Object.keys(args).filter((k) => !identifierKeys.includes(k) && args[k] !== undefined);
}

/** Compact created-task ack: the server-computed identity of a new task. `workflow_state` is kept
 *  when present (set by the tasks_default_workflow_state insert trigger) — the legacy-status bug
 *  class (B-580) means completion/state reads must never fall back to `status` alone. */
const createdTaskAck = (row: unknown) => pick(row, ['id', 'task_number', 'workflow_state']);

/** Compact exchange ack for the elicitation write tools. Skills read answers/rounds via the
 *  get_elicitation READ (untouched); the write ack only confirms identity + consumable-marker
 *  state. `round` = the last filed round's n (0 when none). */
function exchangeAck(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const rounds = Array.isArray(row.rounds) ? (row.rounds as Array<{ n?: number }>) : [];
  const last = rounds[rounds.length - 1];
  return {
    id: row.id,
    task_id: row.task_id,
    status: row.status,
    round: typeof last?.n === 'number' ? last.n : rounds.length,
    answers_submitted_at: row.answers_submitted_at ?? null,
    force_quit_requested_at: row.force_quit_requested_at ?? null,
  };
}

/** file_elicitation_round / conclude_elicitation can return the typed B-461 no-op
 *  `{ noop: true, cause: 'exchange-cancelled', exchange }` — the calling agent MUST see the cancel
 *  (it archives claims minted that turn), so the noop shape is preserved with a compacted exchange. */
function elicitationAck(result: unknown): unknown {
  if (isRecord(result) && result.noop === true) {
    return { noop: true, cause: result.cause, exchange: exchangeAck(result.exchange) };
  }
  return exchangeAck(result);
}

/** `{ added, updated, deleted }` batch results (acceptance criteria / test cases / checklist):
 *  added/updated rows shrink to their ids (the verify gate checks ACs off BY id); deleted is
 *  already an id list. Counts ride along so a batch ack is self-describing. */
function batchIdsAck(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const added = ids(result.added);
  const updated = ids(result.updated);
  const deleted = result.deleted;
  return {
    added,
    updated,
    deleted,
    counts: {
      added: Array.isArray(added) ? added.length : 0,
      updated: Array.isArray(updated) ? updated.length : 0,
      deleted: Array.isArray(deleted) ? deleted.length : 0,
    },
  };
}

/** Compact knowledge-row ack (create/record paths): `id` is load-bearing (it feeds
 *  `decision_ref` and `reference_knowledge`); status/created_at are server-computed. */
const knowledgeCreatedAck = (row: unknown) => pick(row, ['id', 'status', 'created_at']);

/** Supersede acks: both halves are rows the server transitioned — keep the linkage, not the body. */
const supersededAck = (row: unknown) => pick(row, ['id', 'status', 'superseded_by']);

/**
 * The per-tool projection map. Applied in handleToolCall between the dispatch switch and the
 * stringify; tools without an entry (all reads) pass through unchanged.
 */
export const ackProjections: Record<string, AckProjection> = {
  // ——— tasks ———
  create_task: (result) => createdTaskAck(result),
  bulk_create_tasks: (result) => {
    if (!Array.isArray(result)) return result;
    return { created: result.map(createdTaskAck), count: result.length };
  },
  update_task: (result, args) => {
    if (!isRecord(result)) return result;
    return {
      ...(pick(result, ['id', 'task_number', 'status', 'workflow_state', 'updated_at']) as Record<
        string,
        unknown
      >),
      changed_fields: changedFields(args, ['task_id']),
    };
  },
  bulk_update_tasks: (result, args) => {
    if (!Array.isArray(result)) return result;
    // `updated` ids are server-computed signal: which of the requested task_ids actually matched.
    return {
      updated: ids(result),
      count: result.length,
      changed_fields: changedFields(args, ['task_ids']),
    };
  },
  subsume_task: (result) =>
    // Already server-computed and compact except the optional caller-echoed `reason` — dropped.
    pick(result, ['task_id', 'subsumed_by_task_id', 'archived', 'already_subsumed']),

  // ——— epics / labels ———
  create_epic: (result) => pick(result, ['id', 'position', 'created_at']),
  update_epic: (result, args) => {
    if (!isRecord(result)) return result;
    return {
      ...(pick(result, ['id', 'updated_at']) as Record<string, unknown>),
      changed_fields: changedFields(args, ['epic_id']),
    };
  },
  create_label: (result) => pick(result, ['id']),

  // ——— comments ———
  add_comment: (result) => pick(result, ['id', 'created_at']),

  // ——— batch child-record managers ———
  manage_checklist_items: batchIdsAck,
  manage_acceptance_criteria: batchIdsAck,
  manage_test_cases: batchIdsAck,
  manage_dependencies: (result) => {
    if (!isRecord(result)) return result;
    // The added dependency-ROW ids are what list_dependencies later returns for `remove` — keep them.
    return { added: ids(result.added), removed: result.removed };
  },
  manage_subtasks: (result) => {
    if (!isRecord(result)) return result;
    // Created children need id + task_number (+ workflow_state when selected): the decompose gate
    // immediately advances each created child via advance_workflow.
    return {
      attached: result.attached,
      created: Array.isArray(result.created) ? result.created.map(createdTaskAck) : result.created,
      detached: result.detached,
    };
  },

  // ——— knowledge entries / decisions / facts / entities ———
  create_knowledge_entry: knowledgeCreatedAck,
  record_decision: knowledgeCreatedAck,
  update_knowledge_entry: (result, args) => {
    if (!isRecord(result)) return result;
    return {
      ...(pick(result, ['id', 'status', 'updated_at']) as Record<string, unknown>),
      // `title` doubles as the identifier when entry_id is absent; `new_title` is the change.
      changed_fields: changedFields(args, ['entry_id', 'title']),
    };
  },
  supersede_knowledge_entry: (result) => {
    if (!isRecord(result)) return result;
    return {
      superseded: supersededAck(result.superseded),
      replacement: knowledgeCreatedAck(result.replacement),
    };
  },
  supersede_decision: (result) => {
    if (!isRecord(result)) return result;
    return {
      superseded: supersededAck(result.superseded),
      // retire-mode (B-534) legitimately has no successor — preserve the null.
      replacement: result.replacement == null ? null : knowledgeCreatedAck(result.replacement),
    };
  },
  assert_fact: (result) =>
    // subject_entity_id is server-computed (the entity was resolved/created from a NAME).
    pick(result, ['id', 'subject_entity_id', 'status', 'valid_from']),
  invalidate_fact: (result) => pick(result, ['id', 'status', 'valid_to']),
  create_entity: (result) => pick(result, ['id', 'created_at']),
  update_entity: (result, args) => {
    if (!isRecord(result)) return result;
    return {
      ...(pick(result, ['id']) as Record<string, unknown>),
      // kind + name identify the entity when entity_id is absent; new_kind etc. are the changes.
      changed_fields: changedFields(args, ['entity_id', 'kind', 'name']),
    };
  },
  reconcile_entity: (result) => {
    if (!isRecord(result)) return result;
    // mode / merged_stub_id / repointed are the server-computed value of this call; the surviving
    // entity shrinks to its id (its kind/name were the caller's own arguments).
    return {
      mode: result.mode,
      entity: pick(result.entity, ['id']),
      ...(result.merged_stub_id !== undefined ? { merged_stub_id: result.merged_stub_id } : {}),
      ...(result.repointed !== undefined ? { repointed: result.repointed } : {}),
    };
  },

  // ——— milestones / cycles ———
  create_milestone: (result) => pick(result, ['id', 'status', 'created_at']),
  update_milestone: (result, args) => {
    if (!isRecord(result)) return result;
    return {
      ...(pick(result, ['id', 'updated_at']) as Record<string, unknown>),
      changed_fields: changedFields(args, ['milestone_id']),
    };
  },
  ship_milestone: (result) => {
    if (!isRecord(result)) return result;
    // Entirely server-computed summary (the caller sent only milestone_id) — kept, with the full
    // milestone row trimmed to its identity + transition fields.
    return {
      milestone: pick(result.milestone, ['id', 'name', 'status', 'shipped_at']),
      shipped_task_count: result.shipped_task_count,
      removed_tasks: result.removed_tasks,
    };
  },
  create_cycle: (result) =>
    // sequence_number + end_date are server-computed (duration comes from project config).
    pick(result, ['id', 'sequence_number', 'end_date', 'created_at']),
  update_cycle: (result, args) => {
    if (!isRecord(result)) return result;
    return {
      // start/end confirm the applied window (an end_date change cascades to the next cycle).
      ...(pick(result, ['id', 'sequence_number', 'start_date', 'end_date']) as Record<
        string,
        unknown
      >),
      changed_fields: changedFields(args, ['cycle_id']),
    };
  },

  // ——— briefs ———
  compose_brief: (result) => {
    if (!isRecord(result)) return result;
    // The server-rendered `content` stays — gate skills display the brief verbatim from the compose
    // return. `lint` stays verbatim (soft warnings steer the authoring agent). The `doc` echo,
    // expand_sections, related, and resolved_* fields are dropped.
    return {
      brief: pick(result.brief, [
        'id',
        'reason',
        'status',
        'iteration',
        'pending_activity',
        'decision_ref',
        'content',
      ]),
      lint: result.lint,
    };
  },

  // ——— elicitation ———
  start_elicitation: (result) => elicitationAck(result),
  file_elicitation_round: (result) => elicitationAck(result),
  conclude_elicitation: (result) => elicitationAck(result),

  // ——— attachments ———
  attach_file: (result) =>
    // content_type/byte_size/status come from the server-side finalize sniff; `filename` is derived
    // from the caller's own file_path — dropped.
    pick(result, ['attachment_id', 'task_id', 'content_type', 'byte_size', 'status']),
};

/**
 * Write tools whose results are ALREADY compact acks of server-computed state — explicitly
 * annotated pass-throughs (value = why), so the pin test can prove every write tool was decided.
 */
export const ACK_PASS_THROUGH: Record<string, string> = {
  resolve_brief:
    'RPC result is already a compact state-confirming ack ({task_id, brief_id, workflow_state, brief_status, command, idempotent}); skills read workflow_state off it.',
  consume_accept_remark:
    'Already a compact server-computed ack ({brief_id, consumed, already?, unsupported?}) — no caller-sent body to strip (the only arg is the identifier).',
  advance_workflow:
    'Already a compact transition summary ({task_id, from_state, to_state, activity, task:{id, workflow_state, workflow_activity}}); skills read to_state / task.workflow_state.',
  reference_knowledge:
    'Already minimal: { task_id, decision_id, linked } — the link confirmation IS the ack.',
  manage_labels:
    'Already id-lists only: { added: [label ids], removed: [label ids] } — no record echo to strip.',
};

/**
 * Apply the boundary ack projection for `toolName`. Tools without a projection entry (all reads,
 * plus the annotated pass-throughs above) return the result unchanged.
 */
export function projectAck(
  toolName: string,
  result: unknown,
  args: Record<string, unknown>,
): unknown {
  const projection = ackProjections[toolName];
  return projection ? projection(result, args) : result;
}
