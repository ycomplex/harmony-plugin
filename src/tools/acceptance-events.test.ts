import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  probeAcceptanceEventSubstrate,
  getPendingAcceptanceEvent,
  applyAcceptanceEventPayload,
  consumeAcceptanceEvent,
  consumePendingAcceptanceEvent,
  classifyPayload,
  type PendingAcceptanceEvent,
  type AcceptanceEventPayloadItem,
} from './acceptance-events.js';

// Pass-through, mirroring briefs.test.ts's convention.
vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_client: unknown, _projectId: string, input: string) => input),
}));

const PROJECT_ID = 'project-1';

/** A minimal chainable `.from()` mock: each call to a chain method advances to the queued response for
 *  that TABLE. `.rpc()` is a separate queue keyed by function name. */
function makeClient(opts: {
  fromResponses?: Record<string, Array<{ data: unknown; error?: unknown }>>;
  rpcResponses?: Record<string, Array<{ data: unknown; error?: unknown }>>;
} = {}) {
  const fromQueues = opts.fromResponses ?? {};
  const rpcQueues = opts.rpcResponses ?? {};
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const from = vi.fn((table: string) => {
    const queue = fromQueues[table] ?? [];
    const chain: any = {};
    for (const m of ['select', 'eq', 'limit']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => queue.shift() ?? { data: null, error: null });
    // `.select('id').limit(0)` (the substrate probe) resolves via the thenable itself, not maybeSingle.
    chain.then = (resolve: (v: unknown) => unknown) => resolve(queue.shift() ?? { data: null, error: null });
    return chain;
  });

  const rpc = vi.fn(async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    const queue = rpcQueues[name] ?? [];
    return queue.shift() ?? { data: null, error: null };
  });

  return { from, rpc, rpcCalls } as any;
}

describe('probeAcceptanceEventSubstrate (PROBE 3)', () => {
  it('returns "present" when the table read succeeds', async () => {
    const client = makeClient({ fromResponses: { pending_acceptance_events: [{ data: [], error: null }] } });
    await expect(probeAcceptanceEventSubstrate(client)).resolves.toBe('present');
  });

  it('returns "absent" on a Postgres 42P01 (undefined_table) error', async () => {
    const client = makeClient({
      fromResponses: { pending_acceptance_events: [{ data: null, error: { code: '42P01', message: 'relation does not exist' } }] },
    });
    await expect(probeAcceptanceEventSubstrate(client)).resolves.toBe('absent');
  });

  it('returns "absent" on a PostgREST PGRST205 schema-cache table-not-found error', async () => {
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.pending_acceptance_events' in the schema cache" } }],
      },
    });
    await expect(probeAcceptanceEventSubstrate(client)).resolves.toBe('absent');
  });

  it('THROWS (never degrades) on a transient/unrelated error — TEST #12', async () => {
    const client = makeClient({
      fromResponses: { pending_acceptance_events: [{ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }] },
    });
    await expect(probeAcceptanceEventSubstrate(client)).rejects.toThrow(/statement timeout/);
  });

  it('THROWS on a permission error (never misread as "substrate absent")', async () => {
    const client = makeClient({
      fromResponses: { pending_acceptance_events: [{ data: null, error: { code: '42501', message: 'permission denied for table pending_acceptance_events' } }] },
    });
    await expect(probeAcceptanceEventSubstrate(client)).rejects.toThrow(/permission denied/);
  });
});

describe('getPendingAcceptanceEvent', () => {
  it('returns null when the task has no outstanding event', async () => {
    const client = makeClient({ fromResponses: { tasks: [{ data: { pending_acceptance_event_id: null } }] } });
    await expect(getPendingAcceptanceEvent(client, PROJECT_ID, 'task-1')).resolves.toBeNull();
  });

  it('returns the event row when the task points at one', async () => {
    const event = { id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'plan-draft', payload: { items: [] }, pending_activity: 'planning', status: 'pending' };
    const client = makeClient({
      fromResponses: {
        tasks: [{ data: { pending_acceptance_event_id: 'event-1' } }],
        pending_acceptance_events: [{ data: event }],
      },
    });
    await expect(getPendingAcceptanceEvent(client, PROJECT_ID, 'task-1')).resolves.toEqual(event);
  });

  it('degrades to null on an absent-substrate error reading the task column', async () => {
    const client = makeClient({
      fromResponses: { tasks: [{ data: null, error: { code: 'PGRST205', message: 'schema cache: column tasks.pending_acceptance_event_id does not exist' } }] },
    });
    await expect(getPendingAcceptanceEvent(client, PROJECT_ID, 'task-1')).resolves.toBeNull();
  });
});

