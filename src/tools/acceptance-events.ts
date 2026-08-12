// B-797 — the conductor's consume path for an accepted gate brief's deferred payload. Accept becomes a
// consumed EVENT for the four agent-owned-payload reasons (clarification-draft, decomposition-proposal,
// plan-draft, design-decision-draft on the product track): web-accept snapshots the brief's payload into
// a `pending_acceptance_events` row and DEFERS the workflow-state advance; this module executes every
// promised write via the per-write-kind SECURITY DEFINER RPCs, then commits the deferred advance via
// `consume_acceptance_event` — the FINAL write, never the prologue.
//
// PROBE 3 / absent-substrate tolerance (B-383): the tables/RPCs this module depends on reach the prod DB
// only at the next `promote-prod`, but plugin `main` runs against prod immediately once merged. So there
// is a real window where this code is live against a DB that doesn't have the substrate yet. Every entry
// point here MUST distinguish "the relation/RPC does not exist" (schema not migrated — degrade to
// today's synchronous behavior, silently) from any OTHER error (network blip, permission issue, etc. —
// never silently swallowed; must propagate so the caller retries or surfaces it loudly).
//
// The SAME hazard recurs one level down (B-688): PROBE 3 only covers the top-level
// `pending_acceptance_events` table. An individual write_kind's own RPC (e.g. `consume_label_add_write`)
// can lag behind the rest of this module's substrate on the exact same B-383 window — see
// `applyAcceptanceEventPayload`'s `substrate_absent_for` handling below, which degrades that narrower case
// the same way: safely, never an opaque throw, never a call to `consume_acceptance_event`.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

/**
 * B-688 — the CONTRACT this module's `label_add` dispatch depends on from harmony-web's decision-only
 * stamping guard (`can_mark_decision_only` + `consume_label_add_write`, mirrors the B-747
 * `CRITERIA_FLOOR_CONTRACT` pattern in `evidence-status.ts`).
 *
 * Unlike `CRITERIA_FLOOR_CONTRACT`, this module has no live wrapper-with-fallback function reading
 * `can_mark_decision_only` directly today — the guard is enforced entirely SERVER-SIDE, inside
 * `consume_label_add_write` (called BEFORE its ledger insert). So this const pins the SHAPE of both RPCs
 * (names + args + the guard's two return columns + its two `block_reason` values) as a naming contract a
 * hand-edit can't silently drift, not as a live-divergence-detecting wrapper.
 *
 * `decision-only-label-contract.test.ts` asserts every field by name, plus that the `label_add` dispatch
 * (`applyAcceptanceEventPayload`) actually calls `consume_label_add_write` with these exact args. The
 * counterpart lives in harmony-web: `supabase/tests/b688_decision_only_guard.test.sql` exercises both RPCs
 * directly against a live DB. The two are kept in step by hand (separate repos) — same honest residual as
 * the B-747 pairing.
 */
export const DECISION_ONLY_LABEL_CONTRACT = {
  /** can_mark_decision_only — the SOLE authority for whether a ticket may be marked decision-only now.
   *  SECURITY INVOKER; consumed by consume_label_add_write before its ledger insert. */
  guard: {
    rpc: 'can_mark_decision_only',
    arg: '_task_id',
    allowedColumn: 'allowed',
    blockReasonColumn: 'block_reason',
    /** 'terminal' = Verified/Cancelled/Parked (hard block). 'build-shape' = Planned-or-later, or a
     *  linked build PR (redirect to revise-scope). Checked in that order — terminal wins. */
    blockReasons: ['terminal', 'build-shape'] as const,
  },
  /** consume_label_add_write — the B-797-style ledgered write RPC for write_kind='label_add'. Guard-
   *  blocked calls RAISE EXCEPTION ... USING ERRCODE = 'check_violation' (message contains the literal
   *  text 'decision-only guard blocked: <block_reason>') and leave NO ledger row. */
  write: {
    rpc: 'consume_label_add_write',
    eventIdArg: '_event_id',
    externalRefArg: '_external_ref',
    labelNameArg: '_label_name',
  },
} as const;

