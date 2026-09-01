import { describe, it, expect, vi } from 'vitest';
import {
  composeBrief,
  renderBrief,
  renderSlot,
  withDerivedGateSlot,
  writesGateSlot,
  GATE_REASON_FLOW,
  GATE_SLOT_NAMES,
  REASON_FOR_GATE_SLOT,
  NOT_RATIFIED_MARK,
  PROMISED_WRITES_HEADING,
  ENTRY_PROVENANCE_PREFIX,
  type BriefDoc,
} from './briefs.js';
import {
  writeGateSlot,
  writeGateSlotToolHandler,
  parseGateSlotContent,
  pinBuildPrs,
  GATE_SLOT_FIELD_KEY,
} from './gate-slots.js';
import { applyAcceptanceEventPayload, classifyPayload, type PendingAcceptanceEvent } from './acceptance-events.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_client: unknown, _projectId: string, input: string) => input),
}));

/**
 * B-867 — THE GATE-SLOT CONTRACT: ratified doc in, durable ticket section out.
 *
 * The defect this pins shut is a disappearance, not a mismatch. A gate brief is a moment: the human
 * accepts it, the conductor advances, and the wording the gate ratified survives only inside
 * `briefs.doc` — a row nobody reads once the ticket has moved on. The slot is the THIRD mechanical
 * projection of that same ratified doc (after `renderBrief`, what the human reads, and `renderEntry`,
 * what the accept promotes), and the three properties asserted here are what make it trustworthy:
 *
 *   1. IT SAYS WHAT THE BRIEF SAID. Every slot value that has a counterpart in the rendered brief is
 *      byte-identical to it, because both come from the SAME element formatter (f0d55b23: structured
 *      once, rendered deterministically, no parallel rendering pipeline).
 *   2. RATIFIED-EMPTY IS NOT NEVER-RATIFIED. Key presence carries that, at both levels — the slot key
 *      inside `gate_slots`, and each field inside the slot's content.
 *   3. THE WRITE PRESERVES EVERYTHING IT DID NOT MEAN TO TOUCH. Two-level merge: other `field_values`
 *      keys (`build_pr`, `work_branch`) and other gates' slots both survive; only this gate's slot is
 *      replaced.
 *
 * MUTATION-CHECKED — every assertion block below was RUN against a deliberately broken implementation
 * and observed to fail (2026-09-01; each mutation applied alone, then reverted):
 *   (a) `renderSlot` emitting `in_scope: frame.in_scope ?? []`, so an absent answer collapses into a
 *       ratified-empty one                                                     → 2 failed / 49 passed
 *   (b) the release slot re-deriving its own "shipped" wording instead of calling the shared
 *       `renderLanding` — the parallel-pipeline defect                         → 2 failed / 49 passed
 *   (c) `writeGateSlot`'s task route ASSIGNING `field_values` instead of merging, so `build_pr`,
 *       `work_branch` and every other gate's slot are clobbered                → 3 failed / 48 passed
 *   (d) the ledgered route also SENDING `ratified_by`/`ratified_at`, letting a replay back-date a slot
 *                                                                              → 2 failed / 49 passed
 *   (e) `gate_slot` ordered AFTER `knowledge_entry_content` in the apply order  → 2 failed / 49 passed
 *   (f) an EMPTY content object "helpfully" skipped as nothing-to-do            → 2 failed / 49 passed
 * A contract test that passed against any of these would license the exact drift it claims to exclude.
 */

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

// ——— fixtures ————————————————————————————————————————————————————————————————————————————————————

const clarifyDoc = (over: Partial<BriefDoc> = {}): BriefDoc => ({
  decide: 'Is this the problem we are solving?',
  recommend: { text: 'Adopt the stated outcome', confidence: 'high' },
  items: [{ kind: 'decision', text: 'Confirm the outcome', recommendation: 'confirm' }],
  frame: {
    kind: 'clarify',
    solving: 'A reader of the ticket can see what each gate ratified, months later.',
    in_scope: ['the clarify contract', 'the release landing', 'the verify runbook'],
    not_solving: [{ item: 'the brief history UI', lands: 'B-878' }],
  },
  ...over,
});