const childItem = (ref: string, over: Partial<AcceptanceEventPayloadItem> = {}): AcceptanceEventPayloadItem => ({
  write_kind: 'child_ticket', ref, title: `Child ${ref}`, ...over,
});
const acItem = (ref: string, over: Partial<AcceptanceEventPayloadItem> = {}): AcceptanceEventPayloadItem => ({
  write_kind: 'acceptance_criterion', ref, content: `AC ${ref}`, ...over,
});
const checklistItem = (ref: string, over: Partial<AcceptanceEventPayloadItem> = {}): AcceptanceEventPayloadItem => ({
  write_kind: 'checklist_item', ref, title: `Step ${ref}`, ...over,
});
const transferItem = (ref: string, targetRef: string, over: Partial<AcceptanceEventPayloadItem> = {}): AcceptanceEventPayloadItem => ({
  write_kind: 'ac_transfer', ref, content: `Transferred AC ${ref}`, target_child_ref: targetRef, ...over,
});
const labelAddItem = (ref: string, over: Partial<AcceptanceEventPayloadItem> = {}): AcceptanceEventPayloadItem => ({
  write_kind: 'label_add', ref, label_name: 'decision-only', ...over,
});

function makeEvent(items: AcceptanceEventPayloadItem[]): PendingAcceptanceEvent {
  return {
    id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'decomposition-proposal',
    payload: { items }, pending_activity: 'decomposing', status: 'pending',
  };
}