/** One promised write, as authored into a brief's `doc.payload` at compose time. `ref` is the AUTHOR-
 *  CHOSEN stable identifier for this logical write (e.g. "ac-1", "child-2") — reused verbatim as the
 *  ledger's `external_ref`, so a retry naturally re-derives the SAME ref for the SAME logical write. An
 *  `ac_transfer` item's `target_child_ref` must match a `child_ticket` item's own `ref` earlier in the
 *  SAME payload — children are applied before transfers (see `applyPayload` below).
 *
 *  `label_add` (B-688) — the decision-only stamping guard's ledgered write. `label_name` defaults to
 *  `'decision-only'` at the dispatch site (the only real-world caller today) when omitted — never
 *  hardcode a payload author to a different label via this field's absence; an author who means some
 *  other label must set it explicitly. */
export interface AcceptanceEventPayloadItem {
  write_kind: 'acceptance_criterion' | 'child_ticket' | 'checklist_item' | 'ac_transfer' | 'label_add';
  ref: string;
  content?: string;
  title?: string;
  description?: string | null;
  target_child_ref?: string;
  from_ac_id?: string | null;
  label_name?: string;
}

export interface PendingAcceptanceEvent {
  id: string;
  task_id: string;
  brief_id: string;
  reason: string;
  payload: { items?: AcceptanceEventPayloadItem[] } | AcceptanceEventPayloadItem[] | Record<string, unknown>;
  pending_activity: string | null;
  status: 'pending' | 'consumed';
}

/** The three PostgREST/Postgres error shapes that mean "this relation/RPC does not exist on this DB" —
 *  schema-drift class (B-383), same idiom as `isMissingPendingResolution` / `isMissingAcceptRemark` in
 *  briefs.ts. NEVER matches a permission error, a transient network failure, or any other error class —
 *  those must propagate and be retried, never silently read as "substrate absent". */
function isMissingRelationOrFunction(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  // 42P01 = undefined_table, 42883 = undefined_function (raw Postgres codes, reachable via RPC).
  // PGRST202 = PostgREST "function not found in schema cache", PGRST205 = "table not found in schema cache".
  if (code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205') return true;
  const msg = err.message ?? '';
  return /schema cache/i.test(msg) && /(could not find|does not exist)/i.test(msg);
}

export type SubstrateProbeResult = 'present' | 'absent';

/** PROBE 3 — the absent-substrate probe. A cheap, side-effect-free read against `pending_acceptance_events`.
 *  Returns 'present' | 'absent'; THROWS on any other error (a transient blip must be retried by the
 *  caller, never silently misread as "substrate absent" — that is precisely the failure mode PROBE 3
 *  exists to rule out). */
export async function probeAcceptanceEventSubstrate(client: SupabaseClient): Promise<SubstrateProbeResult> {
  const { error } = await client.from('pending_acceptance_events').select('id').limit(0);
  if (!error) return 'present';
  if (isMissingRelationOrFunction(error)) return 'absent';
  throw new Error(`acceptance-event substrate probe failed (not a schema-absence error — do not degrade): ${error.message}`);
}

/** Read the task's outstanding pending-acceptance-event, if any — degrading to `null` when the substrate
 *  is absent (old DB) exactly like every other guarded read in this codebase (fetchPendingResolution,
 *  fetchPendingRemark). Any OTHER error propagates. */
export async function getPendingAcceptanceEvent(
  client: SupabaseClient,
  projectId: string,
  taskId: string,
): Promise<PendingAcceptanceEvent | null> {
  const resolvedId = await resolveTaskId(client, projectId, taskId);

  const { data: task, error: taskErr } = await client
    .from('tasks')
    .select('pending_acceptance_event_id')
    .eq('id', resolvedId)
    .maybeSingle();
  if (taskErr) {
    if (isMissingRelationOrFunction(taskErr)) return null;
    throw new Error(taskErr.message);
  }
  const eventId = (task as { pending_acceptance_event_id?: string | null } | null)?.pending_acceptance_event_id;
  if (!eventId) return null;

  const { data: event, error: eventErr } = await client
    .from('pending_acceptance_events')
    .select('id, task_id, brief_id, reason, payload, pending_activity, status')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) {
    if (isMissingRelationOrFunction(eventErr)) return null;
    throw new Error(eventErr.message);
  }
  return (event as PendingAcceptanceEvent | null) ?? null;
}