const releaseDoc = (over: Partial<BriefDoc> = {}): BriefDoc => ({
  decide: 'Release B-867 to staging?',
  recommend: { text: 'Land it', confidence: 'high' },
  items: [{ kind: 'decision', text: 'Approve the release', recommendation: 'approve' }],
  frame: {
    kind: 'release',
    act: { repos: ['harmony-web', 'harmony-plugin'], pr_count: 2, lands_in: 'staging', atomicity: 'ordered', ordering: 'web first, then plugin', irreversible: ['the migration'] },
    unproven: [{ item: 'the two-level merge against a live board', reason: 'only exercised against a mock client' }],
    evidence_status: { proven_by_run: 7, walk_at_verify: 2, unproven: 0, total: 9, detail: 'all nine accounted for' },
    risk_classes: [],
  },
  ...over,
});

const verifyDoc = (over: Partial<BriefDoc> = {}): BriefDoc => ({
  decide: 'Does staging behaviour match the design?',
  recommend: { text: 'Acknowledge verified', confidence: 'medium' },
  items: [{ kind: 'decision', text: 'Acknowledge verified', recommendation: 'verify once confirmed' }],
  frame: {
    kind: 'verify',
    environment: 'staging',
    criteria: [
      { ac_id: 'ac-1', text: 'A ratified gate lands a section on the ticket', checked: true, disposition: 'walk', step_ref: '1' },
      { ac_id: 'ac-2', text: 'A gate that never ratified shows no section', checked: false, disposition: 'blocked', blocked_reason: 'needs a fresh ticket' },
      { ac_id: 'ac-3', text: 'The merge preserves build_pr', checked: true, disposition: 'test-proven', backed_by: 'gate-slot-contract.test.ts' },
    ],
    evidence_status: '✓ Evidence: complete (3 test cases, 3/3 ACs checked)',
  },
  ...over,
});

/** A chainable client mock: one response queue per TABLE, one per RPC name. */
function makeClient(opts: {
  fromResponses?: Record<string, Array<{ data: unknown; error?: unknown }>>;
  rpcResponses?: Record<string, Array<{ data: unknown; error?: unknown }>>;
} = {}) {
  const fromQueues = opts.fromResponses ?? {};
  const rpcQueues = opts.rpcResponses ?? {};
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const updates: Array<{ table: string; payload: any }> = [];

  const from = vi.fn((table: string) => {
    const queue = fromQueues[table] ?? [];
    const take = () => queue.shift() ?? { data: null, error: null };
    const chain: any = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'is', 'not']) chain[m] = vi.fn(() => chain);
    chain.update = vi.fn((payload: any) => { updates.push({ table, payload }); return chain; });
    chain.maybeSingle = vi.fn(async () => take());
    chain.single = vi.fn(async () => take());
    chain.then = (resolve: (v: unknown) => unknown) => resolve(take());
    return chain;
  });
  const rpc = vi.fn(async (name: string, args: any) => {
    rpcCalls.push({ name, args });
    return (rpcQueues[name] ?? []).shift() ?? { data: null, error: null };
  });
  return { from, rpc, rpcCalls, updates } as any;
}

// ——— 1. The projection: ratified doc in, slot out, at KEY level ————————————————————————————————————

describe('renderSlot: the ratified doc projects to the gate section, key by key', () => {
  it('clarify — solving / in_scope / not_solving, verbatim from the frame', () => {
    const slot = renderSlot(clarifyDoc(), 'clarify')!;
    expect(Object.keys(slot).sort()).toEqual(['in_scope', 'not_solving', 'solving']);
    expect(slot.solving).toBe('A reader of the ticket can see what each gate ratified, months later.');
    expect(slot.in_scope).toEqual(['the clarify contract', 'the release landing', 'the verify runbook']);
    expect(slot.not_solving).toEqual([{ item: 'the brief history UI', lands: 'B-878' }]);
  });

  it('release — shipped / lands_in / unproven / evidence_status (prs come from the task, not the doc)', () => {
    const slot = renderSlot(releaseDoc(), 'release')!;
    expect(Object.keys(slot).sort()).toEqual(['evidence_status', 'lands_in', 'shipped', 'unproven']);
    expect(slot.lands_in).toBe('staging');
    expect(slot.shipped).toContain('2 pull requests across harmony-web, harmony-plugin');
    expect(slot.unproven).toEqual(['the two-level merge against a live board — only exercised against a mock client']);
    expect(slot.evidence_status).toContain('7/9 proven by a test that RAN');
    // The doc cannot know the PR references — they live on the task. Never guessed here.
    expect(slot.prs).toBeUndefined();
  });

  it('verify — environment / criteria / evidence_status, one row per filed criterion', () => {
    const slot = renderSlot(verifyDoc(), 'verify')!;
    expect(Object.keys(slot).sort()).toEqual(['criteria', 'environment', 'evidence_status']);
    expect(slot.environment).toBe('staging');
    expect(slot.criteria).toEqual([
      { text: 'A ratified gate lands a section on the ticket', disposition: '✅ walk now', ac_id: 'ac-1', how: 'runbook step 1' },
      { text: 'A gate that never ratified shows no section', disposition: '⚠️ blocked — needs a fresh ticket', ac_id: 'ac-2' },
      { text: 'The merge preserves build_pr', disposition: '🧪 test-proven', ac_id: 'ac-3', how: 'gate-slot-contract.test.ts' },
    ]);
  });

  it('returns null — NOT an empty slot — when the doc carries no frame of this gate kind', () => {
    expect(renderSlot({ decide: 'x', items: [] }, 'clarify')).toBeNull();
    expect(renderSlot(clarifyDoc(), 'release')).toBeNull();
    expect(renderSlot(releaseDoc(), 'verify')).toBeNull();
  });
});