describe('applyAcceptanceEventPayload', () => {
  it('applies every write-kind, mapping each to its dedicated RPC', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_child_mint_write: [{ data: { applied: true, result_id: 'child-a' } }],
        consume_checklist_item_write: [{ data: { applied: true } }],
        consume_ac_add_write: [{ data: { applied: true } }],
      },
    });
    const event = makeEvent([acItem('ac-1'), checklistItem('step-1'), childItem('child-1')]);
    const result = await applyAcceptanceEventPayload(client, event);
    expect(result.applied).toBe(3);
    expect(result.skipped_already_done).toBe(0);
    expect(client.rpc).toHaveBeenCalledWith('consume_child_mint_write', {
      _event_id: 'event-1', _external_ref: 'child-1', _title: 'Child child-1', _description: null,
    });
    expect(client.rpc).toHaveBeenCalledWith('consume_checklist_item_write', {
      _event_id: 'event-1', _external_ref: 'step-1', _title: 'Step step-1',
    });
    expect(client.rpc).toHaveBeenCalledWith('consume_ac_add_write', {
      _event_id: 'event-1', _external_ref: 'ac-1', _content: 'AC ac-1',
    });
  });

  it('orders child_ticket writes BEFORE ac_transfer writes, regardless of payload order', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_child_mint_write: [{ data: { applied: true, result_id: 'child-a' } }],
        consume_ac_transfer_write: [{ data: { applied: true } }],
      },
    });
    // ac_transfer authored FIRST in the payload array — the function must still apply children first.
    const event = makeEvent([transferItem('xfer-1', 'child-1'), childItem('child-1')]);
    await applyAcceptanceEventPayload(client, event);
    const order = client.rpcCalls.map((c: { name: string }) => c.name);
    expect(order).toEqual(['consume_child_mint_write', 'consume_ac_transfer_write']);
    expect(client.rpc).toHaveBeenCalledWith('consume_ac_transfer_write', {
      _event_id: 'event-1', _external_ref: 'xfer-1', _content: 'Transferred AC xfer-1',
      _target_child_external_ref: 'child-1', _from_ac_id: null,
    });
  });

  // TEST #10 — retry after a simulated partial mint: already-landed writes report applied:false (the
  // ledger's ON CONFLICT DO NOTHING short-circuit); the plugin must count them as skipped, not re-count
  // them as newly applied, and must NOT error.
  it('TEST #10 — a retry where some writes already landed counts them as skipped, not duplicated', async () => {
    const client = makeClient({
      rpcResponses: {
        // children 1-3 already landed on a prior attempt (applied:false); 4-5 are new (applied:true).
        consume_child_mint_write: [
          { data: { applied: false } },
          { data: { applied: false } },
          { data: { applied: false } },
          { data: { applied: true, result_id: 'child-4' } },
          { data: { applied: true, result_id: 'child-5' } },
        ],
      },
    });
    const event = makeEvent([1, 2, 3, 4, 5].map((n) => childItem(`child-${n}`)));
    const result = await applyAcceptanceEventPayload(client, event);
    expect(result.applied).toBe(2);
    expect(result.skipped_already_done).toBe(3);
    expect(client.rpc).toHaveBeenCalledTimes(5);
  });

  it('propagates an RPC error (never swallows it) — TEST #11 crash-before-consume shape', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_child_mint_write: [{ data: null, error: { message: 'insert violates a constraint' } }],
      },
    });
    const event = makeEvent([childItem('child-1'), childItem('child-2')]);
    await expect(applyAcceptanceEventPayload(client, event)).rejects.toThrow(/insert violates a constraint/);
    // The SECOND item must never be attempted once the first has thrown.
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when a payload item is missing its stable ref', async () => {
    const client = makeClient();
    const event = makeEvent([{ write_kind: 'acceptance_criterion', content: 'no ref', ref: '' } as AcceptanceEventPayloadItem]);
    await expect(applyAcceptanceEventPayload(client, event)).rejects.toThrow(/missing its stable 'ref'/);
  });

  // B-688 — label_add dispatch: calls consume_label_add_write with the right args, mirroring the
  // child_ticket dispatch test above.
  it('dispatches a label_add item to consume_label_add_write with the right args', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_label_add_write: [{ data: { applied: true, result_id: 'label-1' } }],
      },
    });
    const event = makeEvent([labelAddItem('label-decision-only')]);
    const result = await applyAcceptanceEventPayload(client, event);
    expect(result.applied).toBe(1);
    expect(result.by_write_kind).toEqual({ label_add: 1 });
    expect(client.rpc).toHaveBeenCalledWith('consume_label_add_write', {
      _event_id: 'event-1', _external_ref: 'label-decision-only', _label_name: 'decision-only',
    });
  });

  it('defaults label_name to "decision-only" when the item omits it', async () => {
    const client = makeClient({
      rpcResponses: { consume_label_add_write: [{ data: { applied: true, result_id: 'label-1' } }] },
    });
    const event = makeEvent([{ write_kind: 'label_add', ref: 'label-decision-only' }]);
    await applyAcceptanceEventPayload(client, event);
    expect(client.rpc).toHaveBeenCalledWith('consume_label_add_write', {
      _event_id: 'event-1', _external_ref: 'label-decision-only', _label_name: 'decision-only',
    });
  });

  // Idempotent re-apply: applied:false on retry (mirrors TEST #10's shape for a single item).
  it('a retry where the label_add already landed reports applied:false — counted as skipped, not duplicated', async () => {
    const client = makeClient({
      rpcResponses: { consume_label_add_write: [{ data: { applied: false } }] },
    });
    const event = makeEvent([labelAddItem('label-decision-only')]);
    const result = await applyAcceptanceEventPayload(client, event);
    expect(result.applied).toBe(0);
    expect(result.skipped_already_done).toBe(1);
  });

  // Guard-blocked: consume_label_add_write raises RAISE EXCEPTION ... USING ERRCODE = 'check_violation'
  // (the guard, can_mark_decision_only, blocked it BEFORE the ledger insert) — this must propagate as a
  // thrown error, NEVER be swallowed or misread as the B-383 missing-substrate case.
  it('propagates a guard-blocked (check_violation) label_add error — never swallowed', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_label_add_write: [{ data: null, error: { code: '23514', message: 'decision-only guard blocked: build-shape (task abc-123)' } }],
      },
    });
    const event = makeEvent([labelAddItem('label-decision-only')]);
    await expect(applyAcceptanceEventPayload(client, event)).rejects.toThrow(/decision-only guard blocked: build-shape/);
  });

  // The B-383 hazard: consume_label_add_write itself doesn't exist yet on this DB (pre-migration window).
  // Must degrade SAFELY — returns rather than throws, and reports which write_kind hit the absent
  // substrate, rather than surfacing an opaque/unhandled error.
  it('B-383 — a missing consume_label_add_write RPC (42883) degrades to substrate_absent_for, never throws', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_label_add_write: [{ data: null, error: { code: '42883', message: 'function consume_label_add_write(uuid, text, text) does not exist' } }],
      },
    });
    const event = makeEvent([labelAddItem('label-decision-only')]);
    const result = await applyAcceptanceEventPayload(client, event);
    expect(result.substrate_absent_for).toBe('label_add');
    expect(result.applied).toBe(0);
  });

  it('B-383 — a missing consume_label_add_write RPC via PGRST202 also degrades to substrate_absent_for', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_label_add_write: [{ data: null, error: { code: 'PGRST202', message: "Could not find the function public.consume_label_add_write in the schema cache" } }],
      },
    });
    const event = makeEvent([labelAddItem('label-decision-only')]);
    const result = await applyAcceptanceEventPayload(client, event);
    expect(result.substrate_absent_for).toBe('label_add');
  });

  it('B-383 — writes that landed BEFORE the missing label_add RPC are preserved in the result (not lost)', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_ac_add_write: [{ data: { applied: true } }],
        consume_label_add_write: [{ data: null, error: { code: '42883', message: 'function does not exist' } }],
      },
    });
    const event = makeEvent([acItem('ac-1'), labelAddItem('label-decision-only')]);
    const result = await applyAcceptanceEventPayload(client, event);
    expect(result.substrate_absent_for).toBe('label_add');
    expect(result.applied).toBe(1);
    expect(result.by_write_kind).toEqual({ acceptance_criterion: 1 });
  });
});