const KNOWN_WRITE_KINDS = new Set(['acceptance_criterion', 'child_ticket', 'checklist_item', 'ac_transfer', 'label_add']);

/** B-816 — the live snapshot shape from `resolve_brief` (which snapshots a brief's whole `doc` VERBATIM)
 *  is `event.payload.payload` (an array): B-810's `compose_brief` call sites author the structured
 *  payload array at `doc.payload`, so the doc-nested `{ decide, items, payload: [...] }` shape carries it
 *  one level deeper than a bare array or `.items`. Check `payload.payload` FIRST — it is the shape every
 *  current `compose_brief` call site actually produces — falling back to the bare-array/`.items` shapes
 *  for any other caller that still uses them. */
function rawItemsOf(payload: PendingAcceptanceEvent['payload']): unknown[] {
  const withNestedPayload = payload as { payload?: unknown };
  if (Array.isArray(withNestedPayload?.payload)) return withNestedPayload.payload;
  if (Array.isArray(payload)) return payload;
  const withItems = payload as { items?: unknown[] };
  return Array.isArray(withItems?.items) ? withItems.items : [];
}

function itemsOf(payload: PendingAcceptanceEvent['payload']): AcceptanceEventPayloadItem[] {
  return rawItemsOf(payload) as AcceptanceEventPayloadItem[];
}

export type PayloadShape = 'empty' | 'structured' | 'unrecognized';

/**
 * Classify the snapshotted payload BEFORE acting on it — the safety valve that keeps a not-yet-wired
 * compose-time payload from silently reading as "nothing to do". A brief's `doc` is snapshotted VERBATIM
 * (technical decision a48df5db): today that is the generic BLUF `{decide, items: [{kind, text,
 * recommendation}], ...}` shape until every `compose_brief` call site is updated to also author the
 * `AcceptanceEventPayloadItem[]` shape this consumer understands. Silently treating an unrecognized shape
 * as "0 items, nothing to apply" would commit a HOLLOW advance — precisely the bug this ticket exists to
 * close, just moved one layer down. So:
 *   - 'empty'        — no items at all (a legitimate zero-payload accept, e.g. decompose's "no split").
 *                       Safe to auto-consume with 0 writes applied.
 *   - 'structured'    — every item carries a recognized `write_kind` — safe to apply via the RPCs.
 *   - 'unrecognized'  — items exist but are NOT in the structured shape (e.g. today's generic BLUF
 *                       `items`). MUST NOT auto-consume — the caller must fall back to the gate's existing
 *                       materialization mechanism (self-heal / the skill's own direct writes), THEN call
 *                       `consumeAcceptanceEvent` explicitly once that materialization is confirmed done.
 */
export function classifyPayload(payload: PendingAcceptanceEvent['payload']): PayloadShape {
  const raw = rawItemsOf(payload);
  if (raw.length === 0) return 'empty';
  const allStructured = raw.every(
    (i) => typeof i === 'object' && i !== null && KNOWN_WRITE_KINDS.has((i as { write_kind?: unknown }).write_kind as string),
  );
  return allStructured ? 'structured' : 'unrecognized';
}