// ——— 2. Ratified-empty is not never-ratified ——————————————————————————————————————————————————————

describe('key presence carries the semantic: empty answer vs never answered', () => {
  it('a ratified EMPTY list stays an empty list — the key is present', () => {
    const doc = clarifyDoc({ frame: { kind: 'clarify', solving: 'x', in_scope: [], not_solving: [] } });
    const slot = renderSlot(doc, 'clarify')!;
    expect(slot).toHaveProperty('in_scope');
    expect(slot).toHaveProperty('not_solving');
    expect(slot.in_scope).toEqual([]);
    expect(slot.not_solving).toEqual([]);
  });

  it('an UNANSWERED field is absent — never defaulted to an empty list', () => {
    const doc = clarifyDoc({ frame: { kind: 'clarify', solving: 'x' } as any });
    const slot = renderSlot(doc, 'clarify')!;
    expect(Object.keys(slot)).toEqual(['solving']);
    expect('in_scope' in slot).toBe(false);
    expect('not_solving' in slot).toBe(false);
  });

  it('a frame answering NOTHING projects to {} — the gate ratified, and its answer is empty', () => {
    const slot = renderSlot({ decide: 'x', items: [], frame: { kind: 'clarify' } as any }, 'clarify');
    expect(slot).toEqual({});
    expect(slot).not.toBeNull();
  });

  it('an empty content object is a VALID write at every gate', () => {
    for (const gate of GATE_SLOT_NAMES) expect(parseGateSlotContent(gate, {})).toEqual({});
  });
});

// ——— 3. It says what the brief said — one formatter, never a second pipeline ————————————————————————

describe('the slot carries the BRIEF wording, from the shared element formatters', () => {
  it('release: shipped / unproven / evidence_status all appear verbatim in the rendered brief', () => {
    const doc = releaseDoc();
    const brief = renderBrief(doc, null, { reason: 'release-decision-pending' });
    const slot = renderSlot(doc, 'release')!;
    expect(brief).toContain(slot.shipped as string);
    expect(brief).toContain((slot.unproven as string[])[0]);
    expect(brief).toContain(slot.evidence_status as string);
  });

  it('verify: every criterion disposition appears verbatim in the rendered brief', () => {
    const doc = verifyDoc();
    const brief = renderBrief(doc, null, { reason: 'verification-ack-pending' });
    for (const row of renderSlot(doc, 'verify')!.criteria as Array<{ disposition: string }>) {
      expect(brief).toContain(row.disposition);
    }
  });

  it('clarify: solving and every in_scope / not_solving element appear in the rendered brief', () => {
    const doc = clarifyDoc();
    const brief = renderBrief(doc, null, { reason: 'clarification-draft' });
    const slot = renderSlot(doc, 'clarify')!;
    expect(brief).toContain(slot.solving as string);
    for (const el of slot.in_scope as string[]) expect(brief).toContain(el);
    for (const ex of slot.not_solving as Array<{ item: string }>) expect(brief).toContain(ex.item);
  });
});

// ——— 4. Born without the entry's furniture ————————————————————————————————————————————————————————