describe('consumeAcceptanceEvent', () => {
  it('calls the RPC and returns its result', async () => {
    const client = makeClient({
      rpcResponses: { consume_acceptance_event: [{ data: { event_id: 'event-1', task_id: 'task-1', status: 'consumed', workflow_state: 'Decomposed', idempotent: false } }] },
    });
    const result = await consumeAcceptanceEvent(client, 'event-1');
    expect(result.workflow_state).toBe('Decomposed');
    expect(client.rpc).toHaveBeenCalledWith('consume_acceptance_event', { _event_id: 'event-1' });
  });

  it('throws on an RPC error', async () => {
    const client = makeClient({ rpcResponses: { consume_acceptance_event: [{ data: null, error: { message: 'no transition' } }] } });
    await expect(consumeAcceptanceEvent(client, 'event-1')).rejects.toThrow(/no transition/);
  });
});

describe('consumePendingAcceptanceEvent — the leg-start-consume orchestrator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('degrades SILENTLY to today\'s behavior when the substrate is absent — TEST #12', async () => {
    const client = makeClient({
      fromResponses: { pending_acceptance_events: [{ data: null, error: { code: 'PGRST205', message: 'schema cache: table not found' } }] },
    });
    const result = await consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1');
    expect(result).toEqual({ status: 'substrate-absent' });
    // Nothing else was ever attempted — no tasks/event read, no RPC call.
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('propagates (never degrades) a transient probe error — TEST #12', async () => {
    const client = makeClient({
      fromResponses: { pending_acceptance_events: [{ data: null, error: { code: '57014', message: 'statement timeout' } }] },
    });
    await expect(consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1')).rejects.toThrow(/statement timeout/);
  });

  it('returns {status:"none"} when the substrate is present but nothing is outstanding', async () => {
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: [], error: null }],
        tasks: [{ data: { pending_acceptance_event_id: null } }],
      },
    });
    const result = await consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1');
    expect(result).toEqual({ status: 'none' });
  });

  it('applies every write then commits the deferred advance — the happy path', async () => {
    const event = { id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'plan-draft', payload: { items: [checklistItem('step-1')] }, pending_activity: 'planning', status: 'pending' };
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: [], error: null }, { data: event }],
        tasks: [{ data: { pending_acceptance_event_id: 'event-1' } }],
      },
      rpcResponses: {
        consume_checklist_item_write: [{ data: { applied: true, result_id: 'item-1' } }],
        consume_acceptance_event: [{ data: { event_id: 'event-1', task_id: 'task-1', status: 'consumed', workflow_state: 'Planned', idempotent: false } }],
      },
    });
    const result = await consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1');
    expect(result.status).toBe('consumed');
    expect(result.applied).toBe(1);
    expect(result.workflow_state).toBe('Planned');
    expect(client.rpc).toHaveBeenCalledWith('consume_acceptance_event', { _event_id: 'event-1' });
  });

  // TEST #11 — a payload-write failure must leave the event visibly pending: consume_acceptance_event
  // must NEVER be called when applyAcceptanceEventPayload throws, and the throw must propagate (not be
  // swallowed) so the caller/human/daemon retry loop sees it.
  it('TEST #11 — never calls consume_acceptance_event when a payload write fails; the error propagates', async () => {
    const event = { id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'decomposition-proposal', payload: { items: [childItem('child-1')] }, pending_activity: 'decomposing', status: 'pending' };
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: [], error: null }, { data: event }],
        tasks: [{ data: { pending_acceptance_event_id: 'event-1' } }],
      },
      rpcResponses: {
        consume_child_mint_write: [{ data: null, error: { message: 'insert violates a constraint' } }],
      },
    });
    await expect(consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1')).rejects.toThrow(/insert violates a constraint/);
    expect(client.rpc).not.toHaveBeenCalledWith('consume_acceptance_event', expect.anything());
  });
});


