import { describe, it, expect, vi } from 'vitest';
import {
  composeBrief,
  renderBrief,
  renderEntry,
  withDerivedEntryContent,
  derivesEntryContent,
  GATE_REASON_FLOW,
  carriesDecisionRef,
  ENTRY_PROVENANCE_PREFIX,
  NOT_RATIFIED_MARK,
  RATIFICATION_CONVENTION,
  entryProvenanceStamp,
  PROMISED_WRITES_HEADING,
  type BriefDoc,
  type DecisionRef,
} from './briefs.js';
import { applyAcceptanceEventPayload, type PendingAcceptanceEvent } from './acceptance-events.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_client: unknown, _projectId: string, input: string) => input),
}));

/**
 * B-866 — THE DERIVATION CONTRACT.
 *
 * The defect this pins shut: the machinery that continued the work read a SEPARATELY hand-authored
 * document, not what the human approved. The composing agent authored the brief prose AND the knowledge
 * entry prose in sequence; the human ratified the brief; the accept promoted the entry. Two copies, one
 * vetted, nothing enforcing they matched — and nothing COULD, because they had two authors.
 *
 * The contract asserted here is the fix in one sentence: APPROVED DOC IN, PROMOTED ENTRY AND EXECUTED
 * WRITES OUT, EQUAL AT KEY LEVEL. Every authored key of the doc the human ratified must appear in the
 * blob they read AND in the entry the accept promotes AND in the payload the accept executes. A
 * derivation that drops, rewrites, or invents a key fails here.
 *
 * WHY A SEPARATE FILE (the criteria-floor / decision-only-label precedent): `briefs.test.ts` proves the
 * renderers behave; it cannot prove the three artefacts AGREE, because agreement is a property of the
 * seam between briefs.ts and acceptance-events.ts. This file exercises that seam end to end.
 *
 * MUTATION-CHECKED: the key-level assertions below were verified to FAIL against a deliberately broken
 * derivation (see the build report) — a contract test that passes against a broken derivation would be
 * worse than none, because it would license the very drift it claims to exclude.
 */

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

function makeClient(responses: Array<{ data: unknown; error?: unknown }>) {
  let i = 0;
  const next = () => responses[i++] ?? { data: null, error: null };
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'eq', 'is', 'not', 'order', 'limit']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => next());
  chain.single = vi.fn(async () => next());
  chain.then = (resolve: (v: unknown) => unknown) => resolve(next());
  chain.rpc = vi.fn(async (name: string) => ({ data: null, error: { code: '42883', message: `function public.${name} does not exist` } }));
  return chain;
}

const DECISION_REF: DecisionRef = { type: 'technical-design', id: '3f1c2b90-0000-4000-8000-000000000abc' };

/** The AUTHORED KEYS — every prose unit the human ratifies. The contract is stated over these. */
const AUTHORED = {
  decide: 'Adopt the single-source projection for gate briefs?',
  recommend: 'Project the entry from the ratified brief doc rather than authoring it twice.',
  why: ['Two authored copies cannot be kept in step by discipline.', 'The human ratifies one of them and the accept promotes the other.'],
  alternatives: [{ option: 'Keep both copies and add a review step', rejection: 'a review of two prose blobs is exactly what nobody does' }],
  context: ['The transport for a derived entry has shipped since B-843 and had no producer.'],
  items: ['Adopt the projection'],
};

const ratifiedDoc = (over: Partial<BriefDoc> = {}): BriefDoc => ({
  decide: AUTHORED.decide,
  recommend: { text: AUTHORED.recommend, confidence: 'high' },
  why: [...AUTHORED.why],
  alternatives: AUTHORED.alternatives.map((a) => ({ ...a })),
  context: [...AUTHORED.context],
  items: AUTHORED.items.map((text) => ({ kind: 'decision' as const, text, recommendation: 'adopt' })),
  ...over,
});

