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
    expect(result).toEqual({ status: 'payload-unrecognized', event_id: 'event-1', reason: 'clarification-draft' });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