describe('a slot is born WITHOUT the entry projection furniture (B-902 must not be inherited)', () => {
  const flat = (v: unknown): string => JSON.stringify(v);

  it.each([['clarify', clarifyDoc()], ['release', releaseDoc()], ['verify', verifyDoc()]] as const)(
    '%s: no ratification oracle, no unticked asks, no promised-writes heading, no provenance stamp',
    (gate, doc) => {
      const rendered = flat(renderSlot(doc as BriefDoc, gate as any));
      expect(rendered).not.toContain(NOT_RATIFIED_MARK);
      expect(rendered).not.toContain('- [ ]');
      expect(rendered).not.toContain('- [x]');
      expect(rendered).not.toContain(PROMISED_WRITES_HEADING);
      expect(rendered).not.toContain('Ratified asks');
      expect(rendered).not.toContain(ENTRY_PROVENANCE_PREFIX);
      // Provenance belongs to the WRITE (ratified_by / ratified_at), never to the projection.
      expect(rendered).not.toContain('ratified_by');
      expect(rendered).not.toContain('ratified_at');
    },
  );

  it('the ASK never leaks into the section — a doc item is not slot content', () => {
    const doc = clarifyDoc({ items: [{ kind: 'decision', text: 'A LIVE OPEN QUESTION', recommendation: 'no' }] });
    expect(JSON.stringify(renderSlot(doc, 'clarify'))).not.toContain('A LIVE OPEN QUESTION');
  });
});

// ——— 5. The eight-reason ledger's fourth column ————————————————————————————————————————————————————

describe('GATE_REASON_FLOW.writes_slot — stated for all eight reasons (B-867)', () => {
  const REASONS = Object.keys(GATE_REASON_FLOW);

  it('EXACTLY THREE reasons write a slot — clarify, release, verify', () => {
    const writes = REASONS.filter((r) => GATE_REASON_FLOW[r].writes_slot);
    expect(writes.sort()).toEqual(['clarification-draft', 'release-decision-pending', 'verification-ack-pending']);
    expect(writes).toHaveLength(3);
  });

  it('every one of the eight rows STATES the field — never inherits it by omission', () => {
    for (const reason of REASONS) expect(typeof GATE_REASON_FLOW[reason].writes_slot).toBe('boolean');
  });

  it('writes_slot is NOT carries_writes — the two columns disagree at FIVE of the eight rows', () => {
    // Deriving one from the other would be wrong in BOTH directions: decompose/design/plan carry writes
    // and land no section, while release/verify land a section and carry no writes at all.
    const disagree = REASONS.filter((r) => GATE_REASON_FLOW[r].writes_slot !== GATE_REASON_FLOW[r].carries_writes);
    expect(disagree.sort()).toEqual([
      'decomposition-proposal', 'design-decision-draft', 'plan-draft',
      'release-decision-pending', 'verification-ack-pending',
    ]);
  });

  it('the two hard-floor gates write a slot while carrying NO writes — the structural fact this design turns on', () => {
    for (const reason of ['release-decision-pending', 'verification-ack-pending']) {
      expect(GATE_REASON_FLOW[reason]).toMatchObject({ carries_writes: false, writes_slot: true });
      expect(GATE_REASON_FLOW[reason].note).toContain('write_gate_slot');
    }
  });

  it("clarify's slot rides its accept payload — the note says so", () => {
    expect(GATE_REASON_FLOW['clarification-draft'].note).toContain('accept payload');
  });

  it('every row still NAMES why, now covering the slot too', () => {
    for (const reason of REASONS) expect(GATE_REASON_FLOW[reason].note).toMatch(/slot/i);
  });

  it('writesGateSlot reads the ledger, and every slot gate maps to its own reason', () => {
    expect(writesGateSlot('clarification-draft')).toBe(true);
    expect(writesGateSlot('plan-draft')).toBe(false);
    expect(writesGateSlot(undefined)).toBe(false);
    for (const gate of GATE_SLOT_NAMES) expect(writesGateSlot(REASON_FOR_GATE_SLOT[gate])).toBe(true);
  });
});

// ——— 6. Compose derives the clarify item (never hand-authored) ————————————————————————————————————