/** Every authored prose key, flattened — the unit of the "equal at key level" assertion. */
function authoredKeys(): string[] {
  return [
    AUTHORED.decide,
    AUTHORED.recommend,
    ...AUTHORED.why,
    ...AUTHORED.alternatives.flatMap((a) => [a.option, a.rejection]),
    ...AUTHORED.context,
    ...AUTHORED.items,
  ];
}

/** Compose a brief through the real handler and hand back what was actually stored. */
async function composeAndCapture(reason: string, doc: BriefDoc, decisionRef: DecisionRef | null = DECISION_REF) {
  const client = makeClient([
    // release-decision-pending alone reads the task's build_pr record first (B-732/B-876).
    ...(reason === 'release-decision-pending' ? [{ data: { field_values: {} } }] : []),
    { data: null },                                                        // no active brief
    { data: { id: 'brief-1', task_id: 'task-1', reason, status: 'active', iteration: 1 } },
    { data: null },                                                        // tasks flag update
  ]);
  await composeBrief(client, PROJECT_ID, USER_ID, {
    task_id: 'task-1', reason, doc, pending_activity: null as any,
    ...(decisionRef ? { decision_ref: decisionRef } : {}),
  });
  const stored = client.insert.mock.calls[0][0] as { doc: BriefDoc; content: string; decision_ref: DecisionRef | null };
  return stored;
}

const entryItemOf = (doc: BriefDoc) => (doc.payload ?? []).find((p) => p.write_kind === 'knowledge_entry_content');

// ——— Step 7: the eight-reason coverage ledger ————————————————————————————————————————————————————

describe('the eight-reason coverage ledger is PINNED, so an unflowed reason is named (B-866)', () => {
  const REASONS = [
    'clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'plan-draft',
    'release-decision-pending', 'verification-ack-pending', 'stale-patch-review', 'revise-scope-review',
  ];

  it('covers all eight §6.5 gate reasons — no reason is silently absent', () => {
    expect(Object.keys(GATE_REASON_FLOW).sort()).toEqual([...REASONS].sort());
  });

  it('EXACTLY FIVE reasons carry a decision_ref — the corrected count, not the inherited "6 of 8"', () => {
    const carries = REASONS.filter((r) => GATE_REASON_FLOW[r].carries_decision_ref);
    expect(carries.sort()).toEqual([
      'clarification-draft', 'decomposition-proposal', 'design-decision-draft',
      'revise-scope-review', 'stale-patch-review',
    ]);
    expect(carries).toHaveLength(5);
  });

  it('EXACTLY FOUR reasons derive the entry body — one fewer than carry the pointer', () => {
    const derives = REASONS.filter((r) => GATE_REASON_FLOW[r].derives_entry_content);
    expect(derives.sort()).toEqual([
      'clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'revise-scope-review',
    ]);
    expect(derives).toHaveLength(4);
  });

  it('plan-draft is the WRITES half only — it composes no decision_ref, so it derives no entry', () => {
    expect(GATE_REASON_FLOW['plan-draft']).toMatchObject({
      carries_decision_ref: false, derives_entry_content: false, carries_writes: true,
    });
    expect(derivesEntryContent('plan-draft')).toBe(false);
  });

  it('release and verify are NEITHER half — stated, not merely missing', () => {
    for (const reason of ['release-decision-pending', 'verification-ack-pending']) {
      expect(GATE_REASON_FLOW[reason]).toMatchObject({
        carries_decision_ref: false, derives_entry_content: false, carries_writes: false,
      });
    }
  });

  // ——— The stale-patch exemption: a NAMED, PRINCIPLED ROW, pinned so it can neither silently widen
  // nor silently vanish. Both directions matter. If it VANISHES, a stale-patch accept starts writing
  // this brief's projection over another gate's already-ratified entry — the destructive case the
  // founder ruled out as "the disease itself, aimed at an artefact the human ratified elsewhere". If it
  // WIDENS, a gate that records its own placeholder entry silently stops deriving, and the ticket's
  // whole guarantee (the accept consumes what was approved) quietly lapses at that gate.
  describe('the stale-patch-review exemption is pinned in both directions', () => {
    it('DOES NOT VANISH: stale-patch-review carries the pointer but derives NO content', () => {
      expect(GATE_REASON_FLOW['stale-patch-review']).toMatchObject({
        carries_decision_ref: true,
        derives_entry_content: false,
      });
      expect(carriesDecisionRef('stale-patch-review')).toBe(true);
      expect(derivesEntryContent('stale-patch-review')).toBe(false);
    });

    it('DOES NOT WIDEN: stale-patch-review is the ONLY reason that carries a pointer without deriving', () => {
      const pointerOnly = REASONS.filter(
        (r) => GATE_REASON_FLOW[r].carries_decision_ref && !GATE_REASON_FLOW[r].derives_entry_content,
      );
      expect(pointerOnly).toEqual(['stale-patch-review']);
    });

    it('no reason derives content without carrying the pointer — there would be nothing to write to', () => {
      const orphans = REASONS.filter(
        (r) => GATE_REASON_FLOW[r].derives_entry_content && !GATE_REASON_FLOW[r].carries_decision_ref,
      );
      expect(orphans).toEqual([]);
    });

    it('the row STATES the reason for the exemption — it is a decision, not a gap', () => {
      const note = GATE_REASON_FLOW['stale-patch-review'].note;
      expect(note).toContain('POINTER-ONLY, BY CONSTRUCTION');
      expect(note).toContain("ANOTHER GATE'S ALREADY-RATIFIED ENTRY");
    });

    it("BEHAVIOUR: a stale-patch compose derives no entry item, and STILL renders the depth-pointer", async () => {
      const stored = await composeAndCapture('stale-patch-review', ratifiedDoc());
      expect(entryItemOf(stored.doc)).toBeUndefined();
      // The pointer fact is untouched by the exemption — that is why the two are separate fields.
      expect(stored.decision_ref).toEqual(DECISION_REF);
      expect(stored.content).toContain('fuller depth lives in the linked decision entry');
    });
  });

  it('every row NAMES why — an exemption nobody wrote down is indistinguishable from an oversight', () => {
    for (const reason of REASONS) {
      expect(GATE_REASON_FLOW[reason].note.trim().length).toBeGreaterThan(20);
    }
  });
});