export interface ApplyPayloadResult {
  event_id: string;
  applied: number;
  skipped_already_done: number;
  by_write_kind: Record<string, number>;
  /** B-688/B-383 — set ONLY when a per-write-kind RPC itself does not exist yet on this DB (the plugin's
   *  `main` can reach prod before harmony-web's migration is promoted). Every write attempted BEFORE this
   *  write_kind was reached already landed (or was already-landed/skipped) via its own idempotent ledger
   *  — safe to leave as-is. The caller MUST treat this exactly like an 'unrecognized' payload shape: never
   *  call `consumeAcceptanceEvent`, leave the event visibly pending, let a later retry (once the migration
   *  lands) pick up where this left off. */
  substrate_absent_for?: AcceptanceEventPayloadItem['write_kind'];
}

/** Internal-only signal (never escapes this module) distinguishing "the RPC for this write_kind does not
 *  exist on this DB yet" (B-383 schema-drift window) from every other RPC error. Thrown at the dispatch
 *  site, caught immediately below — turned into `ApplyPayloadResult.substrate_absent_for`, never an
 *  opaque throw. */
class WriteKindSubstrateAbsentError extends Error {
  constructor(public readonly writeKind: AcceptanceEventPayloadItem['write_kind']) {
    super(`substrate absent for write_kind '${writeKind}' (RPC not found — B-383 pre-migration window)`);
  }
}

/** Execute every promised write for one event's payload, via the per-write-kind SECURITY DEFINER RPCs.
 *  ORDER MATTERS: child_ticket writes land BEFORE ac_transfer writes (a transfer resolves its destination
 *  child through the SAME event's already-landed child_ticket ledger row — the DB RPC raises loudly if
 *  the target hasn't been minted yet). Idempotent by construction: each RPC's own ledger
 *  (event_id, write_kind, external_ref) UNIQUE constraint makes re-applying an already-landed write a
 *  no-op, so calling this twice on the same event (a retry after a partial failure) mints/files/lands
 *  exactly the writes still missing — never a duplicate.
 *
 *  Does NOT call consume_acceptance_event — that is the caller's job, and only after this returns
 *  without throwing AND without `substrate_absent_for` set. A thrown error here must leave the event
 *  'pending' (AC(c)): never call consume on a partially-applied payload. Same invariant applies to the
 *  `substrate_absent_for` degrade path (B-688/B-383) — it returns rather than throws (so it is not
 *  mistaken for a real failure needing loud escalation), but the caller must still never consume on it. */