describe('the clarify gate_slot payload item is DERIVED at compose (B-867 step 7)', () => {
  const gateSlotItem = (doc: BriefDoc) => (doc.payload ?? []).find((p) => p.write_kind === 'gate_slot');

  it('withDerivedGateSlot derives the item from the doc, matching renderSlot exactly', () => {
    const doc = withDerivedGateSlot(clarifyDoc(), 'clarification-draft');
    const item = gateSlotItem(doc)!;
    expect(item.gate).toBe('clarify');
    expect(item.ref).toBe('slot-clarify');
    expect(item.slot_content).toEqual(renderSlot(clarifyDoc(), 'clarify'));
  });

  it('REPLACES a hand-authored item — one source for the section, or none', () => {
    const handAuthored = clarifyDoc({
      payload: [{ write_kind: 'gate_slot', ref: 'slot-clarify', gate: 'clarify', slot_content: { solving: 'PROSE NOBODY RATIFIED' } }],
    });
    const item = gateSlotItem(withDerivedGateSlot(handAuthored, 'clarification-draft'))!;
    expect(JSON.stringify(item.slot_content)).not.toContain('PROSE NOBODY RATIFIED');
  });

  it('the ref is derived from the GATE, so an iterate re-derives the same external_ref', () => {
    const a = gateSlotItem(withDerivedGateSlot(clarifyDoc(), 'clarification-draft'))!;
    const b = gateSlotItem(withDerivedGateSlot(clarifyDoc({ frame: { kind: 'clarify', solving: 'a totally different outcome', in_scope: [], not_solving: [] } }), 'clarification-draft'))!;
    expect(b.ref).toBe(a.ref);
  });

  it('derives NOTHING for a reason with no payload-borne slot, or a doc with no clarify frame', () => {
    expect(gateSlotItem(withDerivedGateSlot(releaseDoc(), 'release-decision-pending'))).toBeUndefined();
    expect(gateSlotItem(withDerivedGateSlot(verifyDoc(), 'verification-ack-pending'))).toBeUndefined();
    expect(gateSlotItem(withDerivedGateSlot({ decide: 'x', items: [] }, 'clarification-draft'))).toBeUndefined();
  });

  it('compose_brief stores the derived item, and the brief RENDERS ITS OWN PROMISE', async () => {
    const client = makeClient({
      fromResponses: {
        briefs: [{ data: null }, { data: { id: 'brief-1', task_id: 'task-1', reason: 'clarification-draft', status: 'active', iteration: 1 } }],
        tasks: [{ data: null }],
      },
    });
    (client as any).insert = undefined;
    // composeBrief inserts through the same chain; capture it off the briefs chain.
    const inserted: any[] = [];
    const origFrom = client.from;
    client.from = vi.fn((table: string) => {
      const chain = origFrom(table);
      chain.insert = vi.fn((payload: any) => { inserted.push(payload); return chain; });
      return chain;
    });

    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: clarifyDoc(), pending_activity: null as any,
    });
    const stored = inserted[0] as { doc: BriefDoc; content: string };
    const item = gateSlotItem(stored.doc)!;
    expect(item).toBeDefined();
    expect(item.slot_content).toEqual(renderSlot(clarifyDoc(), 'clarify'));
    expect(stored.content).toContain(PROMISED_WRITES_HEADING);
    expect(stored.content).toContain('the clarify section on the ticket');
  });
});

// ——— 7. The write, both routes ————————————————————————————————————————————————————————————————————

describe('writeGateSlot — the ledgered route (clarify, through the accept payload)', () => {
  it('sends ONLY the content — never ratified_by / ratified_at (a replay must not back-date a slot)', async () => {
    const client = makeClient({ rpcResponses: { consume_gate_slot_write: [{ data: { applied: true, result_id: 'task-1' } }] } });
    const res = await writeGateSlot(client, {
      gate: 'clarify', content: { solving: 'x', in_scope: [] },
      target: { via: 'acceptance-event', event_id: 'evt-1', external_ref: 'slot-clarify' },
    });
    expect(client.rpcCalls).toEqual([{
      name: 'consume_gate_slot_write',
      args: { _event_id: 'evt-1', _external_ref: 'slot-clarify', _gate: 'clarify', _content: { solving: 'x', in_scope: [] } },
    }]);
    expect(Object.keys(client.rpcCalls[0].args)).toEqual(['_event_id', '_external_ref', '_gate', '_content']);
    expect(res).toMatchObject({ gate: 'clarify', applied: true, result_id: 'task-1' });
  });

  it('an already-landed write is applied:false — a retry, never an error', async () => {
    const client = makeClient({ rpcResponses: { consume_gate_slot_write: [{ data: { applied: false } }] } });
    await expect(writeGateSlot(client, {
      gate: 'clarify', content: {}, target: { via: 'acceptance-event', event_id: 'evt-1', external_ref: 'slot-clarify' },
    })).resolves.toMatchObject({ applied: false });
  });

  it('degrades on an ABSENT RPC (B-383 pre-migration window), and never on a real failure', async () => {
    const absent = makeClient({ rpcResponses: { consume_gate_slot_write: [{ data: null, error: { code: '42883', message: 'function public.consume_gate_slot_write does not exist' } }] } });
    await expect(writeGateSlot(absent, { gate: 'clarify', content: {}, target: { via: 'acceptance-event', event_id: 'e', external_ref: 'r' } }))
      .resolves.toMatchObject({ substrate_absent: true, applied: false });

    const real = makeClient({ rpcResponses: { consume_gate_slot_write: [{ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }] } });
    await expect(writeGateSlot(real, { gate: 'clarify', content: {}, target: { via: 'acceptance-event', event_id: 'e', external_ref: 'r' } }))
      .rejects.toThrow(/duplicate key/);
  });
});