// ——— Step 8: approved doc in, promoted entry and executed writes out ——————————————————————————————

describe('the derivation contract: approved doc in, promoted entry + executed writes out (B-866)', () => {
  it.each(['clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'revise-scope-review'])(
    'compose DERIVES the knowledge_entry_content item at the %s gate',
    async (reason) => {
      const stored = await composeAndCapture(reason, ratifiedDoc());
      const item = entryItemOf(stored.doc);
      expect(item).toBeDefined();
      expect(item!.content && item!.content.trim().length).toBeGreaterThan(0);
      expect(item!.entry_id).toBe(DECISION_REF.id);
    },
  );

  it.each(['plan-draft', 'release-decision-pending', 'verification-ack-pending'])(
    'derives NOTHING at the %s gate — the ledger says it promotes no entry',
    async (reason) => {
      const stored = await composeAndCapture(reason, ratifiedDoc(), null);
      expect(entryItemOf(stored.doc)).toBeUndefined();
    },
  );

  it('derives NOTHING at stale-patch-review even WITH a decision_ref — the named exemption', async () => {
    const stored = await composeAndCapture('stale-patch-review', ratifiedDoc());
    expect(entryItemOf(stored.doc)).toBeUndefined();
  });

  it('derives nothing when the brief carries no decision_ref (the stale-patch null-successor brief)', async () => {
    const stored = await composeAndCapture('stale-patch-review', ratifiedDoc(), null);
    expect(entryItemOf(stored.doc)).toBeUndefined();
  });

  it('EQUAL AT KEY LEVEL: every authored key reaches the read blob AND the promoted entry', async () => {
    const stored = await composeAndCapture('design-decision-draft', ratifiedDoc());
    const promoted = entryItemOf(stored.doc)!.content!;
    for (const key of authoredKeys()) {
      expect(stored.content, `the human's blob dropped: ${key}`).toContain(key);
      expect(promoted, `the promoted entry dropped: ${key}`).toContain(key);
    }
  });

  it('THE PROMOTED ENTRY IS THE PROJECTION OF THE STORED DOC — not a separately authored blob', async () => {
    const stored = await composeAndCapture('design-decision-draft', ratifiedDoc());
    const item = entryItemOf(stored.doc)!;
    // Re-project the doc that was actually persisted. If the payload's content were authored anywhere
    // else — or from anything else — these two strings would differ.
    const reprojected = renderEntry(stored.doc, {
      reason: 'design-decision-draft', accept: null, decisionRef: stored.decision_ref, now: new Date(),
    });
    expect(item.content).toBe(reprojected);
  });

  it('THE EXECUTED WRITE CARRIES EXACTLY THE PROMOTED TEXT — no re-synthesis at consume time', async () => {
    const stored = await composeAndCapture('design-decision-draft', ratifiedDoc());
    const rpc = vi.fn(async () => ({ data: { applied: true }, error: null }));
    const event: PendingAcceptanceEvent = {
      id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'design-decision-draft',
      payload: stored.doc as unknown as Record<string, unknown>, pending_activity: null, status: 'pending',
    };
    const result = await applyAcceptanceEventPayload({ rpc } as any, event);
    expect(result.applied).toBe(1);
    expect(rpc).toHaveBeenCalledWith('consume_knowledge_entry_content_write', {
      _event_id: 'event-1',
      _external_ref: entryItemOf(stored.doc)!.ref,
      _content: entryItemOf(stored.doc)!.content,
      _entry_id: DECISION_REF.id,
    });
  });

  it('the brief RENDERS the promise it will execute — the reader sees the derived entry named', async () => {
    const stored = await composeAndCapture('design-decision-draft', ratifiedDoc());
    expect(stored.content).toContain(PROMISED_WRITES_HEADING);
    expect(stored.content).toContain('the linked decision entry, written from THIS brief');
  });

  it('an author-supplied knowledge_entry_content item is REPLACED, never left as a second source', async () => {
    const stored = await composeAndCapture('design-decision-draft', ratifiedDoc({
      payload: [{ write_kind: 'knowledge_entry_content', ref: 'hand-authored', content: 'PROSE THE HUMAN NEVER READ' }],
    }));
    const items = (stored.doc.payload ?? []).filter((p) => p.write_kind === 'knowledge_entry_content');
    expect(items).toHaveLength(1);
    expect(items[0].content).not.toContain('PROSE THE HUMAN NEVER READ');
  });
});

// ——— Step 2: element-level ratification + the construction stamp ——————————————————————————————————

describe('the derived entry marks ratification per element and stamps its construction (B-866)', () => {
  // The mark tells the reader WHICH claim is unvetted; the convention line tells them what an UNMARKED
  // element means. Neither works alone, so neither may be reworded alone. Pinned as literals AND as a
  // containment relationship, so a rewording that detaches the two fails here rather than shipping an
  // unexplained glyph (or a convention describing a mark that no longer exists).
  it('PINS the ratification token and its convention line TOGETHER', () => {
    expect(NOT_RATIFIED_MARK).toBe('⚠️ [NOT RATIFIED]');
    expect(RATIFICATION_CONVENTION).toBe('Every element below appeared in that brief, except any marked ⚠️ [NOT RATIFIED].');
    // The relationship: the convention must name the exact token the render emits.
    expect(RATIFICATION_CONVENTION).toContain(NOT_RATIFIED_MARK);
    // ...and every stamp must carry that convention verbatim, so no entry marks without explaining.
    expect(entryProvenanceStamp({ reason: 'design-decision-draft', now: new Date('2026-08-31T00:00:00Z') }))
      .toContain(RATIFICATION_CONVENTION);
    // ...and the token the entry actually emits is that same literal.
    const doc = ratifiedDoc({ research: ['A prompt the brief never rendered'] });
    expect(renderEntry(doc, { reason: 'design-decision-draft' })).toContain(RATIFICATION_CONVENTION);
    expect(renderEntry(doc, { reason: 'design-decision-draft' })).toContain(`rendered ${NOT_RATIFIED_MARK}`);
  });

  it('opens with the construction-provenance stamp, so the archive is not read as stamped', () => {
    const entry = renderEntry(ratifiedDoc(), { reason: 'design-decision-draft', now: new Date('2026-08-31T00:00:00Z') });
    expect(entry.split('\n')[0]).toContain(ENTRY_PROVENANCE_PREFIX);
    expect(entry.split('\n')[0]).toContain('2026-08-31');
    expect(entry.split('\n')[0]).toContain('design-decision-draft');
  });

  it('leaves a ratified element UNMARKED — every element of a plain doc was in the brief', () => {
    const entry = renderEntry(ratifiedDoc(), { reason: 'design-decision-draft' });
    const body = entry.split('\n').slice(1).join('\n');
    expect(body).not.toContain(NOT_RATIFIED_MARK);
  });

  it('MARKS THE ELEMENT, not the document: a research-first brief never ratified its recommendation', () => {
    // The brief renders "I don't know enough yet" in the recommendation's place, so the human never saw
    // — and never ratified — the recommendation text the doc carries.
    const doc = ratifiedDoc({ load_bearing_gap: true, research: ['Measure the corpus'] });
    const brief = renderBrief(doc, null, { reason: 'design-decision-draft' });
    const entry = renderEntry(doc, { reason: 'design-decision-draft' });
    expect(brief).not.toContain(AUTHORED.recommend);
    expect(entry).toContain(`**Decision:** ${AUTHORED.recommend} ${NOT_RATIFIED_MARK}`);
    // ...and the elements that WERE in the brief stay unmarked, one element at a time.
    for (const why of AUTHORED.why) expect(entry).toContain(`- ${why}\n`);
    expect(entry).not.toContain(`- ${AUTHORED.why[0]} ${NOT_RATIFIED_MARK}`);
  });

  it('marks an element the brief never showed (research authored without the gap flag)', () => {
    const doc = ratifiedDoc({ research: ['A prompt the brief never rendered'] });
    const entry = renderEntry(doc, { reason: 'design-decision-draft' });
    expect(entry).toContain(`1. A prompt the brief never rendered ${NOT_RATIFIED_MARK}`);
  });
});

// ——— The f0d55b23 constraint + backward compatibility ————————————————————————————————————————————

describe('one structuring, two projections — and the archive is untouched (B-866)', () => {
  it('the entry is NOT the brief: it drops the command tail and the depth-pointer', () => {
    const entry = renderEntry(ratifiedDoc(), { reason: 'design-decision-draft', decisionRef: DECISION_REF });
    expect(entry).not.toContain('Type `accept`');
    expect(entry).not.toContain('fuller depth lives in the linked decision entry');
  });

  it('BACK-COMPAT: a doc with no frame and no payload renders byte-identically to today', () => {
    const PRE_B866 = "## DECIDE: Saved views — sidebar placement.\n\n**Recommend:** Sub-section under project views.\n\n**Why:**\n- Sidebar is where users navigate views\n\n**You need to:**\n- [ ] Pick sidebar placement — *recommend: Sub-section under project views*\n\n> Type `accept`, `edit`, `iterate <feedback>`, or `defer`.";
    const doc: BriefDoc = {
      decide: 'Saved views — sidebar placement.',
      recommend: { text: 'Sub-section under project views.' },
      why: ['Sidebar is where users navigate views'],
      items: [{ kind: 'decision', text: 'Pick sidebar placement', recommendation: 'Sub-section under project views' }],
    };
    expect(renderBrief(doc)).toBe(PRE_B866);
  });

  it('withDerivedEntryContent leaves a non-entry-bearing doc strictly untouched', () => {
    const doc = ratifiedDoc();
    expect(withDerivedEntryContent(doc, 'plan-draft', DECISION_REF, { reason: 'plan-draft' })).toBe(doc);
    expect(withDerivedEntryContent(doc, 'clarification-draft', null, { reason: 'clarification-draft' })).toBe(doc);
  });
});