export async function applyAcceptanceEventPayload(
  client: SupabaseClient,
  event: PendingAcceptanceEvent,
): Promise<ApplyPayloadResult> {
  const items = itemsOf(event.payload);
  const order: AcceptanceEventPayloadItem['write_kind'][] = [
    'child_ticket', 'checklist_item', 'acceptance_criterion', 'ac_transfer', 'label_add',
  ];
  const ordered = order.flatMap((kind) => items.filter((i) => i.write_kind === kind));

  let applied = 0;
  let skipped = 0;
  const byKind: Record<string, number> = {};

  try {
    for (const item of ordered) {
      if (!item.ref) throw new Error(`payload item of write_kind '${item.write_kind}' is missing its stable 'ref' — cannot derive an idempotent external_ref`);

      let result: { applied?: boolean } | null = null;
      if (item.write_kind === 'acceptance_criterion') {
        if (!item.content) throw new Error(`acceptance_criterion item '${item.ref}' is missing content`);
        const { data, error } = await client.rpc('consume_ac_add_write', {
          _event_id: event.id, _external_ref: item.ref, _content: item.content,
        });
        if (error) throw new Error(error.message);
        result = data as { applied?: boolean };
      } else if (item.write_kind === 'child_ticket') {
        if (!item.title) throw new Error(`child_ticket item '${item.ref}' is missing title`);
        const { data, error } = await client.rpc('consume_child_mint_write', {
          _event_id: event.id, _external_ref: item.ref, _title: item.title, _description: item.description ?? null,
        });
        if (error) throw new Error(error.message);
        result = data as { applied?: boolean };
      } else if (item.write_kind === 'checklist_item') {
        if (!item.title) throw new Error(`checklist_item item '${item.ref}' is missing title`);
        const { data, error } = await client.rpc('consume_checklist_item_write', {
          _event_id: event.id, _external_ref: item.ref, _title: item.title,
        });
        if (error) throw new Error(error.message);
        result = data as { applied?: boolean };
      } else if (item.write_kind === 'ac_transfer') {
        if (!item.content) throw new Error(`ac_transfer item '${item.ref}' is missing content`);
        if (!item.target_child_ref) throw new Error(`ac_transfer item '${item.ref}' is missing target_child_ref`);
        const { data, error } = await client.rpc('consume_ac_transfer_write', {
          _event_id: event.id, _external_ref: item.ref, _content: item.content,
          _target_child_external_ref: item.target_child_ref, _from_ac_id: item.from_ac_id ?? null,
        });
        if (error) throw new Error(error.message);
        result = data as { applied?: boolean };
      } else if (item.write_kind === 'label_add') {
        if (item.label_name === '') throw new Error(`label_add item '${item.ref}' has an empty label_name`);
        const labelName = item.label_name ?? 'decision-only';
        const { data, error } = await client.rpc('consume_label_add_write', {
          _event_id: event.id, _external_ref: item.ref, _label_name: labelName,
        });
        if (error) {
          // B-383 hazard: consume_label_add_write itself may not exist yet on this DB — degrade SAFELY
          // (never an opaque throw) rather than treating it like a real write failure. A guard-blocked
          // call (RAISE EXCEPTION ... USING ERRCODE = 'check_violation') is NOT this class — it is a real
          // error and must propagate untouched (never swallowed).
          if (isMissingRelationOrFunction(error)) throw new WriteKindSubstrateAbsentError('label_add');
          throw new Error(error.message);
        }
        result = data as { applied?: boolean };
      }

      if (result?.applied) {
        applied += 1;
        byKind[item.write_kind] = (byKind[item.write_kind] ?? 0) + 1;
      } else {
        skipped += 1;
      }
    }
  } catch (err) {
    if (err instanceof WriteKindSubstrateAbsentError) {
      return { event_id: event.id, applied, skipped_already_done: skipped, by_write_kind: byKind, substrate_absent_for: err.writeKind };
    }
    throw err;
  }

  return { event_id: event.id, applied, skipped_already_done: skipped, by_write_kind: byKind };
}

export interface ConsumeAcceptanceEventResult {
  event_id: string;
  task_id: string;
  status: string;
  workflow_state: string | null;
  idempotent: boolean;
}

/** The FINAL commit — call ONLY after `applyAcceptanceEventPayload` has returned without throwing (every
 *  promised write has landed, or was already landed on a prior attempt). Idempotent: a second call on an
 *  already-consumed event is a safe no-op (the DB RPC itself guards this). */
export async function consumeAcceptanceEvent(
  client: SupabaseClient,
  eventId: string,
): Promise<ConsumeAcceptanceEventResult> {
  const { data, error } = await client.rpc('consume_acceptance_event', { _event_id: eventId });
  if (error) throw new Error(error.message);
  return data as ConsumeAcceptanceEventResult;
}

export interface ConsumePendingAcceptanceResult {
  status: 'none' | 'substrate-absent' | 'consumed' | 'payload-unrecognized';
  event_id?: string;
  reason?: string;
  applied?: number;
  skipped_already_done?: number;
  /** B-688 — the newly-applied count broken down by write_kind (e.g. `{ acceptance_criterion: 2,
   *  label_add: 1 }`). Only set on the `consumed` branch; lets a caller (e.g. harmony-clarify's accept
   *  path) recover "how many ACs did THIS call file" without re-deriving it from `applied`, which mixes
   *  every write_kind together. */
  by_write_kind?: Record<string, number>;
  workflow_state?: string | null;
  /** B-816 — ONLY set on the `payload-unrecognized` branch: the verbatim `rawItemsOf(event.payload)`
   *  snapshot the human already accepted. The owning gate's materialization renders THESE items
   *  (title/content per item) as a confirm-or-adjust ask — never a re-read via `get_task` /
   *  `get_pending_acceptance_event`, and never an open "what did you accept?" re-dictation question. */
  items?: unknown[];
}