describe('classifyPayload — the safety valve against a hollow advance under a new name', () => {
  it('classifies a genuinely empty payload as "empty" (e.g. decompose\'s "no split")', () => {
    expect(classifyPayload({ items: [] })).toBe('empty');
    expect(classifyPayload([])).toBe('empty');
  });

  it('classifies every-item-recognized payloads as "structured"', () => {
    expect(classifyPayload({ items: [childItem('child-1'), acItem('ac-1')] })).toBe('structured');
  });

  // B-688 — label_add is a KNOWN write_kind: a payload mixing it with acceptance_criterion items (the
  // clarify-proposed decision-only shape) classifies "structured", never "unrecognized".
  it('classifies a mix of acceptance_criterion + label_add items as "structured" (B-688)', () => {
    expect(classifyPayload({ items: [acItem('ac-1'), labelAddItem('label-decision-only')] })).toBe('structured');
  });

  it('classifies today\'s generic BLUF `doc.items` shape ({kind, text, recommendation}) as "unrecognized" — NEVER silently empty', () => {
    const briefDocItems = [{ kind: 'decision', text: 'Pick sidebar placement', recommendation: 'Sub-section' }];
    expect(classifyPayload({ items: briefDocItems })).toBe('unrecognized');
  });

  it('classifies a mix of structured + unstructured items as "unrecognized" (fail closed, not partial-apply)', () => {
    const mixed = [childItem('child-1'), { kind: 'decision', text: 'x' }];
    expect(classifyPayload({ items: mixed })).toBe('unrecognized');
  });
});