describe('writeGateSlot — the task route (release / verify, which have no acceptance event)', () => {
  const EXISTING = {
    build_pr: { branch: 'feat/b-867', head_sha: 'abc', pr_url: 'https://github.com/x/pull/1' },
    work_branch: 'feat/b-867',
    gate_slots: { clarify: { content: { solving: 'the clarify answer' }, ratified_by: 'clarify', ratified_at: '2026-08-01T00:00:00Z' } },
  };

  async function write(content: Record<string, unknown>, existing: unknown = EXISTING) {
    const client = makeClient({ fromResponses: { tasks: [{ data: { field_values: existing } }, { data: null }] } });
    const res = await writeGateSlot(client, { gate: 'release', content, target: { via: 'task', task_id: 'task-1' } });
    return { res, written: client.updates[0]?.payload?.field_values };
  }

  it('TWO-LEVEL MERGE: other field_values keys survive, other gates survive, this gate is replaced', async () => {
    const { res, written } = await write({ shipped: 'the landing', lands_in: 'staging' });
    expect(res).toMatchObject({ gate: 'release', applied: true, result_id: 'task-1' });
    expect(written.build_pr).toEqual(EXISTING.build_pr);
    expect(written.work_branch).toBe('feat/b-867');
    expect(written[GATE_SLOT_FIELD_KEY].clarify).toEqual(EXISTING.gate_slots.clarify);
    expect(written[GATE_SLOT_FIELD_KEY].release.content).toEqual({ shipped: 'the landing', lands_in: 'staging' });
  });

  it('stamps ratified_by / ratified_at itself, in the RPC format — never taken from the content', async () => {
    const { written } = await write({ shipped: 'x' });
    const slot = written[GATE_SLOT_FIELD_KEY].release;
    expect(slot.ratified_by).toBe('release');
    expect(slot.ratified_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(slot.content).not.toHaveProperty('ratified_at');
  });

  it('re-writing the SAME gate replaces its slot and never deletes another', async () => {
    const first = await write({ shipped: 'first' });
    const second = await write({ shipped: 'second' }, first.written);
    expect(second.written[GATE_SLOT_FIELD_KEY].release.content).toEqual({ shipped: 'second' });
    expect(Object.keys(second.written[GATE_SLOT_FIELD_KEY]).sort()).toEqual(['clarify', 'release']);
  });

  it('an EMPTY content object is stored verbatim — never skipped as "nothing to do"', async () => {
    const { written } = await write({});
    expect(written[GATE_SLOT_FIELD_KEY]).toHaveProperty('release');
    expect(written[GATE_SLOT_FIELD_KEY].release.content).toEqual({});
  });

  it('a task with no field_values at all still lands a slot, and invents no other key', async () => {
    const { written } = await write({ shipped: 'x' }, null);
    expect(Object.keys(written)).toEqual([GATE_SLOT_FIELD_KEY]);
  });

  it('a non-object gate_slots (an old hand-edit) starts over rather than corrupting the merge', async () => {
    const { written } = await write({ shipped: 'x' }, { build_pr: EXISTING.build_pr, gate_slots: 'nonsense' });
    expect(written.build_pr).toEqual(EXISTING.build_pr);
    expect(Object.keys(written[GATE_SLOT_FIELD_KEY])).toEqual(['release']);
  });

  it('refuses a blank gate and a non-object content — validation BEFORE any write', async () => {
    const client = makeClient({ fromResponses: { tasks: [{ data: { field_values: {} } }, { data: null }] } });
    await expect(writeGateSlot(client, { gate: '  ', content: {}, target: { via: 'task', task_id: 't' } })).rejects.toThrow(/names no gate/);
    await expect(writeGateSlot(client, { gate: 'release', content: null as any, target: { via: 'task', task_id: 't' } })).rejects.toThrow(/content OBJECT/);
    expect(client.updates).toEqual([]);
  });
});

// ——— 8. The acceptance-event write kind ————————————————————————————————————————————————————————————

describe('gate_slot as a payload write kind (B-867 step 6)', () => {
  const event = (items: any[]): PendingAcceptanceEvent => ({
    id: 'evt-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'clarification-draft',
    payload: { payload: items }, pending_activity: 'clarifying', status: 'pending',
  });

  const slotItem = { write_kind: 'gate_slot', ref: 'slot-clarify', gate: 'clarify', slot_content: { solving: 'x', in_scope: [] } };

  it('is a RECOGNIZED write kind — a gate_slot payload is structured, never "unrecognized"', () => {
    expect(classifyPayload({ payload: [slotItem] } as any)).toBe('structured');
  });

  it('dispatches to consume_gate_slot_write with the item ref as the external_ref', async () => {
    const client = makeClient({ rpcResponses: { consume_gate_slot_write: [{ data: { applied: true } }] } });
    const res = await applyAcceptanceEventPayload(client, event([slotItem]));
    expect(client.rpcCalls[0]).toEqual({
      name: 'consume_gate_slot_write',
      args: { _event_id: 'evt-1', _external_ref: 'slot-clarify', _gate: 'clarify', _content: { solving: 'x', in_scope: [] } },
    });
    expect(res.by_write_kind).toEqual({ gate_slot: 1 });
  });

  it('runs AFTER the concrete materializations and BEFORE the entry promotion', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_ac_add_write: [{ data: { applied: true } }],
        consume_gate_slot_write: [{ data: { applied: true } }],
        consume_knowledge_entry_content_write: [{ data: { applied: true } }],
      },
    });
    await applyAcceptanceEventPayload(client, event([
      { write_kind: 'knowledge_entry_content', ref: 'entry-1', content: 'the entry' },
      slotItem,
      { write_kind: 'acceptance_criterion', ref: 'ac-1', content: 'a criterion' },
    ]));
    expect(client.rpcCalls.map((c: any) => c.name)).toEqual([
      'consume_ac_add_write', 'consume_gate_slot_write', 'consume_knowledge_entry_content_write',
    ]);
  });

  it('SUBSTRATE-ABSENT DEGRADE: an undeployed RPC returns substrate_absent_for, never a throw', async () => {
    const client = makeClient({
      rpcResponses: {
        consume_ac_add_write: [{ data: { applied: true } }],
        consume_gate_slot_write: [{ data: null, error: { code: 'PGRST202', message: "Could not find the function public.consume_gate_slot_write in the schema cache" } }],
      },
    });
    const res = await applyAcceptanceEventPayload(client, event([
      { write_kind: 'acceptance_criterion', ref: 'ac-1', content: 'a criterion' },
      slotItem,
      { write_kind: 'knowledge_entry_content', ref: 'entry-1', content: 'the entry' },
    ]));
    expect(res.substrate_absent_for).toBe('gate_slot');
    // Everything before it LANDED; nothing after it was attempted, so the entry was never promoted.
    expect(res.applied).toBe(1);
    expect(client.rpcCalls.map((c: any) => c.name)).toEqual(['consume_ac_add_write', 'consume_gate_slot_write']);
  });

  it('a REAL failure still propagates — it is never read as "substrate absent"', async () => {
    const client = makeClient({ rpcResponses: { consume_gate_slot_write: [{ data: null, error: { code: '42501', message: 'permission denied for table tasks' } }] } });
    await expect(applyAcceptanceEventPayload(client, event([slotItem]))).rejects.toThrow(/permission denied/);
  });

  it('refuses an item that names no gate, or carries no slot_content object', async () => {
    const client = makeClient();
    await expect(applyAcceptanceEventPayload(client, event([{ ...slotItem, gate: '' }]))).rejects.toThrow(/names no gate/);
    await expect(applyAcceptanceEventPayload(client, event([{ ...slotItem, slot_content: undefined }]))).rejects.toThrow(/slot_content/);
    expect(client.rpcCalls).toEqual([]);
  });
});