/**
 * The leg-start-consume entry point (checklist #8) — shaped like the existing B-747 leg-start check:
 * runs BEFORE gate routing/floors. Feature-detects the substrate FIRST (PROBE 3); when absent, degrades
 * to today's behavior — `{ status: 'substrate-absent' }`, nothing else happens, no error. When present
 * but there is no outstanding event, `{ status: 'none' }`. Otherwise applies every promised write and
 * commits the deferred advance, returning a summary.
 *
 * A thrown error here (from `applyAcceptanceEventPayload` or `consumeAcceptanceEvent`) is NOT caught —
 * it propagates. Swallowing it would be exactly the hollow-advance bug this ticket exists to close: the
 * event must stay visibly 'pending' (and `tasks.pending_acceptance_event_id` still set) on failure, which
 * is already true by construction (this function only clears it by calling consume_acceptance_event,
 * which is unreached on a thrown error) — but a caller that swallows the throw would hide the failure
 * from the human/daemon retry loop. Callers MUST let this propagate (or explicitly surface it), never
 * silently continue past it.
 */
export async function consumePendingAcceptanceEvent(
  client: SupabaseClient,
  projectId: string,
  taskId: string,
): Promise<ConsumePendingAcceptanceResult> {
  const probe = await probeAcceptanceEventSubstrate(client);
  if (probe === 'absent') return { status: 'substrate-absent' };

  const event = await getPendingAcceptanceEvent(client, projectId, taskId);
  if (!event) return { status: 'none' };
  if (event.status === 'consumed') return { status: 'none' };

  // The safety valve (see classifyPayload): an unrecognized payload shape must NEVER auto-consume — that
  // would commit a hollow advance under a new name. Leave the event visibly pending; the caller must
  // route to the gate's existing materialization mechanism and then call consumeAcceptanceEvent directly
  // once it has confirmed the work is done.
  if (classifyPayload(event.payload) === 'unrecognized') {
    return { status: 'payload-unrecognized', event_id: event.id, reason: event.reason, items: rawItemsOf(event.payload) };
  }

  const applyResult = await applyAcceptanceEventPayload(client, event);

  // B-688/B-383 — a write-kind's RPC substrate isn't deployed yet on this DB. Degrade EXACTLY like the
  // unrecognized-payload safety valve above: never call consume_acceptance_event, leave the event
  // visibly pending, hand back the same status/shape every existing caller already knows how to route
  // (harmony-clarify's self-heal fallback, the conductor's §1c routing) — no new status string.
  if (applyResult.substrate_absent_for) {
    return { status: 'payload-unrecognized', event_id: event.id, reason: event.reason, items: rawItemsOf(event.payload) };
  }

  const consumeResult = await consumeAcceptanceEvent(client, event.id);

  return {
    status: 'consumed',
    event_id: event.id,
    applied: applyResult.applied,
    skipped_already_done: applyResult.skipped_already_done,
    by_write_kind: applyResult.by_write_kind,
    workflow_state: consumeResult.workflow_state,
  };
}