describe('consumePendingAcceptanceEvent — the unrecognized-payload safety valve', () => {
  it('NEVER auto-consumes an unrecognized payload — returns payload-unrecognized, never calls consume_acceptance_event', async () => {
    const briefDocItems = [{ kind: 'decision', text: 'Scope of a saved filter', recommendation: 'Per-user' }];
    const event = { id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'clarification-draft', payload: { decide: 'x', items: briefDocItems }, pending_activity: 'clarifying', status: 'pending' };
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: [], error: null }, { data: event }],
        tasks: [{ data: { pending_acceptance_event_id: 'event-1' } }],
      },
    });
    const result = await consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1');
    expect(result).toEqual({
      status: 'payload-unrecognized', event_id: 'event-1', reason: 'clarification-draft', items: briefDocItems,
    });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe('consumePendingAcceptanceEvent — the B-688/B-383 missing-write-kind-substrate degrade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('degrades the WHOLE flow to payload-unrecognized when consume_label_add_write does not exist yet — never throws, never consumes', async () => {
    const items = [acItem('ac-1'), labelAddItem('label-decision-only')];
    const event: PendingAcceptanceEvent = {
      id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'clarification-draft',
      payload: { items }, pending_activity: 'clarifying', status: 'pending',
    };
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: [], error: null }, { data: event }],
        tasks: [{ data: { pending_acceptance_event_id: 'event-1' } }],
      },
      rpcResponses: {
        consume_ac_add_write: [{ data: { applied: true } }],
        consume_label_add_write: [{ data: null, error: { code: '42883', message: 'function consume_label_add_write(uuid, text, text) does not exist' } }],
      },
    });
    const result = await consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1');
    expect(result).toEqual({
      status: 'payload-unrecognized', event_id: 'event-1', reason: 'clarification-draft', items,
    });
    // The AC write DID land (its own ledgered RPC ran and succeeded) — only the deferred advance is
    // withheld. consume_acceptance_event must NEVER be called in this branch.
    expect(client.rpc).toHaveBeenCalledWith('consume_ac_add_write', expect.anything());
    expect(client.rpc).not.toHaveBeenCalledWith('consume_acceptance_event', expect.anything());
  });

  it('a guard-blocked label_add (check_violation) is NOT this degrade path — it propagates as a real error', async () => {
    const event: PendingAcceptanceEvent = {
      id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'clarification-draft',
      payload: { items: [labelAddItem('label-decision-only')] }, pending_activity: 'clarifying', status: 'pending',
    };
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: [], error: null }, { data: event }],
        tasks: [{ data: { pending_acceptance_event_id: 'event-1' } }],
      },
      rpcResponses: {
        consume_label_add_write: [{ data: null, error: { code: '23514', message: 'decision-only guard blocked: terminal (task abc-123)' } }],
      },
    });
    await expect(consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1')).rejects.toThrow(/decision-only guard blocked: terminal/);
    expect(client.rpc).not.toHaveBeenCalledWith('consume_acceptance_event', expect.anything());
  });
});
describe('rawItemsOf / classifyPayload — B-816 doc-nested snapshot (B-803 plan-event shape)', () => {
  // resolve_brief snapshots a brief's whole `doc` VERBATIM into pending_acceptance_events.payload. B-810's
  // compose_brief call sites author the structured array at `doc.payload` — so the LIVE snapshot shape is
  // `event.payload.payload` (an array), never `event.payload` itself as an array and never
  // `event.payload.items`. This fixture is that real shape (start-work SKILL.md O2's plan-draft
  // compose_brief call), not a synthetic bare array.
  const docNestedPlanPayload = (payloadItems: AcceptanceEventPayloadItem[]) => ({
    decide: 'Approve this execution plan?',
    items: [{ kind: 'decision', text: '<plan summary>', recommendation: 'proceed' }],
    payload: payloadItems,
  });

  const tenChecklistItems = Array.from({ length: 10 }, (_, i) => checklistItem(`step-${i + 1}`));

  it('a 10-item doc-nested checklist_item snapshot classifies "structured" (never "unrecognized")', () => {
    expect(classifyPayload(docNestedPlanPayload(tenChecklistItems))).toBe('structured');
  });

  it('applies every write via the RPCs and commits the deferred advance through the full consume orchestrator', async () => {
    const event: PendingAcceptanceEvent = {
      id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'plan-draft',
      payload: docNestedPlanPayload(tenChecklistItems), pending_activity: 'planning', status: 'pending',
    };
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: [], error: null }, { data: event }],
        tasks: [{ data: { pending_acceptance_event_id: 'event-1' } }],
      },
      rpcResponses: {
        consume_checklist_item_write: tenChecklistItems.map((item, i) => ({ data: { applied: true, result_id: `item-${i + 1}` } })),
        consume_acceptance_event: [{ data: { event_id: 'event-1', task_id: 'task-1', status: 'consumed', workflow_state: 'Planned', idempotent: false } }],
      },
    });
    const result = await consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1');
    expect(result.status).toBe('consumed');
    expect(result.applied).toBe(10);
    expect(result.workflow_state).toBe('Planned');
    expect(client.rpc).toHaveBeenCalledWith('consume_acceptance_event', { _event_id: 'event-1' });
    expect(client.rpc).toHaveBeenCalledTimes(11); // 10 checklist writes + the final commit
  });

  it('a single deliberately-unrecognized item (B-810\'s acceptance_criterion_update) downgrades the WHOLE doc-nested payload to "payload-unrecognized" and echoes it verbatim on `items`; the event stays pending and consume_acceptance_event is never called', async () => {
    const mixedPayload = [
      ...tenChecklistItems.slice(0, 9),
      { write_kind: 'acceptance_criterion_update', ref: 'ac-sharpen-1', content: 'Sharpened AC text', from_ac_id: 'ac-existing-1' } as unknown as AcceptanceEventPayloadItem,
    ];
    const doc = docNestedPlanPayload(mixedPayload);
    expect(classifyPayload(doc)).toBe('unrecognized');

    const event: PendingAcceptanceEvent = {
      id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'plan-draft',
      payload: doc, pending_activity: 'planning', status: 'pending',
    };
    const client = makeClient({
      fromResponses: {
        pending_acceptance_events: [{ data: [], error: null }, { data: event }],
        tasks: [{ data: { pending_acceptance_event_id: 'event-1' } }],
      },
    });
    const result = await consumePendingAcceptanceEvent(client, PROJECT_ID, 'task-1');
    expect(result).toEqual({
      status: 'payload-unrecognized', event_id: 'event-1', reason: 'plan-draft', items: mixedPayload,
    });
    expect(client.rpc).not.toHaveBeenCalledWith('consume_acceptance_event', expect.anything());
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