// ——— 9. The tool the release and verify accepts call ——————————————————————————————————————————————

describe('write_gate_slot — the release and verify accepts reach the same write', () => {
  const briefRow = (doc: BriefDoc) => ({ data: [{ id: 'brief-9', doc, reason: 'release-decision-pending' }] });

  it('DERIVES the section from the gate brief, and pins the PR references from the task', async () => {
    const client = makeClient({
      fromResponses: {
        briefs: [briefRow(releaseDoc())],
        tasks: [
          { data: { field_values: { build_pr: { pr_number: 202, pr_url: 'https://github.com/x/pull/202' } } } }, // prs read
          { data: { field_values: { build_pr: { pr_number: 202, pr_url: 'https://github.com/x/pull/202' } } } }, // write read
          { data: null },                                                                                        // write
        ],
      },
    });
    const res = await writeGateSlotToolHandler(client, PROJECT_ID, { task_id: 'B-867', gate: 'release' });
    expect(res).toMatchObject({ gate: 'release', written: true, applied: true, brief_id: 'brief-9' });
    const slot = client.updates[0].payload.field_values[GATE_SLOT_FIELD_KEY].release;
    expect(slot.content.shipped).toBe(renderSlot(releaseDoc(), 'release')!.shipped);
    expect(slot.content.prs).toEqual([{ repo: 'build_pr', ref: '#202', url: 'https://github.com/x/pull/202' }]);
    expect(slot.ratified_by).toBe('release');
  });

  it('sets prs to [] when the ticket records none — a stated answer, not a missing one', async () => {
    const client = makeClient({
      fromResponses: { briefs: [briefRow(releaseDoc())], tasks: [{ data: { field_values: {} } }, { data: { field_values: {} } }, { data: null }] },
    });
    await writeGateSlotToolHandler(client, PROJECT_ID, { task_id: 'B-867', gate: 'release' });
    expect(client.updates[0].payload.field_values[GATE_SLOT_FIELD_KEY].release.content.prs).toEqual([]);
  });

  it('a brief with no frame is a legible NO-OP — it never fails a hard-floor accept', async () => {
    const client = makeClient({ fromResponses: { briefs: [{ data: [{ id: 'brief-9', doc: { decide: 'x', items: [] } }] }] } });
    const res = await writeGateSlotToolHandler(client, PROJECT_ID, { task_id: 'B-867', gate: 'release' });
    expect(res).toMatchObject({ written: false, brief_id: 'brief-9' });
    expect(res.reason).toContain('no release frame');
    expect(client.updates).toEqual([]);
  });

  it('no brief at that gate is a legible NO-OP too', async () => {
    const client = makeClient({ fromResponses: { briefs: [{ data: [] }] } });
    const res = await writeGateSlotToolHandler(client, PROJECT_ID, { task_id: 'B-867', gate: 'verify' });
    expect(res).toMatchObject({ written: false });
    expect(res.reason).toContain('verification-ack-pending');
    expect(client.updates).toEqual([]);
  });

  it('reads the gate\'s OWN brief at ANY status — the slot is written at the accept, when it is resolved', async () => {
    const client = makeClient({ fromResponses: { briefs: [{ data: [{ id: 'b', doc: verifyDoc() }] }], tasks: [{ data: { field_values: {} } }, { data: null }] } });
    await writeGateSlotToolHandler(client, PROJECT_ID, { task_id: 'B-867', gate: 'verify' });
    const chain = client.from.mock.results.find((r: any) => r.value.eq.mock.calls.some((c: any[]) => c[1] === 'verification-ack-pending'));
    expect(chain).toBeDefined();
    const content = client.updates[0].payload.field_values[GATE_SLOT_FIELD_KEY].verify.content;
    expect(content).toEqual(renderSlot(verifyDoc(), 'verify'));
  });

  it('rejects an unknown gate and a missing identifier', async () => {
    const client = makeClient();
    await expect(writeGateSlotToolHandler(client, PROJECT_ID, { task_id: 'B-867', gate: 'plan' })).rejects.toThrow(/gate must be one of/);
    await expect(writeGateSlotToolHandler(client, PROJECT_ID, { task_id: '', gate: 'release' })).rejects.toThrow(/task_id is required/);
  });
});

// ——— 10. The pinned build_pr family ————————————————————————————————————————————————————————————————

describe('pinBuildPrs — the divergent live build_pr shapes, pinned to one section shape', () => {
  it('reads B-740 sibling keys, B-743 nesting, and ignores the B-844 non-PR sibling', () => {
    const prs = pinBuildPrs({
      build_pr: { web_pr: { pr_number: 1, pr_url: 'https://github.com/x/pull/1' }, plugin_pr: { pr_number: 2, pr_url: 'https://github.com/y/pull/2' } },
      build_pr_plugin: { pr_number: 3, pr_url: 'https://github.com/y/pull/3' },
      work_branch: 'feat/b-867',
    });
    expect(prs.map((p) => p.ref).sort()).toEqual(['#1', '#2', '#3']);
    expect(prs.every((p) => typeof p.repo === 'string' && typeof p.url === 'string')).toBe(true);
    expect(JSON.stringify(prs)).not.toContain('work_branch');
  });

  it('never throws on a malformed field_values — an unreadable shape yields nothing', () => {
    expect(pinBuildPrs(undefined)).toEqual([]);
    expect(pinBuildPrs('nonsense')).toEqual([]);
    expect(pinBuildPrs({ build_pr: 42 })).toEqual([]);
  });
});