export const consumePendingAcceptanceEventTool = {
  name: 'consume_pending_acceptance_event',
  description:
    'B-797 leg-start-consume: check for and execute an outstanding accepted-brief payload (proposed ACs, ' +
    'decompose children + AC transfers, plan-step checklist, design AC refinements, B-688 decision-only ' +
    'label proposals) BEFORE any gate routing/floor check runs. Call this FIRST, on every leg pickup — ' +
    'mirrors the B-747 leg-start check. Feature-detects the substrate (never by plugin version): on an ' +
    'older DB without the B-797 tables/RPCs returns { status: "substrate-absent" } and changes nothing ' +
    '(today\'s synchronous behavior is exactly preserved). { status: "none" } = no outstanding event. ' +
    '{ status: "consumed" } = every promised write landed (idempotently — a retry after a partial failure ' +
    'only applies what is still missing) and the deferred workflow-state advance committed; ' +
    '`workflow_state` is the ticket\'s new state; `by_write_kind` breaks `applied` down per write_kind ' +
    '(e.g. how many NEW acceptance_criterion writes this call itself filed). ' +
    '{ status: "payload-unrecognized", event_id, reason, items } = EITHER the event\'s snapshotted payload ' +
    'is not (yet) in the structured shape this tool applies, OR (B-688/B-383) a recognized write_kind\'s ' +
    'own RPC is not yet deployed on this DB (a pre-migration window) — both degrade to the SAME status/ ' +
    'shape and the SAME caller handling; do not try to distinguish them. `items` (B-816) is the VERBATIM ' +
    'snapshotted raw items the human already accepted — the owning gate\'s materialization MUST render ' +
    'these items (title/content per item) as a confirm-or-adjust ask, never re-read them via `get_task` / ' +
    '`get_pending_acceptance_event`, and never fall back to an open "what did you accept?" re-dictation ' +
    'question; only residue genuinely absent from `items` is a legitimate open question. Route to the ' +
    'OWNING GATE SKILL\'s existing materialization (e.g. the design-decide B-744 self-heal for clarify ' +
    'ACs, decompose\'s own B-646 existing-child detection), confirm the work is done, THEN call ' +
    '`consume_acceptance_event({ event_id })` directly to commit the deferred advance. NEVER treat ' +
    '"payload-unrecognized" as "nothing to do" — that would commit a hollow advance under a new name. ' +
    'Throws (does NOT swallow) if a recognized payload write fails — the event stays visibly pending; ' +
    'do not catch-and-continue.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)' },
    },
    required: ['task_id'],
  },
};

export async function consumePendingAcceptanceEventToolHandler(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string },
): Promise<ConsumePendingAcceptanceResult> {
  if (!args.task_id) throw new Error('task_id is required');
  return consumePendingAcceptanceEvent(client, projectId, args.task_id);
}

export const consumeAcceptanceEventTool = {
  name: 'consume_acceptance_event',
  description:
    'B-797 — the FINAL commit for a pending acceptance event: marks it consumed, clears ' +
    'tasks.pending_acceptance_event_id, and applies the brief\'s originally-deferred workflow-state advance ' +
    '(if any), atomically. Call this DIRECTLY (skipping consume_pending_acceptance_event\'s payload-apply ' +
    'step) in the SAME-SESSION accept path: the owning gate skill just finished its OWN materialization ' +
    '(e.g. clarify\'s manage_acceptance_criteria call, decompose\'s manage_subtasks call) as it always did ' +
    'before B-797, so there is nothing left to apply — only the deferred advance to commit. `resolve_brief`\'s ' +
    'response carries `pending_acceptance_event_id`; when non-null, call this with it right after resolving. ' +
    'Idempotent — a second call on an already-consumed event is a safe no-op.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      event_id: { type: 'string', description: "The pending acceptance event's id (from resolve_brief's pending_acceptance_event_id, or get task/get_pending_acceptance_event)." },
    },
    required: ['event_id'],
  },
};

export async function consumeAcceptanceEventToolHandler(
  client: SupabaseClient,
  args: { event_id: string },
): Promise<ConsumeAcceptanceEventResult> {
  if (!args.event_id) throw new Error('event_id is required');
  return consumeAcceptanceEvent(client, args.event_id);
}
